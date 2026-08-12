// ============================================================
// AURA DOJÔ — F11.3: REVISÃO DO PLANTEL HERDADO (lado DOJÔ)
// Migration 276. Montado sob /federation/:id (padrão karateDojoStudents /
// karateDojoTags). Guard: requireDojoAccess (Canal A = JWT da conta do
// dojô com dojo_id; Canal B = token do portal).
// REGRA DE CANAL: GETs aceitam A e B; POSTs exigem Canal A — o portal é
// somente leitura (403 PORTAL_READ_ONLY).
//
// ── O QUE ESTA TELA RESOLVE ─────────────────────────────────
// Quando o sensei assume o registro federativo (F11.0–F11.2, migration
// 275), ele herda os praticantes que já apontavam para aquela linha. A
// lista da FPKT está velha: 9.840 praticantes em 105 registros, com 4.033
// pendurados em 74 dojôs marcados como inativos. Aqui ele revisa esse
// plantel e marca quem realmente treina com ele.
//
// ── ⚠️ O QUE ESTAS ROTAS NÃO FAZEM ──────────────────────────
// NÃO INATIVAM NINGUÉM. "Não reconhecido" não é sinônimo de "inativo" — o
// praticante pode ter MUDADO DE DOJÔ (karate_practitioner_transfers, 540
// linhas). Concluir a revisão gera AVISOS para a federação
// (karate_dojo_roster_review_notices), e é ela quem decide entre inativar,
// transferir ou manter, pela rota dela
// (karateRosterReviewNoticesAdmin.js). A resposta do /complete devolve
// `practitioners_changed:false` justamente para deixar isso explícito no
// contrato, não só no comentário.
//
// ── VOLUME E RETOMADA ───────────────────────────────────────
// O maior dojô da planilha tem 288 alunos (os registros chegam a mais):
//   • /roster é paginado (limit até 200) e tem busca por nome/matrícula;
//   • /mark aceita ATÉ 500 praticantes por chamada — obrigar a 300 cliques
//     individuais mataria a feature;
//   • o estado PERSISTE: marca metade hoje, termina amanhã. A revisão é
//     criada na PRIMEIRA marcação (nunca num GET — listagem não escreve) e
//     só fecha no /complete;
//   • reenviar a mesma marcação é idempotente (índice único
//     (review_id, practitioner_id) + DO UPDATE), e concluir duas vezes não
//     duplica aviso (DO NOTHING).
//
// ── ⚠️ LEITURA É PELA REVISÃO CORRENTE, NÃO PELA ABERTA ──────
// Depois do /complete não existe revisão 'in_progress'. Ler o plantel pela
// aberta fazia o backend esquecer as marcações da revisão recém-concluída:
// contador voltava ao plantel inteiro como "pendente" e a lista inteira
// aparecia sem marcação (produção, 12/08/2026). Os dois GETs usam
// svc.getCurrentReview() = aberta || última, mesmo já concluída. ESCRITA
// continua exigindo uma revisão aberta.
//
// Escopo SEMPRE por req.dojoId / req.federationId do guard — nunca do
// body/query. Defensivo 42P01 (migration 276 pendente): GETs degradam
// (plantel listado, todo mundo 'pending', schema_pending:true); POSTs
// devolvem 503 SCHEMA_PENDING.
//
//   GET  /federation/:id/dojo/roster-review            (estado + contagens)
//   GET  /federation/:id/dojo/roster-review/roster     (?q=&status=&review_status=&limit=&offset=)
//   POST /federation/:id/dojo/roster-review/mark       ({practitioner_ids:[], status})
//   POST /federation/:id/dojo/roster-review/complete   ({pending_policy?})
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoRosterReviewService');

// Canal B (portal do dojô) é SOMENTE LEITURA — mesma regra de
// karateDojoStudents.js / karateDojoTags.js. Checado antes de qualquer
// db.query: o motivo do 403 não depende de estado nenhum do banco.
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para revisar o plantel.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

// Quem está agindo — SEMPRE do token, nunca do corpo. Vai para
// reviewed_by/started_by/completed_by e para a trilha em
// karate_dojo_roster_events.
//
// ⚠️ SÓ O uuid SAI DAQUI. O nome (os *_label) é resolvido no serviço, no
// banco (users.full_name). `req.user` é o payload cru do JWT e NÃO tem
// `name` nem `email` — signAccessToken (routes/auth.js) assina apenas id,
// role, plan, company, is_staff, consolidated_view, federation_id,
// karate_role e dojo_id. Ler req.user.name aqui gravava NULL em todos os
// *_label em produção; e pôr o nome no JWT invalidaria os tokens em uso.
function actorFrom(req) {
  return {
    userId: (req.user && req.user.id) || null,
    label: null,
  };
}

function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    // REVISAO_INCOMPLETA volta com os números para o front conseguir
    // perguntar "e os outros 248?" sem uma segunda chamada.
    if (e.summary) body.summary = e.summary;
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (svc.isMissingRelation(e)) {
    return res.status(503).json({
      error: 'Revisão do plantel ainda não disponível (migration 276 pendente)',
      code: 'SCHEMA_PENDING',
      pg_code: '42P01',
    });
  }
  // 22P02: veio um id que não é UUID no lote. É erro do CLIENTE, não nosso
  // — 422 com o código próprio em vez de um 500 genérico.
  if (e && e.code === '22P02') {
    return res.status(422).json({
      error: 'Lista de praticantes contém um identificador inválido',
      code: 'INVALID_PRACTITIONER_ID',
    });
  }
  console.error(`[karateDojoRosterReview] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

// ── GET /federation/:id/dojo/roster-review ──────────────────
// Estado da revisão (a aberta; se não houver, a última concluída) +
// contagens do plantel INTEIRO **daquela mesma revisão**. É o que alimenta
// a barra de progresso e o badge da aba.
//
// `review_status` vem repetido no topo (além de dentro de `review`) para o
// front distinguir "concluída, sem pendências" de "em andamento" sem
// inferir isso de `summary.pending === 0`.
//
// ⚠️ NÃO cria revisão. Abrir a tela para olhar não é começar a revisar.
router.get('/dojo/roster-review', requireDojoAccess, async (req, res) => {
  try {
    const state = await svc.getReviewState(req.dojoId, req.federationId);
    return res.json(state);
  } catch (e) {
    if (svc.isMissingRelation(e)) {
      return res.json({
        review: null,
        review_status: null,
        summary: { inherited_total: 0, recognized: 0, not_recognized: 0, pending: 0, inactive_in_federation: 0 },
        schema_pending: true,
      });
    }
    console.error('[karateDojoRosterReview] state error:', e.message);
    return res.status(500).json({ error: 'Erro ao carregar a revisão do plantel' });
  }
});

// ── GET /federation/:id/dojo/roster-review/roster ───────────
// O plantel herdado, paginado, com o estado da revisão por praticante.
//   ?q=              nome ou matrícula (ILIKE)
//   ?status=         active | inactive  (status NA FEDERAÇÃO — não é a marcação)
//   ?review_status=  recognized | not_recognized | pending
//   ?limit=&offset=  (limit default 50, teto 200)
//
// `review_status` de quem nunca foi tocado é 'pending' — não existe linha
// para ele (ver migration 276: a AUSÊNCIA é o estado).
//
// ⚠️ O JOIN é com a revisão CORRENTE (aberta OU a última concluída), o
// mesmo critério do summary — se a listagem olhasse só a aberta, depois do
// /complete a tela se contradiria: "1 reconhecido / 3 não reconheço" no
// cabeçalho e a lista inteira sem marcação embaixo.
router.get('/dojo/roster-review/roster', requireDojoAccess, async (req, res) => {
  try {
    const current = await svc.getCurrentReview(req.dojoId).catch((e) => {
      if (svc.isMissingRelation(e)) return null;
      throw e;
    });
    const page = await svc.listRoster(req.dojoId, req.federationId, {
      reviewId: current ? current.id : null,
      q: req.query.q,
      status: req.query.status,
      review_status: req.query.review_status,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json(Object.assign({
      review_id: current ? current.id : null,
      review_status: current ? current.status : null,
    }, page));
  } catch (e) {
    if (svc.isMissingRelation(e)) {
      const paging = svc.parsePaging(req.query);
      return res.json({
        review_id: null,
        review_status: null,
        data: [],
        count: 0,
        limit: paging.limit,
        offset: paging.offset,
        schema_pending: true,
      });
    }
    console.error('[karateDojoRosterReview] roster error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar o plantel herdado' });
  }
});

// ── POST /federation/:id/dojo/roster-review/mark ────────────
// Marcação EM LOTE. Body:
//   { practitioner_ids: [uuid], status: 'recognized'|'not_recognized'|'pending' }
//
// 'pending' é o DESMARCAR (apaga a marcação e devolve ao estado "ainda não
// revisado") — errar um clique não pode ser irreversível.
//
// Idempotente: reenviar o mesmo lote faz DO UPDATE do status, nunca uma
// segunda linha. Id de praticante que não é deste dojô volta em `skipped`
// e NUNCA escreve — o escopo é o dojo_id do token, jamais o corpo.
//
// A revisão é CRIADA aqui, na primeira marcação (e só se houver ao menos
// um id válido deste dojô).
router.post('/dojo/roster-review/mark', requireDojoAccess, requireChannelA, async (req, res) => {
  const b = req.body || {};
  try {
    const out = await svc.markBatch(
      req.dojoId,
      req.federationId,
      { practitionerIds: b.practitioner_ids, status: b.status },
      actorFrom(req)
    );
    return res.json(out);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/roster-review/mark');
  }
});

// ── POST /federation/:id/dojo/roster-review/complete ────────
// Fecha a revisão e GERA OS AVISOS para a federação. Body:
//   { pending_policy?: 'not_recognized' | 'recognized' }
//
// SEM pending_policy e com gente não revisada → 409 REVISAO_INCOMPLETA
// (com `summary` no corpo). "Não revisado" e "não reconhecido" são estados
// diferentes; transformar um no outro por omissão seria exatamente o erro
// que esta fase existe para não cometer. Com a policy, o sensei declara
// explicitamente o que fazer com o restante — um clique em vez de 300.
//
// 200 { review, summary, notices_created, practitioners_changed:false }
//     ⚠️ practitioners_changed é SEMPRE false: nada em customers é tocado
//     aqui. Quem inativa/transfere/mantém é a federação.
// 409 REVISAO_NAO_INICIADA | REVISAO_INCOMPLETA | REVISAO_JA_CONCLUIDA
router.post('/dojo/roster-review/complete', requireDojoAccess, requireChannelA, async (req, res) => {
  const b = req.body || {};
  try {
    const out = await svc.completeReview(
      req.dojoId,
      req.federationId,
      { pendingPolicy: b.pending_policy },
      actorFrom(req)
    );
    return res.json(out);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/roster-review/complete');
  }
});

module.exports = router;
