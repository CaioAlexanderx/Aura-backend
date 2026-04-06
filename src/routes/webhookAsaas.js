// ============================================================
// AURA. — F6: Asaas Webhook Handler
// Receives payment confirmations, updates company billing status
// Mounted at: /webhooks/asaas (PUBLIC, no auth)
// ============================================================

const express = require('express');
const router  = express.Router();
const db      = require('../config/database');
const crypto  = require('crypto');

const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_SECRET;

// Timing-safe HMAC validation
function validateSignature(body, signature) {
  if (!ASAAS_WEBHOOK_TOKEN || !signature) return false;
  const expected = crypto.createHmac('sha256', ASAAS_WEBHOOK_TOKEN)
    .update(JSON.stringify(body)).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

// Event mapping
const PAYMENT_STATUS_MAP = {
  PAYMENT_CONFIRMED: 'active',
  PAYMENT_RECEIVED: 'active',
  PAYMENT_OVERDUE: 'overdue',
  PAYMENT_DELETED: 'cancelled',
  PAYMENT_REFUNDED: 'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

router.post('/', async (req, res) => {
  // Validate webhook signature if configured
  const sig = req.headers['asaas-signature'] || req.headers['x-asaas-signature'];
  if (ASAAS_WEBHOOK_TOKEN && !validateSignature(req.body, sig)) {
    console.warn('[WEBHOOK] Invalid Asaas signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  const { event, payment } = req.body;
  if (!event || !payment) return res.status(200).json({ received: true });

  console.log(`[WEBHOOK] Asaas event: ${event} | Payment: ${payment.id} | Status: ${payment.status}`);

  try {
    const newStatus = PAYMENT_STATUS_MAP[event];
    if (!newStatus) {
      // Event we don't handle — acknowledge
      return res.status(200).json({ received: true, handled: false });
    }

    // Find company by Asaas customer or external reference
    const { rows } = await db.query(
      `SELECT id, plan FROM companies 
       WHERE asaas_customer_id=$1 OR id=$2 LIMIT 1`,
      [payment.customer, payment.externalReference]
    );

    if (!rows.length) {
      console.warn(`[WEBHOOK] Company not found for customer ${payment.customer}`);
      return res.status(200).json({ received: true, company_found: false });
    }

    const company = rows[0];

    // Update billing status
    await db.query(
      `UPDATE companies SET 
        billing_status=$1, 
        last_payment_date=$2,
        next_billing_date=$3,
        updated_at=NOW()
       WHERE id=$4`,
      [
        newStatus,
        payment.paymentDate || null,
        payment.dueDate || null,
        company.id,
      ]
    );

    // Log the webhook event
    await db.query(
      `INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at)
       VALUES ($1, 'asaas', $2, $3, NOW())`,
      [company.id, event, JSON.stringify(payment)]
    ).catch(() => {}); // Don't fail if log table doesn't exist yet

    console.log(`[WEBHOOK] Company ${company.id} billing updated to ${newStatus}`);
    res.status(200).json({ received: true, handled: true, status: newStatus });
  } catch (err) {
    console.error('[WEBHOOK] Error processing:', err.message);
    // Always return 200 to prevent Asaas retries
    res.status(200).json({ received: true, error: true });
  }
});

module.exports = router;
