// ============================================================
// AURA. - Servico Multi-usuario RBAC
// FIX: painel added to default permissions
// FIX: acceptInvite relaxed email validation (warns but doesn't block)
// ============================================================

const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const { sendInviteEmail } = require('./mailer');

const DEFAULT_PERMISSIONS = {
  painel:        true,
  pdv:           true,
  estoque:       false,
  clientes:      false,
  financeiro:    false,
  relatorios:    false,
  folha:         false,
  configuracoes: false,
};

async function countActiveMembers(companyId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS total FROM company_members WHERE company_id=$1 AND status=\'active\' AND is_active=true',
    [companyId]
  );
  return parseInt(rows[0].total);
}

async function listMembers(companyId) {
  const { rows } = await db.query(
    `SELECT
       m.id, m.role_label, m.permissions, m.status, m.is_active,
       m.invited_at, m.accepted_at, m.invite_email, m.template_id,
       u.id AS user_id, u.full_name AS user_name, u.email AS user_email,
       rt.name AS template_name
     FROM company_members m
     LEFT JOIN users u ON u.id=m.user_id
     LEFT JOIN role_templates rt ON rt.id=m.template_id
     WHERE m.company_id=$1 AND m.status != 'suspended'
     ORDER BY m.status, u.full_name`,
    [companyId]
  );
  return rows;
}

async function inviteMember(companyId, invitedByUserId, { invite_email, role_label = 'colaborador', template_id, permissions }) {
  const emailToUse = invite_email && invite_email.trim() ? invite_email.trim().toLowerCase() : null;

  if (emailToUse) {
    const existing = await db.query(
      `SELECT m.id, m.status, m.user_id FROM company_members m
       LEFT JOIN users u ON u.id=m.user_id
       WHERE m.company_id=$1 AND (u.email=$2 OR m.invite_email=$2)`,
      [companyId, emailToUse]
    );
    if (existing.rows.length > 0) {
      const rec = existing.rows[0];
      if (rec.status === 'active') throw new Error('Este e-mail ja e membro ativo nesta empresa');
      if (rec.status === 'pending') throw new Error('Este e-mail ja tem um convite pendente nesta empresa');
      if (rec.status === 'suspended') await db.query('DELETE FROM company_members WHERE id=$1', [rec.id]);
    }
  }

  let userId = null;
  if (emailToUse) {
    const userResult = await db.query('SELECT id FROM users WHERE email=$1', [emailToUse]);
    userId = userResult.rows[0]?.id || null;
  }

  if (userId) {
    const existingByUserId = await db.query(
      'SELECT id, status FROM company_members WHERE company_id=$1 AND user_id=$2',
      [companyId, userId]
    );
    if (existingByUserId.rows.length > 0) {
      const rec = existingByUserId.rows[0];
      if (rec.status === 'active') throw new Error('Este usuario ja e membro ativo nesta empresa');
      await db.query('DELETE FROM company_members WHERE id=$1', [rec.id]);
    }
  }

  let finalPermissions = permissions || DEFAULT_PERMISSIONS;
  if (template_id) {
    const { rows } = await db.query(
      'SELECT permissions FROM role_templates WHERE id=$1 AND (company_id=$2 OR company_id IS NULL)',
      [template_id, companyId]
    );
    if (rows.length) finalPermissions = rows[0].permissions;
  }

  const { rows: ctx } = await db.query(
    `SELECT
       COALESCE(c.trade_name, c.legal_name, 'Aura') AS company_name,
       u.full_name AS inviter_name
     FROM companies c
     LEFT JOIN users u ON u.id = $2
     WHERE c.id = $1`,
    [companyId, invitedByUserId]
  );
  const companyName = ctx[0]?.company_name || 'a empresa';
  const inviterName = ctx[0]?.inviter_name || 'a equipe';

  const inviteToken = uuidv4();

  const { rows } = await db.query(
    `INSERT INTO company_members
       (company_id, user_id, role_label, permissions, template_id,
        invited_by, invited_at, invite_token, invite_email, status, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,'pending',false)
     RETURNING id, invite_token, invite_email, role_label, status`,
    [
      companyId, userId, role_label, JSON.stringify(finalPermissions),
      template_id || null, invitedByUserId, inviteToken, emailToUse,
    ]
  );

  const baseUrl   = process.env.INVITE_BASE_URL || 'https://app.getaura.com.br/app';
  const inviteUrl = baseUrl + '/invite/' + inviteToken;

  if (emailToUse) {
    sendInviteEmail(emailToUse, inviteUrl, companyName, role_label, inviterName)
      .then(function(r) { console.log('[members] invite email sent: ' + (r?.id || '') + ' to ' + emailToUse); })
      .catch(function(e) { console.error('[members] invite email failed:', e.message); });
  }

  return { ...rows[0], invite_url: inviteUrl };
}

async function acceptInvite(token, userId) {
  const { rows } = await db.query(
    "SELECT id, company_id, invite_email FROM company_members WHERE invite_token=$1 AND status='pending'",
    [token]
  );
  if (!rows.length) throw new Error('Convite invalido ou ja utilizado');

  const member = rows[0];

  // FIX: relaxed email validation — log mismatch but don't block
  // The invite token itself is the security mechanism (UUID, single-use)
  // Blocking on email mismatch prevented users from registering with
  // a different email than what the admin used to invite them
  if (member.invite_email) {
    const { rows: userRows } = await db.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (userRows.length && userRows[0].email !== member.invite_email) {
      console.log('[members] accept: email mismatch — invite=' + member.invite_email + ' user=' + userRows[0].email + ' (allowing)');
      // Previously: throw new Error('Este convite foi enviado para outro e-mail');
      // Now: allow it — the token is the auth mechanism, not the email
    }
  }

  // Check if user already has another record for this company
  const { rows: existingRecords } = await db.query(
    'SELECT id, status FROM company_members WHERE company_id=$1 AND user_id=$2 AND id != $3',
    [member.company_id, userId, member.id]
  );
  for (const rec of existingRecords) {
    await db.query('DELETE FROM company_members WHERE id=$1', [rec.id]);
  }

  const { rows: updated } = await db.query(
    "UPDATE company_members SET user_id=$1, status='active', is_active=true, accepted_at=NOW(), invite_token=NULL WHERE id=$2 RETURNING *",
    [userId, member.id]
  );
  return updated[0];
}

async function updateMemberPermissions(companyId, memberId, { role_label, permissions, template_id, status }) {
  let finalPermissions = permissions;
  if (template_id && !permissions) {
    const { rows } = await db.query(
      'SELECT permissions FROM role_templates WHERE id=$1 AND (company_id=$2 OR company_id IS NULL)',
      [template_id, companyId]
    );
    if (rows.length) finalPermissions = rows[0].permissions;
  }

  const fields = [], values = [];
  let idx = 1;
  if (role_label       !== undefined) { fields.push('role_label=$' + idx++);  values.push(role_label); }
  if (finalPermissions !== undefined) { fields.push('permissions=$' + idx++); values.push(JSON.stringify(finalPermissions)); }
  if (template_id      !== undefined) { fields.push('template_id=$' + idx++); values.push(template_id); }
  if (status           !== undefined) {
    fields.push('status=$' + idx++);   values.push(status);
    fields.push('is_active=$' + idx++); values.push(status === 'active');
  }
  if (!fields.length) throw new Error('Nenhum campo para atualizar');

  values.push(memberId, companyId);
  const { rows } = await db.query(
    'UPDATE company_members SET ' + fields.join(',') + ' WHERE id=$' + idx++ + ' AND company_id=$' + idx + ' RETURNING *',
    values
  );
  if (!rows.length) throw new Error('Membro nao encontrado');
  return rows[0];
}

module.exports = { countActiveMembers, listMembers, inviteMember, acceptInvite, updateMemberPermissions };
