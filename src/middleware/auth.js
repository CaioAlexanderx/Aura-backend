const jwt  = require('jsonwebtoken');
const db   = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');

const env        = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;

// ── requireAuth ───────────────────────────────────────────────
// Valida JWT e popula req.user com o payload do token.
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ── requireCompanyAccess ──────────────────────────────────────
// Garante que o usuário autenticado pertence à empresa de :id.
//
// Verifica (em ordem):
//   1. companies.owner_id = req.user.id  (dono da empresa)
//   2. company_members WHERE company_id + user_id + active  (membro ativo)
//
// Se opts.roles fornecido, exige que o papel do usuário esteja na lista.
//
// Após validação, disponibiliza req.companyRole para as rotas.
//
// Uso:
//   router.get('/', requireAuth, requireCompanyAccess(), handler);
//   router.delete('/:mid', requireAuth, requireCompanyAccess({ roles: ['owner','admin'] }), handler);
function requireCompanyAccess(opts = {}) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const companyId = req.params.id;
    if (!companyId) {
      return res.status(400).json({ error: 'company_id ausente na rota' });
    }

    const userId = req.user.id;

    // Admins do sistema têm acesso irrestrito
    if (req.user.role === 'admin') {
      req.companyRole = 'admin';
      return next();
    }

    try {
      // Verifica ownership ou membership ativo em uma única query
      const { rows } = await db.query(
        `SELECT 'owner' AS role
         FROM companies
         WHERE id = $1 AND owner_id = $2
         UNION
         SELECT cm.role
         FROM company_members cm
         WHERE cm.company_id = $1
           AND cm.user_id    = $2
           AND cm.status     = 'active'
           AND cm.is_active  = true
         LIMIT 1`,
        [companyId, userId]
      );

      if (!rows.length) {
        return res.status(403).json({ error: 'Acesso negado a esta empresa' });
      }

      const role = rows[0].role;

      // Validação de papel específico se opts.roles informado
      if (opts.roles && opts.roles.length > 0 && !opts.roles.includes(role)) {
        return res.status(403).json({
          error: 'Permissão insuficiente',
          required_roles: opts.roles,
          your_role: role,
        });
      }

      req.companyRole = role;
      next();
    } catch (err) {
      console.error('requireCompanyAccess error:', err);
      res.status(500).json({ error: 'Erro ao verificar acesso' });
    }
  };
}

// ── requireRole ───────────────────────────────────────────────
// Verifica o papel (role) do JWT — opera sobre claims do token.
// Para verificação de acesso à empresa, use requireCompanyAccess.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }
    next();
  };
}

// ── requirePlan ───────────────────────────────────────────────
function requirePlan(...plans) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    if (!plans.includes(req.user.plan)) {
      return res.status(403).json({
        error: 'Plano atual não inclui esta funcionalidade',
        required_plans: plans,
        current_plan: req.user.plan,
      });
    }
    next();
  };
}

// ── requireFeature ────────────────────────────────────────────
function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const features = req.user.features || [];
    if (!features.includes(feature)) {
      return res.status(403).json({
        error: 'Funcionalidade não disponível no plano atual',
        required_feature: feature,
      });
    }
    next();
  };
}

module.exports = {
  requireAuth,
  requireCompanyAccess,
  requireRole,
  requirePlan,
  requireFeature,
};
