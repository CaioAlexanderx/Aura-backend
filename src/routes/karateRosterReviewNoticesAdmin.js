// ============================================================
// AURA DOJÔ — F11.3: AVISOS DA REVISÃO DO PLANTEL (lado FEDERAÇÃO)
// Migration 276. Montado sob /federation/:id. Guards de karateRoles
// (guards.read() para ler, guards.staffWrite() para decidir) — o mesmo
// par usado por karatePractitionerRequestsAdmin.js.
//
// ── O QUE CHEGA AQUI ────────────────────────────────────────
// O sensei revisou o plantel que herdou do registro federativo e concluiu
// a revisão. Cada praticante que ele NÃO reconheceu como aluno atual virou
// uma linha nesta fila. O aviso diz UMA coisa, e só ela:
//
//     "o sensei do dojô X não reconhece esta pessoa como aluno atual dele,
//      em tal data"
//
// ── ⚠️ O QUE O AVISO NÃO DIZ ────────────────────────────────
// Não diz que a pessoa parou de treinar. Ela pode ter MUDADO DE DOJÔ —
// karate_practitioner_transfers tem 540 linhas e o modelo prevê isso desde
// a migration 180. Nada foi inativado quando o aviso nasceu (ver
// karateDojoRosterReviewService.completeReview: `practitioners_changed`
// vem false de propósito). A decisão é aqui, e é humana.
//
// Para ajudar essa decisão, a listagem traz LADO A LADO:
//   • o SNAPSHOT do momento do aviso (nome, matrícula, is_active de então);
//   • o ESTADO ATUAL do praticante (dojo_id e is_active de hoje) e o
//     derivado `practitioner_left_dojo` — "ele já saiu daquele dojô".
// Um aviso cujo praticante hoje está em OUTRO dojô quase sempre é uma
// transferência que ninguém registrou, não alguém que parou de treinar.
//
// ── AS TRÊS DECISÕES ────────────────────────────────────────
//   inactivated → customers.is_active = false (o ÚNICO caminho desta fase
//                 que encosta em is_active; ator identificado).
//   transferred → move para outro dojô + linha em
//                 karate_practitioner_transfers (append-only), reusando o
//                 padrão de approve-transfer.
//   kept        → conferido, fica como está. Sem esta opção a fila nunca
//                 esvaziaria e o "pendente" perderia o sentido.
//
// Escopo: federation_id vem do PATH (:id), com os guards do repo. Inativar
// e transferir são escopados também pelo dojô que avisou — se o praticante
// já saiu de lá, 409 PRATICANTE_JA_SAIU_DO_DOJO em vez de mexer em quem
// hoje treina noutro lugar.
//
// ⚠️ ORDEM DAS ROTAS: '/roster-review-notices/metrics' é ESTÁTICA e vem
// ANTES de qualquer '/roster-review-notices/:noticeId...' — armadilha já
// paga em produção neste repo ('roster-progress' tratado como UUID).
//
//   GET  /federation/:id/roster-review-notices           (?decision=&dojo_id=&q=&limit=&offset=)
//   GET  /federation/:id/roster-review-notices/metrics
//   POST /federation/:id/roster-review-notices/:noticeId/decision
//        { decision, note?, destination_dojo_id? }
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { guards } = require('../config/karateRoles');
const svc = require('../services/karateRosterReviewNoticeService');

function actorFrom(req) {
  return {
    userId: (req.user && req.user.id) || null,
    label: (req.user && (req.user.name || req.user.email)) || null,
  };
}

function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
  }
  if (svc.isMissingRelation(e)) {
    console.error(`[karateRosterReviewNotices] ${ctx}: SCHEMA_PENDING (${e.code}):`, e.message);
    return res.status(503).json({
      error: 'Avisos da revisão do plantel indisponíveis (migration 276 pendente)',
      code: 'SCHEMA_PENDING',
      pg_code: '42P01',
    });
  }
  console.error(`[karateRosterReviewNotices] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

// ── GET /federation/:id/roster-review-notices ───────────────
// A fila. `summary` acompanha a página porque é ele que alimenta os
// contadores do topo da tela e não muda com o filtro/paginação.
router.get('/roster-review-notices', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  try {
    const page = await svc.listNotices(federationId, {
      decision: req.query.decision,
      dojo_id: req.query.dojo_id,
      q: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    const summary = await svc.getSummary(federationId);
    return res.json({ ...page, summary });
  } catch (e) {
    if (svc.isMissingRelation(e)) {
      const paging = svc.parsePaging(req.query);
      console.warn('[karateRosterReviewNotices] migration 276 pendente — fila vazia');
      return res.json({
        data: [], count: 0, limit: paging.limit, offset: paging.offset,
        summary: { ...svc.EMPTY_SUMMARY }, schema_pending: true,
      });
    }
    console.error('[karateRosterReviewNotices] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar avisos de revisão do plantel' });
  }
});

// ── GET /federation/:id/roster-review-notices/metrics ───────
// ROTA ESTÁTICA — declarada ANTES de qualquer paramétrica (ver topo).
router.get('/roster-review-notices/metrics', ...guards.read(), async (req, res) => {
  try {
    const summary = await svc.getSummary(req.params.id);
    return res.json(summary);
  } catch (e) {
    if (svc.isMissingRelation(e)) return res.json({ ...svc.EMPTY_SUMMARY, schema_pending: true });
    console.error('[karateRosterReviewNotices] metrics error:', e.message);
    return res.status(500).json({ error: 'Erro ao calcular métricas dos avisos' });
  }
});

// ── POST /federation/:id/roster-review-notices/:noticeId/decision ──
// { decision: 'inactivated'|'transferred'|'kept', note?, destination_dojo_id? }
//
// 200 { notice, effect }
//     effect.practitioner_changed diz se o praticante foi tocado — false
//     em 'kept', true nas outras duas.
// 404 NOT_FOUND (aviso de outra federação também cai aqui — escopo)
// 409 AVISO_JA_DECIDIDO | PRATICANTE_JA_SAIU_DO_DOJO
// 422 VALIDATION_ERROR | DESTINATION_REQUIRED | DESTINATION_INVALID | DESTINATION_IS_ORIGIN
// 503 MIGRATION_PENDING (karate_practitioner_transfers ausente — a
//     transferência NÃO acontece pela metade)
router.post('/roster-review-notices/:noticeId/decision', ...guards.staffWrite(), async (req, res) => {
  const b = req.body || {};
  try {
    const out = await svc.decideNotice(
      req.params.id,
      req.params.noticeId,
      {
        decision: b.decision,
        note: b.note,
        destinationDojoId: b.destination_dojo_id,
      },
      actorFrom(req)
    );
    return res.json(out);
  } catch (e) {
    return handleWriteError(res, e, 'POST /roster-review-notices/:noticeId/decision');
  }
});

module.exports = router;
