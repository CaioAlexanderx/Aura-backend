// ============================================================
// AURA DOJÔ — F6: inbox de filiação (LADO FEDERAÇÃO)
// Montado sob /federation/:id. Guards de karateRoles.
//
//   GET  /federation/:id/affiliation-requests?status=
//   GET  /federation/:id/affiliation-requests/metrics
//   POST /federation/:id/affiliation-requests/revoke               {dojo_id, reason}
//   POST /federation/:id/affiliation-requests/:requestId/approve   {fpkt_number}
//   POST /federation/:id/affiliation-requests/:requestId/reject    {reason}
//
// ⚠️ ORDEM DAS ROTAS: '/affiliation-requests/metrics' e
// '/affiliation-requests/revoke' são ESTÁTICAS e precisam vir ANTES de
// qualquer '/affiliation-requests/:requestId...' — armadilha já paga em
// produção neste repo (o Express tratou 'roster-progress' como UUID e
// estourou "invalid input syntax for type uuid"). Aqui as duas estáticas têm
// 2 segmentos e as paramétricas têm 3, então não haveria captura de qualquer
// forma; declarar na ordem certa é para a próxima pessoa não precisar contar
// segmento nenhum.
//
// APROVAR = CONECTAR (decisão do Caio): o aceite seta
// companies.karate_dojo_linked_at (migration 251) + fpkt_affiliation_id +
// affiliation_since, tudo numa transação. Não depende de pagamento — a
// anuidade segue o fluxo que já existe. O número de filiação é SEMPRE
// digitado aqui pela federação: sem ele, 422.
//
// REVOGAR = DESCONECTAR (decisão do Caio, 30/07/2026 — F7.4): "Somente a
// federação pode cancelar esse vínculo. Dojô solicita, federação pode
// aceitar e posteriormente revogar." O ciclo inteiro (pedir → aceitar →
// revogar) mora aqui, e as três pontas usam o mesmo serviço.
//
// REVOGAR ≠ INATIVAR (decisão do Caio, 31/07/2026 — F7.4): "A inativação é
// feita pela própria federação." Revogar a filiação e inativar os praticantes
// do dojô eram, na primeira versão, um ato só. São dois. A inativação segue
// pelo caminho que a federação já tinha — cascadeInactivateDojo(), o
// "Suspender" do PATCH /federation/:id/dojos/:dojoId, em karateDojos.js —
// que não foi alterado por esta F7.4 e é independente da revogação.
//
// Decisão de produto (revertendo PR #433 / migration 255): a federação
// NUNCA abre uma filiação espontaneamente. É sempre o dojô que assina a
// Aura quem inicia o pedido (self-serve, POST /dojo/connection). O inbox
// abaixo é puramente self-serve — sem POST base de criação aqui.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { guards } = require('../config/karateRoles');
const svc = require('../services/karateAffiliationRequestService');

function sendServiceError(res, e, context) {
  if (e && e.isServiceError) {
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
  console.error(`[karateAffiliationRequestsAdmin] ${context} error:`, e.message);
  return res.status(500).json({ error: 'Erro ao processar solicitação de filiação' });
}

// ── GET listar (inbox) ──────────────────────────────────────
// Pendentes primeiro, mais recentes no topo. 42P01 (migration 252
// pendente) degrada para lista vazia + schema_pending — a tela abre.
router.get('/affiliation-requests', ...guards.read(), async (req, res) => {
  try {
    const out = await svc.listRequests({
      federationId: req.params.id,
      status: req.query.status,
    });
    return res.json(out);
  } catch (e) {
    return sendServiceError(res, e, 'GET /affiliation-requests');
  }
});

// ── GET métricas da fila (ROTA ESTÁTICA — antes de :requestId) ──
router.get('/affiliation-requests/metrics', ...guards.read(), async (req, res) => {
  try {
    const out = await svc.requestMetrics({ federationId: req.params.id });
    return res.json(out);
  } catch (e) {
    return sendServiceError(res, e, 'GET /affiliation-requests/metrics');
  }
});

// ── POST revogar a filiação (ROTA ESTÁTICA — antes de :requestId) ──
// O ato de cancelar o vínculo é EXCLUSIVO da federação (guards.staffWrite()
// no escopo /federation/:id). Não existe caminho pelo qual o dojô se
// desfilie sozinho: do lado dele (karateDojoConnection.js) só há o GET do
// estado e o POST do PEDIDO, e este PR não abre nenhuma porta nova.
//
// O alvo é o DOJÔ, não a solicitação: todo dojô criado PELA federação nasce
// filiado sem nunca ter existido uma linha em karate_affiliation_requests
// (ver getConnectionState) — chavear a revogação por :requestId deixaria
// exatamente esses de fora.
//
// O que a revogação faz (detalhe e justificativa em revokeAffiliation): zera
// companies.karate_dojo_linked_at e grava a trilha do ato. NÃO INATIVA
// NINGUÉM — a inativação é ato próprio da federação, pelo "Suspender" do
// dojô (cascadeInactivateDojo, em karateDojos.js). Também não apaga nada e
// NÃO devolve a gestão das fichas: o dojô desfiliado continua usando o Aura e
// continua dono da identidade dos alunos dele.
//
// A resposta INFORMA quantos praticantes ativos o dojô ainda tem
// (active_practitioners) para a federação decidir se suspende. É número na
// tela, não gatilho.
//
// 200 { ok, revoked, dojo_id, was_linked_at, practitioners_changed:false,
//       identity_management_changed:false, active_practitioners }
// 422 REVOKE_REASON_REQUIRED | 404 NOT_FOUND | 409 NAO_CONECTADO
router.post('/affiliation-requests/revoke', ...guards.staffWrite(), async (req, res) => {
  const body = req.body || {};
  try {
    const out = await svc.revokeAffiliation({
      federationId: req.params.id,
      dojoId: body.dojo_id,
      reason: body.reason,
      actorId: (req.user && req.user.id) || null,
    });
    return res.json(out);
  } catch (e) {
    return sendServiceError(res, e, 'POST /affiliation-requests/revoke');
  }
});

// ── POST aprovar (aceite = conexão) ─────────────────────────
// 200 { ok, dojo_id, fpkt_affiliation_id, linked_at }
// 422 FPKT_NUMBER_REQUIRED | 409 FPKT_NUMBER_TAKEN | 409 JA_RESOLVIDA
router.post('/affiliation-requests/:requestId/approve', ...guards.staffWrite(), async (req, res) => {
  try {
    const out = await svc.approveRequest({
      federationId: req.params.id,
      requestId: req.params.requestId,
      fpktNumber: req.body && req.body.fpkt_number,
      actorId: (req.user && req.user.id) || null,
    });
    return res.json(out);
  } catch (e) {
    return sendServiceError(res, e, 'POST /affiliation-requests/:requestId/approve');
  }
});

// ── POST recusar (motivo obrigatório) ───────────────────────
// O sensei precisa ver o porquê para corrigir e reenviar (mesma regra do
// H1). NÃO toca karate_dojo_linked_at.
router.post('/affiliation-requests/:requestId/reject', ...guards.staffWrite(), async (req, res) => {
  try {
    const out = await svc.rejectRequest({
      federationId: req.params.id,
      requestId: req.params.requestId,
      reason: req.body && req.body.reason,
      actorId: (req.user && req.user.id) || null,
    });
    return res.json(out);
  } catch (e) {
    return sendServiceError(res, e, 'POST /affiliation-requests/:requestId/reject');
  }
});

module.exports = router;
