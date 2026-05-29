// =============================================================
// AURA. -- Servico unificado de credito (Ledger)
// Fonte unica da verdade para todas as operacoes de crediario.
//
// Funcoes recebem um `client` pg (ja em BEGIN) para composicao
// atomica. getCustomerCreditPreview usa pool diretamente.
//
// API publica:
//   createCreditSale(client, opts)  -> { debited, schedule[] }
//   applyPayment(client, opts)      -> { new_balance, settled_receivables[], covered_installments[], transaction }
//   cancelCreditSale(client, opts)  -> { ok }
//   getCustomerCreditPreview(companyId, customerId) -> preview
// =============================================================

const pool = require('../config/database');

const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

// ─── helpers internos ─────────────────────────────────────────

function buildPixLink(id) {
  const short = id.replace(/-/g, '').slice(0, 12);
  return `https://pagar.getaura.com.br/parcela/${short}`;
}

function scoreLabel(score) {
  if (score >= 800) return 'premium';
  if (score >= 650) return 'bom';
  if (score >= 450) return 'regular';
  if (score >= 300) return 'restrito';
  return 'bloqueado';
}

async function _getOrCreateProfile(client, companyId, customerId) {
  try {
    const r = await client.query(
      `INSERT INTO customer_credit_profiles
         (company_id, customer_id, credit_limit, credit_score, status)
       VALUES ($1, $2, 0, 500, 'active')
       ON CONFLICT (company_id, customer_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [companyId, customerId]
    );
    return r.rows[0] || null;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

async function _getOrCreatePlanConfig(client, companyId) {
  try {
    const r = await client.query(
      `INSERT INTO credit_plan_configs (company_id)
       VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [companyId]
    );
    return r.rows[0] || null;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

// credit_used calculado a partir do saldo do ledger (customer_credit_balances),
// nao mais da soma de installments -- corrige bug #5 do plano.
async function _updateCreditUsed(client, companyId, customerId) {
  try {
    await client.query(
      `UPDATE customer_credit_profiles
         SET credit_used = COALESCE((
           SELECT GREATEST(0, balance)
           FROM customer_credit_balances
           WHERE company_id = $1 AND customer_id = $2
         ), 0),
         updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return;
    throw err;
  }
}

async function _recalculateScore(client, companyId, customerId) {
  try {
    const res = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid')                                           AS total_paid_count,
         COUNT(*) FILTER (WHERE status = 'paid'
           AND (${SP_DATE_COL('paid_at')} <= due_date OR paid_at IS NULL))                 AS total_paid_on_time,
         COALESCE(AVG(
           CASE WHEN status = 'paid'
                 AND ${SP_DATE_COL('paid_at')} > due_date
             THEN (${SP_DATE_COL('paid_at')} - due_date) END
         ), 0)                                                                              AS avg_days_late,
         COALESCE(SUM(amount_due) FILTER (WHERE status = 'paid'), 0)                       AS total_purchases
       FROM credit_installments
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    const row = res.rows[0];

    const relRes = await client.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - created_at)) / 2592000 AS months
       FROM customer_credit_profiles
       WHERE company_id = $1 AND customer_id = $2`,
      [companyId, customerId]
    );
    const months = parseFloat(relRes.rows[0]?.months) || 0;

    const n = parseInt(row.total_paid_count) || 0;
    let score = 500;
    if (n > 0) {
      const onTimePts = (parseInt(row.total_paid_on_time) || 0) / n * 400;
      const latePts   = Math.max(0, 1 - (parseFloat(row.avg_days_late) || 0) / 90) * 300;
      const volPts    = Math.min(1, (parseFloat(row.total_purchases)   || 0) / 5000) * 150;
      const senPts    = Math.min(1, months / 24) * 150;
      score = Math.min(1000, Math.max(0, Math.round(onTimePts + latePts + volPts + senPts)));
    }

    await client.query(
      `UPDATE customer_credit_profiles
         SET credit_score        = $3,
             total_paid_count    = $4,
             total_paid_on_time  = $5,
             avg_days_late       = $6,
             total_purchases     = $7,
             relationship_months = $8,
             score_updated_at    = NOW(),
             updated_at          = NOW()
       WHERE company_id = $1 AND customer_id = $2`,
      [
        companyId, customerId, score,
        parseInt(row.total_paid_count),
        parseInt(row.total_paid_on_time),
        parseFloat(row.avg_days_late),
        parseFloat(row.total_purchases),
        Math.round(months),
      ]
    );
    return score;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') return null;
    throw err;
  }
}

// ─── API publica ───────────────────────────────────────────────

/**
 * createCreditSale — grava debit + A Receber + agenda parcelas.
 * Chamar DENTRO de uma transacao principal (client ja em BEGIN).
 *
 * @param {pg.PoolClient} client
 * @param {{ companyId, customerId, saleId, amount, installments?,
 *           firstDueDate?, interestRate?, productNames?, createdBy? }} opts
 * @returns {{ debited: row, schedule: [] }}
 */
async function createCreditSale(client, {
  companyId, customerId, saleId, amount,
  installments = 1, firstDueDate = null,
  interestRate = 0, productNames = [], createdBy = null,
}) {
  // 1. Ledger: debit
  const { rows: debitRows } = await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, sale_id, type, amount, notes, created_by)
     VALUES ($1, $2, $3, 'debit', $4, $5, $6)
     RETURNING *`,
    [
      companyId, customerId, saleId, amount,
      `Venda no crediario (${productNames.slice(0, 2).join(', ') || 'Venda'})`,
      createdBy,
    ]
  );

  // 2. Financeiro: A Receber pending
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category,
        due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'income', 'pending', $2, $3, 'Crediario - A Receber',
             ${SP_DATE_NOW}, NULL, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      companyId, amount,
      `Crediario - venda ${saleId}`,
      createdBy,
      'pdv-credit-receivable-' + saleId,
    ]
  );

  // 3. Agenda de parcelas (installments > 1)
  const schedule = [];
  if (installments > 1) {
    await _getOrCreateProfile(client, companyId, customerId);
    const config = await _getOrCreatePlanConfig(client, companyId);

    const maxN = parseInt(config?.max_installments) || 12;
    const effectiveRate = parseFloat(interestRate) > 0
      ? parseFloat(interestRate)
      : parseFloat(config?.interest_rate) || 0;
    const n = Math.min(parseInt(installments), maxN, 36);

    const due1 = firstDueDate || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d.toISOString().split('T')[0];
    })();

    // Juros simples: total = principal * (1 + rate * n)
    const totalWithInterest = effectiveRate > 0
      ? parseFloat((amount * (1 + effectiveRate * n)).toFixed(2))
      : amount;

    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    for (let i = 1; i <= n; i++) {
      const amt      = i === n ? baseAmount + remainder : baseAmount;
      const dueDate  = new Date(due1);
      dueDate.setMonth(dueDate.getMonth() + (i - 1));
      const dueDateStr = dueDate.toISOString().split('T')[0];

      const { rows: insRows } = await client.query(
        `INSERT INTO credit_installments
           (company_id, sale_id, customer_id, installment_number, total_installments,
            amount_due, due_date, status, pix_link, covered_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending',
                 'https://pagar.getaura.com.br/parcela/tmp', 0)
         RETURNING id`,
        [companyId, saleId, customerId, i, n, amt, dueDateStr]
      );
      const iid = insRows[0].id;
      await client.query(
        `UPDATE credit_installments SET pix_link = $2 WHERE id = $1`,
        [iid, buildPixLink(iid)]
      );
      schedule.push({ id: iid, installment_number: i, amount_due: amt, due_date: dueDateStr });
    }

    // Marcar venda como parcelada (42703/42P01 defensivo)
    try {
      await client.query(
        `UPDATE sales
           SET is_installment = true, total_installments = $2,
               credit_plan_snapshot = $3
         WHERE id = $1 AND company_id = $4`,
        [saleId, n,
         JSON.stringify({ installments: n, total_amount: amount, interest_rate: effectiveRate }),
         companyId]
      );
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    await _updateCreditUsed(client, companyId, customerId);
  }

  return { debited: debitRows[0], schedule };
}

/**
 * applyPayment — registra recebimento (valor livre) e liquida FIFO.
 * Chamar DENTRO de uma transacao (client ja em BEGIN).
 *
 * @param {pg.PoolClient} client
 * @param {{ companyId, customerId, amount, method?, sessaoId?,
 *           createdBy?, idempotencyKey? }} opts
 * @returns {{ new_balance, settled_receivables[], covered_installments[], transaction, legacy_amount }}
 */
async function applyPayment(client, {
  companyId, customerId, amount, method = null,
  sessaoId = null, createdBy = null, idempotencyKey = null,
}) {
  // 1. Ledger: payment (idempotente se idempotencyKey fornecida)
  let txRow;
  if (idempotencyKey) {
    const { rows } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, payment_method, created_by, idempotency_key)
       VALUES ($1, $2, 'payment', $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [companyId, customerId, amount, method, createdBy, idempotencyKey]
    );
    if (!rows.length) {
      const { rows: ex } = await client.query(
        `SELECT * FROM customer_credit_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      txRow = ex[0];
    } else {
      txRow = rows[0];
    }
  } else {
    const { rows } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, payment_method, created_by)
       VALUES ($1, $2, 'payment', $3, $4, $5)
       RETURNING *`,
      [companyId, customerId, amount, method, createdBy]
    );
    txRow = rows[0];
  }

  // 2. FIFO liquidacao das transactions 'Crediario - A Receber' pendentes
  const fifoMethod = (method || 'dinheiro').toLowerCase();
  const settledReceivables = [];
  let remaining = amount;

  const { rows: pendingTxs } = await client.query(
    `SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
     FROM transactions t
     JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
     WHERE t.company_id = $1
       AND t.category ILIKE 'Crediario%A Receber%'
       AND t.status = 'pending'
       AND s.customer_id = $2
       AND COALESCE(s.status, 'active') != 'cancelled'
     ORDER BY t.created_at ASC
     LIMIT 100`,
    [companyId, customerId]
  );

  for (const pt of pendingTxs) {
    if (remaining <= 0.005) break;
    const ptAmount = parseFloat(pt.amount);

    if (ptAmount <= remaining + 0.005) {
      await client.query(
        `UPDATE transactions
           SET status = 'confirmed', paid_at = NOW(), payment_method = $1,
               category = 'Crediario - Recebido', updated_at = NOW()
         WHERE id = $2`,
        [fifoMethod, pt.id]
      );
      await client.query(
        `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [pt.sale_id, companyId, fifoMethod, ptAmount, sessaoId]
      );
      settledReceivables.push({ id: pt.id, sale_id: pt.sale_id, amount: ptAmount, partial: false });
      remaining = parseFloat((remaining - ptAmount).toFixed(2));
    } else {
      const paidNow = parseFloat(remaining.toFixed(2));
      const restAmt = parseFloat((ptAmount - paidNow).toFixed(2));

      await client.query(
        `UPDATE transactions
           SET status = 'confirmed', paid_at = NOW(), payment_method = $1,
               amount = $2, category = 'Crediario - Recebido (parcial)', updated_at = NOW()
         WHERE id = $3`,
        [fifoMethod, paidNow, pt.id]
      );
      await client.query(
        `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [pt.sale_id, companyId, fifoMethod, paidNow, sessaoId]
      );

      const restKey = pt.idempotency_key + '-rest-' + Date.now();
      await client.query(
        `INSERT INTO transactions
           (company_id, type, status, amount, description, category,
            due_date, paid_at, created_by, idempotency_key)
         VALUES ($1, 'income', 'pending', $2, $3, 'Crediario - A Receber',
                 ${SP_DATE_NOW}, NULL, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          companyId, restAmt,
          `Crediario - saldo venda ${pt.sale_id} (parcial)`,
          createdBy, restKey,
        ]
      );

      settledReceivables.push({ id: pt.id, sale_id: pt.sale_id, amount: paidNow, partial: true, rest: restAmt });
      remaining = 0;
    }
  }

  // Sobra: pagamento maior que A Receber pendentes -- confirma como Recebido generico
  if (remaining > 0.005) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category,
          due_date, paid_at, created_by, idempotency_key, payment_method)
       VALUES ($1, 'income', 'confirmed', $2, $3, 'Crediario - Recebido',
               ${SP_DATE_NOW}, NOW(), $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        companyId,
        parseFloat(remaining.toFixed(2)),
        `Recebimento crediario - cliente ${customerId} (saldo legado)`,
        createdBy,
        'credit-payment-' + txRow.id + '-legacy',
        fifoMethod,
      ]
    );
  }

  // 3. FIFO covered_amount nas credit_installments
  const coveredInstallments = [];
  let toAllocate = amount;

  const { rows: installments } = await client.query(
    `SELECT id, amount_due, covered_amount, status, due_date
     FROM credit_installments
     WHERE company_id = $1 AND customer_id = $2
       AND status IN ('pending', 'overdue')
     ORDER BY due_date ASC
     FOR UPDATE`,
    [companyId, customerId]
  );

  for (const inst of installments) {
    if (toAllocate <= 0.005) break;
    const currentCovered = parseFloat(inst.covered_amount);
    const amountDue      = parseFloat(inst.amount_due);
    const uncovered      = amountDue - currentCovered;
    if (uncovered <= 0.005) continue;

    const coverNow   = Math.min(toAllocate, uncovered);
    const newCovered = Math.round((currentCovered + coverNow) * 100) / 100;
    const newStatus  = newCovered >= amountDue - 0.005 ? 'paid' : inst.status;

    await client.query(
      `UPDATE credit_installments
         SET covered_amount = $3,
             status         = $4,
             paid_at        = CASE WHEN $4 = 'paid' THEN NOW() ELSE paid_at END,
             updated_at     = NOW()
       WHERE id = $1 AND company_id = $2`,
      [inst.id, companyId, newCovered, newStatus]
    );

    coveredInstallments.push({ id: inst.id, covered: coverNow, status: newStatus });
    toAllocate = Math.round((toAllocate - coverNow) * 100) / 100;
  }

  // Recalcula score se alguma parcela foi paga
  if (coveredInstallments.some(c => c.status === 'paid')) {
    await _recalculateScore(client, companyId, customerId);
  }
  await _updateCreditUsed(client, companyId, customerId);

  const { rows: balRows } = await client.query(
    `SELECT balance FROM customer_credit_balances
     WHERE customer_id = $1 AND company_id = $2`,
    [customerId, companyId]
  );

  return {
    new_balance:          parseFloat(balRows[0]?.balance || 0),
    settled_receivables:  settledReceivables,
    covered_installments: coveredInstallments,
    transaction:          txRow,
    legacy_amount:        remaining > 0.005 ? parseFloat(remaining.toFixed(2)) : 0,
  };
}

/**
 * cancelCreditSale — reverte todas as gravacoes de uma venda crediario.
 * Chamar DENTRO de uma transacao principal (client ja em BEGIN).
 */
async function cancelCreditSale(client, { companyId, saleId }) {
  // Busca customer_id da venda para atualizar credit_used
  const { rows: saleRows } = await client.query(
    `SELECT customer_id FROM sales WHERE id = $1 AND company_id = $2`,
    [saleId, companyId]
  );
  const customerId = saleRows[0]?.customer_id;

  // 1. Remove debit do ledger
  await client.query(
    `DELETE FROM customer_credit_transactions
     WHERE sale_id = $1 AND company_id = $2 AND type = 'debit'`,
    [saleId, companyId]
  );

  // 2. Remove A Receber do Financeiro (principal + splits parciais)
  await client.query(
    `DELETE FROM transactions
     WHERE idempotency_key = $1 AND company_id = $2`,
    ['pdv-credit-receivable-' + saleId, companyId]
  );
  await client.query(
    `DELETE FROM transactions
     WHERE company_id = $1
       AND idempotency_key LIKE $2
       AND status = 'pending'`,
    [companyId, 'pdv-credit-receivable-' + saleId + '-%']
  );

  // 3. Cancela credit_installments da venda
  await client.query(
    `UPDATE credit_installments
       SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
     WHERE sale_id = $1 AND company_id = $2
       AND status IN ('pending', 'overdue')`,
    [saleId, companyId]
  );

  // 4. Atualiza credit_used
  if (customerId) {
    await _updateCreditUsed(client, companyId, customerId);
  }

  return { ok: true };
}

/**
 * getCustomerCreditPreview — preview para PDV (pool direto, sem transacao).
 */
async function getCustomerCreditPreview(companyId, customerId) {
  const today = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;
  try {
    const [balRes, profileRes, instRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(balance, 0) AS balance
         FROM customer_credit_balances
         WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      ),
      pool.query(
        `SELECT credit_score, credit_limit, credit_used, status, blocked_reason
         FROM customer_credit_profiles
         WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT COUNT(*) AS open_count,
                MIN(due_date) AS next_due_date,
                COUNT(*) FILTER (WHERE due_date < ${today}) AS overdue_count
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')`,
        [companyId, customerId]
      ),
    ]);

    const balance    = parseFloat(balRes.rows[0]?.balance || 0);
    const profile    = profileRes.rows[0] || {};
    const inst       = instRes.rows[0] || {};
    const score      = parseInt(profile.credit_score) || 500;
    const limit      = parseFloat(profile.credit_limit) || 0;
    const over_limit = limit > 0 && balance >= limit;

    return {
      balance,
      open_installments_count: parseInt(inst.open_count) || 0,
      overdue_count:           parseInt(inst.overdue_count) || 0,
      next_due_date:           inst.next_due_date || null,
      score,
      score_label:             scoreLabel(score),
      credit_limit:            limit,
      credit_used:             parseFloat(profile.credit_used) || balance,
      over_limit,
      status:                  profile.status || 'active',
      blocked_reason:          profile.blocked_reason || null,
    };
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      return {
        balance: 0, open_installments_count: 0, overdue_count: 0,
        next_due_date: null, score: 500, score_label: 'regular',
        credit_limit: 0, credit_used: 0, over_limit: false,
        status: 'active', blocked_reason: null,
      };
    }
    throw err;
  }
}

module.exports = {
  createCreditSale,
  applyPayment,
  cancelCreditSale,
  getCustomerCreditPreview,
  // helpers exportados para compatibilidade interna
  _recalculateScore,
  _updateCreditUsed,
  _getOrCreateProfile,
  _getOrCreatePlanConfig,
};
