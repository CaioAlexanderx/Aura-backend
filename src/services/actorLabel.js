// ============================================================
// AURA — QUEM AGIU: o RÓTULO do ator (users.full_name)
//
// As colunas `*_label` deste produto (reviewed_by_label, started_by_label,
// completed_by_label, reported_by_label, decided_by_label…) existem para
// CONGELAR o nome de quem praticou o ato, no momento em que ele foi
// praticado. Resolver por JOIN depois NÃO é equivalente: o usuário pode
// sair da empresa/federação, e a trilha de auditoria de um ato que muda o
// cadastro de uma pessoa (inativar, transferir de dojô) não pode depender
// de um vínculo que continua vivo.
//
// ── ⚠️ O LABEL NÃO PODE VIR DO TOKEN ────────────────────────
// `req.user` é o payload CRU do JWT. `signAccessToken` (src/routes/auth.js)
// assina apenas id, role, plan, company, is_staff, consolidated_view,
// federation_id, karate_role e dojo_id — NÃO assina `name` nem `email`.
// Então `req.user.name` é SEMPRE undefined e todo `*_label` alimentado por
// ele gravava NULL em produção:
//   • 12/08/2026 — lado DOJÔ: reviewed_by_label / started_by_label /
//     completed_by_label / reported_by_label (corrigido no PR #489);
//   • 12/08/2026 — lado FEDERAÇÃO: decided_by_label NULL nas 3 decisões
//     validadas em produção (este módulo).
// Pôr o nome no JWT "resolveria" os dois de uma vez e INVALIDARIA todo
// token em uso. O nome se resolve aqui, no banco.
//
// ── A COLUNA É `full_name` ──────────────────────────────────
// NÃO existe `users.name`. Fallback: full_name → email → NULL.
//
// ── UMA VEZ POR REQUISIÇÃO ──────────────────────────────────
// Quem chama resolve UMA vez e reusa no lote inteiro — nunca uma consulta
// por linha afetada (a marcação do plantel vai a 500 ids por chamada, e
// seriam 500 idas ao banco para escrever sempre o mesmo texto).
//
// ── BEST-EFFORT, SEMPRE ─────────────────────────────────────
// O rótulo é enfeite da trilha; o uuid (`*_by`) é o dado forte e ele vem do
// token. Falha na resolução vira warn e label NULL — NUNCA derruba o ato.
// Por isso também roda FORA de qualquer BEGIN: um SELECT que falhasse
// dentro da transação a envenenaria (tx-poison).
//
// ── ÂNCORA SQL ──────────────────────────────────────────────
// `-- drr:actor-label`. Os testes da feature (mock por SQL, nunca fila
// posicional) despacham por essa âncora — mudá-la quebra o despachante.
// ============================================================
'use strict';

const db = require('../config/database');

/**
 * @param {{userId?: string|null, label?: string|null}} actor
 * @returns {Promise<{userId: string|null, label: string|null}>}
 */
async function resolveActor(actor) {
  const userId = (actor && actor.userId) || null;
  const given = (actor && actor.label) || null;
  // Sem usuário não há o que resolver (e não há o que gravar em `*_by`).
  if (!userId) return { userId: null, label: given };
  // Rótulo já resolvido por quem chamou (ex.: fluxo público com nome
  // declarado) — respeita e não vai ao banco.
  if (given) return { userId, label: given };
  try {
    const { rows } = await db.query(
      `-- drr:actor-label
       SELECT full_name, email
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );
    if (!rows.length) return { userId, label: null };
    const fullName = rows[0].full_name != null ? String(rows[0].full_name).trim() : '';
    const email = rows[0].email != null ? String(rows[0].email).trim() : '';
    return { userId, label: fullName || email || null };
  } catch (e) {
    console.warn('[actorLabel] label do ator não resolvido (não bloqueia):', e.message);
    return { userId, label: null };
  }
}

module.exports = { resolveActor };
