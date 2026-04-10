// ============================================================
// AURA. — GET /auth/my-permissions
// Retorna role + permissions do membro logado na empresa atual
// Usado pelo frontend pra gate de modulos por membro
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/my-permissions', requireAuth, async (req, res) => {
  try {
    // Busca empresa ativa do usuario
    const { rows } = await db.query(
      `SELECT cm.role_label, cm.permissions, cm.status,
              c.id AS company_id, c.plan
       FROM company_members cm
       JOIN companies c ON c.id = cm.company_id
       WHERE cm.user_id = $1 AND cm.is_active = true AND cm.status = 'active'
       ORDER BY c.created_at ASC LIMIT 1`,
      [req.user.id]
    );

    if (!rows.length) {
      // Usuario sem empresa — retorna acesso total (owner padrao)
      return res.json({ role: 'owner', permissions: null, is_owner: true });
    }

    const m = rows[0];
    const isOwner = m.role_label === 'owner';
    const perms = typeof m.permissions === 'string'
      ? JSON.parse(m.permissions)
      : (m.permissions || null);

    res.json({
      role: m.role_label,
      permissions: isOwner ? null : perms, // null = acesso total
      is_owner: isOwner,
      company_id: m.company_id,
      plan: m.plan,
    });
  } catch (err) {
    console.error('[my-permissions] error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar permissoes' });
  }
});

module.exports = router;
