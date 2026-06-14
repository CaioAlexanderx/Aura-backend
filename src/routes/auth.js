// ============================================================
// AURA. — Autenticacao
//
// PR35 (2026-04-28): /auth/login, /register e /me agora expoem
// ai_enabled e ai_consent_at no company. useAiAccess do frontend
// usa pra gating do painel IA (Modo Consulta + brief auto). Sem
// esses campos, IA nunca liberava mesmo com UPDATE no banco.
//
// MULTICNPJ Sessao 1 (2026-05-02): politica consolidated-default.
// Quando user tem 2+ empresas ativas, login/me/refresh emitem JWT
// com `company=null, consolidated_view=true`. Frontend renderiza
// painel consolidado por padrao. Telas que precisam de scope
// especifico (PDV/NF-e/Folha) usam <RequireCompanyScope /> que
// abre picker e dispara switchCompany() pra trocar o JWT.
//
// FIX 2026-05-03: resolveDefaultContext e companyCount agora usam
// query PERMISSIVE (`WHERE c.owner_id = $1 OR cm.user_id = $1`) em
// vez de JOIN strict em company_members. Caso edge: empresa criada
// via Multi-CNPJ podia nao ter entry em company_members, fazendo o
// resolveDefaultContext nao ver e o user cair em modo single-company
// com a primary em vez de consolidated. Agora robusto a essa falha
// estrutural (que tambem foi corrigida em userCompanies.js POST).
//
// feat/terms-acceptance (2026-05-14): /auth/register agora exige
// terms_accepted=true no body e persiste terms_accepted_at + terms_version
// na tabela users (migration 114). Qualquer cadastro sem aceite recebe 400.
// ============================================================
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');
const { sendSelfServeSignupNotification } = require('../services/mailer');

const env        = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const ACCESS_TTL  = '1h';
const REFRESH_TTL = '7d';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_PROD = env.NODE_ENV === 'production';

// MULTICNPJ: ranking de planos pra calcular plan efetivo no modo consolidado.
const PLAN_RANK = { essencial: 1, negocio: 2, expansao: 3, personalizado: 4 };

function signAccessToken(payload) {
  return jwt.sign({ ...payload, type: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}
function signRefreshToken(payload) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, type: 'refresh', jti }, JWT_SECRET, { expiresIn: REFRESH_TTL });
  return { token, jti };
}
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function setRefreshCookie(res, refreshToken) {
  res.cookie('aura_refresh', refreshToken, { httpOnly: true, secure: IS_PROD, sameSite: IS_PROD ? 'strict' : 'lax', maxAge: REFRESH_TTL_MS, path: '/api/v1/auth' });
}
function clearRefreshCookie(res) { res.clearCookie('aura_refresh', { path: '/api/v1/auth' }); }
async function storeRefreshToken(userId, refreshToken, req) {
  try { await db.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)', [userId, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), req.ip, (req.headers['user-agent'] || '').substring(0, 200)]); } catch (_) {}
}

async function resolveDefaultContext(userId, dbConn) {
  const conn = dbConn || db;
  const { rows } = await conn.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.legal_name, c.plan, c.onboarding_step,
            c.trial_ends_at, c.module_overrides, c.billing_status,
            c.access_code_used, c.vertical_active, c.ai_enabled, c.ai_consent_at,
            c.is_primary, c.created_at,
            CASE
              WHEN c.owner_id = $1 THEN 'owner'
              ELSE COALESCE(cm.role_label, 'member')
            END AS member_role
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, c.is_primary DESC NULLS LAST, c.created_at ASC`,
    [userId]
  );

  rows.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  if (rows.length === 0) {
    return { count: 0, primary: null, consolidated: false, effectivePlan: 'essencial' };
  }
  if (rows.length === 1) {
    return {
      count: 1,
      primary: rows[0],
      consolidated: false,
      effectivePlan: rows[0].plan || 'essencial',
    };
  }

  const maxPlan = rows.reduce((acc, c) => {
    const r = PLAN_RANK[c.plan] || 1;
    return r > acc.rank ? { plan: c.plan, rank: r } : acc;
  }, { plan: 'essencial', rank: 1 });

  return {
    count: rows.length,
    primary: rows[0],
    consolidated: true,
    effectivePlan: maxPlan.plan,
  };
}

function shapeCompany(company, fallbackMemberRole) {
  if (!company) return null;
  return {
    id: company.id,
    name: company.legal_name || company.name || company.trade_name,
    plan: company.plan,
    onboarding_step: company.onboarding_step,
    module_overrides: company.module_overrides || {},
    trial_active: !!(company.trial_ends_at && new Date(company.trial_ends_at) > new Date()),
    trial_ends_at: company.trial_ends_at,
    billing_status: company.billing_status || null,
    access_code_used: !!(company.access_code_used),
    vertical_active: company.vertical_active || null,
    ai_enabled: !!(company.ai_enabled),
    ai_consent_at: company.ai_consent_at || null,
    member_role: company.member_role || fallbackMemberRole || 'owner',
  };
}

// POST /api/v1/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, company_name, phone, cnpj, access_code, terms_accepted, terms_version, self_serve } = req.body;
  const isSelfServe = (self_serve === true || self_serve === 'true');

  if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatorios: name, email, password' });
  // Aceite dos Termos obrigatorio — registrado para fins de auditoria juridica (migration 114)
  if (!terms_accepted) return res.status(400).json({ error: 'O aceite dos Termos de Uso e obrigatorio para criar uma conta' });
  if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'E-mail ja cadastrado' }); }

    let plan = 'essencial', trialDays = 0, discountPct = 0, codeType = null, codeId = null, referrerId = null;
    if (access_code) {
      const { rows: codes } = await client.query('SELECT id, type, plan, discount_pct, trial_days, max_uses, uses, expires_at, is_active, referrer_id FROM access_codes WHERE code = $1', [access_code.toUpperCase().trim()]);
      if (!codes.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo de acesso invalido' }); }
      const ac = codes[0];
      if (!ac.is_active) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo desativado' }); }
      if (ac.uses >= ac.max_uses) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo esgotado' }); }
      if (ac.expires_at && new Date(ac.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Codigo expirado' }); }
      plan = ac.plan || 'essencial'; trialDays = ac.trial_days || 0; discountPct = ac.discount_pct || 0; codeType = ac.type; codeId = ac.id; referrerId = ac.referrer_id;
      await client.query('UPDATE access_codes SET uses = uses + 1, updated_at = NOW() WHERE id = $1', [ac.id]);
    }

    // Cadastro self-service (site /comecar e app /cadastro): sem codigo de acesso,
    // trial padrao Negocio 7 dias. Cadastros internos (sem a flag) seguem essencial.
    if (!access_code && isSelfServe) {
      plan = 'negocio'; trialDays = 7; codeType = 'self_serve';
    }

    const isStaff = email.toLowerCase().trim().endsWith('@getaura.com.br');
    const password_hash = await bcrypt.hash(password, 12);

    // Persiste aceite dos Termos: terms_accepted_at = momento exato do cadastro, terms_version = versao aceita.
    // Coluna adicionada pela migration 114. terms_version padrao 'v1' caso frontend antigo nao envie.
    const acceptedVersion = (typeof terms_version === 'string' && terms_version.trim()) ? terms_version.trim() : 'v1';
    const { rows: [user] } = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role, is_staff, phone, terms_accepted_at, terms_version)
       VALUES ($1, $2, $3, 'client', $4, $5, NOW(), $6)
       RETURNING id, full_name AS name, email, role, is_staff, email_verified, created_at`,
      [name.trim(), email.toLowerCase().trim(), password_hash, isStaff, phone || null, acceptedVersion]
    );

    let company = null;
    let isNewCompany = false;
    let memberRole = 'owner';
    let skipCompany = !company_name;

    if (!skipCompany && cnpj) {
      const cleanCnpj = cnpj.replace(/\D/g, '');
      if (cleanCnpj.length === 14 || cleanCnpj.length === 11) {
        const { rows: existingCompanies } = await client.query(
          'SELECT id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, module_overrides, billing_status, access_code_used, vertical_active, ai_enabled, ai_consent_at FROM companies WHERE cnpj = $1',
          [cleanCnpj]
        );
        if (existingCompanies.length > 0) {
          company = existingCompanies[0];
          isNewCompany = false;
          memberRole = 'vendedor';
          plan = company.plan;
          console.log('[auth] User ' + email + ' joining existing company ' + company.id + ' via CNPJ ' + cleanCnpj);
        }
      }
    }

    if (!skipCompany && !company) {
      isNewCompany = true;
      const trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString() : null;
      const { rows: [newCompany] } = await client.query(
        'INSERT INTO companies (owner_id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, access_code_used, cnpj, phone) VALUES ($1, $2, $2, $3, \'cnpj\', $4, $5, $6, $7) RETURNING id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, module_overrides, access_code_used, vertical_active, ai_enabled, ai_consent_at',
        [user.id, company_name.trim(), plan, trialEndsAt, access_code || null, cnpj ? cnpj.replace(/\D/g, '') : null, phone || null]
      );
      company = newCompany;
    }

    if (company) {
      await client.query(
        'INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, $3, \'active\', true)',
        [company.id, user.id, memberRole]
      );
    }

    if (codeType === 'referral' && referrerId) {
      await client.query('INSERT INTO referrals (referrer_id, referred_user_id, referred_email, code, status, completed_at) VALUES ($1, $2, $3, $4, \'completed\', NOW())', [referrerId, user.id, email.toLowerCase().trim(), access_code.toUpperCase().trim()]);
    }
    await client.query('COMMIT');

    // E-mail de follow-up pra CS quando uma conta self-service e criada (best-effort, nao bloqueia).
    if (isNewCompany && trialDays > 0 && (isSelfServe || codeType === 'trial')) {
      sendSelfServeSignupNotification({
        name: user.name,
        companyName: company.trade_name || company.legal_name,
        email: user.email,
        phone: phone || null,
        cnpj: cnpj || null,
        plan: company.plan,
        trialDays,
        trialEndsAt: company.trial_ends_at,
      }).catch((e) => console.error('[register] self-serve notify email falhou:', e.message));
    }

    const tokenPayload = {
      id: user.id,
      role: user.role,
      plan: company ? company.plan : 'essencial',
      company: company ? company.id : null,
      is_staff: user.is_staff,
      consolidated_view: false,
    };
    const accessToken = signAccessToken(tokenPayload);
    const { token: refreshToken } = signRefreshToken({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, req);
    setRefreshCookie(res, refreshToken);
    logAuditAction(user.id, company ? company.id : null, 'register', 'New account: ' + email.toLowerCase().trim() + (skipCompany ? ' (invite flow, no company)' : !isNewCompany ? ' (joined existing company)' : '') + ' | terms_version=' + acceptedVersion);

    res.status(201).json({
      token: accessToken, refresh_token: refreshToken, token_expires_in: '1h',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff, email_verified: user.email_verified || false },
      company: company ? {
        ...company,
        module_overrides: company.module_overrides || {},
        trial_active: !!(company.trial_ends_at),
        trial_ends_at: company.trial_ends_at,
        billing_status: company.billing_status || null,
        access_code_used: !!(company.access_code_used),
        vertical_active: company.vertical_active || null,
        ai_enabled: !!(company.ai_enabled),
        ai_consent_at: company.ai_consent_at || null,
        member_role: memberRole,
      } : null,
      consolidated_view: false,
      company_count: company ? 1 : 0,
      code_applied: access_code ? { type: codeType, plan: plan, discount_pct: discountPct, trial_days: trialDays } : null,
      joined_existing: company ? !isNewCompany : false,
      no_company: skipCompany,
    });
  } catch (err) { await client.query('ROLLBACK'); console.error('register error:', err); res.status(500).json({ error: 'Erro ao criar conta' }); }
  finally { client.release(); }
});

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email e password sao obrigatorios' });

  try {
    const { rows } = await db.query(
      'SELECT id, full_name AS name, email, password_hash, role, is_active, is_staff, totp_enabled, email_verified FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Credenciais invalidas' });
    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { logAuditAction(null, null, 'login_failed', 'Failed login for ' + email.toLowerCase().trim(), { ip: req.ip }); return res.status(401).json({ error: 'Credenciais invalidas' }); }
    if (user.totp_enabled) return res.json({ requires_2fa: true, user_id: user.id, message: 'Autenticacao de dois fatores necessaria.' });

    const ctx = await resolveDefaultContext(user.id);

    const tokenPayload = {
      id: user.id,
      role: user.role,
      plan: ctx.effectivePlan,
      company: ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null),
      is_staff: user.is_staff || false,
      consolidated_view: ctx.consolidated,
    };
    const accessToken = signAccessToken(tokenPayload);
    const { token: refreshToken } = signRefreshToken({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, req);
    setRefreshCookie(res, refreshToken);
    logAuditAction(user.id, ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null), 'login', 'Login: ' + user.email + (ctx.consolidated ? ' [consolidated]' : ''));

    res.json({
      token: accessToken, refresh_token: refreshToken, token_expires_in: '1h',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff || false, email_verified: user.email_verified || false },
      company: ctx.consolidated ? null : shapeCompany(ctx.primary, ctx.primary?.member_role),
      consolidated_view: ctx.consolidated,
      company_count: ctx.count,
    });
  } catch (err) { console.error('login error:', err); res.status(500).json({ error: 'Erro ao autenticar' }); }
});

// POST /api/v1/auth/refresh
router.post('/refresh', async (req, res) => {
  const refreshTokenInput = req.body.refresh_token || req.cookies?.aura_refresh;
  if (!refreshTokenInput) return res.status(400).json({ error: 'refresh_token e obrigatorio' });
  try {
    const decoded = jwt.verify(refreshTokenInput, JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(400).json({ error: 'Token nao e refresh' });
    const tokenHash = hashToken(refreshTokenInput);
    try {
      const { rows } = await db.query('SELECT id, revoked FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2', [tokenHash, decoded.id]);
      if (rows.length > 0 && rows[0].revoked) { clearRefreshCookie(res); return res.status(401).json({ error: 'Refresh token revogado', code: 'REFRESH_REVOKED' }); }
    } catch (_) {}

    const { rows: uRows } = await db.query('SELECT id, role, is_staff FROM users WHERE id = $1 AND is_active = true', [decoded.id]);
    if (!uRows.length) return res.status(401).json({ error: 'Usuario desativado' });
    const user = uRows[0];

    const ctx = await resolveDefaultContext(user.id);

    const newAccessToken = signAccessToken({
      id: user.id,
      role: user.role,
      plan: ctx.effectivePlan,
      company: ctx.consolidated ? null : (ctx.primary ? ctx.primary.id : null),
      is_staff: user.is_staff || false,
      consolidated_view: ctx.consolidated,
    });
    res.json({
      token: newAccessToken,
      token_expires_in: '1h',
      consolidated_view: ctx.consolidated,
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') { clearRefreshCookie(res); return res.status(401).json({ error: 'Refresh token expirado', code: 'REFRESH_EXPIRED' }); }
    return res.status(401).json({ error: 'Refresh token invalido' });
  }
});

// POST /api/v1/auth/logout
router.post('/logout', async (req, res) => {
  const refreshTokenInput = req.body.refresh_token || req.cookies?.aura_refresh;
  if (!refreshTokenInput) return res.json({ message: 'Logout realizado' });
  try { const decoded = jwt.verify(refreshTokenInput, JWT_SECRET, { ignoreExpiration: true }); const tokenHash = hashToken(refreshTokenInput); try { await db.query('UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1 AND user_id = $2', [tokenHash, decoded.id]); } catch (_) {} logAuditAction(decoded.id, null, 'logout', 'User logged out'); } catch (_) {}
  clearRefreshCookie(res);
  res.json({ message: 'Logout realizado com sucesso' });
});

// POST /api/v1/auth/me
router.post('/me', requireAuth, async (req, res) => {
  try {
    const { rows: uRows } = await db.query(
      'SELECT id, full_name AS name, email, role, is_staff, totp_enabled, email_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!uRows.length) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const u = uRows[0];

    const jwtConsolidated = !!req.user.consolidated_view;
    const jwtCompanyId = req.user.company || null;

    let company = null;
    let memberRole = 'owner';
    if (!jwtConsolidated && jwtCompanyId) {
      const { rows: cRows } = await db.query(
        `SELECT c.id, c.legal_name, c.plan, c.onboarding_step,
                c.trial_ends_at, c.module_overrides, c.billing_status,
                c.access_code_used, c.vertical_active, c.ai_enabled, c.ai_consent_at,
                CASE
                  WHEN c.owner_id = $1 THEN 'owner'
                  ELSE COALESCE(cm.role_label, 'member')
                END AS member_role
           FROM companies c
           LEFT JOIN company_members cm
             ON cm.company_id = c.id
            AND cm.user_id = $1
            AND cm.status = 'active'
            AND cm.is_active = true
          WHERE c.id = $2 AND c.is_active = true
            AND (c.owner_id = $1 OR cm.user_id = $1)`,
        [u.id, jwtCompanyId]
      );
      if (cRows.length) {
        company = cRows[0];
        memberRole = cRows[0].member_role || 'owner';
      }
    }

    const { rows: countRows } = await db.query(
      `SELECT COUNT(DISTINCT c.id)::int AS cnt
         FROM companies c
         LEFT JOIN company_members cm
           ON cm.company_id = c.id
          AND cm.user_id = $1
          AND cm.status = 'active'
          AND cm.is_active = true
        WHERE (c.owner_id = $1 OR cm.user_id = $1)
          AND c.is_active = true`,
      [u.id]
    );
    const companyCount = countRows[0]?.cnt || 0;

    res.json({
      user: { id: u.id, name: u.name, email: u.email, role: u.role, is_staff: u.is_staff || false, totp_enabled: u.totp_enabled || false, email_verified: u.email_verified || false },
      company: company ? shapeCompany(company, memberRole) : null,
      consolidated_view: jwtConsolidated,
      company_count: companyCount,
    });
  } catch (err) { console.error('me error:', err); res.status(500).json({ error: 'Erro ao buscar perfil' }); }
});

// SEC-07: 2FA sub-routes
router.use('/', require('./twoFactor'));

module.exports = router;
