// ============================================================
// AURA. — BE-CODES-01: Access Codes
// POST /auth/validate-code
// POST /referrals/generate   (authenticated)
// GET  /referrals/mine        (authenticated)
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const crypto = require('crypto');

// POST /auth/validate-code
router.post('/validate-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code obrigatorio' });

  try {
    const { rows } = await db.query(
      `SELECT id, code, type, plan, discount_pct, trial_days, max_uses, uses, expires_at, is_active
       FROM access_codes WHERE code = $1`,
      [code.toUpperCase().trim()]
    );

    if (!rows.length) {
      return res.status(404).json({ valid: false, error: 'Codigo nao encontrado' });
    }

    const ac = rows[0];

    if (!ac.is_active) {
      return res.json({ valid: false, error: 'Codigo desativado' });
    }
    if (ac.uses >= ac.max_uses) {
      return res.json({ valid: false, error: 'Codigo ja atingiu o limite de usos' });
    }
    if (ac.expires_at && new Date(ac.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'Codigo expirado' });
    }

    res.json({
      valid: true,
      type: ac.type,
      plan: ac.plan,
      discount_pct: ac.discount_pct,
      trial_days: ac.trial_days,
    });
  } catch (err) {
    console.error('validate-code error:', err);
    res.status(500).json({ error: 'Erro ao validar codigo' });
  }
});

// POST /referrals/generate
router.post('/generate', requireAuth, async (req, res) => {
  try {
    // Check if user already has a referral code
    const { rows: existing } = await db.query(
      `SELECT code FROM access_codes WHERE referrer_id = $1 AND type = 'referral' AND is_active = true`,
      [req.user.id]
    );

    if (existing.length > 0) {
      return res.json({ code: existing[0].code, existing: true });
    }

    // BUGFIX: column is full_name, not name
    const { rows: users } = await db.query(
      `SELECT full_name FROM users WHERE id = $1`, [req.user.id]
    );
    const firstName = (users[0]?.full_name || 'USER').split(' ')[0].toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z]/g, '').slice(0, 8);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 4);
    const code = `REF-${firstName}${suffix}`;

    await db.query(
      `INSERT INTO access_codes (code, type, plan, discount_pct, max_uses, referrer_id, expires_at)
       VALUES ($1, 'referral', 'essencial', 20, 5, $2, NOW() + INTERVAL '90 days')`,
      [code, req.user.id]
    );

    res.status(201).json({ code, existing: false });
  } catch (err) {
    console.error('generate referral error:', err);
    res.status(500).json({ error: 'Erro ao gerar codigo de indicacao' });
  }
});

// GET /referrals/mine
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows: codes } = await db.query(
      `SELECT code, uses, max_uses, discount_pct, expires_at, created_at
       FROM access_codes WHERE referrer_id = $1 AND type = 'referral'`,
      [req.user.id]
    );

    const { rows: referrals } = await db.query(
      `SELECT r.referred_email, r.status, r.created_at, r.completed_at,
              u.full_name AS referred_name
       FROM referrals r
       LEFT JOIN users u ON u.id = r.referred_user_id
       WHERE r.referrer_id = $1
       ORDER BY r.created_at DESC`,
      [req.user.id]
    );

    const completed = referrals.filter(r => r.status === 'completed').length;

    res.json({
      code: codes[0] || null,
      referrals,
      stats: {
        total: referrals.length,
        completed,
        pending: referrals.filter(r => r.status === 'pending').length,
        savings_count: completed,
      },
    });
  } catch (err) {
    console.error('my referrals error:', err);
    res.status(500).json({ error: 'Erro ao buscar indicacoes' });
  }
});

module.exports = router;
