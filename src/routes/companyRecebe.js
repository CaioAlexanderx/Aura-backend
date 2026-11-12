// ============================================================
// AURA. — Recebe na Aura: rotas da subconta da empresa (RA-05, 10/11/2026)
//
//   GET  /companies/:id/recebe/status      status da subconta desta empresa,
//          com a situação nos 4 blocos (RA-06): blocks[{key, status}]
//   POST /companies/:id/recebe/status/atualizar  lê a situação na Asaas com a
//          chave da subconta e grava (RA-06)
//   POST /companies/:id/recebe/onboarding  cria a subconta (idempotente)
//          body: dados do titular + holder_type ('PJ' padrão | 'PF' | 'MEI')
//
// Montado em routes/private.js: requireAuth + requireCompanyAccess já rodaram
// (o usuário pertence a :id). Aqui: flag primeiro, depois só dono/admin.
//
// Flag RECEBE_NA_AURA_ENABLED desligada → 404 RECEBE_INDISPONIVEL antes de
// tocar a tabela ou a Asaas. Escopo sempre por req.params.id (multi-CNPJ:
// cada empresa do grupo tem a sua subconta; nunca do body/query).
// A apiKey da subconta nunca sai na resposta.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const svc = require('../services/companyBaasService');

function podeMexer(req) {
  return req.companyRole === 'owner' || req.companyRole === 'admin';
}

router.use((req, res, next) => {
  if (!svc.isEnabled()) {
    return res.status(404).json({
      error: `O ${svc.RECEBE_NA_AURA_NAME} ainda não está disponível.`,
      code: 'RECEBE_INDISPONIVEL',
    });
  }
  if (!podeMexer(req)) {
    return res.status(403).json({
      error: `Só o dono ou um admin da empresa mexe no ${svc.RECEBE_NA_AURA_NAME}.`,
      code: 'SOMENTE_DONO_OU_ADMIN',
    });
  }
  return next();
});

function sendError(res, e, ctx) {
  if (e && e.status && e.code) {
    return res.status(e.status).json({ error: e.message, code: e.code });
  }
  console.error(`[companyRecebe] ${ctx}:`, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

router.get('/status', async (req, res) => {
  try {
    return res.json(await svc.getStatus(req.params.id));
  } catch (e) {
    return sendError(res, e, 'status');
  }
});

router.post('/status/atualizar', async (req, res) => {
  try {
    return res.json(await svc.refreshStatus(req.params.id));
  } catch (e) {
    return sendError(res, e, 'status/atualizar');
  }
});

router.post('/onboarding', async (req, res) => {
  try {
    const out = await svc.createAccount(req.params.id, req.body || {}, {
      userId: req.user && req.user.id,
    });
    return res.status(out.created ? 201 : 200).json(out);
  } catch (e) {
    return sendError(res, e, 'onboarding');
  }
});

module.exports = router;
