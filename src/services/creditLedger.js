// =============================================================
// AURA. -- Servico unificado de credito (Ledger)
// Fonte unica da verdade para todas as operacoes de crediario.
//
// Funcoes recebem um `client` pg (ja em BEGIN) para composicao
// atomica. getCustomerCreditPreview usa pool diretamente.
//
// API publica:
//   createCreditSale(client, opts)  -> { debited, schedule[], warnings[] }
//   applyPayment(client, opts)      -> { new_balance, settled_receivables[], covered_installments[], transaction }
//   cancelCreditSale(client, opts)  -> { ok }
//   getCustomerCreditPreview(companyId, customerId) -> preview
//   resolveTerms(profile, config)   -> termos efetivos (F2)
//   scoreLabel(score)               -> string (exportado p/ reuso em rotas)
//   scoreWarning(score, config)     -> aviso nao-impeditivo (Hub F1.4)
//
// REGRA DE NEGOCIO (imutavel): score baixo NUNCA bloqueia a venda.
// Score so gera AVISO ao lojista. O UNICO impeditivo e o bloqueio
// MANUAL do cliente (profile.status === 'blocked').
// =============================================================

const pool = require('../config/database');

const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";
const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

// Expr SQL p/ backdate: converte o param (YYYY-MM-DD) num timestamptz ao
// meio-dia em America/Sao_Paulo. Se o param for NULL, cai em NOW().
const BACKDATE_TS = (p) =>
  `COALESCE((${p}::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW())`;

// ─── periodicidade de pagamento ───────────────────────────────
function resolvePeriod(unit, count, config) {
  let u = unit || config?.period_unit || 'month';
  if (!['day', 'week', 'month'].includes(u)) u = 'month';
  let c = parseInt(count != null ? count : (config?.period_count != null ? config.period_count : 1), 10);
  if (!Number.isFinite(c) || c < 1 || c > 365) c = 1;
  return { unit: u, count: c };
}

function dueDateForIndex(firstDueStr, unit, count, idx) {
  const d = new Date(firstDueStr);
  const step = (parseInt(count, 10) || 1) * idx;
  if (unit === 'week') d.setDate(d.getDate() + 7 * step);
  else if (unit === 'day') d.setDate(d.getDate() + step);
  else d.setMonth(d.getMonth() + step);
  return d.toISOString().split('T')[0];
}

// ─── F2: resolveTerms ─────────────────────────────────────────
// Retorna termos efetivos com precedencia:
//   override do cliente (term_*) ?? config da loja ?? default hardcoded
// Juros e sempre opt-in: null/0 = sem juros.
function resolveTerms(profile, config) {
  const defaults = {
    interest_rate:       0,
    max_installments:    12,
    period_unit:         'month',
    period_count:        1,
    due_day:             null,
    late_fee_rate:       0,
    late_interest_daily: 0,
  };

  const effective = {
    interest_rate:       profile?.term_interest_rate       ?? config?.interest_rate       ?? defaults.interest_rate,
    max_installments:    profile?.term_max_installments    ?? config?.max_installments    ?? defaults.max_installments,
    period_unit:         profile?.term_period_unit         ?? config?.period_unit         ?? defaults.period_unit,
    period_count:        profile?.term_period_count        ?? config?.period_count        ?? defaults.period_count,
    due_day:             profile?.term_due_day             ?? config?.due_day             ?? defaults.due_day,
    late_fee_rate:       profile?.term_late_fee_rate       ?? config?.late_fee_rate       ?? defaults.late_fee_rate,
    late_interest_daily: profile?.term_late_interest_daily ?? config?.late_interest_daily ?? defaults.late_interest_daily,
  };

  // Normaliza tipos
  effective.interest_rate       = parseFloat(effective.interest_rate)       || 0;
  effective.max_installments    = parseInt(effective.max_installments)       || 12;
  effective.period_count        = parseInt(effective.period_count)           || 1;
  effective.late_fee_rate       = parseFloat(effective.late_fee_rate)        || 0;
  effective.late_interest_daily = parseFloat(effective.late_interest_daily)  || 0;
  if (!['day', 'week', 'month'].includes(effective.period_unit)) effective.period_unit = 'month';

  const overrides = {
    interest_rate:       profile?.term_interest_rate       ?? null,
    max_installments:    profile?.term_max_installments    ?? null,
    period_unit:         profile?.term_period_unit         ?? null,
    period_count:        profile?.term_period_count        ?? null,
    due_day:             profile?.term_due_day             ?? null,
    late_fee_rate:       profile?.term_late_fee_rate       ?? null,
    late_interest_daily: profile?.term_late_interest_daily ?? null,
  };

  return { effective, overrides };
}

// ─── helpers internos ─────────────────────────────────────────

function buildPixLink(id) {
  const short = id.replace(/-/g, '').slice(0, 12);
  return `https://pagar.getaura.com.br/parcela/${short}`;
}

// Exportado para reuso nas rotas (GET /customers/:cid/profile, preview PDV).
function scoreLabel(score) {
  if (score >= 800) return 'premium';
  if (score >= 650) return 'bom';
  if (score >= 450) return 'regular';
  if (score >= 300) return 'restrito';
  return 'bloqueado';
}

// ─── Hub F1.4: scoreWarning ───────────────────────────────────
// Aviso NAO-impeditivo. Retorna objeto se o score do cliente esta abaixo
// do limiar configurado em credit_plan_configs.score_warn_min; senao null.
// score_warn_min null/0 = sem aviso. Defensivo: config pode nao ter o campo
// (deploy parcial / 42703 tratado a montante => config sem a coluna).
//
// IMPORTANTE: este helper SO gera aviso. NUNCA bloqueia uma venda/parcela.
// O unico impeditivo do crediario e o bloqueio MANUAL (status === 'blocked').
function scoreWarning(score, config) {
  const min = parseInt(config?.score_warn_min, 10) || 0;
  const s   = parseInt(score, 10);
  if (min > 0 && Number.isFinite(s) && s < min) {
    return { below_min: true, threshold: min, actual: s };
  }
  return null;
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
 *           firstDueDate?, interestRate?, productNames?, createdBy?,
 *           periodUnit?, periodCount?, accountId? }} opts
 *   accountId (F3): vincula ao carne especifico. NULL = Conta geral.
 * @returns {{ debited: row, schedule: [], warnings: [] }}
 *
 * REGRA: bloqueio MANUAL (status === 'blocked') e o UNICO impeditivo —
 * lanca Error com .statusCode=422 / .code='CUSTOMER_BLOCKED' p/ o chamador
 * traduzir. Score baixo NUNCA bloqueia: vira apenas warnings[] no retorno.
 */
async function createCreditSale(client, {
  companyId, customerId, saleId, amount,
  installments = 1, firstDueDate = null,
  interestRate = 0, productNames = [], createdBy = null,
  periodUnit = null, periodCount = null,
  accountId = null,
}) {
  // 0. Bloqueio manual (UNICO impeditivo) + aviso de score (NAO-impeditivo).
  //    Carrega profile/config de forma defensiva (tabela/coluna podem faltar
  //    em deploy parcial — nesse caso seguimos sem bloqueio nem aviso).
  let _profile = null;
  let _config  = null;
  try {
    _profile = await _getOrCreateProfile(client, companyId, customerId);
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  if (_profile?.status === 'blocked') {
    const err = new Error(
      `Cliente com credito bloqueado. Motivo: ${_profile.blocked_reason || 'Bloqueio manual'}.`
    );
    err.statusCode = 422;
    err.code       = 'CUSTOMER_BLOCKED';
    err.reason     = _profile.blocked_reason || 'Bloqueio manual';
    throw err;
  }
  try {
    _config = await _getOrCreatePlanConfig(client, companyId);
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  const _warn = scoreWarning(parseInt(_profile?.credit_score, 10) || 500, _config);
  // Score NUNCA bloqueia: apenas anexa aviso ao retorno de sucesso.
  const warnings = _warn
    ? [{ code: 'SCORE_BELOW_MIN', threshold: _warn.threshold, actual: _warn.actual }]
    : [];

  // 1. Ledger: debit (com account_id defensivo)
  let debitRows;
  try {
    const r = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, notes, created_by, account_id)
       VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7)
       RETURNING *`,
      [
        companyId, customerId, saleId, amount,
        `Venda no crediario (${productNames.slice(0, 2).join(', ') || 'Venda'})`,
        createdBy, accountId,
      ]
    );
    debitRows = r.rows;
  } catch (err) {
    if (err.code === '42703') {
      // account_id ainda nao existe (deploy parcial) -- fallback sem coluna
      const r = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, sale_id, type, amount, notes, created_by)
         VALUES ($1, $2, $3, 'debit', $4, $5, $6)
         RETURNING *`,
        [companyId, customerId, saleId, amount,
          `Venda no crediario (${productNames.slice(0, 2).join(', ') || 'Venda'})`,
          createdBy]
      );
      debitRows = r.rows;
    } else throw err;
  }

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

    // F3: se accountId aponta para um carne com terms_snapshot, usar como defaults
    let accountTerms = null;
    if (accountId) {
      try {
        const { rows: accRows } = await client.query(
          `SELECT terms_snapshot FROM credit_accounts WHERE id = $1 AND company_id = $2`,
          [accountId, companyId]
        );
        accountTerms = accRows[0]?.terms_snapshot || null;
      } catch (e) {
        if (e.code !== '42P01' && e.code !== '42703') throw e;
      }
    }

    const maxN = parseInt(accountTerms?.max_installments || config?.max_installments) || 12;
    const effectiveRate = parseFloat(interestRate) > 0
      ? parseFloat(interestRate)
      : parseFloat(accountTerms?.interest_rate || config?.interest_rate) || 0;
    const n = Math.min(parseInt(installments), maxN, 36);
    const period = resolvePeriod(
      periodUnit || accountTerms?.period_unit,
      periodCount || accountTerms?.period_count,
      config
    );

    const due1 = firstDueDate || (() => {
      const d = new Date();
      d.setMonth(d.getMonth() + 1);
      return d.toISOString().split('T')[0];
    })();

    const totalWithInterest = effectiveRate > 0
      ? parseFloat((amount * (1 + effectiveRate * n)).toFixed(2))
      : amount;

    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    for (let i = 1; i <= n; i++) {
      const amt        = i === n ? baseAmount + remainder : baseAmount;
      const dueDateStr = dueDateForIndex(due1, period.unit, period.count, i - 1);

      let iid;
      try {
        const { rows: insRows } = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, pix_link, covered_amount, account_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending',
                   'https://pagar.getaura.com.br/parcela/tmp', 0, $8)
           RETURNING id`,
          [companyId, saleId, customerId, i, n, amt, dueDateStr, accountId]
        );
        iid = insRows[0].id;
      } catch (err) {
        if (err.code === '42703') {
          const { rows: insRows } = await client.query(
            `INSERT INTO credit_installments
               (company_id, sale_id, customer_id, installment_number, total_installments,
                amount_due, due_date, status, pix_link, covered_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending',
                     'https://pagar.getaura.com.br/parcela/tmp', 0)
             RETURNING id`,
            [companyId, saleId, customerId, i, n, amt, dueDateStr]
          );
          iid = insRows[0].id;
        } else throw err;
      }
      await client.query(
        `UPDATE credit_installments SET pix_link = $2 WHERE id = $1`,
        [iid, buildPixLink(iid)]
      );
      schedule.push({ id: iid, installment_number: i, amount_due: amt, due_date: dueDateStr });
    }

    try {
      await client.query(
        `UPDATE sales
           SET is_installment = true, total_installments = $2,
               credit_plan_snapshot = $3
         WHERE id = $1 AND company_id = $4`,
        [saleId, n,
         JSON.stringify({ installments: n, total_amount: amount, interest_rate: effectiveRate,
                          period_unit: period.unit, period_count: period.count }),
         companyId]
      );
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    await _updateCreditUsed(client, companyId, customerId);
  }

  return { debited: debitRows[0], schedule, warnings };
}

/**
 * applyPayment — registra recebimento (valor livre) e liquida FIFO.
 * Chamar DENTRO de uma transacao (client ja em BEGIN).
 *
 * @param {pg.PoolClient} client
 * @param {{ companyId, customerId, amount, method?, sessaoId?,
 *           createdBy?, idempotencyKey?, paidAt?,
 *           accountId? }} opts
 *   accountId (F3): quando fornecido, FIFO escopo ao carne.
 *                   NULL/undefined = comportamento atual (FIFO global).
 * @returns {{ new_balance, settled_receivables[], covered_installments[], transaction, legacy_amount }}
 */
async function applyPayment(client, {
  companyId, customerId, amount, method = null,
  sessaoId = null, createdBy = null, idempotencyKey = null,
  paidAt = null,
  accountId = null,
}) {
  // 1. Ledger: payment
  let txRow;
  if (idempotencyKey) {
    let r;
    try {
      r = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, type, amount, payment_method, created_by, idempotency_key, created_at, account_id)
         VALUES ($1, $2, 'payment', $3, $4, $5, $6, ${BACKDATE_TS('$7')}, $8)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [companyId, customerId, amount, method, createdBy, idempotencyKey, paidAt, accountId]
      );
    } catch (err) {
      if (err.code === '42703') {
        r = await client.query(
          `INSERT INTO customer_credit_transactions
             (company_id, customer_id, type, amount, payment_method, created_by, idempotency_key, created_at)
           VALUES ($1, $2, 'payment', $3, $4, $5, $6, ${BACKDATE_TS('$7')})
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING *`,
          [companyId, customerId, amount, method, createdBy, idempotencyKey, paidAt]
        );
      } else throw err;
    }
    if (!r.rows.length) {
      const { rows: ex } = await client.query(
        `SELECT * FROM customer_credit_transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      txRow = ex[0];
    } else {
      txRow = r.rows[0];
    }
  } else {
    let r;
    try {
      r = await client.query(
        `INSERT INTO customer_credit_transactions
           (company_id, customer_id, type, amount, payment_method, created_by, created_at, account_id)
         VALUES ($1, $2, 'payment', $3, $4, $5, ${BACKDATE_TS('$6')}, $7)
         RETURNING *`,
        [companyId, customerId, amount, method, createdBy, paidAt, accountId]
      );
    } catch (err) {
      if (err.code === '42703') {
        r = await client.query(
          `INSERT INTO customer_credit_transactions
             (company_id, customer_id, type, amount, payment_method, created_by, created_at)
           VALUES ($1, $2, 'payment', $3, $4, $5, ${BACKDATE_TS('$6')})
           RETURNING *`,
          [companyId, customerId, amount, method, createdBy, paidAt]
        );
      } else throw err;
    }
    txRow = r.rows[0];
  }

  // 2. FIFO liquidacao das transactions 'A Receber' pendentes
  // Se accountId fornecido: filtra por carne via JOIN com customer_credit_transactions
  const fifoMethod = (method || 'dinheiro').toLowerCase();
  const settledReceivables = [];
  let remaining = amount;

  // Para FIFO escopo por carne, precisamos do sale_id das transacoes do carne
  // O filtro de carne e feito via account_id na customer_credit_transactions (debit)
  let pendingTxsQuery;
  let pendingTxsParams;
  if (accountId) {
    pendingTxsQuery = `
      SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
      FROM transactions t
      JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
      JOIN customer_credit_transactions cct
        ON cct.sale_id = s.id AND cct.company_id = $1
        AND cct.type = 'debit' AND cct.account_id = $3
      WHERE t.company_id = $1
        AND t.category ILIKE 'Crediario%A Receber%'
        AND t.status = 'pending'
        AND s.customer_id = $2
        AND COALESCE(s.status, 'active') != 'cancelled'
      ORDER BY t.created_at ASC
      LIMIT 100`;
    pendingTxsParams = [companyId, customerId, accountId];
  } else {
    pendingTxsQuery = `
      SELECT t.id, t.amount, t.idempotency_key, s.id AS sale_id
      FROM transactions t
      JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
      WHERE t.company_id = $1
        AND t.category ILIKE 'Crediario%A Receber%'
        AND t.status = 'pending'
        AND s.customer_id = $2
        AND COALESCE(s.status, 'active') != 'cancelled'
      ORDER BY t.created_at ASC
      LIMIT 100`;
    pendingTxsParams = [companyId, customerId];
  }

  let pendingTxs;
  try {
    const r = await client.query(pendingTxsQuery, pendingTxsParams);
    pendingTxs = r.rows;
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      // fallback: FIFO global sem filtro de carne
      const r = await client.query(
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
      pendingTxs = r.rows;
    } else throw err;
  }

  for (const pt of pendingTxs) {
    if (remaining <= 0.005) break;
    const ptAmount = parseFloat(pt.amount);

    if (ptAmount <= remaining + 0.005) {
      await client.query(
        `UPDATE transactions
           SET status = 'confirmed', paid_at = ${BACKDATE_TS('$3')}, payment_method = $1,
               category = 'Crediario - Recebido', updated_at = NOW()
         WHERE id = $2`,
        [fifoMethod, pt.id, paidAt]
      );
      await client.query(
        `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at)
         VALUES ($1, $2, $3, $4, $5, ${BACKDATE_TS('$6')}) ON CONFLICT DO NOTHING`,
        [pt.sale_id, companyId, fifoMethod, ptAmount, sessaoId, paidAt]
      );
      settledReceivables.push({ id: pt.id, sale_id: pt.sale_id, amount: ptAmount, partial: false });
      remaining = parseFloat((remaining - ptAmount).toFixed(2));
    } else {
      const paidNow = parseFloat(remaining.toFixed(2));
      const restAmt = parseFloat((ptAmount - paidNow).toFixed(2));

      await client.query(
        `UPDATE transactions
           SET status = 'confirmed', paid_at = ${BACKDATE_TS('$4')}, payment_method = $1,
               amount = $2, category = 'Crediario - Recebido (parcial)', updated_at = NOW()
         WHERE id = $3`,
        [fifoMethod, paidNow, pt.id, paidAt]
      );
      await client.query(
        `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at)
         VALUES ($1, $2, $3, $4, $5, ${BACKDATE_TS('$6')}) ON CONFLICT DO NOTHING`,
        [pt.sale_id, companyId, fifoMethod, paidNow, sessaoId, paidAt]
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

  // Sobra: pagamento maior que A Receber pendentes
  if (remaining > 0.005) {
    await client.query(
      `INSERT INTO transactions
         (company_id, type, status, amount, description, category,
          due_date, paid_at, created_by, idempotency_key, payment_method)
       VALUES ($1, 'income', 'confirmed', $2, $3, 'Crediario - Recebido',
               COALESCE($7::date, ${SP_DATE_NOW}), ${BACKDATE_TS('$7')}, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        companyId,
        parseFloat(remaining.toFixed(2)),
        `Recebimento crediario - cliente ${customerId} (saldo legado)`,
        createdBy,
        'credit-payment-' + txRow.id + '-legacy',
        fifoMethod,
        paidAt,
      ]
    );
  }

  // 3. FIFO covered_amount nas credit_installments (escopo por carne se accountId)
  const coveredInstallments = [];
  let toAllocate = amount;

  let instQuery;
  let instParams;
  if (accountId) {
    instQuery = `
      SELECT id, amount_due, covered_amount, status, due_date
      FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2
        AND account_id = $3
        AND status IN ('pending', 'overdue')
      ORDER BY due_date ASC
      FOR UPDATE`;
    instParams = [companyId, customerId, accountId];
  } else {
    instQuery = `
      SELECT id, amount_due, covered_amount, status, due_date
      FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2
        AND status IN ('pending', 'overdue')
      ORDER BY due_date ASC
      FOR UPDATE`;
    instParams = [companyId, customerId];
  }

  let installments;
  try {
    const r = await client.query(instQuery, instParams);
    installments = r.rows;
  } catch (err) {
    if (err.code === '42703') {
      // account_id nao existe ainda: FIFO global
      const r = await client.query(
        `SELECT id, amount_due, covered_amount, status, due_date
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC
         FOR UPDATE`,
        [companyId, customerId]
      );
      installments = r.rows;
    } else throw err;
  }

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
             paid_at        = CASE WHEN $5 THEN ${BACKDATE_TS('$6')} ELSE paid_at END,
             updated_at     = NOW()
       WHERE id = $1 AND company_id = $2`,
      [inst.id, companyId, newCovered, newStatus, newStatus === 'paid', paidAt]
    );

    coveredInstallments.push({ id: inst.id, covered: coverNow, status: newStatus });
    toAllocate = Math.round((toAllocate - coverNow) * 100) / 100;
  }

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
 */
async function cancelCreditSale(client, { companyId, saleId }) {
  const { rows: saleRows } = await client.query(
    `SELECT customer_id FROM sales WHERE id = $1 AND company_id = $2`,
    [saleId, companyId]
  );
  const customerId = saleRows[0]?.customer_id;

  await client.query(
    `DELETE FROM customer_credit_transactions
     WHERE sale_id = $1 AND company_id = $2 AND type = 'debit'`,
    [saleId, companyId]
  );

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

  await client.query(
    `UPDATE credit_installments
       SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
     WHERE sale_id = $1 AND company_id = $2
       AND status IN ('pending', 'overdue')`,
    [saleId, companyId]
  );

  if (customerId) {
    await _updateCreditUsed(client, companyId, customerId);
  }

  return { ok: true };
}

/**
 * getCustomerCreditPreview — preview para PDV (pool direto).
 */
async function getCustomerCreditPreview(companyId, customerId) {
  const today = `(NOW() AT TIME ZONE 'America/Sao_Paulo')::date`;
  try {
    const [balRes, profileRes, instRes, configRes] = await Promise.all([
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
      pool.query(
        `SELECT score_warn_min FROM credit_plan_configs WHERE company_id = $1`,
        [companyId]
      ).catch(() => ({ rows: [] })),
    ]);

    const balance    = parseFloat(balRes.rows[0]?.balance || 0);
    const profile    = profileRes.rows[0] || {};
    const inst       = instRes.rows[0] || {};
    const config     = configRes.rows[0] || {};
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
      score_warning:           scoreWarning(score, config),
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
        score_warning: null,
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
  resolveTerms,
  scoreLabel,
  scoreWarning,
  // helpers exportados para compatibilidade interna
  _recalculateScore,
  _updateCreditUsed,
  _getOrCreateProfile,
  _getOrCreatePlanConfig,
  resolvePeriod,
  dueDateForIndex,
};
