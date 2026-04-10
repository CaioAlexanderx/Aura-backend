// ============================================================
// AURA. — Invite Public Routes (sem company context)
// GET  /invite/:token        — valida e retorna dados do convite
// POST /invite/:token/accept — aceita o convite (requer auth)
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.length <= 2
    ? local[0] + '***'
    : local[0] + '***' + local[local.length - 1];
  return masked + '@' + domain;
}

// GET /invite/:token — public, no auth
router.get('/:token', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         m.id, m.invite_email, m.role_label, m.status, m.invited_at,
         m.company_id, m.invite_token,
         c.trade_name, c.legal_name
       FROM company_members m
       JOIN companies c ON c.id = m.company_id
       WHERE m.invite_token = $1`,
      [req.params.token]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Convite nao encontrado ou ja utilizado' });
    }

    const inv = rows[0];
    if (inv.status !== 'pending') {
      return res.status(410).json({ error: 'Este convite ja foi aceito ou cancelado' });
    }

    res.json({
      company_name: inv.trade_name || inv.legal_name || 'Empresa',
      role: inv.role_label || 'Colaborador',
      email: inv.invite_email,
      masked_email: maskEmail(inv.invite_email),
      invited_at: inv.invited_at,
      valid: true,
    });
  } catch (err) {
    console.error('[invite validate] error:', err.message);
    res.status(500).json({ error: 'Erro ao validar convite' });
  }
});

// POST /invite/:token/accept — requires auth
router.post('/:token/accept', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, invite_email, status FROM company_members
       WHERE invite_token = $1`,
      [req.params.token]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Convite nao encontrado ou ja utilizado' });
    }

    const inv = rows[0];
    if (inv.status !== 'pending') {
      return res.status(410).json({ error: 'Este convite ja foi aceito ou cancelado' });
    }

    // Check email match
    const { rows: userRows } = await db.query(
      'SELECT email FROM users WHERE id = $1', [req.user.id]
    );
    if (!userRows.length || userRows[0].email !== inv.invite_email) {
      return res.status(403).json({
        error: 'Este convite foi enviado para ' + maskEmail(inv.invite_email) + '. Entre com esse email.',
      });
    }

    // Accept
    const { rows: updated } = await db.query(
      `UPDATE company_members
       SET user_id = $1, status = 'active', is_active = true,
           accepted_at = NOW(), invite_token = NULL
       WHERE id = $2 RETURNING *`,
      [req.user.id, inv.id]
    );

    res.json({ message: 'Convite aceito! Bem-vindo a equipe.', member: updated[0] });
  } catch (err) {
    console.error('[invite accept] error:', err.message);
    res.status(500).json({ error: 'Erro ao aceitar convite' });
  }
});

module.exports = router;
