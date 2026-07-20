// ============================================================
// AURA DOJÔ — F3b: Webhook público da subconta Asaas do dojô (BaaS)
//
// Montado em /webhooks/asaas-dojo (PÚBLICO, SEM auth de empresa — a Asaas
// não tem sessão Aura). Autentica por header 'asaas-access-token' comparado
// por HASH (SHA-256) contra karate_dojo_baas_accounts.webhook_token_hash
// (migration 244). Token inválido/ausente → 401, zero efeito.
//
// Cada subconta empurra pra ESTE mesmo endpoint; o token identifica o dojô.
//
// Eventos:
//   PAYMENT_RECEIVED / PAYMENT_CONFIRMED (externalReference = charge_id)
//     → dá baixa na cobrança via karateDojoBillingService.confirmCharge
//       (method 'pix') — MESMA semântica da baixa manual, idempotente
//       (já paga → 200 ok). Escopo por dojo_id do token (confirmCharge
//       filtra por dojoId; cobrança de outro dojô → 404 → ack sem efeito).
//   ACCOUNT_STATUS_* (status da subconta) → atualiza onboarding
//     (docs_pending/under_review/approved/rejected), monotônico e à prova
//     de evento fora de ordem (nunca rebaixa 'approved'; 'rejected' terminal).
//   PAYMENT_DELETED / estorno / QUALQUER outro → 200 ack sem ação. NUNCA
//     regride cobrança paga (não existe caminho de "despagar" aqui).
//
// Sempre responde 200 rápido (mesmo em erro interno) pra não pausar a fila
// de retry da Asaas — padrão da doc e do webhook de billing existente.
// ============================================================
'use strict';

const express = require('express');
const router = express.Router();
const baasSvc = require('../services/karateDojoBaasService');
const billingSvc = require('../services/karateDojoBillingService');

const PAID_EVENTS = new Set(['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED']);

router.post('/', async (req, res) => {
  try {
    const token = req.headers['asaas-access-token'] || '';
    const account = await baasSvc.findAccountByWebhookToken(token);
    if (!account) {
      console.warn('[asaas-dojo] token ausente/inválido — rejeitado (401, zero mutação)');
      return res.status(401).json({ error: 'Não autorizado', code: 'UNAUTHORIZED' });
    }

    const event = req.body && req.body.event;
    const payment = (req.body && req.body.payment) || {};

    // ── Status da subconta (onboarding) ──
    if (baasSvc.isAccountStatusEvent(event, req.body)) {
      const newStatus = baasSvc.mapAccountStatus(event, req.body);
      const r = await baasSvc.applyAccountStatus(account.dojo_id, newStatus);
      console.log('[asaas-dojo] account status event=' + (event || '(none)') + ' → ' + (r.status || 'sem mudança'));
      return res.status(200).json({ received: true, handled: true, account_status: r.status || null, changed: !!r.changed });
    }

    // ── Pagamento recebido/confirmado → baixa idempotente ──
    if (event && PAID_EVENTS.has(event)) {
      const chargeId = payment.externalReference;
      if (!chargeId) {
        return res.status(200).json({ received: true, handled: false, reason: 'no_external_reference' });
      }
      try {
        const result = await billingSvc.confirmCharge(account.dojo_id, chargeId, 'pix');
        return res.status(200).json({ received: true, handled: true, already_paid: !!result.already_paid });
      } catch (e) {
        // cobrança não encontrada/cancelada etc — nunca 500 (evita loop de retry)
        console.warn('[asaas-dojo] confirmCharge não aplicou (200 mesmo assim):', e.code || e.message);
        return res.status(200).json({ received: true, handled: false, reason: e.code || 'confirm_failed' });
      }
    }

    // ── PAYMENT_DELETED / estorno / qualquer outro → ack sem ação ──
    // Nunca há caminho de "despagar": só PAYMENT_RECEIVED/CONFIRMED mexem na
    // cobrança, e confirmCharge só faz pending→paid.
    console.log('[asaas-dojo] evento sem ação (ack):', event || '(none)');
    return res.status(200).json({ received: true, handled: false, event_ignored: event || null });
  } catch (err) {
    console.error('[asaas-dojo] erro inesperado (200 mesmo assim):', err.message);
    return res.status(200).json({ received: true, error: true });
  }
});

module.exports = router;
