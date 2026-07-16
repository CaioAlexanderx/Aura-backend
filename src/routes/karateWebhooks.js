// ============================================================
// AURA KARATÊ — Webhook de Pagamento (Fase F5)
//
// Montado em /webhooks/karate-payments (PÚBLICO, sem requireAuth — o
// provedor de pagamento não tem sessão de usuário Aura).
//
// GATE (fail-closed): sem nenhuma credencial configurada (nem por
// federação em digital_channel_config, nem via env), este endpoint NUNCA
// processa o evento — responde 401 sem tocar em nenhuma tabela. Rota
// pública cujo efeito é dar baixa em parcela de anuidade: ausência de
// segredo tem que significar "recusar", nunca "confiar e processar" — do
// contrário qualquer POST forjado na internet confirmaria pagamento.
// Aceitar sem segredo é o comportamento adotado por outros webhooks
// públicos deste projeto (ver corpo do PR #360 para a lista) — isso NÃO
// é uma convenção a seguir aqui, é um risco conhecido nos outros,
// deliberadamente fora do escopo desta rota.
//
// Resposta escolhida pra "sem segredo configurado": 401, idêntica (mesmo
// status e mesmo corpo) à resposta de "segredo configurado mas token
// inválido" — de propósito, pra não vazar ao chamador se o servidor tem
// ou não uma credencial configurada pra essa federação.
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

    // Fail-closed: sem segredo (nem por federação, nem env), a requisição é
    // recusada ANTES de qualquer efeito colateral — mesma resposta (status
    // e corpo) do caso "token inválido" logo abaixo, de propósito, pra não
    // vazar se o servidor tem ou não uma credencial configurada.
    if (!expectedSecret) {
      console.warn('[karateWebhooks] nenhum segredo configurado (federação nem env) — recusando (fail-closed, zero mutação)');
      return res.status(401).json({ error: 'Não autorizado' });
    }

    const token = _extractToken(req);
    if (!token || !_timingSafeMatch(token, expectedSecret)) {
      console.warn('[karateWebhooks] token invalido ou ausente — rejeitado');
      return res.status(401).json({ error: 'Não autorizado' });
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
