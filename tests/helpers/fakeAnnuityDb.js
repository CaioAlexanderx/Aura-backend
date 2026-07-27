// ============================================================
// Fake in-memory de karate_dojo_annuity_history / karate_annuity_installments
// / karate_annuity_payments / transactions / karate_annual_fees / companies,
// o suficiente para exercitar de ponta a ponta (sem Postgres real):
//   - PATCH /financial/annuities/dojos/:dojoId/:annuityId (karateAnnuities.js)
//   - recomputeAnnuityFromLedger / syncAnnuityHeaderRollup (REAIS, não
//     mockados — é o que garante que o FIFO testado aqui é o comportamento
//     de produção, não uma simulação).
// Usado só pelos testes de tests/integration/karateAnnuityHeaderEdit.test.js.
// ============================================================
'use strict';

let seq = 1;
function uid(prefix) {
  return `${prefix}-${String(seq++).padStart(6, '0')}`;
}

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// state: { header, installments: [], payments: [], transactions: Map(id->row),
//          txByIdemKey: Map(key->id), fees: [], companies: Map(id->row) }
function createFakeClient(state) {
  async function query(sql, params = []) {
    const text = norm(sql);

    if (/^BEGIN/.test(text)) return { rows: [] };
    if (/^COMMIT/.test(text)) return { rows: [] };
    if (/^ROLLBACK/.test(text)) return { rows: [] };

    // ── mine: header FOR UPDATE ──────────────────────────────
    if (text.startsWith('SELECT id, dojo_id, federation_id, reference_period, plan, amount, due_date, status FROM karate_dojo_annuity_history')) {
      const [id, dojoId, fedId] = params;
      const h = state.header;
      if (h && String(h.id) === String(id) && String(h.dojo_id) === String(dojoId) && String(h.federation_id) === String(fedId)) {
        return { rows: [{ ...h }] };
      }
      return { rows: [] };
    }

    // ── mine: dup reference_period check ─────────────────────
    if (text.startsWith('SELECT id FROM karate_dojo_annuity_history WHERE dojo_id = $1 AND reference_period = $2 AND id <> $3')) {
      const [dojoId, period, excludeId] = params;
      const candidates = [state.header, ...(state.otherHeaders || [])].filter(Boolean);
      const hit = candidates.find((h) => String(h.dojo_id) === String(dojoId) && h.reference_period === period && String(h.id) !== String(excludeId));
      return { rows: hit ? [{ id: hit.id }] : [] };
    }

    // ── mine: installments FOR UPDATE (ORDER BY seq ASC) ─────
    if (text.startsWith('SELECT * FROM karate_annuity_installments WHERE annuity_id = $1 AND federation_id = $2 ORDER BY seq ASC FOR UPDATE')) {
      const [annuityId, fedId] = params;
      const rows = state.installments
        .filter((i) => String(i.annuity_id) === String(annuityId) && String(i.federation_id) === String(fedId))
        .sort((a, b) => a.seq - b.seq)
        .map((i) => ({ ...i }));
      return { rows };
    }

    // ── recompute: installments FOR UPDATE (ORDER BY due_date, seq) ──
    if (text.includes('FROM karate_annuity_installments') && text.includes('due_date ASC NULLS FIRST, seq ASC') && text.includes('FOR UPDATE')) {
      const [annuityId, fedId] = params;
      const rows = state.installments
        .filter((i) => String(i.annuity_id) === String(annuityId) && String(i.federation_id) === String(fedId))
        .sort((a, b) => {
          const ad = a.due_date ? new Date(a.due_date).getTime() : -Infinity;
          const bd = b.due_date ? new Date(b.due_date).getTime() : -Infinity;
          if (ad !== bd) return ad - bd;
          return a.seq - b.seq;
        })
        .map((i) => ({ ...i }));
      return { rows };
    }

    // ── syncAnnuityHeaderRollup: getInstallments (sem federation_id/FOR UPDATE) ──
    if (text === 'SELECT * FROM karate_annuity_installments WHERE annuity_id = $1 ORDER BY seq ASC') {
      const [annuityId] = params;
      const rows = state.installments
        .filter((i) => String(i.annuity_id) === String(annuityId))
        .sort((a, b) => a.seq - b.seq)
        .map((i) => ({ ...i }));
      return { rows };
    }

    // ── getVigentFee ──────────────────────────────────────────
    if (text.includes('FROM karate_annual_fees')) {
      const [fedId, feeType, plan] = params;
      const row = state.fees.find((f) =>
        String(f.federation_id) === String(fedId) && f.fee_type === feeType &&
        (plan === null || plan === undefined ? f.plan == null : f.plan === plan)
      );
      return { rows: row ? [{ ...row }] : [] };
    }

    // ── mine: update existing installment amount/due_date ────
    if (text.startsWith('UPDATE karate_annuity_installments SET amount = $1, due_date = $2, updated_at = NOW() WHERE id = $3')) {
      const [amount, dueDate, id] = params;
      const inst = state.installments.find((i) => String(i.id) === String(id));
      if (inst) { inst.amount = amount; inst.due_date = dueDate; }
      return { rows: [] };
    }

    // ── mine: sync transaction amount/due_date ───────────────
    if (text.startsWith("UPDATE transactions SET amount = $1, due_date = $2, updated_at = NOW() WHERE id = $3 AND status <> 'cancelled'")) {
      const [amount, dueDate, id] = params;
      const tx = state.transactions.get(String(id));
      if (tx && tx.status !== 'cancelled') { tx.amount = amount; tx.due_date = dueDate; }
      return { rows: [] };
    }

    // ── mine: insert new installment ─────────────────────────
    if (text.startsWith("INSERT INTO karate_annuity_installments (annuity_id, federation_id, seq, amount, due_date, status, kind) VALUES ($1,$2,$3,$4,$5,'pending','anuidade')")) {
      const [annuityId, fedId, s, amount, dueDate] = params;
      const id = uid('inst');
      state.installments.push({
        id, annuity_id: annuityId, federation_id: fedId, seq: s, amount, amount_paid: 0,
        due_date: dueDate, status: 'pending', kind: 'anuidade', payment_method: null, paid_at: null, transaction_id: null,
      });
      return { rows: [{ id }] };
    }

    // ── mine: dojo name lookup ────────────────────────────────
    if (text.startsWith('SELECT COALESCE(trade_name, legal_name) AS name FROM companies WHERE id = $1')) {
      const [id] = params;
      const c = state.companies.get(String(id));
      return { rows: c ? [{ name: c.name }] : [] };
    }

    // ── createTransactionsForInstallments: insert transaction ─
    if (text.startsWith('INSERT INTO transactions') && text.includes('idempotency_key') && text.includes('ON CONFLICT (idempotency_key) DO NOTHING')) {
      const [fedId, category, amount, dueDate, description, idempotencyKey, referenceType, refId] = params;
      if (state.txByIdemKey.has(idempotencyKey)) return { rows: [] };
      const id = uid('tx');
      state.transactions.set(id, {
        id, company_id: fedId, type: 'income', category, amount, status: 'pending', due_date: dueDate,
        description, idempotency_key: idempotencyKey, reference_type: referenceType, reference_id: refId,
      });
      state.txByIdemKey.set(idempotencyKey, id);
      return { rows: [{ id }] };
    }
    if (text.startsWith('SELECT id FROM transactions WHERE idempotency_key = $1')) {
      const [key] = params;
      const id = state.txByIdemKey.get(key);
      return { rows: id ? [{ id }] : [] };
    }
    if (text.startsWith('UPDATE karate_annuity_installments SET transaction_id = $1 WHERE id = $2')) {
      const [txId, instId] = params;
      const inst = state.installments.find((i) => String(i.id) === String(instId));
      if (inst) inst.transaction_id = txId;
      return { rows: [] };
    }

    // ── mine: reassign ledger to anchor (surplus) ─────────────
    if (text.startsWith('UPDATE karate_annuity_payments SET installment_id = $1 WHERE installment_id = $2')) {
      const [anchorId, oldId] = params;
      state.payments.forEach((p) => { if (String(p.installment_id) === String(oldId)) p.installment_id = anchorId; });
      return { rows: [] };
    }

    // ── mine: cancel transaction (surplus) ────────────────────
    if (text.startsWith("UPDATE transactions SET status = 'cancelled', updated_at = NOW() WHERE id = $1")) {
      const [id] = params;
      const tx = state.transactions.get(String(id));
      if (tx) tx.status = 'cancelled';
      return { rows: [] };
    }

    // ── mine: cancel pending pix intents (no-op) ──────────────
    if (text.startsWith('UPDATE karate_payment_intents')) {
      return { rows: [] };
    }

    // ── mine: delete surplus installment ──────────────────────
    if (text.startsWith('DELETE FROM karate_annuity_installments WHERE id = $1')) {
      const [id] = params;
      state.installments = state.installments.filter((i) => String(i.id) !== String(id));
      return { rows: [] };
    }

    // ── mine: header UPDATE (reference_period/plan) ───────────
    if (text.startsWith('UPDATE karate_dojo_annuity_history SET') && !text.includes('COALESCE($')) {
      // extrai pares campo=$n na ordem em que aparecem (exclui updated_at)
      const fieldMatches = [...text.matchAll(/(\w+) = \$(\d+)/g)].filter((m) => m[1] !== 'updated_at');
      for (const m of fieldMatches) {
        const field = m[1];
        const idx = Number(m[2]) - 1;
        state.header[field] = params[idx];
      }
      return { rows: [] };
    }

    // ── recompute: ledger replay SELECT (JOIN installments) ──
    if (text.includes('FROM karate_annuity_payments p') && text.includes('JOIN karate_annuity_installments i')) {
      const [annuityId, fedId] = params;
      const liveIds = new Set(state.installments.map((i) => String(i.id)));
      const instById = new Map(state.installments.map((i) => [String(i.id), i]));
      const rows = state.payments
        .filter((p) => String(p.annuity_id) === String(annuityId) && String(p.federation_id) === String(fedId) && liveIds.has(String(p.installment_id)))
        .slice()
        .sort((a, b) => {
          const ac = new Date(a.created_at).getTime();
          const bc = new Date(b.created_at).getTime();
          if (ac !== bc) return ac - bc;
          const ai = instById.get(String(a.installment_id));
          const bi = instById.get(String(b.installment_id));
          const ad = ai && ai.due_date ? new Date(ai.due_date).getTime() : -Infinity;
          const bd = bi && bi.due_date ? new Date(bi.due_date).getTime() : -Infinity;
          if (ad !== bd) return ad - bd;
          const aseq = ai ? ai.seq : 0;
          const bseq = bi ? bi.seq : 0;
          if (aseq !== bseq) return aseq - bseq;
          return String(a.id).localeCompare(String(b.id));
        })
        .map((p) => ({ ...p }));
      return { rows };
    }

    // ── recompute: DELETE ledger ──────────────────────────────
    if (text.startsWith('DELETE FROM karate_annuity_payments WHERE annuity_id = $1 AND federation_id = $2')) {
      const [annuityId, fedId] = params;
      state.payments = state.payments.filter((p) => !(String(p.annuity_id) === String(annuityId) && String(p.federation_id) === String(fedId)));
      return { rows: [] };
    }

    // ── recompute: INSERT ledger row ──────────────────────────
    if (text.startsWith('INSERT INTO karate_annuity_payments (federation_id, installment_id, annuity_id, amount, paid_at, payment_method, created_by, operation_id, created_at)')) {
      const [fedId, instId, annuityId, amount, paidAt, method, createdBy, opId, createdAt] = params;
      const id = uid('pay');
      state.payments.push({ id, federation_id: fedId, installment_id: instId, annuity_id: annuityId, amount, paid_at: paidAt, payment_method: method, created_by: createdBy, operation_id: opId, created_at: createdAt });
      return { rows: [] };
    }

    // ── recompute: per-installment amount_paid/status UPDATE ──
    if (text.startsWith('UPDATE karate_annuity_installments SET amount_paid = $1, status = $2, payment_method = $3, paid_at = $4::timestamptz, updated_at = NOW() WHERE id = $5')) {
      const [amountPaid, status, method, paidAt, id] = params;
      const inst = state.installments.find((i) => String(i.id) === String(id));
      if (inst) {
        inst.amount_paid = amountPaid; inst.status = status; inst.payment_method = method; inst.paid_at = paidAt;
      }
      return { rows: inst ? [{ ...inst }] : [] };
    }

    // ── syncAnnuityHeaderRollup: header UPDATE (RETURNING *) ──
    if (text.includes('COALESCE($5, payment_method)')) {
      const [total, status, dueDate, paidAt, paymentMethod, transactionId, id] = params;
      const h = state.header;
      if (h && String(h.id) === String(id)) {
        h.amount = total; h.status = status; h.due_date = dueDate; h.paid_at = paidAt;
        if (paymentMethod != null) h.payment_method = paymentMethod;
        if (transactionId != null) h.transaction_id = transactionId;
        return { rows: [{ ...h }] };
      }
      return { rows: [] };
    }

    throw new Error('fakeAnnuityDb: query inesperada -> ' + text + ' | params=' + JSON.stringify(params));
  }

  return { query, release: () => {} };
}

module.exports = { createFakeClient, round2, uid };
