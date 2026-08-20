// ============================================================
// Fake in-memory do caminho de LIQUIDAÇÃO da anuidade pelo sync
// (F2-sync, follow-up da Onda 1 do QA do Dojô).
//
// Cobre, sem Postgres real e SEM mockar a lógica de negócio, toda a cadeia:
//   karateApplyEvent.applyEvent (claim + dispatch)
//     → settleAnnuity (lookup do header + park-and-replay)
//       → karateAnnuityLedger.settlePeriodOnClient (FOR UPDATE + FIFO)
//         → computeDistribution / writeDistribution (REAIS)
//         → karateAnnuityService.syncAnnuityHeaderRollup (REAL — é o que
//            garante que o header aqui é o rollup de produção, não simulação)
//
// Dispatcher por REGEX (mesmo estilo de tests/helpers/fakeAnnuityDb.js e do
// makeCheckEnforcingClient da regressão B1), tolerante a espaços.
//
// state = {
//   header: { id, dojo_id, federation_id, reference_period, status, paid_at,
//             amount, due_date, payment_method, transaction_id } | null,
//   installments: [ { id, annuity_id, federation_id, seq, amount, amount_paid,
//                     status, due_date, kind, payment_method, paid_at,
//                     transaction_id } ],
//   payments: [],           // linhas de karate_annuity_payments (ledger)
//   claims: [],             // linhas de karate_sync_applied
// }
// ============================================================
'use strict';

let seq = 1;
function uid(prefix) {
  return `${prefix}-${String(seq++).padStart(4, '0')}`;
}

function norm(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function createFakeClient(state) {
  state.payments = state.payments || [];
  state.claims = state.claims || [];
  const log = [];

  async function query(sql, params = []) {
    const text = norm(sql);
    log.push({ text, params });

    if (/^BEGIN|^COMMIT|^ROLLBACK|^SAVEPOINT/i.test(text)) return { rows: [] };

    // ── claim: INSERT karate_sync_applied ... ON CONFLICT DO NOTHING RETURNING id
    if (/^INSERT INTO karate_sync_applied/i.test(text)) {
      const dedupeKey = params[0];
      if (state.claims.some((c) => c.dedupe_key === dedupeKey)) return { rows: [] }; // já aplicado
      const id = uid('applied');
      state.claims.push({ id, dedupe_key: dedupeKey });
      return { rows: [{ id }] };
    }

    // ── tagApplied: UPDATE karate_sync_applied SET target_table ...
    if (/^UPDATE karate_sync_applied/i.test(text)) return { rows: [] };

    // ── settleAnnuity: lookup do header por dojo+período+federação
    if (/^SELECT id FROM karate_dojo_annuity_history WHERE dojo_id = \$1 AND reference_period = \$2 AND federation_id = \$3/i.test(text)) {
      const [dojoId, period, fedId] = params;
      const h = state.header;
      if (h && String(h.dojo_id) === String(dojoId) && h.reference_period === period && String(h.federation_id) === String(fedId)) {
        return { rows: [{ id: h.id }] };
      }
      return { rows: [] };
    }

    // ── settlePeriodOnClient: parcelas FOR UPDATE (FIFO)
    if (/FROM karate_annuity_installments/i.test(text) && /FOR UPDATE/i.test(text)) {
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

    // ── writeDistribution: UPDATE parcela (amount_paid/status/paid_at)
    if (/^UPDATE karate_annuity_installments SET amount_paid = \$1, status = \$2, payment_method = COALESCE\(\$3, payment_method\), paid_at = CASE WHEN \$2 = 'paid'/i.test(text)) {
      const [amountPaid, status, method, paidAt, id] = params;
      const inst = state.installments.find((i) => String(i.id) === String(id));
      if (inst) {
        inst.amount_paid = amountPaid;
        inst.status = status;
        if (method != null) inst.payment_method = method;
        if (status === 'paid') inst.paid_at = paidAt;
      }
      return { rows: [] };
    }

    // ── writeDistribution: INSERT ledger
    if (/^INSERT INTO karate_annuity_payments/i.test(text)) {
      const [fedId, instId, annuityId, amount, paidAt, method, createdBy, opId] = params;
      state.payments.push({
        id: uid('pay'), federation_id: fedId, installment_id: instId, annuity_id: annuityId,
        amount, paid_at: paidAt, payment_method: method, created_by: createdBy, operation_id: opId,
      });
      return { rows: [] };
    }

    // ── syncAnnuityHeaderRollup: getInstallments (sem federation_id/FOR UPDATE)
    if (/^SELECT \* FROM karate_annuity_installments WHERE annuity_id = \$1 ORDER BY seq ASC$/i.test(text)) {
      const [annuityId] = params;
      const rows = state.installments
        .filter((i) => String(i.annuity_id) === String(annuityId))
        .sort((a, b) => a.seq - b.seq)
        .map((i) => ({ ...i }));
      return { rows };
    }

    // ── syncAnnuityHeaderRollup: UPDATE header (RETURNING *)
    if (/^UPDATE karate_dojo_annuity_history SET amount = \$1, status = \$2, due_date = \$3, paid_at = \$4/i.test(text)) {
      const [total, status, dueDate, paidAt, method, txId, id] = params;
      const h = state.header;
      if (h && String(h.id) === String(id)) {
        h.amount = total; h.status = status; h.due_date = dueDate; h.paid_at = paidAt;
        if (method != null) h.payment_method = method;
        if (txId != null) h.transaction_id = txId;
        return { rows: [{ ...h }] };
      }
      return { rows: [] };
    }

    // ── settleAnnuity fallback (header sem parcelas): paid_at só
    if (/^UPDATE karate_dojo_annuity_history SET paid_at = COALESCE\(paid_at, \$2\), updated_at = NOW\(\) WHERE id = \$1 AND paid_at IS NULL/i.test(text)) {
      const [id, paidAt] = params;
      const h = state.header;
      if (h && String(h.id) === String(id) && h.paid_at == null) {
        h.paid_at = paidAt;
        return { rows: [{ id: h.id }] };
      }
      return { rows: [] };
    }

    throw new Error('fakeSyncAnnuityDb: query inesperada -> ' + text + ' | params=' + JSON.stringify(params));
  }

  return { query, release: () => {}, _log: log };
}

module.exports = { createFakeClient, round2, uid };
