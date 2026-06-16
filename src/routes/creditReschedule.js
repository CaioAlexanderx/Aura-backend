// ============================================================
// AURA. -- Crediario: RENEGOCIACAO de parcelas (Item 2, 16/06/2026)
//
// GET  /customers/:cid/accounts/:accountId/reschedule/preview
//   Preview sem lock: cronograma + delta de saldo calculados pelo motor puro.
//   Query: total?, installments, first_due_date?, period_unit?, period_count?
//   (total omitido => usa o saldo aberto atual = renegociacao sem mudar total)
//
// POST /customers/:cid/accounts/:accountId/reschedule
//   Aplica em transacao atomica. Body: { total?, installments, first_due_date?,
//   period_unit?, period_count? }
//
// :accountId === 'general' => account_id IS NULL (carne Conta Geral).
//
// Montado em private.js sob /credit (requireAuth + requireCompanyAccess +
// requirePlan('negocio','expansao') ja aplicados a montante).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { computeReschedulePlan, applyReschedule, loadOpenInstallments, sumRemaining } = require('../services/credit/reschedule');

// Helper canonico (mesmo de creditUnify.js/creditRefund.js).
async function assertCrediarioEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) { const e = new Error('Empresa nao encontrada'); e.status = 404; throw e; }
  if (rows[0].enabled !== 'true') {
    const e = new Error('Modulo de crediario nao esta habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.');
    e.status = 403; e.code = 'CREDIARIO_DISABLED'; throw e;
  }
}

// 'general' (ou vazio) => null (carne Conta Geral).
function resolveAccountId(raw) {
  if (!raw || raw === 'general') return null;
  return raw;
}

// Periodicidade do carne (terms_snapshot) ou da empresa (credit_plan_configs).
// A renegociacao NAO adiciona juros (o total e explicito), entao so o periodo importa.
async function resolveReschedulePeriod(companyId, accountId) {
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
      `SELECT period_unit, period_count FROM credit_plan_configs WHERE company_id = $1`,
      [companyId]
    );
    config = rows[0] || null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  return {
    periodUnit:  accountTerms?.period_unit  || config?.period_unit  || 'month',
    periodCount: parseInt(accountTerms?.period_count || config?.period_count || 1),
  };
}

async function ensureCustomer(companyId, customerId) {
  const { rows } = await db.query(
    `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
    [customerId, companyId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------
// GET .../reschedule/preview
// ---------------------------------------------------------------
router.get('/customers/:cid/accounts/:accountId/reschedule/preview', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const accountId  = resolveAccountId(req.params.accountId);

  const installments = parseInt(req.query.installments, 10);
  const hasTotal     = req.query.total != null && req.query.total !== '';
  const total        = hasTotal ? parseFloat(req.query.total) : null;
  const firstDueDate = req.query.first_due_date || null;
  const periodUnit   = req.query.period_unit  || null;
  const periodCount  = req.query.period_count ? parseInt(req.query.period_count, 10) : null;

  if (isNaN(installments) || installments < 1) {
    return res.status(400).json({ error: 'installments invalido (deve ser >= 1)' });
  }
  if (hasTotal && (isNaN(total) || total < 0)) {
    return res.status(400).json({ error: 'total invalido (deve ser >= 0)' });
  }

  try {
    if (!(await ensureCustomer(companyId, customerId))) {
      return res.status(404).json({ error: 'Cliente nao encontrado' });
    }
  } catch (err) {
    console.error('[creditReschedule] preview customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    const period   = await resolveReschedulePeriod(companyId, accountId);
    const openRows = await loadOpenInstallments(db, companyId, customerId, accountId, false);
    const plan = computeReschedulePlan({
      openRemaining: sumRemaining(openRows),
      total,
      installments,
      firstDueDate,
      periodUnit:  periodUnit  || period.periodUnit,
      periodCount: periodCount || period.periodCount,
    });
    return res.status(200).json({ ...plan, open_installments_count: openRows.length });
  } catch (err) {
    console.error('[creditReschedule] preview error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao calcular preview da renegociacao' });
  }
});

// ---------------------------------------------------------------
// POST .../reschedule
// ---------------------------------------------------------------
router.post('/customers/:cid/accounts/:accountId/reschedule', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const accountId  = resolveAccountId(req.params.accountId);

  const installments = parseInt(req.body?.installments, 10);
  const hasTotal     = req.body?.total != null && req.body?.total !== '';
  const total        = hasTotal ? parseFloat(req.body.total) : null;
  const firstDueDate = req.body?.first_due_date || null;
  const periodUnit   = req.body?.period_unit  || null;
  const periodCount  = req.body?.period_count ? parseInt(req.body.period_count, 10) : null;

  if (isNaN(installments) || installments < 1) {
    return res.status(400).json({ error: 'installments invalido (deve ser >= 1)' });
  }
  if (hasTotal && (isNaN(total) || total < 0)) {
    return res.status(400).json({ error: 'total invalido (deve ser >= 0)' });
  }

  try {
    if (!(await ensureCustomer(companyId, customerId))) {
      return res.status(404).json({ error: 'Cliente nao encontrado' });
    }
  } catch (err) {
    console.error('[creditReschedule] apply customer check:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao verificar cliente' });
  }

  try {
    await assertCrediarioEnabled(companyId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }

  const period = await resolveReschedulePeriod(companyId, accountId).catch(() => ({
    periodUnit: 'month', periodCount: 1,
  }));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await applyReschedule(client, {
      companyId,
      customerId,
      accountId,
      total,
      installments,
      firstDueDate,
      periodUnit:  periodUnit  || period.periodUnit,
      periodCount: periodCount || period.periodCount,
      createdBy:   req.user?.id || null,
    });
    await client.query('COMMIT');
    return res.status(200).json(result);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[creditReschedule] apply error:', err.code, err.message);
    return res.status(500).json({ error: 'Erro ao renegociar parcelas' });
  } finally {
    client.release();
  }
});

module.exports = router;
