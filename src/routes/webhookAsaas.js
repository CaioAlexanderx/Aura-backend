// ============================================================
// AURA. — Asaas Webhook Handler
// FIX: Asaas sends access token in header, NOT HMAC signature
// Asaas header: asaas-access-token (plain token comparison)
// Mounted at: /webhooks/asaas (PUBLIC, no auth)
//
// Handles two flows:
//   1. externalReference = 'digital-order-<uuid>'  → pedido Canal Digital
//   2. tudo mais                                    → billing de empresa (plano)
//
// MULTI-CNPJ (M2): quando o billing da PRIMARY muda, propaga pras
// empresas filhas (billing_owner_company_id = primary.id). Sem isso,
// uma empresa secundária que nunca paga ficaria com status errado
// (ex: primary cancela, mas filha continua 'active'). A primary é a
// fonte da verdade de billing pra todo o "grupo" do owner.
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const crypto  = require('crypto');
const notify  = require('../services/digitalOrderNotifications');

const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_SECRET;

function validateToken(req) {
  if (!ASAAS_WEBHOOK_TOKEN) {
    console.warn('[WEBHOOK] ASAAS_WEBHOOK_SECRET not set — accepting all events');
    return true;
  }
  var token = req.headers['asaas-access-token'] || '';
  if (!token) {
    console.warn('[WEBHOOK] No asaas-access-token header received');
    return false;
  }
  try {
    var a = Buffer.from(String(token));
    var b = Buffer.from(String(ASAAS_WEBHOOK_TOKEN));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

var PAYMENT_STATUS_MAP = {
  PAYMENT_CONFIRMED: 'active',
  PAYMENT_RECEIVED:  'active',
  PAYMENT_OVERDUE:   'overdue',
  PAYMENT_DELETED:   'cancelled',
  PAYMENT_REFUNDED:  'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

var ORDER_PAYMENT_MAP = {
  PAYMENT_CONFIRMED: 'confirmed',
  PAYMENT_RECEIVED:  'confirmed',
  PAYMENT_REFUNDED:  'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

router.post('/', async function(req, res) {
  if (!validateToken(req)) {
    console.warn('[WEBHOOK] Invalid Asaas token — rejecting');
    return res.status(403).json({ error: 'Invalid token' });
  }

  var event   = req.body.event;
  var payment = req.body.payment;
  if (!event || !payment) return res.status(200).json({ received: true });

  console.log('[WEBHOOK] Asaas event: ' + event + ' | Payment: ' + payment.id + ' | ref: ' + payment.externalReference);

  // ── 1. Digital order payment
  var extRef = payment.externalReference || '';
  if (extRef.startsWith('digital-order-')) {
    return handleDigitalOrderPayment(req, res, event, payment, extRef);
  }

  // ── 2. Company billing (plano)
  try {
    var newStatus = PAYMENT_STATUS_MAP[event];
    if (!newStatus) return res.status(200).json({ received: true, handled: false });

    var result = await db.query(
      'SELECT id, plan, billing_status, is_primary FROM companies WHERE asaas_customer_id=$1 OR id=$2 LIMIT 1',
      [payment.customer, payment.externalReference]
    );
    if (!result.rows.length) {
      console.warn('[WEBHOOK] Company not found for customer ' + payment.customer);
      return res.status(200).json({ received: true, company_found: false });
    }

    var company    = result.rows[0];
    var prevStatus = company.billing_status;
    await db.query(
      'UPDATE companies SET billing_status=$1, last_payment_date=$2, next_billing_date=$3, updated_at=NOW() WHERE id=$4',
      [newStatus, payment.paymentDate || null, payment.dueDate || null, company.id]
    );

    // ── MULTI-CNPJ: propaga pra filhas se for primary ────
    // billing_owner_company_id aponta pra primary; quando ela muda
    // de status, todas as filhas devem refletir (atender requisições
    // de plano, gates, etc). Não propagamos last_payment/next_billing
    // pras filhas porque essas datas são da subscription real e podem
    // confundir UIs que mostram "próximo vencimento por empresa".
    var propagated = 0;
    if (company.is_primary) {
      var propagateRes = await db.query(
        `UPDATE companies
            SET billing_status = $1, updated_at = NOW()
          WHERE billing_owner_company_id = $2
            AND id <> $2
            AND is_active = true`,
        [newStatus, company.id]
      );
      propagated = propagateRes.rowCount || 0;
      if (propagated > 0) {
        console.log('[WEBHOOK] Propagated billing_status=' + newStatus +
                    ' to ' + propagated + ' child companies of primary ' + company.id);
      }
    }

    await db.query(
      'INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at) VALUES ($1, \'asaas\', $2, $3, NOW())',
      [company.id, event, JSON.stringify(payment)]
    ).catch(function() {});

    console.log('[WEBHOOK] Company ' + company.id + ' billing: ' + prevStatus + ' -> ' + newStatus);
    res.status(200).json({
      received: true,
      handled: true,
      status: newStatus,
      propagated_to_children: propagated,
    });
  } catch (err) {
    console.error('[WEBHOOK] Error processing billing:', err.message);
    res.status(200).json({ received: true, error: true });
  }
});

async function handleDigitalOrderPayment(req, res, event, payment, extRef) {
  const orderId          = extRef.replace('digital-order-', '').trim();
  const newPaymentStatus = ORDER_PAYMENT_MAP[event];

  if (!newPaymentStatus) {
    return res.status(200).json({ received: true, handled: false, reason: 'event_ignored' });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_status, company_id, customer_name, customer_email, order_number
       FROM digital_orders WHERE id = $1`, [orderId]
    );
    if (!rows.length) {
      console.warn('[WEBHOOK] digital order not found:', orderId);
      return res.status(200).json({ received: true, order_found: false });
    }

    const order = rows[0];
    if (order.payment_status === 'confirmed' && newPaymentStatus === 'confirmed') {
      return res.status(200).json({ received: true, handled: false, reason: 'already_confirmed' });
    }

    const shouldConfirmOrder = newPaymentStatus === 'confirmed' && order.status === 'pending_payment';

    await db.query(`
      UPDATE digital_orders SET
        payment_status   = $1,
        asaas_payment_id = COALESCE(asaas_payment_id, $2),
        status           = CASE WHEN $3 THEN 'confirmed' ELSE status END,
        confirmed_at     = CASE WHEN $3 AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END,
        updated_at       = NOW()
      WHERE id = $4
    `, [newPaymentStatus, payment.id, shouldConfirmOrder, orderId]);

    await db.query(
      `INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at)
       VALUES ($1, 'asaas', $2, $3, NOW())`,
      [order.company_id, event, JSON.stringify(payment)]
    ).catch(() => {});

    console.log(`[WEBHOOK] digital_order ${orderId}: payment -> ${newPaymentStatus}` +
      (shouldConfirmOrder ? ', status -> confirmed' : ''));

    // Notificacões (fire-and-forget)
    if (shouldConfirmOrder) {
      notify.notifyPaymentConfirmed({ order: { ...order, status: 'confirmed' } })
        .catch(err => console.error('[notify] payment confirmed error:', err.message));
    }

    res.status(200).json({
      received:        true,
      handled:         true,
      order_id:        orderId,
      payment_status:  newPaymentStatus,
      order_confirmed: shouldConfirmOrder,
    });
  } catch (err) {
    console.error('[WEBHOOK] Error processing digital order payment:', err.message);
    res.status(200).json({ received: true, error: true });
  }
}

module.exports = router;
