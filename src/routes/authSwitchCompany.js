// ============================================================
// AURA. — Auth Multi-CNPJ (M1-03 + M1-04)
// - POST /auth/switch-company: re-emite JWT com novo contexto
// - GET  /auth/companies: lista empresas do user (pra switcher)
// ============================================================
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { validateRuntimeEnv } = require('../config/env');
const { logAuditAction } = require('../middleware/auditLog');

const env = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const ACCESS_TTL = '15m';

function signAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, {
    expiresIn: ACCESS_TTL,
  });
}

// ──────────────────────────────────────────────────────────
// GET /auth/companies — lista empresas do user (M1-04)
// Resposta enxuta otimizada pra renderização do switcher.
// ──────────────────────────────────────────────────────────
router.get('/companies', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT
         c.id, c.trade_name, c.legal_name, c.cnpj,
         c.plan, c.is_primary, c.vertical_active, c.logo_url,
         c.billing_status, c.trial_ends_at,
         CASE
           WHEN c.owner_id = $1 THEN 'owner'
           ELSE COALESCE(cm.role_label, 'member')
         END AS role
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $1
        AND cm.status = 'active' AND cm.is_active = true
       WHERE (c.owner_id = $1 OR cm.user_id = $1)
         AND c.is_active = true
       ORDER BY c.is_primary DESC, c.created_at ASC`,
      [userId]
    );

    const currentCompanyId = req.user.company || null;
    const consolidated = !!req.user.consolidated_view;

    res.json({
      companies: rows.map((c) => ({
        id: c.id,
        name: c.trade_name || c.legal_name || '',
        legal_name: c.legal_name || '',
        trade_name: c.trade_name || '',
        cnpj: c.cnpj || '',
        plan: c.plan,
        is_primary: c.is_primary,
        vertical: c.vertical_active,
        logo_url: c.logo_url,
        billing_status: c.billing_status,
        trial_active:
          c.trial_ends_at && new Date(c.trial_ends_at) > new Date(),
        role: c.role,
        is_current: c.id === currentCompanyId,
      })),
      current_company_id: currentCompanyId,
      consolidated_view: consolidated,
      total: rows.length,
    });
  } catch (err) {
    console.error('[auth/companies] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao listar empresas' });
  }
});

// ──────────────────────────────────────────────────────────
// POST /auth/switch-company (M1-03)
// Body: { company_id }  ou  { company_id: 'all' }
// Retorna novo access token + dados da empresa atual.
// Refresh token NÃO é rotacionado (é do user, não da company).
// ──────────────────────────────────────────────────────────
router.post('/switch-company', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { company_id } = req.body || {};

  // ── Modo "Todas as empresas" (visualização agregada) ──
  if (company_id === null || company_id === 'all' || company_id === '*') {
    const { rows: companies } = await db.query(
      `SELECT c.id, c.plan
         FROM companies c
         LEFT JOIN company_members cm
           ON cm.company_id = c.id AND cm.user_id = $1
          AND cm.status = 'active' AND cm.is_active = true
        WHERE (c.owner_id = $1 OR cm.user_id = $1)
          AND c.is_active = true`,
      [userId]
    );

    if (companies.length < 2) {
      return res.status(400).json({
        error: 'CONSOLIDATED_NEEDS_MULTIPLE',
        message:
          'Modo "Todas as empresas" requer 2+ empresas. Você tem apenas ' +
          companies.length +
          '.',
      });
    }

    const PLAN_RANK = {
      essencial: 1,
      negocio: 2,
      expansao: 3,
      personalizado: 4,
    };
    const highestPlan = companies
      .map((c) => c.plan)
      .sort((a, b) => (PLAN_RANK[b] || 0) - (PLAN_RANK[a] || 0))[0];

    const tokenPayload = {
      id: userId,
      role: req.user.role,
      plan: highestPlan || 'essencial',
      company: null,
      is_staff: req.user.is_staff || false,
      consolidated_view: true,
    };
    const accessToken = signAccessToken(tokenPayload);

    try {
      await db.query(
        `INSERT INTO multicnpj_audit
           (user_id, action, source_company_id, target_company_id, metadata)
         VALUES ($1, 'switch_company', $2, NULL, $3::jsonb)`,
        [
          userId,
          req.user.company || null,
          JSON.stringify({
            mode: 'consolidated',
            companies_count: companies.length,
            highest_plan: highestPlan,
          }),
        ]
      );
    } catch (auditErr) {
      console.error(
        '[switchCompany] consolidated audit failed:',
        auditErr.message
      );
    }

    return res.json({
      token: accessToken,
      token_expires_in: ACCESS_TTL,
      current_company: null,
      consolidated_view: true,
      companies_count: companies.length,
      message: 'Modo "Todas as empresas" ativado.',
    });
  }

  // ── Modo empresa específica ──
  if (!company_id) {
    return res
      .status(400)
      .json({ error: 'company_id é obrigatório (ou use "all" para modo consolidado)' });
  }

  try {
    const { rows } = await db.query(
      `SELECT
         c.id, c.legal_name, c.trade_name, c.plan, c.cnpj,
         c.vertical_active, c.is_primary, c.module_overrides,
         c.billing_status, c.trial_ends_at, c.ai_enabled, c.ai_consent_at,
         c.logo_url, c.onboarding_step, c.access_code_used,
         CASE
           WHEN c.owner_id = $2 THEN 'owner'
           ELSE cm.role_label
         END AS role
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
       WHERE c.id = $1
         AND c.is_active = true
         AND (c.owner_id = $2 OR cm.user_id = $2)
       LIMIT 1`,
      [company_id, userId]
    );

    if (!rows.length) {
      return res.status(403).json({
        error: 'NO_ACCESS',
        message: 'Você não tem acesso a esta empresa.',
      });
    }

    const company = rows[0];

    const tokenPayload = {
      id: userId,
      role: req.user.role,
      plan: company.plan || 'essencial',
      company: company.id,
      is_staff: req.user.is_staff || false,
    };
    const accessToken = signAccessToken(tokenPayload);

    try {
      await db.query(
        `INSERT INTO multicnpj_audit
           (user_id, action, source_company_id, target_company_id, metadata)
         VALUES ($1, 'switch_company', $2, $3, $4::jsonb)`,
        [
          userId,
          req.user.company || null,
          company.id,
          JSON.stringify({
            previous_plan: req.user.plan,
            new_plan: company.plan,
            target_name: company.trade_name || company.legal_name,
          }),
        ]
      );
    } catch (auditErr) {
      console.error('[switchCompany] audit failed:', auditErr.message);
    }

    logAuditAction(
      userId,
      company.id,
      'switch_company',
      'User switched to company: ' + (company.trade_name || company.legal_name)
    );

    const trialActive =
      company.trial_ends_at && new Date(company.trial_ends_at) > new Date();

    return res.json({
      token: accessToken,
      token_expires_in: ACCESS_TTL,
      current_company: {
        id: company.id,
        name: company.trade_name || company.legal_name,
        legal_name: company.legal_name,
        trade_name: company.trade_name,
        cnpj: company.cnpj,
        plan: company.plan,
        vertical: company.vertical_active,
        is_primary: company.is_primary,
        module_overrides: company.module_overrides || {},
        billing_status: company.billing_status,
        trial_active: !!trialActive,
        trial_ends_at: company.trial_ends_at,
        ai_enabled: !!company.ai_enabled,
        ai_consent_at: company.ai_consent_at,
        access_code_used: !!company.access_code_used,
        logo_url: company.logo_url,
        onboarding_step: company.onboarding_step,
        member_role: company.role,
      },
      consolidated_view: false,
    });
  } catch (err) {
    console.error('[switchCompany] error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao trocar empresa' });
  }
});

module.exports = router;
