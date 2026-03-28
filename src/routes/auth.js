// ============================================================
// AURA. — Autenticação
// POST /api/v1/auth/register
// POST /api/v1/auth/login
// POST /api/v1/auth/me
// ============================================================
const router  = require('express').Router();
const bcrypt  = require('bcrypt');          // pacote correto no package.json
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
// Body: { name, email, password, company_name, plan? }
router.post('/register', async (req, res) => {
  const { name, email, password, company_name, plan = 'essencial' } = req.body;

  if (!name || !email || !password || !company_name) {
    return res.status(400).json({ error: 'Campos obrigatórios: name, email, password, company_name' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido' });
  }
  const validPlans = ['essencial', 'negocio', 'expansao'];
  if (!validPlans.includes(plan)) {
    return res.status(400).json({ error: `Plano inválido. Use: ${validPlans.join(', ')}` });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { rows: [user] } = await client.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, 'client')
       RETURNING id, name, email, role, created_at`,
      [name.trim(), email.toLowerCase().trim(), password_hash]
    );

    const { rows: [company] } = await client.query(
      `INSERT INTO companies (owner_id, legal_name, trade_name, plan, onboarding_step)
       VALUES ($1, $2, $2, $3, 'cnpj')
       RETURNING id, legal_name, trade_name, plan, onboarding_step`,
      [user.id, company_name.trim(), plan]
    );

    await client.query(
      `INSERT INTO company_members (company_id, user_id, role, status, is_active)
       VALUES ($1, $2, 'owner', 'active', true)`,
      [company.id, user.id]
    );

    await client.query('COMMIT');

    const token = signToken({ id: user.id, role: user.role, plan: company.plan, company: company.id });
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      company,
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
// Body: { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email e password são obrigatórios' });
  }

  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.password_hash, u.role, u.is_active,
              c.id AS company_id, c.legal_name AS company_name, c.plan, c.onboarding_step
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

    const token = signToken({ id: user.id, role: user.role, plan: user.plan || 'essencial', company: user.company_id });
    res.json({
      token,
      user:    { id: user.id, name: user.name, email: user.email, role: user.role },
      company: user.company_id
        ? { id: user.company_id, name: user.company_name, plan: user.plan, onboarding_step: user.onboarding_step }
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
      `SELECT u.id, u.name, u.email, u.role,
              c.id AS company_id, c.legal_name, c.plan, c.onboarding_step
       FROM users u
       LEFT JOIN company_members cm ON cm.user_id = u.id AND cm.status='active' AND cm.is_active=true
       LEFT JOIN companies c ON c.id = cm.company_id
       WHERE u.id = $1
       ORDER BY c.created_at ASC LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    const u = rows[0];
    res.json({
      user:    { id: u.id, name: u.name, email: u.email, role: u.role },
      company: u.company_id
        ? { id: u.company_id, name: u.legal_name, plan: u.plan, onboarding_step: u.onboarding_step }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

module.exports = router;
