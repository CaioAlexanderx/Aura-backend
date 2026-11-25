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
//    com ASAAS_ENV=sandbox), derivado POR SUBCONTA (HMAC com o company_id da
//    conta do corpo; 25/11). Sem segredo configurado, conta desconhecida ou
//    token errado → 401, nada gravado (só a leitura da conta para saber qual
//    token esperar). A resposta não diz qual foi.
// 2. Depois o serviço (services/recebeWebhookService): flag, idempotência
//    pelo id do evento, situação da conta, registro dos pagamentos.
// ============================================================
'use strict';

const router = require('express').Router();
const svc = require('../services/recebeWebhookService');

router.post('/', async (req, res) => {
  let auth;
  try {
    // Token da SUBCONTA do aviso (account.id do corpo → empresa → HMAC).
    auth = await svc.checkToken(req.headers['asaas-access-token'], req.body);
  } catch (e) {
    console.error('[recebe-webhook] falha ao conferir o aviso:', e && (e.code || e.message));
    return res.status(500).json({ received: false, code: 'INTERNAL_ERROR' });
  }
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
