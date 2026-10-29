// ============================================================
// AURA. — Webhook Mercado Pago
// POST /webhooks/mp
//
// MP envia { action, type, user_id, data: { id } } quando um pagamento muda.
// Respondemos 200 imediatamente (MP espera < 500ms) e processamos async.
// Verificamos o status real via GET /v1/payments/:id antes de confirmar
// (nunca confiar somente no payload do webhook).
//
// ── DOIS JEITOS DE A LOJA ESTAR CONECTADA ───────────────────────────────
// 1. OAuth (tq-94/tq-95, 29/10/2026): a loja autorizou a aplicação da Aura.
//    O Mercado Pago avisa no webhook ÚNICO da aplicação, assinado com
//    MP_WEBHOOK_SECRET, e diz de quem é o pagamento em `user_id` (o id do
//    vendedor). A loja é resolvida por companies_payment_gateways.mp_user_id
//    — não há mais segredo por loja. Se a mesma conta do Mercado Pago serve
//    dois CNPJs do grupo, quem desempata é o pedido (mp_payment_id ou
//    external_reference = digital_orders.id).
// 2. Manual (token colado, como sempre foi): segredo por loja em
//    companies_payment_gateways.webhook_secret, mesma regra de antes:
//    se alguma loja manual tem segredo, a assinatura tem que bater com um
//    deles; se nenhuma tem, segue sem HMAC e com WARN no log.
//
// Assinatura (as duas): x-signature: ts=TS,v1=HASH + x-request-id: REQ.
// Manifest `id:DATA_ID;request-id:REQ;ts:TS;` e HMAC-SHA256(segredo).hex().
//
// ── O QUE NÃO MUDA ─────────────────────────────────────────────────────
// Nenhuma mutação confia no body. Todo caminho que confirma pedido chama
// getMpPayment() com o token da PRÓPRIA loja (decifrado e renovado se for
// OAuth — services/mpGateway) e só grava confirmed se o Mercado Pago
// responder status=approved. Idempotente: o UPDATE exige
// status='pending_payment' e só quem muda a linha dispara confirmação,
// e-mail e sino. Notificação repetida não faz nada.
//
// Novidades de segurança (tq-95):
//   - o pedido achado por external_reference tem que ser de uma empresa
//     dona do token que achou o pagamento (antes, um pagamento de uma loja
//     podia apontar para o pedido de outra);
//   - valor aprovado menor que o total do pedido não confirma.
//
// fix (22/05/2026): chama notifyPaymentConfirmed após onOrderConfirmed.
// SEGURANÇA (11/07/2026): ver PR #361 (fail-closed e WARN sem HMAC).
// ============================================================
'use strict';

const crypto               = require('crypto');
const router               = require('express').Router();
const db                   = require('../config/database');
const { getMpPayment }     = require('../services/mpService');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
const notify                = require('../services/digitalOrderNotifications');
const lojaEvents            = require('../services/lojaEvents');
const mpOAuth               = require('../services/mpOAuth');
const mpGateway             = require('../services/mpGateway');

const ACOES_DE_PAGAMENTO = new Set(['payment.updated', 'payment.created']);

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

function assinaturaBate(secret, paymentId, requestId, parsed) {
  if (!secret || !parsed || !requestId) return false;
  return timingSafeEqualHex(computeMpHmac(secret, paymentId, requestId, parsed.ts), parsed.v1);
}

// Todos os gateways MP. Antes da migration 417 as colunas do OAuth não
// existem: cai no SELECT antigo e todo mundo é manual.
async function carregarGateways() {
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, access_token, webhook_secret,
              auth_method, refresh_token, token_expires_at, connection_status, mp_user_id
         FROM companies_payment_gateways
        WHERE gateway = 'mercadopago' LIMIT 500`
    );
    return rows;
  } catch (e) {
    if (e.code !== '42703') return []; // tabela pode não existir em deployment antigo
  }
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, access_token, webhook_secret
         FROM companies_payment_gateways
        WHERE gateway = 'mercadopago' LIMIT 500`
    );
    return rows;
  } catch (_) { return []; }
}

const ehOAuth = (g) => g.auth_method === 'oauth';

/**
 * Quais lojas podem ser donas desta notificação.
 * @returns {{ candidatos: object[], origem: string } | null} null = rejeitar
 */
function resolverCandidatos({ gateways, paymentId, requestId, parsed, sellerId }) {
  const appSecret = mpOAuth.webhookSecret();
  const oauth  = gateways.filter(g => ehOAuth(g) && g.connection_status !== 'caiu');
  const manual = gateways.filter(g => !ehOAuth(g));
  const doVendedor = (lista) => (sellerId ? lista.filter(g => String(g.mp_user_id || '') === sellerId) : lista);

  // 1. Webhook da aplicação da Aura (OAuth), assinado com MP_WEBHOOK_SECRET.
  if (assinaturaBate(appSecret, paymentId, requestId, parsed)) {
    return { candidatos: doVendedor(oauth), origem: 'aplicacao' };
  }

  const candidatos = [];
  let origem = 'sem-assinatura';

  // 2. Lojas manuais: regra de sempre (segredo por loja).
  const manualComSegredo = manual.filter(g => g.webhook_secret);
  if (manualComSegredo.length > 0) {
    const g = manualComSegredo.find(m => assinaturaBate(m.webhook_secret, paymentId, requestId, parsed));
    if (g) { candidatos.push(g); origem = 'loja'; }
  } else if (manual.length > 0) {
    console.warn('[webhookMp] NENHUM gateway manual com webhook_secret — pulando validação HMAC ' +
      '(paymentId=' + paymentId + '). A confirmação só acontece se o próprio Mercado Pago ' +
      '(getMpPayment) reportar status=approved para o token dono do pagamento.');
    candidatos.push(...manual);
  }

  // 3. OAuth sem MP_WEBHOOK_SECRET configurado: só a reverificação protege.
  //    Com o segredo configurado, notificação sem assinatura da aplicação
  //    nunca chega às lojas OAuth.
  if (!appSecret && oauth.length > 0) {
    console.warn('[webhookMp] MP_WEBHOOK_SECRET ausente — lojas conectadas por OAuth sem validação ' +
      'de assinatura (paymentId=' + paymentId + '); só a reconsulta no Mercado Pago protege.');
    candidatos.push(...doVendedor(oauth));
  }

  if (!candidatos.length) return null;
  return { candidatos, origem };
}

async function confirmarPedido(order, { tipo }) {
  const { rowCount } = await db.query(
    `UPDATE digital_orders
     SET status         = 'confirmed',
         payment_status = 'paid',
         confirmed_at   = NOW(),
         updated_at     = NOW()
     WHERE id = $1 AND status = 'pending_payment'`,
    [order.id]
  );
  if (rowCount === 0) return false; // outra notificação/instância já confirmou

  await onOrderConfirmed(order.id);
  notify.notifyPaymentConfirmed({ order })
    .catch(err => console.error(`[webhookMp] notifyPaymentConfirmed (${tipo}) error:`, err.message));
  lojaEvents.emit('loja_pedido_pago', order);
  return true;
}

// Valor aprovado menor que o total do pedido não confirma (centavo de folga).
function valorCobre(order, payment) {
  if (order.total == null || payment.transaction_amount == null) return true;
  return Number(payment.transaction_amount) + 0.01 >= Number(order.total);
}

async function tokenDe(gw) {
  try { return await mpGateway.tokenDoGateway(db, gw); }
  catch (e) {
    console.error('[webhookMp] token da loja ilegível (gateway=' + gw.id + '):', e.message);
    return null;
  }
}

const COLS_PEDIDO = 'id, company_id, status, order_number, customer_name, customer_email, total';

async function processar(req) {
  const body      = req.body || {};
  const action    = body.action;
  // data.id pode vir no body OU na query (MP usa as duas formas)
  const paymentId = String(body?.data?.id || req.query?.['data.id'] || req.query?.id || '');

  if (!paymentId || paymentId.length > 64 || !ACOES_DE_PAGAMENTO.has(action)) return;

  const gateways = await carregarGateways();
  if (!gateways.length) return;

  const sellerId  = body.user_id != null ? String(body.user_id) : '';
  const requestId = String(req.headers['x-request-id'] || '');
  const parsed    = parseMpSignatureHeader(req.headers['x-signature']);

  const r = resolverCandidatos({ gateways, paymentId, requestId, parsed, sellerId });
  if (!r) {
    console.warn('[webhookMp] notificação sem assinatura válida e sem loja candidata — ignorada (paymentId=' + paymentId + ')');
    return;
  }
  const { candidatos } = r;

  // ===== 1. Pedido pelo mp_payment_id (Pix MP, ou cartão já visto) =====
  const { rows: ordersByPaymentId } = await db.query(
    `SELECT ${COLS_PEDIDO} FROM digital_orders WHERE mp_payment_id = $1 LIMIT 1`,
    [paymentId]
  );
  let order = ordersByPaymentId[0] || null;

  if (order) {
    if (order.status !== 'pending_payment') return;
    const gw = candidatos.find(g => g.company_id === order.company_id);
    if (!gw) {
      console.warn('[webhookMp] pedido de empresa fora das candidatas da notificação — ignorado (paymentId=' + paymentId + ')');
      return;
    }
    const accessToken = await tokenDe(gw);
    if (!accessToken) return;

    // Verificação via API mesmo com HMAC válido — defesa em profundidade e
    // o status pode mudar entre notificações.
    const payment = await getMpPayment({ accessToken, paymentId });
    if (payment?.status !== 'approved') return;
    if (!valorCobre(order, payment)) {
      console.warn('[webhookMp] valor aprovado menor que o total do pedido — não confirmado (order=' + order.id + ')');
      return;
    }
    await confirmarPedido(order, { tipo: 'pix' });
    return;
  }

  // ===== 2. Cartão (Checkout Pro): payment_id ainda não salvo. =====
  // Busca o pagamento com o token de cada candidata (uma vez por conta do
  // Mercado Pago) e casa pelo external_reference (= digital_orders.id).
  let payment = null;
  let dono = null;
  const contasVistas = new Set();
  for (const gw of candidatos) {
    const conta = gw.mp_user_id ? 'u:' + gw.mp_user_id : 'g:' + gw.id;
    if (contasVistas.has(conta)) continue;
    contasVistas.add(conta);
    const accessToken = await tokenDe(gw);
    if (!accessToken) continue;
    try {
      const p = await getMpPayment({ accessToken, paymentId });
      if (p && p.id) { payment = p; dono = gw; break; }
    } catch (_) { /* tenta próximo */ }
  }

  if (!payment || !payment.external_reference) return;

  const { rows: ordersByRef } = await db.query(
    `SELECT ${COLS_PEDIDO} FROM digital_orders WHERE id::text = $1 LIMIT 1`,
    [String(payment.external_reference)]
  );
  if (!ordersByRef.length) return;
  order = ordersByRef[0];

  // O pedido tem que ser de uma empresa dona da conta que achou o pagamento.
  const empresasDaConta = new Set(
    candidatos
      .filter(g => g === dono || (dono.mp_user_id && g.mp_user_id === dono.mp_user_id))
      .map(g => g.company_id)
  );
  if (!empresasDaConta.has(order.company_id)) {
    console.warn('[webhookMp] external_reference aponta para pedido de outra empresa — ignorado (paymentId=' + paymentId + ')');
    return;
  }
  if (order.status !== 'pending_payment') return;
  if (payment.status !== 'approved') return;
  if (!valorCobre(order, payment)) {
    console.warn('[webhookMp] valor aprovado menor que o total do pedido — não confirmado (order=' + order.id + ')');
    return;
  }

  // Persiste payment_id pra próximos webhooks resolverem direto (O(1))
  await db.query(
    `UPDATE digital_orders SET mp_payment_id = $1, updated_at = NOW() WHERE id = $2`,
    [paymentId, order.id]
  );
  await confirmarPedido(order, { tipo: 'card' });
}

router.post('/', async (req, res) => {
  // Responde antes de processar para não esgotar o timeout do MP
  res.sendStatus(200);
  try {
    await processar(req);
  } catch (err) {
    console.error('[webhookMp] error:', err.message);
  }
});

module.exports = router;
module.exports._resolverCandidatos = resolverCandidatos;
