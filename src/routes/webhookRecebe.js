// ============================================================
// AURA. — Recebe na Aura: webhook das SUBCONTAS das lojas (RA-07, 13/11/2026)
//
//   POST /webhooks/asaas-recebe
//
// PÚBLICO (a Asaas não tem sessão Aura), separado do webhook das assinaturas
// da Aura (/webhooks/asaas) e do BaaS do dojô (/webhooks/asaas-dojo).
//
// 1. Token primeiro, sempre: header `asaas-access-token` contra o segredo do
//    ambiente (RECEBE_ASAAS_WEBHOOK_TOKEN, ou RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN
//    com ASAAS_ENV=sandbox). Sem segredo configurado, ou token errado → 401,
//    nada lido nem gravado. A resposta não diz qual dos dois foi.
// 2. Depois o serviço (services/recebeWebhookService): flag, idempotência
//    pelo id do evento, situação da conta, registro dos pagamentos.
// ============================================================
'use strict';

const router = require('express').Router();
const svc = require('../services/recebeWebhookService');

router.post('/', async (req, res) => {
  const auth = svc.checkToken(req.headers['asaas-access-token']);
  if (!auth.ok) {
    const grave = auth.reason === 'sem_segredo_configurado' || auth.reason === 'segredo_curto_demais';
    const msg = `[recebe-webhook] recusado (401): ${auth.reason}` +
      (grave ? ` — configure ${svc.secretEnvName()} (mínimo ${svc.MIN_TOKEN_LENGTH} caracteres)` : '');
    if (grave) console.error(msg); else console.warn(msg);
    return res.status(401).json({ error: 'Não autorizado', code: 'UNAUTHORIZED' });
  }
  try {
    const out = await svc.handleEvent(req.body);
    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[recebe-webhook] erro inesperado:', e && e.message);
    return res.status(500).json({ received: false, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
