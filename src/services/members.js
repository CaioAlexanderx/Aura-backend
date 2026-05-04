// ============================================================
// AURA. - Servico Multi-usuario RBAC
// FIX: painel added to default permissions
// FIX: acceptInvite relaxed email validation (warns but doesn't block)
// ONDA 2.7: unified multi-CNPJ member management
//   - getSiblingCompanyIds / getSiblingCompanies
//   - listMembersUnified — one entry per user across all sibling companies
//   - inviteMemberMulti  — invite to multiple CNPJs with a shared token
//   - updateMemberAndSync — sync permissions + CNPJ access toggle
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

// existingToken: optional pre-generated token for multi-CNPJ invite sharing.
// When provided, skips email sending (handled by the caller once).
async function inviteMember(companyId, invitedByUserId, { invite_email, role_label = 'colaborador', template_id, permissions }, existingToken = null) {
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

  const inviteToken = existingToken || uuidv4();

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

  // Email is sent only when this is the primary invite (no pre-existing token)
  if (emailToUse && !existingToken) {
    sendInviteEmail(emailToUse, inviteUrl, companyName, role_label, inviterName)
      .then(function(r) { console.log('[members] invite email sent: ' + (r?.id || '') + ' to ' + emailToUse); })
      .catch(function(e) { console.error('[members] invite email failed:', e.message); });
  }

  return { ...rows[0], invite_url: inviteUrl };
}

async function acceptInvite(token, userId) {
  // Find ALL entries sharing this token (multi-CNPJ invite may have multiple rows)
  const { rows } = await db.query(
    "SELECT id, company_id, invite_email FROM company_members WHERE invite_token=$1 AND status='pending'",
    [token]
  );
  if (!rows.length) throw new Error('Convite invalido ou ja utilizado');

  const primary = rows[0];

  // FIX: relaxed email validation — log mismatch but don't block.
  // The invite token itself is the security mechanism (UUID, single-use).
  if (primary.invite_email) {
    const { rows: userRows } = await db.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (userRows.length && userRows[0].email !== primary.invite_email) {
      console.log('[members] accept: email mismatch — invite=' + primary.invite_email + ' user=' + userRows[0].email + ' (allowing)');
    }
  }

  // Activate ALL entries sharing this token (handles multi-CNPJ invites)
  let primaryResult = null;
  for (const member of rows) {
    // Remove any conflicting records for this user in this company
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
    if (!primaryResult) primaryResult = updated[0];
  }

  return primaryResult;
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

// ============================================================
// ONDA 2.7 — Multi-CNPJ unified helpers
// ============================================================

// Returns all company IDs sharing the same billing owner (including itself)
async function getSiblingCompanyIds(companyId) {
  const { rows } = await db.query(`
    WITH pid AS (
      SELECT COALESCE(billing_owner_company_id, id) AS v FROM companies WHERE id = $1
    )
    SELECT c.id FROM companies c CROSS JOIN pid
    WHERE c.id = pid.v OR c.billing_owner_company_id = pid.v
  `, [companyId]);
  return rows.map(r => r.id);
}

// Returns sibling company objects {id, name, is_primary}
async function getSiblingCompanies(companyId) {
  const { rows } = await db.query(`
    WITH pid AS (
      SELECT COALESCE(billing_owner_company_id, id) AS v FROM companies WHERE id = $1
    )
    SELECT c.id, COALESCE(c.trade_name, c.legal_name, 'Empresa') AS name, c.is_primary
    FROM companies c CROSS JOIN pid
    WHERE c.id = pid.v OR c.billing_owner_company_id = pid.v
    ORDER BY c.is_primary DESC
  `, [companyId]);
  return rows;
}

// Unified member list: one entry per user across all sibling companies.
// Each entry has companies:[{company_id, company_name, is_primary, member_id}]
async function listMembersUnified(companyId) {
  const siblingIds = await getSiblingCompanyIds(companyId);
  if (!siblingIds.length) return { members: [], siblings: [] };
  const siblings = await getSiblingCompanies(companyId);

  const ph = siblingIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(`
    SELECT
      m.id, m.company_id, m.role_label, m.permissions, m.status, m.is_active,
      m.invited_at, m.accepted_at, m.invite_email,
      u.id AS user_id, u.full_name AS user_name, u.email AS user_email,
      COALESCE(c.trade_name, c.legal_name, 'Empresa') AS company_name, c.is_primary
    FROM company_members m
    LEFT JOIN users u ON u.id = m.user_id
    JOIN companies c ON c.id = m.company_id
    WHERE m.company_id IN (${ph}) AND m.status != 'suspended'
    ORDER BY m.status, u.full_name NULLS LAST
  `, siblingIds);

  // Deduplicate by user_id (or invite_email for pending without user_id)
  const map = new Map();
  for (const row of rows) {
    const key = row.user_id || ('inv:' + (row.invite_email || row.id));
    if (!map.has(key)) {
      map.set(key, {
        id:           row.id,
        user_id:      row.user_id,
        user_name:    row.user_name || row.invite_email || 'Pendente',
        user_email:   row.user_email || row.invite_email || '',
        role_label:   row.role_label,
        status:       row.status,
        is_active:    row.is_active,
        permissions:  typeof row.permissions === 'string'
          ? JSON.parse(row.permissions) : (row.permissions || {}),
        invite_email: row.invite_email,
        invited_at:   row.invited_at,
        accepted_at:  row.accepted_at,
        companies:    [],
      });
    }
    map.get(key).companies.push({
      company_id:   row.company_id,
      company_name: row.company_name,
      is_primary:   row.is_primary,
      member_id:    row.id,
    });
  }
  return { members: Array.from(map.values()), siblings };
}

// Invite member to multiple sibling companies using a shared invite token.
// company_ids[]: which companies to grant access to.
async function inviteMemberMulti(companyId, invitedByUserId, body) {
  const { company_ids, ...inviteBody } = body;

  // No company_ids provided — fallback to single-company invite
  if (!company_ids || !Array.isArray(company_ids) || !company_ids.length) {
    return inviteMember(companyId, invitedByUserId, inviteBody);
  }

  const siblingIds = await getSiblingCompanyIds(companyId);
  let validIds = company_ids.filter(id => siblingIds.includes(id));
  if (!validIds.length) throw new Error('Nenhuma empresa valida selecionada');

  // Primary company always gets the invite (it owns the link URL)
  if (!validIds.includes(companyId)) validIds.unshift(companyId);

  // Shared token: all entries activated together when the invitee accepts
  const sharedToken = uuidv4();
  let primaryResult = null;

  for (const cid of validIds) {
    try {
      const result = await inviteMember(cid, invitedByUserId, inviteBody, sharedToken);
      if (cid === companyId) primaryResult = result;
    } catch (e) {
      // Only re-throw for the primary company; skip duplicates in secondary
      if (cid === companyId) throw e;
      console.log(`[members] multi-invite to ${cid} skipped: ${e.message}`);
    }
  }
  return primaryResult;
}

// Update member permissions + auto-sync to all sibling companies.
// Also handles company_ids toggle (grant/revoke access to specific CNPJs).
async function updateMemberAndSync(companyId, memberId, data) {
  const updated = await updateMemberPermissions(companyId, memberId, data);

  // Pending invites have no user_id — nothing to sync yet
  if (!updated.user_id) return updated;

  const { permissions, role_label, company_ids } = data;

  // Sync permissions/role to all other sibling companies for this user
  if (permissions !== undefined || role_label !== undefined) {
    const siblingIds = await getSiblingCompanyIds(companyId);
    const fields = [], values = [];
    let idx = 1;
    if (permissions !== undefined) { fields.push(`permissions=$${idx++}`); values.push(JSON.stringify(permissions)); }
    if (role_label  !== undefined) { fields.push(`role_label=$${idx++}`);  values.push(role_label); }
    for (const sibId of siblingIds) {
      if (sibId === companyId) continue;
      try {
        await db.query(
          `UPDATE company_members SET ${fields.join(', ')} WHERE company_id=$${idx} AND user_id=$${idx + 1} AND status='active'`,
          [...values, sibId, updated.user_id]
        );
      } catch (e) { console.log(`[members] sync to ${sibId} failed: ${e.message}`); }
    }
  }

  // Handle CNPJ access toggle: grant or revoke access to specific companies
  if (company_ids !== undefined) {
    const siblingIds = await getSiblingCompanyIds(companyId);
    const permsJson = JSON.stringify(
      typeof updated.permissions === 'string'
        ? JSON.parse(updated.permissions) : (updated.permissions || {})
    );
    for (const sibId of siblingIds) {
      const shouldHave = company_ids.includes(sibId);
      const { rows: ex } = await db.query(
        'SELECT id, status FROM company_members WHERE company_id=$1 AND user_id=$2',
        [sibId, updated.user_id]
      );
      if (shouldHave && !ex.length) {
        // Grant access: create an active entry
        try {
          await db.query(`
            INSERT INTO company_members
              (company_id, user_id, role_label, permissions, status, is_active, accepted_at)
            VALUES ($1, $2, $3, $4, 'active', true, NOW())
          `, [sibId, updated.user_id, updated.role_label, permsJson]);
        } catch (e) { console.log(`[members] add access to ${sibId} failed: ${e.message}`); }
      } else if (!shouldHave && ex.length && ex[0].status === 'active') {
        // Revoke access: suspend the entry
        try {
          await db.query(
            `UPDATE company_members SET status='suspended', is_active=false WHERE company_id=$1 AND user_id=$2`,
            [sibId, updated.user_id]
          );
        } catch (e) { console.log(`[members] revoke from ${sibId} failed: ${e.message}`); }
      }
    }
  }

  return updated;
}

module.exports = {
  countActiveMembers, listMembers, inviteMember, acceptInvite,
  updateMemberPermissions,
  // ONDA 2.7 — unified multi-CNPJ
  getSiblingCompanyIds, getSiblingCompanies,
  listMembersUnified, inviteMemberMulti, updateMemberAndSync,
};
