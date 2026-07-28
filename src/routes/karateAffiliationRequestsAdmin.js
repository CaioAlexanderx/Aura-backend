// ============================================================
// AURA DOJÔ — F6: inbox de filiação (LADO FEDERAÇÃO)
// Montado sob /federation/:id. Guards de karateRoles.
//
//   GET  /federation/:id/affiliation-requests?status=
//   GET  /federation/:id/affiliation-requests/metrics
//   POST /federation/:id/affiliation-requests                     {dojo_id,...}
//   POST /federation/:id/affiliation-requests/:requestId/approve  {fpkt_number}
//   POST /federation/:id/affiliation-requests/:requestId/reject   {reason}
//
// ⚠️ ORDEM DAS ROTAS: '/affiliation-requests/metrics' é ESTÁTICA e precisa
// vir ANTES de qualquer '/affiliation-requests/:requestId...' — armadilha
// já paga em produção neste repo (o Express tratou 'roster-progress' como
// UUID e estourou "invalid input syntax for type uuid").
//
// APROVAR = CONECTAR (decisão do Caio): o aceite seta
// companies.karate_dojo_linked_at (migration 251) + fpkt_affiliation_id +
// affiliation_since, tudo numa transação. Não depende de pagamento — a
// anuidade segue o fluxo que já existe. O número de filiação é SEMPRE
// digitado aqui pela federação: sem ele, 422.
//
// CONVERGÊNCIA (migration 255, 27/07/2026): investigação confirmou que
// karate_dojo_connections/"Conectar dojô" (Track F) NÃO é um segundo
// inbox de filiação — é configuração de MODO DE SINCRONIA (native/manual)
// para um dojô que JÁ está linkado (o próprio picker do modal só lista
// dojôs com karate_dojo_linked_at IS NOT NULL) e está parqueada/dormente
// para handshake externo (ver header de karateConnections.js). O ÚNICO
// gap real era: a federação não tinha como abrir ESTE pedido pelo lado
// dela (só o dojô self-serve conseguia, via POST /dojo/connection). O
// POST base abaixo fecha esse gap SEM criar tabela nova: mesmo inbox,
// mesmo approve/reject/FPKT, só o campo `origin` muda.
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

// ── POST criar (LADO FEDERAÇÃO abre pelo dojô) ──────────────
// migration 255: mesmo inbox do self-serve (POST /dojo/connection), só
// que iniciado pela federação — dojo_id no corpo (precisa já estar
// tecnicamente roteado a esta federação: companies.federation_id).
// 201 { id, status:'pending', origin:'federation' }
// 200 { ..., already_pending:true }         — já havia pendente
// 404 DOJO_NOT_FOUND | 422 DOJO_NAO_ROTEADO | 409 JA_CONECTADO
router.post('/affiliation-requests', ...guards.staffWrite(), async (req, res) => {
  try {
    const out = await svc.createFederationInitiatedRequest({
      federationId: req.params.id,
      dojoId: req.body && req.body.dojo_id,
      body: req.body || {},
      actorId: (req.user && req.user.id) || null,
    });
    return res.status(out.already_pending ? 200 : 201).json(out);
  } catch (e) {
    return sendServiceError(res, e, 'POST /affiliation-requests');
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
