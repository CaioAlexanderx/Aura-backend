// ============================================================
// AURA. -- Crediario: UNIFICACAO de carne (Item 3, 13/06/2026)
//
// GET  /customers/:cid/accounts/:accountId/unify/preview
//   Preview sem lock: retorna o plano calculado pelo motor puro.
//   Query: amount, installments, first_due_date, period_unit?, period_count?
//
// POST /customers/:cid/accounts/:accountId/unify
//   Aplica a unificacao em transacao atomica.
//   Body: { amount, installments, first_due_date, sale_id?, period_unit?, period_count? }
//
// :accountId === 'general' => account_id IS NULL (carne Conta Geral).
//
// Montado em private.js sob /credit (requireAuth + requireCompanyAccess +
// requirePlan('negocio','expansao') ja aplicados a montante).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const creditLedger = require('../services/creditLedger');

// Helper copiado de creditRefund.js (padrao canonico de checagem do modulo).
async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) { const e = new Error('Empresa nao encontrada'); e.status = 404; throw e; }
  if (rows[0].enabled !== 'true') {
    const e = new Error(
      'Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.'
    );
    e.status = 403;
    e.code   = 'CREDIARIO_DISABLED';
    throw e;
  }
}

// Resolve accountId: 'general' (string) => null (carne Conta Geral).
function resolveAccountId(raw) {
  if (!raw || raw === 'general') return null;
  return raw;
}

// Carrega juros/periodo do carne (terms_snapshot) e da empresa (credit_plan_configs),
// priorizando o carne. Retorna { interestRate, periodUnit, periodCount }.
async function resolveUnifyTerms(companyId, accountId) {
  let accountTerms = null;
  if (accountId) {
    try {
      const { rows } = await db.query(
        `SELECT terms_snapshot FROM credit_accounts WHERE id = $1 AND company_id = $2`,
        [accountId, companyId]
      );
      accountTerms = rows[0]?.terms_snapshot || null;
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }
  }

  let config = null;
  try {
    const { rows } = await db.query(
      `SELECT interest_rate, period_unit, period_count, max_installments
       FROM credit_plan_configs WHERE company_id = $1`,
      [companyId]
    );
    config = rows[0] || null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }

  return {
    interestRate: parseFloat(accountTerms?.interest_rate ?? config?.interest_rate ?? 0) || 0,
    periodUnit:   accountTerms?.period_unit   || config?.period_unit   || 'month',
    periodCount:  parseInt(accountTerms?.period_count  || config?.period_count  || 1),
  };
}

// Carrega parcelas abertas do carne SEM lock (para preview).
async function loadOpenInstallments(companyId, customerId, accountId) {
  try {
    if (accountId) {
      const { rows } = await db.query(
        `SELECT id, amount_due, covered_amount
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND account_id = $3
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC`,
        [companyId, customerId, accountId]
      );
      return rows;
    } else {
      const { rows } = await db.query(
        `SELECT id, amount_due, covered_amount
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND account_id IS NULL
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC`,
        [companyId, customerId]
      );
      return rows;
    }
  } catch (err) {
    if (err.code === '42703') {
      const { rows } = await db.query(
        `SELECT id, amount_due, covered_amount
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2
           AND status IN ('pending', 'overdue')
         ORDER BY due_date ASC`,
        [companyId, customerId]
      );
      return rows;
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// GET /customers/:cid/accounts/:accountId/unify/preview
// ---------------------------------------------------------------
router.get('/customers/:cid/accounts/:accountId/unify/preview', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const accountId  = resolveAccountId(req.params.accountId);

  const amount      = parseFloat(req.query.amount);
  const installments = parseInt(req.query.installments, 10);
  const firstDueDate = req.query.first_due_date || null;
  const periodUnit   = req.query.period_unit   || null;
  const periodCount  = req.query.period_count  ? parseInt(req.query.period_count, 10) : null;

  if (isNaN(amount) || amount < 0) {
    return res.status(400).json({ error: 'amount invalido (deve ser >= 0)' });
  }
  if (isNaN(installments) || installments < 1) {
    return res.status(400).json({ error: 'installments invalido (deve ser >= 1)' });
  }

  // Valida que o cliente pertence a empresa.
  try {
    const { rows } = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
  } catch (err) {
    console.error('[creditUnify] preview customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    const terms = await resolveUnifyTerms(companyId, accountId);
    const openInstallments = await loadOpenInstallments(companyId, customerId, accountId);

    const plan = creditLedger.computeUnifyPlan({
      openInstallments,
      newAmount:    amount,
      installments,
      interestRate: terms.interestRate,
      firstDueDate,
      periodUnit:   periodUnit  || terms.periodUnit,
      periodCount:  periodCount || terms.periodCount,
    });

    return res.status(200).json(plan);
  } catch (err) {
    console.error('[creditUnify] preview error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao calcular preview de unificacao' });
  }
});

// ---------------------------------------------------------------
// POST /customers/:cid/accounts/:accountId/unify
// ---------------------------------------------------------------
router.post('/customers/:cid/accounts/:accountId/unify', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const accountId  = resolveAccountId(req.params.accountId);

  const amount      = parseFloat(req.body?.amount);
  const installments = parseInt(req.body?.installments, 10);
  const firstDueDate = req.body?.first_due_date || null;
  const saleId      = req.body?.sale_id       || null;
  const periodUnit  = req.body?.period_unit   || null;
  const periodCount = req.body?.period_count  ? parseInt(req.body.period_count, 10) : null;

  if (isNaN(amount) || amount < 0) {
    return res.status(400).json({ error: 'amount invalido (deve ser >= 0)' });
  }
  if (isNaN(installments) || installments < 1) {
    return res.status(400).json({ error: 'installments invalido (deve ser >= 1)' });
  }

  // Valida que o cliente pertence a empresa.
  try {
    const { rows } = await db.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });
  } catch (err) {
    console.error('[creditUnify] apply customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  // Checa se o modulo esta habilitado.
  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  const terms = await resolveUnifyTerms(companyId, accountId).catch(() => ({
    interestRate: 0, periodUnit: 'month', periodCount: 1,
  }));

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const result = await creditLedger.applyUnify(client, {
      companyId,
      customerId,
      accountId,
      newAmount:    amount,
      installments,
      firstDueDate,
      periodUnit:   periodUnit  || terms.periodUnit,
      periodCount:  periodCount || terms.periodCount,
      interestRate: terms.interestRate,
      saleId,
    });

    await client.query('COMMIT');
    return res.status(200).json(result);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[creditUnify] apply error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao unificar carne' });
  } finally {
    client.release();
  }
});

module.exports = router;
