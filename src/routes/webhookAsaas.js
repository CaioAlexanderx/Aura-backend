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
// FIX (11/07/2026) — PAYMENT_DELETED destruia billing de cliente adimplente:
//   Apagar uma cobranca avulsa/pendente/vencida no painel do Asaas dispara
//   PAYMENT_DELETED. O mapa mandava isso pra billing_status='cancelled' e o
//   UPDATE gravava last_payment_date = payment.paymentDate (NULL num pagamento
//   deletado). Cliente em dia virava 'cancelled' com last_payment_date NULL,
//   caia no checkout e perdia os gates de plano (Encanto Presentes: 15/06 e
//   11/07). Agora:
//     - PAYMENT_DELETED e NEUTRO: loga em webhook_logs, nao toca em companies.
//       Cancelamento real vem de SUBSCRIPTION_DELETED/INACTIVATED.
//     - last_payment_date so e escrito em pagamento efetivo (CONFIRMED/RECEIVED).
//     - next_billing_date nunca e sobrescrito por NULL (COALESCE).
//
// FIX (11/07/2026, parte 2) — evento fora de ordem mascarava inadimplencia:
//   Caso Sheid Mania. Cartao no Asaas CONFIRMA na captura mas so REPASSA ~30
//   dias depois — entao o PAYMENT_RECEIVED da mensalidade de junho (venc 08/06)
//   chegou em 10/07, DEPOIS do PAYMENT_OVERDUE da mensalidade de julho (venc
//   08/07, cartao recusado). Processando por ordem de chegada, o RECEIVED
//   antigo sobrescreveu 'overdue' -> 'active': cliente inadimplente aparecia
//   adimplente e ninguem via. Evento fora de ordem NAO e excecao aqui, e o
//   comportamento normal de assinatura no cartao.
//   Agora comparamos o dueDate da cobranca do evento com o dueDate do ultimo
//   evento que mudou status (isStaleStatusEvent): se for de uma cobranca mais
//   ANTIGA, billing_status nao muda. last_payment_date ainda avanca em
//   pagamento efetivo (o dinheiro entrou mesmo) — via GREATEST, nunca retrocede.
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

// 11/07/2026: PAYMENT_DELETED foi REMOVIDO deste mapa de proposito.
// Apagar uma cobranca no painel NAO e um sinal de que o cliente cancelou a
// assinatura — e uma operacao administrativa rotineira (limpar duplicada,
// remover vencida antes de reemitir). Mapea-lo pra 'cancelled' derrubava
// cliente adimplente pro checkout. Ver STATUS_NEUTRAL_EVENTS abaixo.
var PAYMENT_STATUS_MAP = {
  PAYMENT_CONFIRMED: 'active',
  PAYMENT_RECEIVED:  'active',
  PAYMENT_OVERDUE:   'overdue',
  PAYMENT_REFUNDED:  'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

// Eventos que MUDAM billing_status — usados no guard de ordenacao pra achar
// qual foi a ultima cobranca a definir o estado da empresa.
var STATUS_EVENTS = Object.keys(PAYMENT_STATUS_MAP);

// Eventos registrados (auditoria) mas que NAO alteram o billing da empresa.
var STATUS_NEUTRAL_EVENTS = {
  PAYMENT_DELETED: true,
};

// So estes eventos representam dinheiro efetivamente recebido — apenas eles
// podem escrever last_payment_date.
var PAID_EVENTS = {
  PAYMENT_CONFIRMED: true,
  PAYMENT_RECEIVED:  true,
};

var ORDER_PAYMENT_MAP = {
  PAYMENT_CONFIRMED: 'confirmed',
  PAYMENT_RECEIVED:  'confirmed',
  PAYMENT_REFUNDED:  'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
};

// Grava o evento cru em webhook_logs. Best-effort — nunca derruba o handler.
async function logWebhookEvent(companyId, event, payment) {
  await db.query(
    'INSERT INTO webhook_logs (company_id, provider, event, payload, processed_at) VALUES ($1, \'asaas\', $2, $3, NOW())',
    [companyId, event, JSON.stringify(payment)]
  ).catch(function() {});
}

// ── Guard de ordenacao ────────────────────────────────────────
// Retorna true quando o evento se refere a uma cobranca MAIS ANTIGA do que a
// que definiu o estado atual da empresa — nesse caso ele nao pode mexer em
// billing_status.
//
// Por que dueDate e nao data do evento: no cartao, o Asaas CONFIRMA na captura
// e so REPASSA ~30 dias depois (PAYMENT_RECEIVED). Entao os eventos chegam
// fora de ordem por design. O dueDate identifica de QUAL mensalidade o evento
// fala; a data de chegada, nao.
//
// Ignora logs de digital-order (Canal Digital grava em webhook_logs com o mesmo
// company_id, mas sao pedidos, nao mensalidade do plano).
//
// Best-effort: qualquer falha/ausencia de dado → nao stale (comportamento
// antigo), pra nunca travar o processamento de um evento legitimo.
async function isStaleStatusEvent(companyId, payment) {
  try {
    var incomingDue = payment && payment.dueDate ? String(payment.dueDate) : null;
    if (!incomingDue) return false;

    var { rows } = await db.query(
      `SELECT payload->>'dueDate' AS due_date
         FROM webhook_logs
        WHERE company_id = $1
          AND provider = 'asaas'
          AND event = ANY($2)
          AND payload->>'dueDate' IS NOT NULL
          AND COALESCE(payload->>'externalReference', '') NOT LIKE 'digital-order-%'
        ORDER BY processed_at DESC
        LIMIT 1`,
      [companyId, STATUS_EVENTS]
    );

    var lastDue = rows[0] && rows[0].due_date ? String(rows[0].due_date) : null;
    if (!lastDue) return false;

    // ISO 'YYYY-MM-DD' → comparacao lexicografica == cronologica.
    return incomingDue < lastDue;
  } catch (err) {
    console.error('[WEBHOOK] isStaleStatusEvent falhou (seguindo sem guard):', err.message);
    return false;
  }
}

router.post('/', async function(req, res) {
  if (!validateToken(req)) {
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
    var isNeutral = !!STATUS_NEUTRAL_EVENTS[event];
    var newStatus = PAYMENT_STATUS_MAP[event];
    if (!newStatus && !isNeutral) {
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

    // ── Evento neutro: audita e sai SEM tocar em companies ────
    // PAYMENT_DELETED cai aqui. Apagar uma cobranca no Asaas nao diz nada
    // sobre a saude da assinatura do cliente.
    if (isNeutral) {
      await logWebhookEvent(company.id, event, payment);
      console.log('[WEBHOOK] Company ' + company.id + ' — evento neutro ' + event +
                  ' registrado; billing_status preservado em ' + prevStatus);
      return res.status(200).json({
        received: true,
        handled: true,
        status_changed: false,
        status: prevStatus,
        event_neutral: event,
      });
    }

    var isPaid = !!PAID_EVENTS[event];

    // ── Guard de ordenacao: evento de mensalidade ANTIGA ──────
    // Nao muda billing_status. Se for pagamento efetivo, last_payment_date
    // ainda avanca (o dinheiro entrou mesmo) — GREATEST garante que a data
    // nunca retrocede. GREATEST ignora NULLs no Postgres.
    var stale = await isStaleStatusEvent(company.id, payment);
    if (stale) {
      if (isPaid && payment.paymentDate) {
        await db.query(
          `UPDATE companies
              SET last_payment_date = GREATEST(last_payment_date, $1::date),
                  updated_at = NOW()
            WHERE id = $2`,
          [payment.paymentDate, company.id]
        );
      }
      await logWebhookEvent(company.id, event, payment);
      console.warn('[WEBHOOK] Company ' + company.id + ' — evento STALE ignorado pra status: ' +
                   event + ' (cobranca venc ' + payment.dueDate + ' e mais antiga que a que definiu o estado atual). ' +
                   'billing_status mantido em ' + prevStatus);
      return res.status(200).json({
        received: true,
        handled: true,
        status_changed: false,
        status: prevStatus,
        stale_event: event,
        stale_due_date: payment.dueDate || null,
      });
    }

    // last_payment_date so avanca em pagamento efetivo; nos demais eventos
    // (OVERDUE, REFUNDED, CHARGEBACK) preserva o que ja estava la.
    // next_billing_date nunca e sobrescrito por NULL.
    await db.query(
      `UPDATE companies
          SET billing_status    = $1,
              last_payment_date = CASE WHEN $2 THEN COALESCE($3, last_payment_date) ELSE last_payment_date END,
              next_billing_date = COALESCE($4, next_billing_date),
              updated_at        = NOW()
        WHERE id = $5`,
      [newStatus, isPaid, payment.paymentDate || null, payment.dueDate || null, company.id]
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

    await logWebhookEvent(company.id, event, payment);

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

    await logWebhookEvent(order.company_id, event, payment);

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
