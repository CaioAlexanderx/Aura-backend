// ============================================================
// AURA. — Middleware de autenticação e autorização
// SEC-02: Refresh token support
// FIX: role_label (real schema) instead of role
// FIX (24/06/2026): requireCompanyAccess roda em TODO request. Quando o socket
//   app<->banco caía (blip cross-region Railway/Supabase), o erro de conexão
//   virava 500 "Erro ao verificar acesso" e o app inteiro parecia offline
//   (Davi não conseguia abrir a Matriz). Agora a verificação usa db.queryRetry
//   (1 retry curto em erro transitório de conexão — SELECT idempotente) e, se
//   ainda assim falhar por conexão, responde 503 (transitório) em vez de 500.
//   Fallback p/ db.query quando queryRetry não existe (mocks de teste que
//   substituem o módulo database sem o helper) — chamado como MÉTODO de db p/
//   preservar o `this` do pool em produção.
// ============================================================
const jwt  = require('jsonwebtoken');
const db   = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');

const env        = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;

// SEC-02: Redis for token blacklist
let redis = null;
try { redis = require('../config/redis').default || require('../config/redis'); } catch (_) {}

// ── requireAuth ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // SEC-02: Reject refresh tokens used as access tokens
    if (decoded.type === 'refresh') {
      return res.status(401).json({ error: 'Use o access token, não o refresh token' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ── requireCompanyAccess ──────────────────────────────────
// FIX: schema uses role_label (not role) in company_members
function requireCompanyAccess(opts = {}) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    const companyId = req.params.id;
    if (!companyId) {
      return res.status(400).json({ error: 'company_id ausente na rota' });
    }
    if (req.user.role === 'admin') {
      req.companyRole = 'admin';
      return next();
    }
    try {
      // SELECT idempotente → seguro repetir em blip de conexão (db.queryRetry).
      // Fallback p/ db.query quando queryRetry não existe (ex.: mocks de teste
      // que substituem o módulo database sem o helper). Chamamos como MÉTODO de
      // db (db.queryRetry(...) / db.query(...)) p/ preservar o `this` do pool.
      const roleSql =
        `SELECT 'owner' AS role FROM companies WHERE id = $1 AND owner_id = $2
         UNION
         SELECT cm.role_label AS role FROM company_members cm
         WHERE cm.company_id = $1 AND cm.user_id = $2 AND cm.status = 'active' AND cm.is_active = true
         LIMIT 1`;
      const roleParams = [companyId, req.user.id];
      const { rows } = await (typeof db.queryRetry === 'function'
        ? db.queryRetry(roleSql, roleParams)
        : db.query(roleSql, roleParams));
      if (!rows.length) {
        return res.status(403).json({ error: 'Acesso negado a esta empresa' });
      }
      const role = rows[0].role;
      if (opts.roles && opts.roles.length > 0 && !opts.roles.includes(role)) {
        return res.status(403).json({ error: 'Permissão insuficiente', required_roles: opts.roles, your_role: role });
      }
      req.companyRole = role;
      next();
    } catch (err) {
      console.error('requireCompanyAccess error:', err);
      // Blip de conexão app<->banco: 503 transitório (não 500). O cliente pode
      // tentar de novo; não é erro de lógica nem permissão.
      if (db.isTransientConnError && db.isTransientConnError(err)) {
        return res.status(503).json({
          error: 'Instabilidade momentânea de conexão. Tente novamente.',
          code: 'DB_CONN_TRANSIENT',
        });
      }
      res.status(500).json({ error: 'Erro ao verificar acesso' });
    }
  };
}

// ── requireRole ───────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }
    next();
  };
}

// ── requirePlan ───────────────────────────────────────────
function requirePlan(...plans) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    if (!plans.includes(req.user.plan)) {
      return res.status(403).json({ error: 'Plano atual não inclui esta funcionalidade', required_plans: plans, current_plan: req.user.plan });
    }
    next();
  };
}

function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
    const features = req.user.features || [];
    if (!features.includes(feature)) {
      return res.status(403).json({ error: 'Funcionalidade não disponível', required_feature: feature });
    }
    next();
  };
}

module.exports = { requireAuth, requireCompanyAccess, requireRole, requirePlan, requireFeature };
