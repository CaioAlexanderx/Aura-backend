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
// 06/05/2026 (Sprint 4 — backlog futuro):
//   POST /:mid/extend     — renova validade do convite mantendo token
//   GET  /:mid/audit-log  — historico de acoes do member
//   logAction()           — registrado em todas as rotas mutativas
// 06/05/2026 (seats por plano):
//   GET /unified e /billing usam summarizeSeats — devolve seats_included,
//   seats_used, at_limit, monthly_cost (so cobra acessos ACIMA do plano).
//   /billing usa COUNT direto (1 DB call) — nao precisa da lista completa.
//   /unified usa listMembersUnified para deduplicar usuarios entre CNPJs.
// 12/05/2026 (extra seats manual):
//   loadEffectiveBilling retorna {plan, extra_seats_granted}. summarizeSeats
//   passa a receber o terceiro arg pra expandir o limite. Gestao Aura
//   controla via PATCH /admin/clients/:cid/extra-seats (adminClients360.js).
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
const { logAction, listAudit, diffPermissions } = require('../services/memberAudit');
const { summarizeSeats, SEAT_PRICE_BRL } = require('../services/memberSeats');

// Carrega plano efetivo + extra_seats_granted do billing_owner.
// billing_owner_company_id puxa do "dono" no caso de CNPJs irmaos.
// 12/05/2026: extra_seats_granted vem da migration 110.
async function loadEffectiveBilling(companyId) {
  try {
    const { rows } = await db.query(`
      WITH owner AS (
        SELECT COALESCE(billing_owner_company_id, id) AS oid
        FROM companies WHERE id = $1
      )
      SELECT c.plan, COALESCE(c.extra_seats_granted, 0) AS extra_seats_granted
      FROM companies c
      JOIN owner ON c.id = owner.oid
    `, [companyId]);
    return {
      plan: (rows[0]?.plan || 'essencial').toLowerCase(),
      extra_seats_granted: parseInt(rows[0]?.extra_seats_granted, 10) || 0,
    };
  } catch (err) {
    console.error('[members] loadEffectiveBilling failed:', err.message);
    return { plan: 'essencial', extra_seats_granted: 0 };
  }
}

// GET /companies/:id/members/unified
router.get('/unified', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const result = await listMembersUnified(req.params.id);
    const billing = await loadEffectiveBilling(req.params.id);
    const seats  = summarizeSeats(billing.plan, result.members, billing.extra_seats_granted);

    const activeCount  = result.members.filter(m => m.status === 'active' && m.is_active).length;
    const pendingCount = result.members.filter(m => m.status === 'pending').length;

    res.json({
      total:        result.members.length,
      active:       activeCount,
      pending:      pendingCount,
      // Compat: monthly_cost agora considera seats inclusos no plano.
      // 0 enquanto ha vagas; (extras * 19) acima do limite.
      monthly_cost: seats.monthly_cost,
      // Novos campos (seats por plano)
      plan:               seats.plan,
      seats_included:     seats.seats_included,
      seats_used:         seats.seats_used,
      seats_remaining:    seats.seats_remaining,
      extra_seats:        seats.extra_seats,
      // 12/05/2026: seats extras pagos manualmente (Gestao Aura)
      extra_seats_granted: seats.extra_seats_granted,
      extra_seat_price:   seats.extra_seat_price,
      at_limit:           seats.at_limit,
      over_limit:         seats.over_limit,
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
    const billing = await loadEffectiveBilling(req.params.id);
    // Adapta lista single-company pro shape esperado por summarizeSeats
    const summarizable = members.map(m => ({
      status:    m.status,
      is_active: m.is_active,
    }));
    const seats = summarizeSeats(billing.plan, summarizable, billing.extra_seats_granted);
    const activeCount = members.filter(m => m.status === 'active' && m.is_active).length;
    res.json({
      total:        members.length,
      active:       activeCount,
      pending:      members.filter(m => m.status === 'pending').length,
      monthly_cost: seats.monthly_cost,
      plan:             seats.plan,
      seats_included:   seats.seats_included,
      seats_used:       seats.seats_used,
      seats_remaining:  seats.seats_remaining,
      extra_seats:      seats.extra_seats,
      extra_seats_granted: seats.extra_seats_granted,
      extra_seat_price: seats.extra_seat_price,
      at_limit:         seats.at_limit,
      over_limit:       seats.over_limit,
      members,
    });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar membros' }); }
});

// POST /companies/:id/members/invite
router.post('/invite', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const result = await inviteMemberMulti(req.params.id, req.user.id, req.body);
    // Sprint 4: log invite_created com role + permissions snapshot
    if (result?.id) {
      logAction(req.params.id, result.id, req.user.id, 'invite_created', {
        invite_email: result.invite_email || null,
        role_label:   result.role_label || null,
        company_ids:  req.body.company_ids || null,
        permissions:  req.body.permissions || null,
      });
    }
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
    // Sprint 4: log invite_accepted
    if (member?.id && member?.company_id) {
      logAction(member.company_id, member.id, req.user.id, 'invite_accepted', {});
    }
    res.json({ message: 'Convite aceito. Bem-vindo a equipe!', member });
  } catch (err) {
    const status = err.message.includes('invalido') || err.message.includes('nvalid') ? 410 : 403;
    res.status(status).json({ error: err.message });
  }
});

// Helper compartilhado: busca contexto pra montar email.
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
router.post('/:mid/resend-email', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, invite_token, invite_email, role_label, status
       FROM company_members WHERE id=$1 AND company_id=$2`,
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
      logAction(req.params.id, m.id, req.user.id, 'invite_resent', { invite_email: m.invite_email });
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
       FROM company_members WHERE id=$1 AND company_id=$2`,
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Convite nao encontrado' });

    const m = rows[0];
    if (m.status !== 'pending') return res.status(400).json({ error: 'Convite ja foi aceito ou cancelado' });
    if (!m.invite_token) return res.status(400).json({ error: 'Convite sem token. Gere um novo convite.' });

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

    const oldEmail = m.invite_email;
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
      logAction(req.params.id, m.id, req.user.id, 'invite_email_changed', { old_email: oldEmail, new_email: newEmail });
    } catch (mailErr) {
      console.error('[members] new email failed to send:', mailErr.message);
      logAction(req.params.id, m.id, req.user.id, 'invite_email_changed', { old_email: oldEmail, new_email: newEmail, send_failed: true });
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

// POST /companies/:id/members/:mid/extend  (Sprint 4)
// Renova invited_at = NOW() (mais 7 dias) mantendo invite_token e link.
router.post('/:mid/extend', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, invite_token, status, invited_at
       FROM company_members WHERE id=$1 AND company_id=$2`,
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Convite nao encontrado' });
    const m = rows[0];
    if (m.status !== 'pending') return res.status(400).json({ error: 'So convites pendentes podem ser estendidos' });
    if (!m.invite_token) return res.status(400).json({ error: 'Convite sem token valido. Gere um novo.' });

    const { rows: updated } = await db.query(
      `UPDATE company_members SET invited_at = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING id, invited_at, invite_token`,
      [req.params.mid, req.params.id]
    );

    const inviteUrl = buildInviteUrl(updated[0].invite_token);
    logAction(req.params.id, m.id, req.user.id, 'invite_extended', { previous_invited_at: m.invited_at });
    res.json({ message: 'Validade estendida em 7 dias', invited_at: updated[0].invited_at, invite_url: inviteUrl });
  } catch (err) {
    console.error('[members] extend error:', err.message);
    res.status(500).json({ error: 'Erro ao estender validade' });
  }
});

// GET /companies/:id/members/:mid/audit-log  (Sprint 4)
router.get('/:mid/audit-log', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const entries = await listAudit(req.params.id, req.params.mid, limit);
    res.json({ total: entries.length, entries });
  } catch (err) {
    console.error('[members] audit-log error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar historico' });
  }
});

// PATCH /companies/:id/members/:mid
router.patch('/:mid', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    // Sprint 4: snapshot do estado anterior pra calcular diff no log
    const { rows: before } = await db.query(
      `SELECT permissions, role_label
       FROM company_members WHERE id=$1 AND company_id=$2`,
      [req.params.mid, req.params.id]
    );
    const oldPerms = before[0]?.permissions || {};
    const oldRole  = before[0]?.role_label;

    const member = await updateMemberAndSync(req.params.id, req.params.mid, req.body);

    // Loga eventos relevantes (so o que de fato mudou)
    if (req.body.permissions !== undefined) {
      const oldP = typeof oldPerms === 'string' ? JSON.parse(oldPerms) : (oldPerms || {});
      const newP = typeof member.permissions === 'string' ? JSON.parse(member.permissions) : (member.permissions || {});
      const diff = diffPermissions(oldP, newP);
      if (diff.added.length || diff.removed.length) {
        logAction(req.params.id, req.params.mid, req.user.id, 'permissions_updated', diff);
      }
    }
    if (req.body.role_label !== undefined && oldRole !== req.body.role_label) {
      logAction(req.params.id, req.params.mid, req.user.id, 'role_changed', { from: oldRole, to: req.body.role_label });
    }
    if (req.body.company_ids !== undefined) {
      logAction(req.params.id, req.params.mid, req.user.id, 'companies_changed', { company_ids: req.body.company_ids });
    }

    res.json({ member });
  } catch (err) {
    const status = err.message.includes('nao encontrado') || err.message.includes('encontrado') ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
});

// DELETE /companies/:id/members/:mid
router.delete('/:mid', requireAuth, requireCompanyAccess({ roles: ['owner', 'admin'] }), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, user_id, status, invite_email, role_label FROM company_members WHERE id=$1 AND company_id=$2',
      [req.params.mid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membro nao encontrado' });
    if (rows[0].user_id === req.user.id) return res.status(400).json({ error: 'Voce nao pode remover a si mesmo' });

    const m = rows[0];

    if (m.status === 'pending') {
      // Sprint 4: log ANTES do DELETE pra preservar member_id na metadata
      logAction(req.params.id, m.id, req.user.id, 'invite_cancelled', {
        invite_email: m.invite_email || null,
        role_label:   m.role_label || null,
      });
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
      logAction(req.params.id, m.id, req.user.id, 'member_suspended', {});
      res.json({ message: 'Membro suspenso', deleted: false });
    }
  } catch (err) { res.status(500).json({ error: 'Erro ao remover membro' }); }
});

// GET /companies/:id/members/billing
//
// Retorna resumo de cobranca baseado em seats por plano.
// Usa COUNT direto (1 DB call) — o endpoint so precisa do total de
// acessos ativos/pendentes para calcular extras. Para a visao unificada
// multi-CNPJ com deduplicacao por usuario, usar GET /unified.
//
// Mock chain (tests):
//   Middleware 2 + Handler 1 (COUNT) = 3 mocks
router.get('/billing', requireAuth, requireCompanyAccess(), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS total
       FROM company_members
       WHERE company_id = $1
         AND status != 'suspended'
         AND (status = 'pending' OR is_active = true)`,
      [req.params.id]
    );
    const seatsUsed = parseInt(rows[0]?.total || '0', 10);
    const billing = await loadEffectiveBilling(req.params.id);

    // Array sintetico compativel com summarizeSeats (so precisa do tamanho)
    const synthetic = Array.from({ length: seatsUsed }, function() {
      return { status: 'active', is_active: true };
    });
    const seats = summarizeSeats(billing.plan, synthetic, billing.extra_seats_granted);

    res.json({
      plan:             seats.plan,
      seats_included:   seats.seats_included,
      seats_used:       seats.seats_used,
      seats_remaining:  seats.seats_remaining,
      extra_seats:      seats.extra_seats,
      extra_seats_granted: seats.extra_seats_granted,
      price_per_member: SEAT_PRICE_BRL,
      monthly_total:    seats.monthly_cost,
      at_limit:         seats.at_limit,
      over_limit:       seats.over_limit,
      // Compat
      active_members:   seats.seats_used,
      billable_members: seats.extra_seats,
      note: seats.over_limit
        ? 'Limite do plano excedido. Cada acesso adicional custa R$' + SEAT_PRICE_BRL + '/mes.'
        : 'Acessos inclusos no plano: ' + seats.seats_included + '. Acima disso, R$' + SEAT_PRICE_BRL + '/mes por acesso adicional.',
    });
  } catch (err) {
    console.error('[members] billing error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular cobranca' });
  }
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
