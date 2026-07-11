// ============================================================
// AURA KARATÊ — Webhook de Pagamento (Fase F5)
//
// Montado em /webhooks/karate-payments (PÚBLICO, sem requireAuth — o
// provedor de pagamento não tem sessão de usuário Aura).
//
// GATE: sem nenhuma credencial configurada (nem por federação em
// digital_channel_config, nem via env), este endpoint nunca recebe
// tráfego real — só o provider dinâmico (não o static_brcode, que não
// tem webhook) chama isso, e o provider dinâmico só é criado quando há
// credenciais. Mesmo assim, o handler abaixo nunca presume que uma
// credencial existe: sem segredo configurado, o comportamento (aceitar
// e logar) segue o MESMO padrão já adotado pelos outros webhooks públicos
// deste projeto.
//
// Contrato de entrada (mesmo vocabulário já usado internamente pelo
// stub de provider dinâmico — services/karatePaymentProvider.js — e
// pelos outros webhooks de pagamento do projeto):
//   { event: 'PAYMENT_CONFIRMED' | 'PAYMENT_RECEIVED' | outro,
//     payment: { id, externalReference, status, paymentDate, clientPaymentDate } }
//
// Idempotência: replay do mesmo evento (mesmo payment.id, já confirmado)
// NÃO reaplica a baixa — karatePaymentService.confirmIntent já é
// idempotente (intent.status === 'paid' → no-op). O webhook sempre
// responde 200, mesmo em replay ou evento desconhecido, pra não entrar
// em loop de retry do provedor.
// ============================================================
'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../config/database');
const paymentSvc = require('../services/karatePaymentService');

const PAID_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);

// ── Segredo global de fallback (por federação tem prioridade — ver
// _resolveWebhookSecret) ────────────────────────────────────────────
const GLOBAL_WEBHOOK_SECRET = process.env.KARATE_PAYMENT_WEBHOOK_SECRET || null;

let _secretColumnAvailable = null; // cache module-level (CLAUDE.md armadilha #1)

async function _resolveFederationWebhookSecret(federationId) {
  if (!federationId || _secretColumnAvailable === false) return null;
  try {
    const { rows } = await db.query(
      `SELECT karate_payment_provider_webhook_secret
       FROM digital_channel_config WHERE company_id = $1 LIMIT 1`,
      [federationId]
    );
    _secretColumnAvailable = true;
    const val = rows[0] && rows[0].karate_payment_provider_webhook_secret;
    return (val && String(val).trim()) || null;
  } catch (e) {
    if (e.code !== '42703') throw e;
    _secretColumnAvailable = false; // migration 224 ainda não aplicada
    return null;
  }
}

async function _findIntentByProviderPaymentId(paymentId) {
  if (!paymentId) return null;
  const { rows } = await db.query(
    `SELECT id, federation_id, status, provider
     FROM karate_payment_intents WHERE payment_intent_id = $1 LIMIT 1`,
    [paymentId]
  );
  return rows[0] || null;
}

function _extractToken(req) {
  return req.headers['x-webhook-token'] ||
         req.headers['x-payment-webhook-token'] ||
         req.headers['x-payment-token'] ||
         '';
}

function _timingSafeMatch(received, expected) {
  try {
    const a = Buffer.from(String(received || ''));
    const b = Buffer.from(String(expected || ''));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

function _logWebhookBestEffort(federationId, provider, event, payload) {
  db.query(
    `INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [federationId || null, provider || 'karate_payment', event || '(none)', JSON.stringify(payload || {})]
  ).catch(() => {});
}

router.post('/', async (req, res) => {
  try {
    const event   = req.body && req.body.event;
    const payment = req.body && req.body.payment;
    const paymentId = payment && payment.id;

    // Localiza o intent pelo id do provedor ANTES de validar o token, pra
    // conseguir escopar a validação por federação quando possível — sem
    // vazar, na resposta, se o intent existe ou não (a resposta de token
    // inválido é sempre genérica).
    const intent = await _findIntentByProviderPaymentId(paymentId);

    const federationSecret = await _resolveFederationWebhookSecret(intent && intent.federation_id);
    const expectedSecret = federationSecret || GLOBAL_WEBHOOK_SECRET;

    if (expectedSecret) {
      const token = _extractToken(req);
      if (!token || !_timingSafeMatch(token, expectedSecret)) {
        console.warn('[karateWebhooks] token invalido ou ausente — rejeitado');
        return res.status(401).json({ error: 'Não autorizado' });
      }
    } else {
      console.warn('[karateWebhooks] nenhum segredo configurado (federação nem env) — aceitando sem validar');
    }

    if (!event || !PAID_EVENTS.has(event)) {
      console.log('[karateWebhooks] evento nao tratado (no-op):', event || '(ausente)');
      _logWebhookBestEffort(intent && intent.federation_id, intent && intent.provider, event, req.body);
      return res.status(200).json({ received: true, handled: false, event_ignored: event || null });
    }

    if (!intent) {
      console.warn('[karateWebhooks] payment_intent_id nao encontrado:', paymentId || '(ausente)');
      return res.status(200).json({ received: true, handled: false, reason: 'intent_not_found' });
    }

    _logWebhookBestEffort(intent.federation_id, intent.provider, event, req.body);

    const result = await paymentSvc.confirmIntent(intent.id, { source: 'webhook' });

    if (result.code === 'ALREADY_PAID' || result.code === 'NOT_FOUND') {
      // Replay: a baixa já foi aplicada (ou o intent sumiu entre o lookup
      // e o confirm) — idempotente, 200 sem reaplicar nada.
      return res.status(200).json({ received: true, handled: false, idempotent_hit: true });
    }

    console.log('[karateWebhooks] intent confirmado via webhook:', intent.id);
    return res.status(200).json({
      received: true,
      handled: true,
      intent_id: intent.id,
      transaction_id: result.transactionId,
      status: result.status,
    });
  } catch (err) {
    // Nunca 500: provedor entraria em loop de retry.
    console.error('[karateWebhooks] erro inesperado (respondendo 200 mesmo assim):', err.message);
    return res.status(200).json({ received: true, error: true });
  }
});

module.exports = router;
