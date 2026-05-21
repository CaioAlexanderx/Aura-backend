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
// ============================================================
'use strict';

const router               = require('express').Router();
const db                   = require('../config/database');
const { getMpPayment }     = require('../services/mpService');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');

router.post('/', async (req, res) => {
  // Responde antes de processar para não esgotar o timeout do MP
  res.sendStatus(200);

  try {
    const action    = req.body?.action;
    const paymentId = String(req.body?.data?.id || '');

    // Só nos interessa notificação de pagamento
    if (!paymentId || action !== 'payment.updated') return;

    // 1. Tenta encontrar o pedido pelo mp_payment_id (Pix MP: salvo na criação)
    const { rows: orders } = await db.query(
      `SELECT id, company_id, status
       FROM digital_orders
       WHERE mp_payment_id = $1
       LIMIT 1`,
      [paymentId]
    );

    let order = orders[0] || null;

    // 2. Fallback para CheckoutPro (cartão): payment_id não foi salvo antes.
    //    Buscamos o pagamento entre todos os gateways MP e usamos
    //    external_reference (= order UUID) para localizar o pedido.
    if (!order) {
      let allGatewayRows = [];
      try {
        const { rows } = await db.query(
          `SELECT access_token FROM companies_payment_gateways WHERE gateway = 'mercadopago' LIMIT 50`
        );
        allGatewayRows = rows;
      } catch (_) { /* tabela pode não existir */ }

      let payment = null;
      for (const gw of allGatewayRows) {
        try {
          const p = await getMpPayment({ accessToken: gw.access_token, paymentId });
          if (p && p.id) { payment = p; break; }
        } catch (_) { /* tenta próximo gateway */ }
      }

      if (!payment || !payment.external_reference) return;

      // external_reference é o order.id (UUID)
      const { rows: ordersByRef } = await db.query(
        `SELECT id, company_id, status
         FROM digital_orders
         WHERE id::text = $1
         LIMIT 1`,
        [String(payment.external_reference)]
      );
      if (!ordersByRef.length) return;

      order = ordersByRef[0];
      if (order.status !== 'pending_payment') return;
      if (payment.status !== 'approved') return;

      // Salva payment_id para futuros webhooks não repetirem a busca completa
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
      if (rowCount > 0) await onOrderConfirmed(order.id);
      return;
    }

    // Fluxo original: match por mp_payment_id (Pix MP)
    // Idempotência: só processa se ainda está aguardando pagamento
    if (order.status !== 'pending_payment') return;

    // 3. Buscar access_token da empresa
    const { rows: gateways } = await db.query(
      `SELECT access_token
       FROM companies_payment_gateways
       WHERE company_id = $1 AND gateway = 'mercadopago'
       LIMIT 1`,
      [order.company_id]
    );
    if (!gateways.length) return;

    // 4. Verificar status real no MP (segurança — nunca confiar só no webhook)
    const payment = await getMpPayment({
      accessToken: gateways[0].access_token,
      paymentId,
    });
    if (payment?.status !== 'approved') return;

    // 5. Confirmar pedido (UPDATE com condição garante idempotência)
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

  } catch (err) {
    console.error('[webhookMp] error:', err.message);
  }
});

module.exports = router;
