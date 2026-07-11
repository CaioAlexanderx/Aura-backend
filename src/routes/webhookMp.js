// ============================================================
// AURA. — Webhook Mercado Pago
// POST /webhooks/mp
//
// MP envia { action, data: { id } } quando um pagamento muda.
// Respondemos 200 imediatamente (MP espera < 500ms) e processamos async.
// Verificamos o status real via GET /v1/payments/:id antes de confirmar
// (nunca confiar somente no payload do webhook).
//
// Fase 2 (21/05/2026): fallback por external_reference para pagamentos
// CheckoutPro (cartão). Quando mp_payment_id não tem match (cartão nunca
// armazenou o payment_id antes da confirmação), buscamos o pagamento no MP,
// extraímos external_reference (= order.id) e fazemos o match pelo UUID.
//
// Migration 121 (21/05/2026): validação HMAC x-signature.
// MP envia headers: x-signature: ts=TS,v1=HASH + x-request-id: REQ.
// Manifest: `id:DATA_ID;request-id:REQ;ts:TS;`
// HMAC-SHA256(webhook_secret, manifest).hex() === v1 → autêntico.
//
// Quando ALGUM gateway tem webhook_secret cadastrado, EXIGIMOS assinatura
// válida (rejeita se nenhuma chave bate). Quando nenhum tem (fallback legado),
// mantemos o comportamento original (consulta API antes de confirmar).
//
// Bonus: HMAC válido resolve qual gateway processou o pagamento, evitando
// a varredura O(N) do fallback CheckoutPro.
//
// fix (22/05/2026): chama notifyPaymentConfirmed após onOrderConfirmed
// para enviar e-mail de confirmação ao cliente (Pix MP e Cartão).
// SELECT de digital_orders inclui order_number, customer_name, customer_email.
//
// SEGURANÇA (11/07/2026 — auditoria dos 2 webhooks públicos sem auth, ver
// PR #360 pro padrão fail-closed usado no webhook de pagamento do karatê):
//   Diferente do webhook Asaas (fail-closed / reverificação — ver
//   webhookAsaas.js), este webhook JÁ tinha, antes desta mudança, uma
//   mitigação equivalente embutida: quando nenhum gateway tem webhook_secret
//   cadastrado, a validação HMAC é pulada (linhas abaixo), mas NENHUM
//   caminho de mutação confia no body — todos os 3 pontos que confirmam um
//   pedido (fluxo Pix por mp_payment_id, fallback CheckoutPro por
//   external_reference, e o próprio fallback) chamam getMpPayment() e só
//   gravam status=confirmed se o PRÓPRIO Mercado Pago responder
//   status==='approved'. Um evento forjado no body (action/data.id
//   inventados) não muta nada: ou o paymentId não existe pra nenhum access
//   token de gateway cadastrado (getMpPayment falha silenciosamente pra
//   cada candidate), ou existe mas não está 'approved', ou não tem
//   external_reference que bata com um pedido pending_payment real.
//   MP também não permite consultar payment de outro merchant com um
//   access_token que não é dono dele — a reverificação é por si só um
//   controle de posse, não só de status.
//   Único gap real (agora corrigido): quando nenhum gateway tinha secret,
//   nada era logado — o "modo sem proteção HMAC" ficava invisível nos logs
//   do Railway. Adicionado warn ruidoso abaixo (ver "sem HMAC" no log).
// ============================================================
'use strict';

const crypto               = require('crypto');
const router               = require('express').Router();
const db                   = require('../config/database');
const { getMpPayment }     = require('../services/mpService');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
const notify                = require('../services/digitalOrderNotifications');

// Parse "ts=1704908010,v1=618c85345248..." → { ts, v1 } ou null.
function parseMpSignatureHeader(header) {
  if (!header || typeof header !== 'string') return null;
  const parts = header.split(',').map(s => s.trim());
  let ts = null, v1 = null;
  for (const p of parts) {
    const eqIdx = p.indexOf('=');
    if (eqIdx < 0) continue;
    const k = p.slice(0, eqIdx);
    const v = p.slice(eqIdx + 1);
    if (k === 'ts') ts = v;
    else if (k === 'v1') v1 = v;
  }
  if (!ts || !v1) return null;
  return { ts, v1 };
}

function computeMpHmac(secret, dataId, requestId, ts) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return crypto.createHmac('sha256', secret).update(manifest).digest('hex');
}

// Comparação timing-safe de hashes hex.
function timingSafeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

router.post('/', async (req, res) => {
  // Responde antes de processar para não esgotar o timeout do MP
  res.sendStatus(200);

  try {
    const action    = req.body?.action;
    // data.id pode vir no body OU na query (MP usa as duas formas)
    const paymentId = String(req.body?.data?.id || req.query?.['data.id'] || req.query?.id || '');

    if (!paymentId || action !== 'payment.updated') return;

    // Carrega TODOS os gateways MP de uma vez. Usado pro HMAC, pro
    // fallback de lookup e pra resolver access_token do pedido.
    let allGateways = [];
    try {
      const { rows } = await db.query(
        `SELECT id, company_id, access_token, webhook_secret
         FROM companies_payment_gateways
         WHERE gateway = 'mercadopago' LIMIT 100`
      );
      allGateways = rows;
    } catch (_) { /* tabela ou coluna pode não existir em deployment antigo */ }

    // ===== Validação HMAC x-signature =====
    // Se algum gateway tem webhook_secret, exigimos x-signature válido.
    // Se nenhum tem, pulamos (fallback legado consultando MP API) — mas
    // NUNCA silenciosamente: loga WARN pra não ficar invisível no Railway
    // que este webhook está aceitando notificações sem verificar HMAC
    // (a proteção real, nesse modo, é a reverificação contra a API do MP
    // mais abaixo — nenhuma mutação depende só disto aqui).
    const sigHeader = req.headers['x-signature'];
    const requestId = String(req.headers['x-request-id'] || '');
    const parsed = parseMpSignatureHeader(sigHeader);

    const gatewaysWithSecret = allGateways.filter(g => g.webhook_secret);
    let trustedGateway = null;

    if (gatewaysWithSecret.length > 0) {
      if (!parsed || !requestId) {
        console.warn('[webhookMp] x-signature/x-request-id ausentes mas há gateways com webhook_secret cadastrado — rejeitando notificação (paymentId=' + paymentId + ')');
        return;
      }
      for (const g of gatewaysWithSecret) {
        const expected = computeMpHmac(g.webhook_secret, paymentId, requestId, parsed.ts);
        if (timingSafeEqualHex(expected, parsed.v1)) {
          trustedGateway = g;
          break;
        }
      }
      if (!trustedGateway) {
        console.warn('[webhookMp] x-signature inválido para todos os gateways com secret — possível spoofing (paymentId=' + paymentId + ')');
        return;
      }
    } else {
      console.warn('[webhookMp] NENHUM gateway com webhook_secret cadastrado — pulando validação HMAC ' +
        '(paymentId=' + paymentId + '). Nenhuma mutação confia neste ponto: a confirmação abaixo só ' +
        'acontece se o próprio Mercado Pago (getMpPayment) reportar status=approved pro access_token ' +
        'dono do pagamento. Recomenda-se cadastrar webhook_secret por gateway assim que possível ' +
        '(fecha a checagem de autenticidade sem depender só da reverificação).');
    }

    // ===== 1. Tenta encontrar pedido pelo mp_payment_id (Pix MP) =====
    const { rows: ordersByPaymentId } = await db.query(
      `SELECT id, company_id, status, order_number, customer_name, customer_email
       FROM digital_orders
       WHERE mp_payment_id = $1
       LIMIT 1`,
      [paymentId]
    );
    let order = ordersByPaymentId[0] || null;

    // ===== 2. Fallback CheckoutPro (cartão): payment_id não está salvo. =====
    // Resolve via external_reference (= order.id no MP).
    // Se HMAC já resolveu o gateway, consulta apenas nele. Senão itera.
    if (!order) {
      const candidates = trustedGateway ? [trustedGateway] : allGateways;
      let payment = null;
      for (const gw of candidates) {
        try {
          const p = await getMpPayment({ accessToken: gw.access_token, paymentId });
          if (p && p.id) { payment = p; trustedGateway = gw; break; }
        } catch (_) { /* tenta próximo */ }
      }

      if (!payment || !payment.external_reference) return;

      const { rows: ordersByRef } = await db.query(
        `SELECT id, company_id, status, order_number, customer_name, customer_email
         FROM digital_orders
         WHERE id::text = $1
         LIMIT 1`,
        [String(payment.external_reference)]
      );
      if (!ordersByRef.length) return;

      order = ordersByRef[0];
      if (order.status !== 'pending_payment') return;
      if (payment.status !== 'approved') return;

      // Persiste payment_id pra próximos webhooks resolverem direto (O(1))
      await db.query(
        `UPDATE digital_orders SET mp_payment_id = $1, updated_at = NOW() WHERE id = $2`,
        [paymentId, order.id]
      );

      const { rowCount } = await db.query(
        `UPDATE digital_orders
         SET status         = 'confirmed',
             payment_status = 'paid',
             confirmed_at   = NOW(),
             updated_at     = NOW()
         WHERE id = $1 AND status = 'pending_payment'`,
        [order.id]
      );
      if (rowCount > 0) {
        await onOrderConfirmed(order.id);
        // Notifica cliente por e-mail que o pagamento (cartão) foi confirmado
        notify.notifyPaymentConfirmed({ order })
          .catch(err => console.error('[webhookMp] notifyPaymentConfirmed (card) error:', err.message));
      }
      return;
    }

    // ===== Fluxo Pix MP (payment_id já salvo na criação) =====
    if (order.status !== 'pending_payment') return;

    // Resolve access_token. Preferir trustedGateway se HMAC já bateu
    // E ele é da mesma empresa do pedido.
    let accessToken = null;
    if (trustedGateway && trustedGateway.company_id === order.company_id) {
      accessToken = trustedGateway.access_token;
    } else {
      const gw = allGateways.find(g => g.company_id === order.company_id);
      accessToken = gw?.access_token || null;
    }
    if (!accessToken) return;

    // Verificação extra via API mesmo quando HMAC válido — defesa em
    // profundidade. MP webhook pode chegar antes do payment estar
    // efetivamente aprovado (status pode mudar entre v1 e v2 da notificação).
    const payment = await getMpPayment({ accessToken, paymentId });
    if (payment?.status !== 'approved') return;

    const { rowCount } = await db.query(
      `UPDATE digital_orders
       SET status         = 'confirmed',
           payment_status = 'paid',
           confirmed_at   = NOW(),
           updated_at     = NOW()
       WHERE id = $1 AND status = 'pending_payment'`,
      [order.id]
    );
    if (rowCount === 0) return; // outra instância já confirmou

    await onOrderConfirmed(order.id);
    // Notifica cliente por e-mail que o pagamento (Pix MP) foi confirmado
    notify.notifyPaymentConfirmed({ order })
      .catch(err => console.error('[webhookMp] notifyPaymentConfirmed (pix) error:', err.message));
  } catch (err) {
    console.error('[webhookMp] error:', err.message);
  }
});

module.exports = router;
