// ============================================================
// AURA. — Member Permissions Helper
// Enriquece a resposta de login/me com permissoes do membro
// ============================================================
const db = require('../config/database');

/**
 * Busca permissoes e role do membro logado para a empresa atual.
 * Retorna { member_role, member_permissions } ou defaults para owner.
 */
async function getMemberContext(userId, companyId) {
  if (!userId || !companyId) {
    return { member_role: 'owner', member_permissions: null };
  }

  try {
    const { rows } = await db.query(
      `SELECT role_label, permissions FROM company_members
       WHERE user_id = $1 AND company_id = $2 AND is_active = true AND status = 'active'
       LIMIT 1`,
      [userId, companyId]
    );

    if (!rows.length) {
      return { member_role: 'owner', member_permissions: null };
    }

    const m = rows[0];
    return {
      member_role: m.role_label || 'funcionario',
      member_permissions: typeof m.permissions === 'string'
        ? JSON.parse(m.permissions)
        : (m.permissions || null),
    };
  } catch (err) {
    console.error('[memberContext] error:', err.message);
    return { member_role: 'owner', member_permissions: null };
  }
}

module.exports = { getMemberContext };
