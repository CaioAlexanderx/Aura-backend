// ============================================================
// AURA. — Webhook Mercado Pago
// POST /webhooks/mp
//
// MP envia { action, data: { id } } quando um pagamento muda.
// Respondemos 200 imediatamente (MP espera < 500ms) e processamos async.
// Verificamos o status real via GET /v1/payments/:id antes de confirmar
// (nunca confiar somente no payload do webhook).
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

    // 1. Encontrar o pedido pelo mp_payment_id
    const { rows: orders } = await db.query(
      `SELECT id, company_id, status
       FROM digital_orders
       WHERE mp_payment_id = $1
       LIMIT 1`,
      [paymentId]
    );
    if (!orders.length) return;

    const order = orders[0];
    // Idempotência: só processa se ainda está aguardando pagamento
    if (order.status !== 'pending_payment') return;

    // 2. Buscar access_token da empresa
    const { rows: gateways } = await db.query(
      `SELECT access_token
       FROM companies_payment_gateways
       WHERE company_id = $1 AND gateway = 'mercadopago'
       LIMIT 1`,
      [order.company_id]
    );
    if (!gateways.length) return;

    // 3. Verificar status real no MP (segurança — nunca confiar só no webhook)
    const payment = await getMpPayment({
      accessToken: gateways[0].access_token,
      paymentId,
    });
    if (payment?.status !== 'approved') return;

    // 4. Confirmar pedido (UPDATE com condição garante idempotência)
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
