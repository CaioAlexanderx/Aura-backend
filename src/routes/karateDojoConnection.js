// ============================================================
// AURA DOJÔ — F6: conexão/filiação do dojô à federação (LADO DOJÔ)
// Montado sob /federation/:id. Guard requireDojoAccess (Canal A = JWT do
// Aura Dojô, Canal B = portal do responsável).
//
//   GET  /federation/:id/dojo/connection
//        — estado da conexão: none | pending | approved | rejected.
//          Canal A e B (o portal LÊ).
//   POST /federation/:id/dojo/connection
//        — cria a solicitação de filiação. SÓ Canal A (403
//          PORTAL_READ_ONLY no Canal B — pedir filiação é ato do dono da
//          conta, não de quem tem um link de leitura).
//
// Por que isto existe: companies.federation_id é vínculo TÉCNICO
// (roteamento/guard); a VISIBILIDADE para a federação é
// companies.karate_dojo_linked_at (migration 251). O dojô self-serve
// nascia com o primeiro e sem o segundo — invisível para a federação (PR
// #420) e sem as superfícies federativas (PR #422), SEM caminho nenhum
// para pedir conexão. Esta é a porta.
//
// dojo_id/federation_id vêm SEMPRE do token (req.dojoId/req.federationId),
// nunca do corpo.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateAffiliationRequestService');

const isTestEnv = () => process.env.NODE_ENV === 'test';

// Um dojô se filia UMA vez. 10/10min já é folga absurda para retentativa
// legítima de formulário e fecha a porta para flood.
const connectionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.dojoId || 'no-dojo'}:${req.ip || 'no-ip'}`,
  skip: () => isTestEnv(),
});

// Traduz o erro do service (status + code) para HTTP. Erro sem .status é
// bug nosso → 500 genérico com log.
function sendServiceError(res, e, context) {
  if (e && e.isServiceError) {
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
  console.error(`[karateDojoConnection] ${context} error:`, e.message);
  return res.status(500).json({ error: 'Erro ao processar conexão com a federação' });
}

// ── GET /federation/:id/dojo/connection ─────────────────────
// Nunca 403/404 por não estar conectado: o front precisa do ESTADO para
// escolher a tela (convite para pedir, "em análise", motivo da recusa ou
// dojô conectado).
router.get('/dojo/connection', requireDojoAccess, async (req, res) => {
  try {
    const state = await svc.getConnectionState({
      dojoId: req.dojoId,
      federationId: req.federationId,
    });
    return res.json(state);
  } catch (e) {
    return sendServiceError(res, e, 'GET /dojo/connection');
  }
});

// ── POST /federation/:id/dojo/connection ────────────────────
// 201 { id, status:'pending' }                — pedido criado
// 200 { id, status:'pending', already_pending } — já havia pendente
// 409 JA_CONECTADO                             — já é filiado
// 422 VALIDATION_ERROR                         — sem nome/telefone de contato
router.post('/dojo/connection', requireDojoAccess, connectionLimiter, async (req, res) => {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal é somente leitura. Peça a filiação pela conta do dojô no app.',
      code: 'PORTAL_READ_ONLY',
    });
  }

  try {
    const out = await svc.createConnectionRequest({
      dojoId: req.dojoId,
      federationId: req.federationId,
      body: req.body || {},
    });
    return res.status(out.already_pending ? 200 : 201).json(out);
  } catch (e) {
    return sendServiceError(res, e, 'POST /dojo/connection');
  }
});

module.exports = router;
