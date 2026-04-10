// ============================================================
// AURA. - Rotas publicas de convite (sem company access)
// GET  /invite/:token         - valida convite (publico)
// POST /invite/:token/accept  - aceita convite (requer auth, sem company access)
// ============================================================
const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { acceptInvite } = require('../services/members');

// GET /invite/:token - valida e retorna dados do convite (publico)
router.get('/:token', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT
         cm.invite_email, cm.role_label, cm.status,
         COALESCE(c.trade_name, c.legal_name, 'Empresa') AS company_name
       FROM company_members cm
       JOIN companies c ON c.id = cm.company_id
       WHERE cm.invite_token = $1`,
      [req.params.token]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Convite nao encontrado' });
    }

    const r = rows[0];
    if (r.status !== 'pending') {
      return res.status(410).json({
        error: 'Este convite ja foi utilizado ou expirou',
        status: r.status,
      });
    }

    // Mascara o email para exibicao: jo***@empresa.com
    const [local = '', domain = ''] = (r.invite_email || '').split('@');
    const masked = local.length > 2
      ? `${local[0]}${local[1]}***@${domain}`
      : `***@${domain}`;

    res.json({
      company_name: r.company_name,
      role:         r.role_label,
      email:        r.invite_email,  // email completo (para pre-fill no registro)
      masked_email: masked,           // email mascarado (para exibicao)
      status:       r.status,
    });
  } catch (err) {
    console.error('[invite] validate error:', err.message);
    res.status(500).json({ error: 'Erro ao validar convite' });
  }
});

// POST /invite/:token/accept - aceita convite (requireAuth apenas, SEM company access)
// O convidado nao eh membro da empresa ainda, entao nao pode usar o router privado
router.post('/:token/accept', requireAuth, async (req, res) => {
  try {
    const member = await acceptInvite(req.params.token, req.user.id);
    res.json({
      accepted:   true,
      company_id: member.company_id,
      role:       member.role_label,
      message:    'Convite aceito! Bem-vindo a equipe.',
    });
  } catch (err) {
    const status = err.message?.includes('nvalid') || err.message?.includes('tilizado') ? 410
                 : err.message?.includes('e-mail') || err.message?.includes('email') ? 403
                 : 400;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
