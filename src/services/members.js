// ============================================================
// AURA. — Serviço Multi-usuário RBAC (BE-09)
// FIX: full_name (real schema) instead of name
// ============================================================

const db = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_PERMISSIONS = {
  pdv: true, estoque: false, clientes: false,
  financeiro: false, relatorios: false, folha: false, configuracoes: false,
};

async function countActiveMembers(companyId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS total FROM company_members
     WHERE company_id=$1 AND status='active' AND is_active=true`,
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
     WHERE m.company_id=$1
     ORDER BY m.status, u.full_name`,
    [companyId]
  );
  return rows;
}

async function inviteMember(companyId, invitedByUserId, { invite_email, role_label='funcionário', template_id, permissions }) {
  if (!invite_email) throw new Error('invite_email é obrigatório');

  const existing = await db.query(
    `SELECT m.id, m.status FROM company_members m
     LEFT JOIN users u ON u.id=m.user_id
     WHERE m.company_id=$1 AND (u.email=$2 OR m.invite_email=$2)`,
    [companyId, invite_email]
  );
  if (existing.rows.length > 0) {
    const s = existing.rows[0].status;
    throw new Error(`Este e-mail já tem um convite ${s==='pending'?'pendente':'ativo'} nesta empresa`);
  }

  let finalPermissions = permissions || DEFAULT_PERMISSIONS;
  if (template_id) {
    const { rows } = await db.query(
      'SELECT permissions FROM role_templates WHERE id=$1 AND (company_id=$2 OR company_id IS NULL)',
      [template_id, companyId]
    );
    if (rows.length) finalPermissions = rows[0].permissions;
  }

  const userResult = await db.query('SELECT id FROM users WHERE email=$1', [invite_email]);
  const userId = userResult.rows[0]?.id || null;
  const inviteToken = uuidv4();

  const { rows } = await db.query(
    `INSERT INTO company_members
       (company_id, user_id, role_label, permissions, template_id,
        invited_by, invited_at, invite_token, invite_email, status, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8,'pending',false)
     RETURNING id, invite_token, invite_email, role_label, status`,
    [companyId, userId, role_label, JSON.stringify(finalPermissions),
     template_id||null, invitedByUserId, inviteToken, invite_email]
  );

  return {
    ...rows[0],
    invite_url: `${process.env.APP_URL||'https://getaura.com.br'}/invite/${inviteToken}`,
    note: 'Envio do e-mail de convite: BE-08/BE-12 (aguarda CNPJ)',
  };
}

async function acceptInvite(token, userId) {
  const { rows } = await db.query(
    `SELECT id, company_id, invite_email FROM company_members
     WHERE invite_token=$1 AND status='pending'`,
    [token]
  );
  if (!rows.length) throw new Error('Convite inválido ou já utilizado');

  const member = rows[0];
  const { rows: userRows } = await db.query('SELECT email FROM users WHERE id=$1', [userId]);
  if (!userRows.length || userRows[0].email !== member.invite_email) {
    throw new Error('Este convite foi enviado para outro e-mail');
  }

  const { rows: updated } = await db.query(
    `UPDATE company_members
     SET user_id=$1, status='active', is_active=true,
         accepted_at=NOW(), invite_token=NULL
     WHERE id=$2 RETURNING *`,
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

  const fields=[], values=[];
  let idx=1;
  if (role_label       !== undefined) { fields.push(`role_label=$${idx++}`);   values.push(role_label); }
  if (finalPermissions !== undefined) { fields.push(`permissions=$${idx++}`);  values.push(JSON.stringify(finalPermissions)); }
  if (template_id      !== undefined) { fields.push(`template_id=$${idx++}`);  values.push(template_id); }
  if (status           !== undefined) {
    fields.push(`status=$${idx++}`);
    values.push(status);
    fields.push(`is_active=$${idx++}`);
    values.push(status === 'active');
  }
  if (!fields.length) throw new Error('Nenhum campo para atualizar');

  values.push(memberId, companyId);
  const { rows } = await db.query(
    `UPDATE company_members SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`,
    values
  );
  if (!rows.length) throw new Error('Membro não encontrado');
  return rows[0];
}

module.exports = { countActiveMembers, listMembers, inviteMember, acceptInvite, updateMemberPermissions };
