// ============================================================
// AURA KARATÊ — Fase G3: rastro de ações financeiras (quem fez, quando)
//
// Contexto: um clique acidental em QA marcou 3 anuidades reais como pagas
// em produção — só foi possível reconstruir o que aconteceu porque alguém
// olhou updated_at no minuto seguinte. Este módulo grava autor + antes/depois
// de TODA ação que mexe em dinheiro de anuidade (baixa, void, criação de
// cobrança, campanha, lote, troca de plano, e-mail de cobrança).
//
// ⚠️ REGRA DE OURO: o log NUNCA pode derrubar a operação principal.
//   logFinanceAudit() roda numa conexão PRÓPRIA do pool (db.query) — não é
//   client.query() de nenhuma transação em curso no caller. Por isso é
//   seguro chamar mesmo já dentro de um BEGIN/COMMIT do caller: uma falha
//   aqui nunca envenena a transação principal (essa é a armadilha real:
//   um try/catch "best-effort" dentro de BEGIN sem SAVEPOINT deixa a
//   transação em estado "aborted" e todo COMMIT subsequente falha — ver
//   CLAUDE.md #10). Usar uma conexão separada evita a armadilha por
//   construção, sem precisar de SAVEPOINT nenhum.
//
// Convenção adotada por todos os callers: logFinanceAudit() SEMPRE é
// chamado DEPOIS do COMMIT da operação principal ter sucedido (nunca antes,
// nunca dentro do BEGIN) — before/after são montados a partir de dados já
// lidos/conhecidos pelo handler (SELECT feito antes do UPDATE, ou o próprio
// RETURNING do UPDATE), sem nenhuma query extra dentro da transação
// principal — isso preserva o número de queries dos handlers existentes.
// ============================================================
'use strict';

const db = require('../config/database');

const VALID_SOURCES = ['ui', 'batch', 'campaign', 'webhook', 'api'];
const VALID_TARGET_TYPES = ['annuity', 'installment'];

// Cache module-level do nome/e-mail do usuário — evita 1 SELECT por
// chamada em loops de lote/campanha (o mesmo actor assina todas as linhas
// daquela chamada). TTL implícito: vive enquanto o processo vive; plano/
// dados de usuário raramente mudam o nome, e mesmo que mudem o pior caso é
// um rótulo levemente desatualizado no histórico — aceitável (é rótulo de
// exibição, não fonte de verdade de autorização).
const actorLabelCache = new Map();

async function resolveActorLabel(userId) {
  if (!userId) return 'sistema';
  if (actorLabelCache.has(userId)) return actorLabelCache.get(userId);
  try {
    const { rows } = await db.query('SELECT full_name, email FROM users WHERE id = $1', [userId]);
    const label = rows[0] ? (rows[0].full_name || rows[0].email || 'usuário') : 'usuário';
    actorLabelCache.set(userId, label);
    return label;
  } catch (e) {
    console.error('[karateFinanceAudit] falha ao resolver actor_label:', e.message);
    return 'usuário';
  }
}

// Helper de conveniência pros handlers: extrai o autor do request
// autenticado (req.user.id vem do JWT — ver middleware/auth.js).
function actorFromReq(req) {
  return { actorUserId: (req.user && req.user.id) || null };
}

// Grava uma linha de auditoria financeira. NUNCA lança — se a gravação
// falhar, registra o erro no console e retorna undefined silenciosamente.
// `source`: 'ui'|'batch'|'campaign'|'webhook'|'api'. `actorLabel`, se não
// informado, é resolvido a partir de actorUserId (ou 'webhook'/'sistema'
// quando não há usuário).
async function logFinanceAudit(entry) {
  try {
    const {
      federationId, action, targetType, targetId = null,
      dojoId = null, practitionerId = null,
      actorUserId = null, actorLabel = null,
      source = 'ui', before = null, after = null,
    } = entry || {};

    if (!federationId || !action || !VALID_TARGET_TYPES.includes(targetType)) {
      console.error('[karateFinanceAudit] entrada inválida, log descartado:', { federationId, action, targetType });
      return;
    }

    const resolvedSource = VALID_SOURCES.includes(source) ? source : 'api';
    const resolvedLabel = actorLabel
      || (resolvedSource === 'webhook' ? 'webhook' : await resolveActorLabel(actorUserId));

    await db.query(
      `INSERT INTO karate_finance_audit_log
         (federation_id, action, target_type, target_id, dojo_id, practitioner_id,
          actor_user_id, actor_label, source, before, after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        federationId, action, targetType, targetId, dojoId, practitionerId,
        actorUserId, resolvedLabel, resolvedSource,
        before !== null && before !== undefined ? JSON.stringify(before) : null,
        after !== null && after !== undefined ? JSON.stringify(after) : null,
      ]
    );
  } catch (err) {
    // Best-effort de propósito: falha ao logar NUNCA derruba a operação
    // financeira principal (ela já foi commitada quando chegamos aqui).
    console.error('[karateFinanceAudit] falha ao gravar log (operação principal NÃO foi afetada):', err.message);
  }
}

module.exports = { logFinanceAudit, resolveActorLabel, actorFromReq, VALID_SOURCES, VALID_TARGET_TYPES };
