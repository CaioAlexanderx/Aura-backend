// ============================================================
// AURA. — Asaas Webhook Handler
// FIX: Asaas sends access token in header, NOT HMAC signature
// Asaas header: asaas-access-token (plain token comparison)
// Mounted at: /api/v1/webhooks/asaas (PUBLIC, no auth)
// FIX (03/05): logs de debug ricos pra rastrear webhooks rejeitados
//              (zero eventos chegavam ao DB desde 24/04 — investigando se
//              é mismatch de token, header com nome diferente, ou Asaas
//              pausou a integracao). Logs aparecem no Railway.
//
// Handles three flows:
//   1. event PIX_AUTOMATIC_RECURRING_AUTHORIZATION_* → autorização Pix Automático
//   2. externalReference = 'digital-order-<uuid>'  → pedido Canal Digital
//   3. tudo mais                                    → billing de empresa (plano)
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
const billingPix = require('../services/billingPix');

const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_SECRET;

// Log inicial 1x no boot pra confirmar config
if (ASAAS_WEBHOOK_TOKEN) {
  console.log('[WEBHOOK] ASAAS_WEBHOOK_SECRET configurado (length=' + ASAAS_WEBHOOK_TOKEN.length + ', sha256-prefix=' +
    crypto.createHash('sha256').update(ASAAS_WEBHOOK_TOKEN).digest('hex').slice(0, 8) + ')');
} else {
  console.warn('[WEBHOOK] ASAAS_WEBHOOK_SECRET NAO configurado — aceitando todos webhooks sem validar');
}

function logIncomingRequest(req, decision, reason) {
  // Sanitiza headers pra log: nao loga valor de auth, so presence + length
  const headerNames = Object.keys(req.headers || {}).sort();
  const authLikeHeaders = headerNames.filter(h =>
    /token|secret|signature|auth|asaas/i.test(h)
  );
  const headerSummary = authLikeHeaders.map(h => {
    const v = req.headers[h];
    const len = typeof v === 'string' ? v.length : (Array.isArray(v) ? v.join(',').length : 0);
    return h + '(len=' + len + ')';
  });
  const event = req.body?.event || '(no event)';
  const paymentId = req.body?.payment?.id || '(no payment)';
  console.log('[WEBHOOK] ' + decision + ' — ' + reason + ' | event=' + event +
    ' | payment=' + paymentId + ' | auth-headers=[' + headerSummary.join(', ') +
    '] | all-header-count=' + headerNames.length + ' | from-ip=' + (req.ip || '(unknown)'));
}

function validateToken(req) {
  if (!ASAAS_WEBHOOK_TOKEN) {
    logIncomingRequest(req, 'ACCEPTED', 'no secret configured');
    return true;
  }
  var token = req.headers['asaas-access-token'] || '';
  if (!token) {
    // Tenta variantes comuns de nome de header (caso Asaas tenha mudado)
    var alt = req.headers['asaas-token'] || req.headers['x-asaas-token'] ||
              req.headers['x-asaas-signature'] || req.headers['authorization'] || '';
    if (alt) {
      logIncomingRequest(req, 'REJECTED-401',
        'missing asaas-access-token header but found alternate auth-like header — Asaas pode ter mudado o nome do header');
    } else {
      logIncomingRequest(req, 'REJECTED-401', 'no asaas-access-token header at all');
    }
    return false;
  }
  try {
    var a = Buffer.from(String(token));
    var b = Buffer.from(String(ASAAS_WEBHOOK_TOKEN));
    if (a.length !== b.length) {
      logIncomingRequest(req, 'REJECTED-403',
        'token length mismatch: received=' + a.length + ', expected=' + b.length);
      return false;
    }
    const ok = crypto.timingSafeEqual(a, b);
    if (!ok) {
      logIncomingRequest(req, 'REJECTED-403', 'token value mismatch (same length)');
      return false;
    }
    logIncomingRequest(req, 'ACCEPTED', 'token valid');
    return true;
  } catch (err) {
    logIncomingRequest(req, 'REJECTED-403', 'comparison threw: ' + err.message);
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
    return res.status(403).json({ error: 'Invalid token' });
  }

  var event   = req.body.event;

  // ── 0. Pix Automático: eventos de AUTORIZAÇÃO (sem objeto `payment`) ──
  // Precisam ser tratados ANTES do guard `!payment` abaixo, pois o payload
  // de autorização não traz `payment`. As cobranças recorrentes do Pix
  // Automático continuam disparando os PAYMENT_* (tratados no fluxo 2).
  if (event && event.indexOf('PIX_AUTOMATIC_RECURRING_AUTHORIZATION') === 0) {
    return billingPix.handlePixAutoAuthorizationEvent(req, res, db);
  }

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
    if (!newStatus) {
      console.log('[WEBHOOK] Event ' + event + ' nao mapeado — ignorando (mas recebido)');
      return res.status(200).json({ received: true, handled: false, event_ignored: event });
    }

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

// ── Endpoint de diagnostico (GET, sem validacao de token) ─────
// Permite ao operador checar se o secret esta carregado e bate
// com o que ele espera (compara hash de prefixo, nao o secret cru).
// Uso: curl https://.../api/v1/webhooks/asaas/_diag
router.get('/_diag', function(req, res) {
  res.json({
    status: 'ok',
    secret_configured: !!ASAAS_WEBHOOK_TOKEN,
    secret_length: ASAAS_WEBHOOK_TOKEN ? ASAAS_WEBHOOK_TOKEN.length : 0,
    secret_sha256_prefix: ASAAS_WEBHOOK_TOKEN
      ? crypto.createHash('sha256').update(ASAAS_WEBHOOK_TOKEN).digest('hex').slice(0, 8)
      : null,
    expected_header: 'asaas-access-token',
    note: 'Compare secret_sha256_prefix com o hash do token configurado no painel Asaas pra confirmar que batem.',
  });
});

module.exports = router;
