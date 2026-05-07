// ============================================================
// AURA. — Rotas Multi-usuario RBAC (BE-09)
// P1 #10: DELETE now truly removes pending members (not just suspend)
// ONDA 2.7: unified multi-CNPJ member management
//   GET /unified — membros de todos os CNPJs do mesmo dono
//   POST /invite  — delega para inviteMemberMulti (suporta company_ids[])
//   PATCH /:mid   — delega para updateMemberAndSync (sync automatico)
// 06/05/2026 (Sprint UX Equipe):
//   POST /:mid/resend-email — reenvia email com mesmo token
//   PATCH /:mid/invite-email — edita destinatario e reenvia (mesmo token)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireCompanyAccess } = require('../middleware/auth');
const {
  countActiveMembers, listMembers, inviteMember,
  acceptInvite, updateMemberPermissions,
  listMembersUnified, inviteMemberMulti, updateMemberAndSync,
  buildInviteUrl,
} = require('../services/members');
const { sendInviteEmail } = require('../services/mailer');

// GET /companies/:id/members/unified
// Retorna uma entrada por usuario com campo companies:[{company_id, ...}].
// Permissoes universais — sincronizadas automaticamente em todos os CNPJs.
router.get('/unified', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const result = await listMembersUnified(req.params.id);
    const activeCount = result.members.filter(m => m.status === 'active' && m.is_active).length;
    res.json({
      total:        result.members.length,
      active:       activeCount,
      pending:      result.members.filter(m => m.status === 'pending').length,
      monthly_cost: Math.max(activeCount - 1, 0) * 19,
      members:      result.members,
      siblings:     result.siblings,
    });
  } catch (err) {
    console.error('[members] unified list error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar membros' });
  }
});

// GET /companies/:id/members
router.get('/', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const members = await listMembers(req.params.id);
    const activeCount = members.filter(m => m.status === 'active' && m.is_active).length;
    res.json({
      total: members.length,
      active: activeCount,
      pending: members.filter(m => m.status === 'pending').length,
      monthly_cost: Math.max(activeCount - 1, 0) * 19,
      members,
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar membros' }); }
});

// POST /companies/:id/members/invite
// Aceita company_ids[] para convidar para multiplos CNPJs em uma so acao.
router.post('/invite', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const result = await inviteMemberMulti(req.params.id, req.user.id, req.body);
    res.status(201).json(result);
  } catch (err) {
    const status = err.message.includes('ja tem') || err.message.includes('ja e membro') ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /members/accept/:token
router.post('/accept/:token', requireAuth, async (req, res) => {
  try {
    const member = await acceptInvite(req.params.token, req.user.id);
    res.json({ message: 'Convite aceito. Bem-vindo a equipe!', member });
  } catch (err) {
    const status = err.message.includes('invalido') || err.message.includes('nvalid') ? 410 : 403;
    res.status(status).json({ error: err.message });
  }
});

// Helper compartilhado: busca contexto pra montar email (company_name, inviter_name).
async function loadInviteContext(companyId, inviterUserId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(c.trade_name, c.legal_name, 'Aura') AS company_name,
       u.full_name AS inviter_name
     FROM companies c
     LEFT JOIN users u ON u.id = $2
     WHERE c.id = $1`,
    [companyId, inviterUserId]
  );
  return {
    companyName: rows[0]?.company_name || 'a empresa',
    inviterName: rows[0]?.inviter_name || 'a equipe',
  };
}

// POST /companies/:id/members/:mid/resend-email
// Reenvia o email do convite usando o mesmo invite_token. Member precisa
// estar pending e ter invite_email cadastrado.
router.post('/:mid/resend-email', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, invite_token, invite_email, role_label, status
       FROM company_members
       WHERE id=$1 AND company_id=$2`,
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Convite nao encontrado' });

    const m = rows[0];
    if (m.status !== 'pending') return res.status(400).json({ error: 'Convite ja foi aceito ou cancelado' });
    if (!m.invite_email) return res.status(400).json({ error: 'Este convite nao tem email cadastrado. Compartilhe o link manualmente ou edite o email primeiro.' });
    if (!m.invite_token) return res.status(400).json({ error: 'Convite sem token valido. Gere um novo convite.' });

    const inviteUrl = buildInviteUrl(m.invite_token);
    const { companyName, inviterName } = await loadInviteContext(req.params.id, req.user.id);

    try {
      const r = await sendInviteEmail(m.invite_email, inviteUrl, companyName, m.role_label || 'Colaborador', inviterName);
      console.log('[members] resend email sent:', r?.id || '', 'to', m.invite_email);
      res.json({ message: 'Email reenviado', invite_email: m.invite_email, invite_url: inviteUrl });
    } catch (mailErr) {
      console.error('[members] resend email failed:', mailErr.message);
      res.status(502).json({ error: 'Nao foi possivel enviar o email agora. Tente novamente em alguns minutos.' });
    }
  } catch (err) {
    console.error('[members] resend route error:', err.message);
    res.status(500).json({ error: 'Erro ao reenviar email' });
  }
});

// PATCH /companies/:id/members/:mid/invite-email
// Atualiza o destinatario do convite (mesmo token) e reenvia.
// Body: { invite_email: 'novo@email.com' }
router.patch('/:mid/invite-email', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  const { invite_email } = req.body || {};
  if (!invite_email || !String(invite_email).trim()) {
    return res.status(400).json({ error: 'invite_email e obrigatorio' });
  }
  const newEmail = String(invite_email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) {
    return res.status(400).json({ error: 'Email invalido' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, invite_token, invite_email, role_label, status
       FROM company_members
       WHERE id=$1 AND company_id=$2`,
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Convite nao encontrado' });

    const m = rows[0];
    if (m.status !== 'pending') return res.status(400).json({ error: 'Convite ja foi aceito ou cancelado' });
    if (!m.invite_token) return res.status(400).json({ error: 'Convite sem token. Gere um novo convite.' });

    // Checa se o novo email ja eh membro ATIVO ou pendente nessa empresa (em outro registro)
    const { rows: clash } = await db.query(
      `SELECT cm.id FROM company_members cm
       LEFT JOIN users u ON u.id = cm.user_id
       WHERE cm.company_id = $1
         AND cm.id != $2
         AND cm.status IN ('active', 'pending')
         AND (cm.invite_email = $3 OR u.email = $3)`,
      [req.params.id, m.id, newEmail]
    );
    if (clash.length) {
      return res.status(409).json({ error: 'Este email ja esta vinculado a outro membro/convite nesta empresa' });
    }

    // Atualiza email + reseta invited_at pra contar 7 dias do reenvio
    const { rows: updated } = await db.query(
      `UPDATE company_members
         SET invite_email = $1, invited_at = NOW()
       WHERE id = $2 AND company_id = $3
       RETURNING id, invite_token, invite_email, role_label`,
      [newEmail, req.params.mid, req.params.id]
    );

    const inviteUrl = buildInviteUrl(updated[0].invite_token);
    const { companyName, inviterName } = await loadInviteContext(req.params.id, req.user.id);

    try {
      const r = await sendInviteEmail(newEmail, inviteUrl, companyName, updated[0].role_label || 'Colaborador', inviterName);
      console.log('[members] invite email updated+sent:', r?.id || '', 'to', newEmail);
    } catch (mailErr) {
      // Email atualizado mas envio falhou — retorna OK com warning
      console.error('[members] new email failed to send:', mailErr.message);
      return res.status(200).json({
        message: 'Email atualizado, mas nao conseguimos reenviar agora. Tente reenviar em alguns minutos.',
        invite_email: newEmail,
        invite_url: inviteUrl,
        warning: 'send_failed',
      });
    }

    res.json({ message: 'Email atualizado e reenviado', invite_email: newEmail, invite_url: inviteUrl });
  } catch (err) {
    console.error('[members] update invite-email error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar email do convite' });
  }
});

// PATCH /companies/:id/members/:mid
// Permissoes sao sincronizadas automaticamente para todos os CNPJs do mesmo usuario.
// Aceita company_ids[] para alternar acesso a CNPJs especificos.
router.patch('/:mid', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const member = await updateMemberAndSync(req.params.id, req.params.mid, req.body);
    res.json({ member });
  } catch (err) {
    const status = err.message.includes('nao encontrado') || err.message.includes('encontrado') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /companies/:id/members/:mid
// P1 #10: pending members are truly deleted, active members are suspended
router.delete('/:mid', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT user_id, status FROM company_members WHERE id=$1 AND company_id=$2',
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membro nao encontrado' });
    if (rows[0].user_id === req.user.id) return res.status(400).json({ error: 'Voce nao pode remover a si mesmo' });

    if (rows[0].status === 'pending') {
      await db.query(
        'DELETE FROM company_members WHERE id=$1 AND company_id=$2',
        [req.params.mid, req.params.id]
      );
      res.json({ message: 'Convite removido', deleted: true });
    } else {
      await db.query(
        `UPDATE company_members SET status='suspended', is_active=false WHERE id=$1 AND company_id=$2`,
        [req.params.mid, req.params.id]
      );
      res.json({ message: 'Membro suspenso', deleted: false });
    }
  } catch (err) { res.status(500).json({ error: 'Erro ao remover membro' }); }
});

// GET /companies/:id/members/billing
router.get('/billing', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const activeCount = await countActiveMembers(req.params.id);
    const billable = Math.max(activeCount - 1, 0);
    res.json({
      active_members: activeCount, billable_members: billable,
      price_per_member: 19, monthly_total: billable * 19,
      note: 'O titular da conta nao e cobrado. R$19/membro adicional ativo/mes.',
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao calcular cobranca' }); }
});

// GET /companies/:id/members/roles
router.get('/roles', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, description, permissions, is_default,
              CASE WHEN company_id IS NULL THEN 'global' ELSE 'custom' END AS type
       FROM role_templates WHERE company_id=$1 OR company_id IS NULL
       ORDER BY is_default DESC, name`, [req.params.id]
    );
    res.json({ total: rows.length, templates: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar templates' }); }
});

// POST /companies/:id/members/roles
router.post('/roles', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  const { name, description, permissions = {} } = req.body;
  if (!name) return res.status(400).json({ error: 'name e obrigatorio' });
  try {
    const { rows } = await db.query(
      `INSERT INTO role_templates (company_id, name, description, permissions) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name, description || null, JSON.stringify(permissions)]
    );
    res.status(201).json({ template: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ja existe um template com este nome' });
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// PATCH /companies/:id/members/roles/:rid
router.patch('/roles/:rid', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  const { name, description, permissions } = req.body;
  const fields = [], values = [];
  let idx = 1;
  if (name        !== undefined) { fields.push(`name=$${idx++}`);        values.push(name); }
  if (description !== undefined) { fields.push(`description=$${idx++}`); values.push(description); }
  if (permissions !== undefined) { fields.push(`permissions=$${idx++}`); values.push(JSON.stringify(permissions)); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push('updated_at=NOW()');
  values.push(req.params.rid, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE role_templates SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Template nao encontrado ou e global' });
    res.json({ template: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar template' }); }
});

// DELETE /companies/:id/members/roles/:rid
router.delete('/roles/:rid', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM role_templates WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.rid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template nao encontrado ou e global' });
    res.json({ message: 'Template removido' });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover template' }); }
});

module.exports = router;
