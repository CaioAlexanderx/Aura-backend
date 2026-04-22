// ============================================================
// AURA. — Admin: mudanca de plano de clientes
// PATCH /admin/clients/:cid/plan — altera companies.plan
//
// IMPORTANTE: isso muda SO os capabilities (modulos visiveis).
// NAO toca na assinatura Asaas — a cobranca precisa ser ajustada
// separadamente via Asaas ou deixada como esta pra manter
// grandfathering.
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const { getVisibleModules } = require('../services/modules');

const adminOnly = [requireAuth, requireRole('admin')];

const VALID_PLANS = ['essencial', 'negocio', 'expansao', 'personalizado'];

// PATCH /admin/clients/:cid/plan
router.patch('/clients/:cid/plan', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  const { plan } = req.body || {};

  if (!plan || !VALID_PLANS.includes(plan)) {
    throw new AppError(
      'Plano invalido. Use: ' + VALID_PLANS.join(', '),
      400
    );
  }

  // Checa empresa
  const { rows: existing } = await pool.query(
    `SELECT id, plan, trade_name, legal_name, module_overrides FROM companies WHERE id = $1`,
    [cid]
  );
  if (!existing.length) throw new AppError('Empresa nao encontrada', 404);

  const oldPlan = existing[0].plan || 'essencial';
  if (oldPlan === plan) {
    return res.json({
      message: 'Plano ja esta em ' + plan,
      company: existing[0],
      changed: false,
    });
  }

  // Atualiza plano
  const { rows } = await pool.query(
    `UPDATE companies
     SET plan = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, plan, module_overrides, trade_name, legal_name`,
    [plan, cid]
  );

  const company = rows[0];
  const visible = getVisibleModules(company.plan, company.module_overrides || {});

  // Log da mudanca pra auditoria (best-effort — se tabela nao existir, nao bloqueia)
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, action, target_company_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        req.user?.id || null,
        'plan_change',
        cid,
        JSON.stringify({ from: oldPlan, to: plan }),
      ]
    );
  } catch (err) {
    // Tabela pode nao existir em todos os ambientes — apenas loga
    console.warn('[admin/plan] audit log falhou:', err.message);
  }

  res.json({
    message: 'Plano alterado de ' + oldPlan + ' para ' + plan,
    company,
    visible_modules: visible,
    changed: true,
  });
}));

module.exports = router;
