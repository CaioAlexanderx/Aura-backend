// ============================================================
// AURA. — F6: Asaas Webhook Handler
// FIX: Asaas sends access token in header, NOT HMAC signature
// Asaas header: asaas-access-token (plain token comparison)
// Mounted at: /webhooks/asaas (PUBLIC, no auth)
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const crypto  = require('crypto');

const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_SECRET;

// FIX: Asaas uses a plain access token, NOT HMAC-SHA256
// They send the token in the 'asaas-access-token' header
function validateToken(req) {
  if (!ASAAS_WEBHOOK_TOKEN) {
    // No secret configured — accept all (log warning)
    console.warn('[WEBHOOK] ASAAS_WEBHOOK_SECRET not set — accepting all events');
    return true;
  }

  // Asaas sends the token in this header
  var token = req.headers['asaas-access-token'] || '';

  if (!token) {
    console.warn('[WEBHOOK] No asaas-access-token header received');
    return false;
  }

  // Timing-safe comparison
  try {
    var a = Buffer.from(String(token));
    var b = Buffer.from(String(ASAAS_WEBHOOK_TOKEN));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Event mapping
var PAYMENT_STATUS_MAP = {
  PAYMENT_CONFIRMED: 'active',
  PAYMENT_RECEIVED: 'active',
  PAYMENT_OVERDUE: 'overdue',
  PAYMENT_DELETED: 'cancelled',
  PAYMENT_REFUNDED: 'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

router.post('/', async function(req, res) {
  // Validate webhook token
  if (!validateToken(req)) {
    console.warn('[WEBHOOK] Invalid Asaas token — rejecting');
    return res.status(403).json({ error: 'Invalid token' });
  }

  var event = req.body.event;
  var payment = req.body.payment;
  if (!event || !payment) return res.status(200).json({ received: true });

  console.log('[WEBHOOK] Asaas event: ' + event + ' | Payment: ' + payment.id + ' | Status: ' + payment.status);

  try {
    var newStatus = PAYMENT_STATUS_MAP[event];
    if (!newStatus) {
      return res.status(200).json({ received: true, handled: false });
    }

    // Find company by Asaas customer or external reference
    var result = await db.query(
      'SELECT id, plan, billing_status FROM companies WHERE asaas_customer_id=$1 OR id=$2 LIMIT 1',
      [payment.customer, payment.externalReference]
    );

    if (!result.rows.length) {
      console.warn('[WEBHOOK] Company not found for customer ' + payment.customer);
      return res.status(200).json({ received: true, company_found: false });
    }

    var company = result.rows[0];
    var prevStatus = company.billing_status;

    // Update billing status
    await db.query(
      'UPDATE companies SET billing_status=$1, last_payment_date=$2, next_billing_date=$3, updated_at=NOW() WHERE id=$4',
      [newStatus, payment.paymentDate || null, payment.dueDate || null, company.id]
    );

    // Log the webhook event
    await db.query(
      'INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at) VALUES ($1, \'asaas\', $2, $3, NOW())',
      [company.id, event, JSON.stringify(payment)]
    ).catch(function() {}); // Don't fail if log table doesn't exist

    console.log('[WEBHOOK] Company ' + company.id + ' billing: ' + prevStatus + ' -> ' + newStatus);
    res.status(200).json({ received: true, handled: true, status: newStatus });
  } catch (err) {
    console.error('[WEBHOOK] Error processing:', err.message);
    // Always return 200 to prevent Asaas retries
    res.status(200).json({ received: true, error: true });
  }
});

module.exports = router;
