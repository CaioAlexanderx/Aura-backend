// ============================================================
// AURA KARATÊ — Auditoria de correção de transferências (migration 293)
//
// karate_practitioner_transfers é append-only/imutável (trigger da 180).
// O PR #541 passou a permitir editar (PATCH) e anular (VOID) UM registro
// pelo escape hatch da 221. Este módulo grava o RASTRO dessas correções:
// quem fez, quando e o-que-mudou (before/after) — o que faltava quando a
// correção era um UPDATE/DELETE cru.
//
// ⚠️ DIFERENÇA PROPOSITAL vs. karateFinanceAudit:
//   Lá o log é best-effort e roda DEPOIS do COMMIT (nunca pode derrubar a
//   operação financeira). AQUI a auditoria roda DENTRO da MESMA transação
//   da correção (recebe o `client`): a correção e seu rastro são atômicos —
//   ou os dois acontecem, ou nenhum. Corrigir sem deixar rastro é
//   exatamente o que este follow-up existe para impedir; então se a
//   auditoria não puder ser gravada, a correção também não vale (a rota
//   trata 42P01/42703 como MIGRATION_PENDING → 503).
// ============================================================
'use strict';

const VALID_ACTIONS = ['patch', 'void'];

// Resolve o rótulo legível do autor pela MESMA conexão da transação (não
// abre conexão nova do pool — manteria a atomicidade e a ordem das queries).
async function resolveActorLabel(client, userId) {
  if (!userId) return 'sistema';
  try {
    const { rows } = await client.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
    return rows[0] ? (rows[0].full_name || rows[0].email || 'usuário') : 'usuário';
  } catch (_) {
    // users é tabela central (sempre existe); um erro aqui não deveria
    // acontecer, mas se acontecer NÃO poluímos a tx — cai pro rótulo default.
    return 'usuário';
  }
}

// Grava uma linha de auditoria de correção DENTRO da transação do caller.
// Lança se a tabela não existir (42P01) ou faltar coluna (42703) — a rota
// mapeia para 503 MIGRATION_PENDING e faz ROLLBACK da correção inteira.
async function recordTransferCorrection(client, entry) {
  const {
    transferId, federationId, practitionerId = null, action,
    actorUserId = null, before = null, after = null, reason = null,
  } = entry || {};

  if (!transferId || !federationId || !VALID_ACTIONS.includes(action)) {
    throw new Error(`[karateTransferAudit] entrada inválida: ${JSON.stringify({ transferId, federationId, action })}`);
  }

  const actorLabel = await resolveActorLabel(client, actorUserId);

  await client.query(
    `INSERT INTO karate_practitioner_transfer_audit
       (transfer_id, federation_id, practitioner_id, action, actor_user_id, actor_label, before, after, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      transferId, federationId, practitionerId, action, actorUserId, actorLabel,
      before !== null && before !== undefined ? JSON.stringify(before) : null,
      after !== null && after !== undefined ? JSON.stringify(after) : null,
      reason,
    ]
  );
}

module.exports = { recordTransferCorrection, resolveActorLabel, VALID_ACTIONS };
