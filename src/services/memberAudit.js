// ============================================================
// AURA. — Member Audit Service (Sprint 4 da revisao UX, 06/05/2026)
// Helper pra registrar mudancas em company_members. Fire-and-forget:
// um falha de log nunca deve quebrar a request principal de invite/edit.
// ============================================================

const db = require('../config/database');

/**
 * Registra uma acao no member_audit_log.
 * Fire-and-forget: erros sao logados em console mas nao propagam.
 *
 * @param {string} companyId
 * @param {string|null} memberId  — pode ser null se member ja foi deletado
 * @param {string|null} actorUserId — quem fez a acao
 * @param {string} action — invite_created/invite_resent/etc
 * @param {object} metadata — snapshot do que mudou
 */
async function logAction(companyId, memberId, actorUserId, action, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO member_audit_log (company_id, member_id, actor_user_id, action, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, memberId || null, actorUserId || null, action, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    // Nao propaga — log de auditoria nao pode bloquear fluxo principal
    console.error('[member-audit] log failed:', err.message, '— action:', action);
  }
}

/**
 * Retorna ultimas N entries do log pra um member.
 * Inclui nome/email do ator quando disponivel.
 */
async function listAudit(companyId, memberId, limit = 50) {
  const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
  const { rows } = await db.query(
    `SELECT
       al.id, al.action, al.metadata, al.created_at,
       al.actor_user_id,
       u.full_name AS actor_name,
       u.email     AS actor_email
     FROM member_audit_log al
     LEFT JOIN users u ON u.id = al.actor_user_id
     WHERE al.company_id = $1 AND al.member_id = $2
     ORDER BY al.created_at DESC
     LIMIT $3`,
    [companyId, memberId, safeLimit]
  );
  return rows;
}

/**
 * Calcula diff de permissions pra metadata mais util no log.
 * Retorna { added: [...], removed: [...] } ao inves do objeto completo.
 */
function diffPermissions(oldPerms = {}, newPerms = {}) {
  const added = [];
  const removed = [];
  const allKeys = new Set([...Object.keys(oldPerms), ...Object.keys(newPerms)]);
  for (const k of allKeys) {
    const oldVal = !!oldPerms[k];
    const newVal = !!newPerms[k];
    if (oldVal !== newVal) {
      if (newVal) added.push(k);
      else removed.push(k);
    }
  }
  return { added, removed };
}

module.exports = { logAction, listAudit, diffPermissions };
