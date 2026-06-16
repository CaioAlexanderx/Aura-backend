// =============================================================
// AURA. -- Credito: motor de RENEGOCIACAO de parcelas (Item 2, 16/06/2026).
//
// Da liberdade ao lojista para reorganizar as parcelas ABERTAS de um carne
// (ou da conta geral): mudar o NUMERO de parcelas e/ou o VALOR por parcela.
// Decisao Caio (16/06): o TOTAL e EDITAVEL e a edicao e livre dos dois lados
// (mexer em N recalcula o valor; mexer no valor recalcula N; o total pode subir
// ou descer). Quando o total muda, o delta vai pro ledger para o SALDO seguir
// o novo cronograma -- senao schedule e saldo divergem.
//
// MODELO DE LEDGER (imutavel):
//   customer_credit_balances (view) = sum(debit) - sum(payment|refund|...).
//   credit_installments e' so o CRONOGRAMA; nao define o saldo.
//   applyUnify reescreve so o schedule; aqui fazemos o mesmo + ajuste de saldo.
//
//   delta = target_total - open_remaining
//     delta < 0  (desconto/perdao)  -> INSERT type='refund'  (view subtrai) e
//                                       reduz best-effort o "A Receber" pendente.
//     delta > 0  (acrescimo/encargo)-> INSERT type='debit'   (view soma). NAO
//                                       cria "A Receber" novo (ficaria sem venda
//                                       p/ o FIFO casar); e' capturado no caixa
//                                       como "saldo legado" no proximo
//                                       recebimento (mesmo caminho do applyPayment).
//
// computeReschedulePlan: motor PURO (sem I/O) -- reusado por preview E apply,
// garantindo preview === aplicacao (mesma garantia do recebimento B3/unify).
//
// Chamar applyReschedule DENTRO de uma transacao (client ja em BEGIN).
// =============================================================

const { round2 } = require('./terms');
const { computeUnifyPlan } = require('./unify');
const creditLedger = require('../creditLedger');

// -------------------------------------------------------------
// Motor PURO. Recebe o saldo aberto do escopo (open_remaining) e o total
// alvo escolhido pelo lojista; devolve cronograma + delta de saldo.
// Reusa a distribuicao canonica do unify (floor por parcela, resto na ultima)
// passando openInstallments=[] + newAmount=total + interest=0.
// -------------------------------------------------------------
function computeReschedulePlan({
  openRemaining = 0,
  total = null,
  installments = 1,
  firstDueDate = null,
  periodUnit = 'month',
  periodCount = 1,
} = {}) {
  const openRem = round2(Math.max(0, Number(openRemaining) || 0));
  const target  = total == null ? openRem : round2(Math.max(0, Number(total) || 0));

  const dist = computeUnifyPlan({
    openInstallments: [],
    newAmount:        target,
    installments,
    interestRate:     0,
    firstDueDate,
    periodUnit,
    periodCount,
  });

  return {
    open_remaining:     openRem,
    target_total:       target,
    delta:              round2(target - openRem),
    installments_count: dist.installments_count,
    schedule:           dist.schedule,
  };
}

// Carrega parcelas abertas do escopo (sem lock, p/ preview). Fallback 42703
// (account_id ausente em deploy parcial) cai p/ escopo global do cliente.
async function loadOpenInstallments(db, companyId, customerId, accountId, forUpdate = false) {
  const lock = forUpdate ? 'FOR UPDATE' : '';
  try {
    if (accountId) {
      const { rows } = await db.query(
        `SELECT id, amount_due, covered_amount
           FROM credit_installments
          WHERE company_id = $1 AND customer_id = $2
            AND account_id = $3
            AND status IN ('pending', 'overdue')
          ORDER BY due_date ASC ${lock}`,
        [companyId, customerId, accountId]
      );
      return rows;
    }
    const { rows } = await db.query(
      `SELECT id, amount_due, covered_amount
         FROM credit_installments
        WHERE company_id = $1 AND customer_id = $2
          AND account_id IS NULL
          AND status IN ('pending', 'overdue')
        ORDER BY due_date ASC ${lock}`,
      [companyId, customerId]
    );
    return rows;
  } catch (err) {
    if (err.code === '42703') {
      const { rows } = await db.query(
        `SELECT id, amount_due, covered_amount
           FROM credit_installments
          WHERE company_id = $1 AND customer_id = $2
            AND status IN ('pending', 'overdue')
          ORDER BY due_date ASC ${lock}`,
        [companyId, customerId]
      );
      return rows;
    }
    throw err;
  }
}

function sumRemaining(rows) {
  return round2(
    (rows || []).reduce(
      (s, i) => s + Math.max(0, (Number(i.amount_due) || 0) - (Number(i.covered_amount) || 0)),
      0
    )
  );
}

// -------------------------------------------------------------
// applyReschedule -- aplica a renegociacao (DENTRO de uma transacao).
//   1. Lock das parcelas abertas do escopo -> open_remaining + ids substituidos.
//   2. Guard: precisa existir parcela aberta (senao um delta>0 dobraria o saldo
//      de um fiado sem cronograma).
//   3. Cancela as parcelas substituidas (covered_amount=0; nao toca pagas).
//   4. Insere o novo cronograma (saleId null -- renegociacao nao e' venda nova).
//   5. delta no ledger (refund/desconto ou debit/acrescimo) + reduz A Receber.
//   6. Atualiza credit_used + le saldo novo.
// -------------------------------------------------------------
async function applyReschedule(client, {
  companyId,
  customerId,
  accountId = null,
  total,
  installments,
  firstDueDate = null,
  periodUnit = null,
  periodCount = null,
  createdBy = null,
}) {
  // 1. Lock das parcelas abertas do escopo.
  const openRows = await loadOpenInstallments(client, companyId, customerId, accountId, true);
  const openRemaining = sumRemaining(openRows);
  const replacedIds = (openRows || []).map((i) => i.id).filter(Boolean);

  // 2. Guard: sem parcela aberta nao ha o que renegociar (e um delta>0 criaria
  //    debito em cima de divida sem cronograma -> double count).
  if (replacedIds.length === 0) {
    const e = new Error('Nao ha parcelas abertas para renegociar neste carne.');
    e.status = 422;
    e.code   = 'NO_OPEN_INSTALLMENTS';
    throw e;
  }

  // 3. Plano puro (preview === apply).
  const plan = computeReschedulePlan({
    openRemaining,
    total,
    installments,
    firstDueDate,
    periodUnit: periodUnit || 'month',
    periodCount: periodCount || 1,
  });

  // 4. Cancela as parcelas substituidas (preserva historico; covered=0).
  await client.query(
    `UPDATE credit_installments
        SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
      WHERE id = ANY($1) AND company_id = $2`,
    [replacedIds, companyId]
  );

  // 5. Insere o novo cronograma. Espelha o INSERT do applyUnify (fallback 42703).
  const appliedIds = [];
  for (const slot of plan.schedule) {
    let iid;
    try {
      const { rows } = await client.query(
        `INSERT INTO credit_installments
           (company_id, sale_id, customer_id, installment_number, total_installments,
            amount_due, due_date, status, covered_amount, account_id)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', 0, $7)
         RETURNING id`,
        [companyId, customerId, slot.number, plan.installments_count,
         slot.amount_due, slot.due_date, accountId]
      );
      iid = rows[0].id;
    } catch (err) {
      if (err.code === '42703') {
        const { rows } = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, covered_amount)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', 0)
           RETURNING id`,
          [companyId, customerId, slot.number, plan.installments_count,
           slot.amount_due, slot.due_date]
        );
        iid = rows[0].id;
      } else throw err;
    }
    appliedIds.push(iid);
  }

  // 6. Ajuste de saldo (delta) no ledger -- so quando o total mudou.
  const delta = plan.delta;
  let adjustment = null;

  if (delta < -0.005) {
    // DESCONTO: type='refund' (a view subtrai) reduz a divida.
    const discount = round2(-delta);
    await insertLedger(client, {
      companyId, customerId, accountId, createdBy,
      type: 'refund', amount: discount, paymentMethod: 'crediario_ajuste',
      notes: 'Renegociacao - desconto no saldo',
    });
    // Reduz best-effort o "A Receber" pendente (Financeiro nao superestimar).
    await reduceReceivables(client, companyId, customerId, discount);
    adjustment = { type: 'discount', amount: discount };
  } else if (delta > 0.005) {
    // ACRESCIMO: type='debit' (a view soma) aumenta a divida. Sem "A Receber"
    // novo -> capturado no caixa como saldo legado no proximo recebimento.
    const surcharge = round2(delta);
    await insertLedger(client, {
      companyId, customerId, accountId, createdBy,
      type: 'debit', amount: surcharge, paymentMethod: null,
      notes: 'Renegociacao - acrescimo no saldo',
    });
    adjustment = { type: 'surcharge', amount: surcharge };
  }

  // 7. credit_used + saldo novo.
  try { await creditLedger._updateCreditUsed(client, companyId, customerId); } catch (_) {}

  let newBalance = 0;
  try {
    const { rows } = await client.query(
      `SELECT balance FROM customer_credit_balances
        WHERE customer_id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    newBalance = parseFloat(rows[0]?.balance || 0);
  } catch (_) {}

  return {
    ...plan,
    replaced_installment_ids: replacedIds,
    applied_installment_ids:  appliedIds,
    adjustment,
    new_balance: newBalance,
  };
}

// INSERT defensivo no ledger (fallback 42703 sem source/account_id).
async function insertLedger(client, { companyId, customerId, accountId, createdBy, type, amount, paymentMethod, notes }) {
  try {
    await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, payment_method, notes, source, created_by, account_id)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, 'reschedule', $7, $8)`,
      [companyId, customerId, type, amount, paymentMethod, notes, createdBy, accountId]
    );
  } catch (err) {
    if (err.code === '42703') {
      await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)`,
        [companyId, customerId, type, amount, paymentMethod, notes, createdBy]
      );
    } else throw err;
  }
}

// Reduz best-effort o "A Receber" pendente do cliente (oldest-first). Mesma
// tecnica do refund.js (step 9), porem escopo CLIENTE (renegociacao nao e por
// venda). Nao-fatal: falha aqui nao desfaz a renegociacao.
async function reduceReceivables(client, companyId, customerId, amount) {
  try {
    let toReduce = round2(amount);
    const { rows } = await client.query(
      `SELECT t.id, t.amount
         FROM transactions t
         JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
        WHERE t.company_id = $1
          AND t.category ILIKE 'Crediario%A Receber%'
          AND t.status = 'pending'
          AND s.customer_id = $2
          AND COALESCE(s.status, 'active') != 'cancelled'
        ORDER BY t.created_at ASC
        FOR UPDATE OF t`,
      [companyId, customerId]
    );
    for (const recv of rows) {
      if (toReduce <= 0.005) break;
      const recvAmount = parseFloat(recv.amount) || 0;
      if (recvAmount <= 0.005) continue;
      const cut = round2(Math.min(recvAmount, toReduce));
      if (cut >= recvAmount - 0.005) {
        await client.query(
          `DELETE FROM transactions WHERE id = $1 AND company_id = $2 AND status = 'pending'`,
          [recv.id, companyId]
        );
      } else {
        await client.query(
          `UPDATE transactions SET amount = GREATEST(0, amount - $1), updated_at = NOW()
            WHERE id = $2 AND company_id = $3`,
          [cut, recv.id, companyId]
        );
      }
      toReduce = round2(toReduce - cut);
    }
  } catch (e) {
    console.warn('[credit/reschedule] reduce A Receber (non-fatal):', e.message);
  }
}

module.exports = { computeReschedulePlan, applyReschedule, loadOpenInstallments, sumRemaining };
