// ============================================================
// AURA. — Autenticação
// POST /api/v1/auth/register
// POST /api/v1/auth/login
// POST /api/v1/auth/me
// POST /api/v1/auth/validate-code
// ============================================================
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const db      = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');
const { requireAuth } = require('../middleware/auth');

const env        = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;
const JWT_TTL    = process.env.JWT_EXPIRES_IN || '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_TTL });
}

// ── POST /api/v1/auth/register ───────────────────────────────
// Body: { name, email, password, company_name, phone?, cnpj?, access_code? }
router.post('/register', async (req, res) => {
  const { name, email, password, company_name, phone, cnpj, access_code } = req.body;

  if (!name || !email || !password || !company_name) {
    return res.status(400).json({ error: 'Campos obrigatórios: name, email, password, company_name' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check existing user
    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }

    // Validate access code if provided
    let plan = 'essencial';
    let trialDays = 0;
    let discountPct = 0;
    let codeType = null;
    let codeId = null;
    let referrerId = null;

    if (access_code) {
      const { rows: codes } = await client.query(
        `SELECT id, type, plan, discount_pct, trial_days, max_uses, uses, expires_at, is_active, referrer_id
         FROM access_codes WHERE code = $1`,
        [access_code.toUpperCase().trim()]
      );

      if (!codes.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Código de acesso inválido' });
      }

      const ac = codes[0];
      if (!ac.is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Código desativado' });
      }
      if (ac.uses >= ac.max_uses) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Código já atingiu o limite de usos' });
      }
      if (ac.expires_at && new Date(ac.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Código expirado' });
      }

      plan = ac.plan || 'essencial';
      trialDays = ac.trial_days || 0;
      discountPct = ac.discount_pct || 0;
      codeType = ac.type;
      codeId = ac.id;
      referrerId = ac.referrer_id;

      // Increment usage
      await client.query(
        'UPDATE access_codes SET uses = uses + 1, updated_at = NOW() WHERE id = $1',
        [ac.id]
      );
    }

    // Create user
    const isStaff = email.toLowerCase().trim().endsWith('@getaura.com.br');
    const password_hash = await bcrypt.hash(password, 12);

    const { rows: [user] } = await client.query(
      `INSERT INTO users (name, email, password_hash, role, is_staff, phone)
       VALUES ($1, $2, $3, 'client', $4, $5)
       RETURNING id, name, email, role, is_staff, created_at`,
      [name.trim(), email.toLowerCase().trim(), password_hash, isStaff, phone || null]
    );

    // Create company with trial if applicable
    const trialEndsAt = trialDays > 0
      ? new Date(Date.now() + trialDays * 86400000).toISOString()
      : null;

    const { rows: [company] } = await client.query(
      `INSERT INTO companies (owner_id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, access_code_used, cnpj)
       VALUES ($1, $2, $2, $3, 'cnpj', $4, $5, $6)
       RETURNING id, legal_name, trade_name, plan, onboarding_step, trial_ends_at`,
      [user.id, company_name.trim(), plan, trialEndsAt, access_code || null, cnpj || null]
    );

    // Create company membership
    await client.query(
      `INSERT INTO company_members (company_id, user_id, role, status, is_active)
       VALUES ($1, $2, 'owner', 'active', true)`,
      [company.id, user.id]
    );

    // If referral code, create referral record
    if (codeType === 'referral' && referrerId) {
      await client.query(
        `INSERT INTO referrals (referrer_id, referred_user_id, referred_email, code, status, completed_at)
         VALUES ($1, $2, $3, $4, 'completed', NOW())`,
        [referrerId, user.id, email.toLowerCase().trim(), access_code.toUpperCase().trim()]
      );
    }

    await client.query('COMMIT');

    const token = signToken({
      id: user.id, role: user.role, plan: company.plan,
      company: company.id, is_staff: user.is_staff,
    });

    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff },
      company: {
        ...company,
        trial_active: !!trialEndsAt,
        trial_ends_at: trialEndsAt,
      },
      code_applied: access_code ? { type: codeType, plan, discount_pct: discountPct, trial_days: trialDays } : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('register error:', err);
    res.status(500).json({ error: 'Erro ao criar conta' });
  } finally {
    client.release();
  }
});

// ── POST /api/v1/auth/login ──────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email e password são obrigatórios' });
  }

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.is_active, u.is_staff,
              c.id AS company_id, c.legal_name AS company_name, c.plan, c.onboarding_step,
              c.trial_ends_at
       FROM users u
       LEFT JOIN company_members cm ON cm.user_id = u.id AND cm.status = 'active' AND cm.is_active = true
       LEFT JOIN companies c        ON c.id = cm.company_id
       WHERE u.email = $1
       ORDER BY c.created_at ASC LIMIT 1`,
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const user = rows[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com o suporte.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = signToken({
      id: user.id, role: user.role, plan: user.plan || 'essencial',
      company: user.company_id, is_staff: user.is_staff || false,
    });

    const trialActive = user.trial_ends_at && new Date(user.trial_ends_at) > new Date();

    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, is_staff: user.is_staff || false },
      company: user.company_id
        ? {
            id: user.company_id, name: user.company_name, plan: user.plan,
            onboarding_step: user.onboarding_step,
            trial_active: trialActive,
            trial_ends_at: user.trial_ends_at,
          }
        : null,
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Erro ao autenticar' });
  }
});

// ── POST /api/v1/auth/me ────────────────────────────────────
router.post('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_staff,
              c.id AS company_id, c.legal_name, c.plan, c.onboarding_step, c.trial_ends_at
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
      user:    { id: u.id, name: u.name, email: u.email, role: u.role, is_staff: u.is_staff || false },
      company: u.company_id
        ? { id: u.company_id, name: u.legal_name, plan: u.plan, onboarding_step: u.onboarding_step, trial_active: trialActive, trial_ends_at: u.trial_ends_at }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

module.exports = router;
