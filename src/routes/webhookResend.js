// ============================================================
// AURA. — POST /api/v1/webhooks/resend (tq-90, 24/10/2026)
//
// Endpoint já cadastrado no painel do Resend pelo Caio (21/10). Público,
// autenticado SÓ pela assinatura svix (services/resendWebhook):
//   - sem RESEND_WEBHOOK_SECRET: 503 e log; nada é aceito sem verificar;
//   - assinatura inválida, timestamp fora de 5 min ou corpo alterado: 401;
//   - válido: aplica no email_log e responde 200 (evento desconhecido ou
//     resend_id que não é nosso também: 200, para o Resend não reenviar).
//   - erro de banco: 500, e o Resend tenta de novo (o evento é idempotente).
//
// O corpo cru vem de req.rawBody (express.json com verify, src/app.js). O
// segredo nunca é logado.
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { verificarAssinatura, aplicarEvento } = require('../services/resendWebhook');

let avisouSemSegredo = false;

router.post('/', async (req, res) => {
  const segredo = process.env.RESEND_WEBHOOK_SECRET;
  if (!segredo || !String(segredo).trim()) {
    if (!avisouSemSegredo) {
      console.error('[webhookResend] RESEND_WEBHOOK_SECRET ausente: evento recusado (503)');
      avisouSemSegredo = true;
    }
    return res.status(503).json({ error: 'webhook não configurado' });
  }

  const corpo = req.rawBody;
  const v = verificarAssinatura({
    segredo,
    id: req.get('svix-id'),
    timestamp: req.get('svix-timestamp'),
    assinatura: req.get('svix-signature'),
    corpo,
  });
  if (!v.ok) {
    console.warn(`[webhookResend] recusado: ${v.motivo} (svix-id=${String(req.get('svix-id') || '-').slice(0, 60)})`);
    return res.status(401).json({ error: 'assinatura inválida' });
  }

  let evento;
  try {
    evento = JSON.parse(Buffer.isBuffer(corpo) ? corpo.toString('utf8') : String(corpo));
  } catch (_) {
    return res.status(400).json({ error: 'corpo inválido' });
  }

  try {
    const r = await aplicarEvento(db, evento);
    if (r.desligou && r.desligou.length) {
      console.log(`[webhookResend] reclamação de spam: desligado ${r.desligou.join(', ')}`);
    }
    return res.status(200).json({ ok: true, tratado: r.tratado });
  } catch (err) {
    console.error(`[webhookResend] falha ao aplicar ${evento && evento.type}: ${err.message}`);
    return res.status(500).json({ error: 'falha ao gravar' });
  }
});

module.exports = router;
