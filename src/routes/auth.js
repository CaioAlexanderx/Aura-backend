// ============================================================
// AURA. — Autenticação
// S1: SEC-02 Refresh token + SEC-06 httpOnly cookie
// S10: SEC-07 2FA TOTP sub-router
// ============================================================
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

const env        = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IS_PROD = env.NODE_ENV === 'production';

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
  try { await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)`, [userId, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_MS), req.ip, (req.headers['user-agent'] || '').substring(0, 200)]); } catch (_) {}
}

// ── POST /api/v1/auth/register ─────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, password, company_name, phone, cnpj, access_code } = req.body;
  if (!name || !email || !password || !company_name) return res.status(400).json({ error: 'Campos obrigatórios: name, email, password, company_name' });
  if (password.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'E-mail já cadastrado' }); }

    let plan = 'essencial', trialDays = 0, discountPct = 0, codeType = null, codeId = null, referrerId = null;
    if (access_code) {
      const { rows: codes } = await client.query(`SELECT id, type, plan, discount_pct, trial_days, max_uses, uses, expires_at, is_active, referrer_id FROM access_codes WHERE code = $1`, [access_code.toUpperCase().trim()]);
      if (!codes.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Código de acesso inválido' }); }
      const ac = codes[0];
      if (!ac.is_active) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Código desativado' }); }
      if (ac.uses >= ac.max_uses) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Código esgotado' }); }
      if (ac.expires_at && new Date(ac.expires_at) < new Date()) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Código expirado' }); }
      plan = ac.plan || 'essencial'; trialDays = ac.trial_days || 0; discountPct = ac.discount_pct || 0; codeType = ac.type; codeId = ac.id; referrerId = ac.referrer_id;
      await client.query('UPDATE access_codes SET uses = uses + 1, updated_at = NOW() WHERE id = $1', [ac.id]);
    }

    const isStaff = email.toLowerCase().trim().endsWith('@getaura.com.br');
    const password_hash = await bcrypt.hash(password, 12);
    const { rows: [user] } = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role, is_staff, phone) VALUES ($1, $2, $3, 'client', $4, $5) RETURNING id, full_name AS name, email, role, is_staff, email_verified, created_at`,
      [name.trim(), email.toLowerCase().trim(), password_hash, isStaff, phone || null]
    );

    const trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 86400000).toISOString() : null;
    const { rows: [company] } = await client.query(
      `INSERT INTO companies (owner_id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, access_code_used, cnpj) VALUES ($1, $2, $2, $3, 'cnpj', $4, $5, $6) RETURNING id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, module_overrides`,
      [user.id, company_name.trim(), plan, trialEndsAt, access_code || null, cnpj || null]
    );

    await client.query(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, 'owner', 'active', true)`, [company.id, user.id]);
    if (codeType === 'referral' && referrerId) {
      await client.query(`INSERT INTO referrals (referrer_id, referred_user_id, referred_email, code, status, completed_at) VALUES ($1, $2, $3, $4, 'completed', NOW())`, [referrerId, user.id, email.toLowerCase().trim(), access_code.toUpperCase().trim()]);
    }
    await client.query('COMMIT');

    const tokenPayload = { id: user.id, role: user.role, plan: company.plan, company: company.id, is_staff: user.is_staff };
    const accessToken = signAccessToken(tokenPayload);
    const { token: refreshToken } = signRefreshToken({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, req);
    setRefreshCookie(res, refreshToken);
    logAuditAction(user.id, company.id, 'register', `New account: ${email.toLowerCase().trim()}`);

    res.status(201).json({
      token: accessToken, refresh_token: refreshToken, token_expires_in: '15m',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff, email_verified: user.email_verified || false },
      company: { ...company, module_overrides: company.module_overrides || {}, trial_active: !!trialEndsAt, trial_ends_at: trialEndsAt },
      code_applied: access_code ? { type: codeType, plan, discount_pct: discountPct, trial_days: trialDays } : null,
    });
  } catch (err) { await client.query('ROLLBACK'); console.error('register error:', err); res.status(500).json({ error: 'Erro ao criar conta' }); }
  finally { client.release(); }
});

// ── POST /api/v1/auth/login ────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email e password são obrigatórios' });

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name AS name, u.email, u.password_hash, u.role, u.is_active, u.is_staff, u.totp_enabled, u.email_verified,
              c.id AS company_id, c.legal_name AS company_name, c.plan, c.onboarding_step, c.trial_ends_at, c.module_overrides
       FROM users u
       LEFT JOIN company_members cm ON cm.user_id = u.id AND cm.status = 'active' AND cm.is_active = true
       LEFT JOIN companies c ON c.id = cm.company_id
       WHERE u.email = $1
       ORDER BY c.created_at ASC LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Credenciais inválidas' });
    const user = rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) { logAuditAction(null, null, 'login_failed', `Failed login for ${email.toLowerCase().trim()}`, { ip: req.ip }); return res.status(401).json({ error: 'Credenciais inválidas' }); }
    if (user.totp_enabled) return res.json({ requires_2fa: true, user_id: user.id, message: 'Autenticacao de dois fatores necessaria.' });

    const tokenPayload = { id: user.id, role: user.role, plan: user.plan || 'essencial', company: user.company_id, is_staff: user.is_staff || false };
    const accessToken = signAccessToken(tokenPayload);
    const { token: refreshToken } = signRefreshToken({ id: user.id });
    await storeRefreshToken(user.id, refreshToken, req);
    setRefreshCookie(res, refreshToken);
    const trialActive = user.trial_ends_at && new Date(user.trial_ends_at) > new Date();
    logAuditAction(user.id, user.company_id, 'login', `Login: ${user.email}`);

    res.json({
      token: accessToken, refresh_token: refreshToken, token_expires_in: '15m',
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff || false, email_verified: user.email_verified || false },
      company: user.company_id
        ? { id: user.company_id, name: user.company_name, plan: user.plan, onboarding_step: user.onboarding_step,
            module_overrides: user.module_overrides || {}, trial_active: trialActive, trial_ends_at: user.trial_ends_at }
        : null,
    });
  } catch (err) { console.error('login error:', err); res.status(500).json({ error: 'Erro ao autenticar' }); }
});

// ── POST /api/v1/auth/refresh ───────────────────────────
router.post('/refresh', async (req, res) => {
  const refreshTokenInput = req.body.refresh_token || req.cookies?.aura_refresh;
  if (!refreshTokenInput) return res.status(400).json({ error: 'refresh_token é obrigatório' });
  try {
    const decoded = jwt.verify(refreshTokenInput, JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(400).json({ error: 'Token não é refresh' });
    const tokenHash = hashToken(refreshTokenInput);
    try { const { rows } = await db.query(`SELECT id, revoked FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2`, [tokenHash, decoded.id]); if (rows.length > 0 && rows[0].revoked) { clearRefreshCookie(res); return res.status(401).json({ error: 'Refresh token revogado', code: 'REFRESH_REVOKED' }); } } catch (_) {}
    const { rows } = await db.query(`SELECT u.id, u.role, u.is_staff, c.id AS company_id, c.plan FROM users u LEFT JOIN company_members cm ON cm.user_id = u.id AND cm.status = 'active' AND cm.is_active = true LEFT JOIN companies c ON c.id = cm.company_id WHERE u.id = $1 AND u.is_active = true ORDER BY c.created_at ASC LIMIT 1`, [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'Usuário desativado' });
    const user = rows[0];
    const newAccessToken = signAccessToken({ id: user.id, role: user.role, plan: user.plan || 'essencial', company: user.company_id, is_staff: user.is_staff || false });
    res.json({ token: newAccessToken, token_expires_in: '15m' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') { clearRefreshCookie(res); return res.status(401).json({ error: 'Refresh token expirado', code: 'REFRESH_EXPIRED' }); }
    return res.status(401).json({ error: 'Refresh token inválido' });
  }
});

// ── POST /api/v1/auth/logout ───────────────────────────
router.post('/logout', async (req, res) => {
  const refreshTokenInput = req.body.refresh_token || req.cookies?.aura_refresh;
  if (!refreshTokenInput) return res.json({ message: 'Logout realizado' });
  try { const decoded = jwt.verify(refreshTokenInput, JWT_SECRET, { ignoreExpiration: true }); const tokenHash = hashToken(refreshTokenInput); try { await db.query(`UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE token_hash = $1 AND user_id = $2`, [tokenHash, decoded.id]); } catch (_) {} logAuditAction(decoded.id, null, 'logout', 'User logged out'); } catch (_) {}
  clearRefreshCookie(res);
  res.json({ message: 'Logout realizado com sucesso' });
});

// ── POST /api/v1/auth/me ──────────────────────────────
router.post('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.full_name AS name, u.email, u.role, u.is_staff, u.totp_enabled, u.email_verified,
              c.id AS company_id, c.legal_name, c.plan, c.onboarding_step, c.trial_ends_at, c.module_overrides
       FROM users u
       LEFT JOIN company_members cm ON cm.user_id = u.id AND cm.status='active' AND cm.is_active=true
       LEFT JOIN companies c ON c.id = cm.company_id
       WHERE u.id = $1
       ORDER BY c.created_at ASC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const u = rows[0];
    const trialActive = u.trial_ends_at && new Date(u.trial_ends_at) > new Date();
    res.json({
      user: { id: u.id, name: u.name, email: u.email, role: u.role, is_staff: u.is_staff || false, totp_enabled: u.totp_enabled || false, email_verified: u.email_verified || false },
      company: u.company_id
        ? { id: u.company_id, name: u.legal_name, plan: u.plan, onboarding_step: u.onboarding_step,
            module_overrides: u.module_overrides || {}, trial_active: trialActive, trial_ends_at: u.trial_ends_at }
        : null,
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar perfil' }); }
});

// ── SEC-07: 2FA sub-routes ────────────────────────────────
router.use('/', require('./twoFactor'));

module.exports = router;
