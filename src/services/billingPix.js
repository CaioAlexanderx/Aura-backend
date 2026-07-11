// ============================================================
// AURA. — Pix Automático (cobrança recorrente com débito automático)
//
// 22/06/2026. A assinatura PIX de hoje é uma /subscriptions billingType=PIX:
// recorrente, mas o cliente PRECISA pagar o QR todo mês (gera inadimplência
// involuntária). O Pix Automático resolve isso: o pagador autoriza UMA vez
// (pagando o 1º QR) e os meses seguintes são debitados automaticamente.
//
// Modelo Asaas (jornada 3 — QR imediato):
//   1. POST /pix/automatic/authorizations  → cria a autorização + QR imediato.
//      Com paymentCreationMode=SUBSCRIPTION, a Asaas gera as cobranças
//      recorrentes sozinha (não precisamos de cron).
//   2. Pagador paga o QR no app do banco → autorização vira ACTIVE (webhook).
//   3. Mensalidades seguintes debitam sozinhas; cada uma dispara os
//      PAYMENT_CONFIRMED/RECEIVED/OVERDUE padrão (já tratados no webhook).
//
// SEGURANÇA DE ROLLOUT:
//   - Tudo gated por env PIX_AUTOMATICO_ENABLED (default OFF).
//   - O caller (billing.js) envolve em try/catch e cai no PIX comum em
//     qualquer falha → na pior hipótese, comportamento idêntico ao de hoje.
//
// ⚠️ Campos do immediateQrCode e shape exato da resposta seguem a referência
//    da Asaas; VALIDAR EM SANDBOX antes de ligar a flag em produção.
// ============================================================
'use strict';

const { asaas } = require('./asaasClient');

function isPixAutoEnabled() {
  return String(process.env.PIX_AUTOMATICO_ENABLED || '').toLowerCase() === 'true';
}

// description e contractId têm limite de 35 chars na API de autorização.
function truncate35(s) {
  const v = String(s == null ? '' : s);
  return v.length <= 35 ? v : v.slice(0, 35);
}

// contractId aceita <= 35 chars; UUID com hífens tem 36 → remove hífens (32).
function shortContractId(companyId) {
  return String(companyId || '').replace(/-/g, '').slice(0, 35);
}

// Extrai QR (copia-e-cola + imagem) de formatos possíveis da resposta.
function pickQr(obj) {
  const q = obj?.immediateQrCode || obj?.qrCode || obj || {};
  return {
    payload: q.payload || q.copyPaste || q.pixCopiaECola || null,
    encodedImage: q.encodedImage || q.qrCodeImage || null,
    expiration: q.expirationDate || q.expiration || null,
    conciliationIdentifier: q.conciliationIdentifier || obj?.conciliationIdentifier || null,
  };
}

/**
 * Cria uma autorização de Pix Automático com QR imediato (1ª cobrança).
 * @returns {Promise<{id, status, qr:{payload,encodedImage,expiration,conciliationIdentifier}, raw}>}
 */
async function createPixAutoAuthorization({
  customerId, value, frequency = 'MONTHLY',
  contractId, startDate, finishDate, description, firstDueDate,
}) {
  const desc = truncate35(description);
  const body = {
    customerId,
    frequency,
    contractId: shortContractId(contractId),
    startDate,
    finishDate: finishDate || undefined,
    value,
    description: desc,
    // Asaas gera as cobranças recorrentes (dispensa cron do nosso lado).
    paymentCreationMode: 'SUBSCRIPTION',
    // Cobrança imediata que registra o consentimento + paga o 1º mês.
    immediateQrCode: {
      value,
      description: desc,
      dueDate: firstDueDate || startDate,
    },
  };

  const auth = await asaas('POST', '/pix/automatic/authorizations', body);
  return {
    id: auth.id,
    status: auth.status || null,
    qr: pickQr(auth),
    raw: auth,
  };
}

/**
 * Cria a assinatura PIX COMUM (fallback): a Asaas emite um PIX por ciclo que
 * o cliente paga manualmente. Espelha o ramo PIX de billing.js.
 * @returns {Promise<{subscription, pix}>}
 */
async function createCommonPixSubscription({
  customerId, value, nextDueDate, endDate, description, externalReference,
}) {
  const subscription = await asaas('POST', '/subscriptions', {
    customer: customerId,
    billingType: 'PIX',
    value,
    nextDueDate,
    cycle: 'MONTHLY',
    endDate: endDate || undefined,
    description: truncate35(description),
    externalReference,
  });

  let pix = null;
  try {
    const payments = await asaas('GET', '/subscriptions/' + subscription.id + '/payments?limit=1');
    if (payments.data?.[0]?.id) {
      const q = await asaas('GET', '/payments/' + payments.data[0].id + '/pixQrCode');
      pix = { payload: q.payload || null, encodedImage: q.encodedImage || null, expiration: q.expirationDate || null };
    }
  } catch (_) { /* QR é best-effort; subscription já existe */ }

  return { subscription, pix };
}

// ── Webhook: eventos de autorização do Pix Automático ─────────────
// Eventos (ver docs/fluxos-de-webhook):
//   PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED   — QR criado (pending)
//   ..._ACTIVATED — pago + autorizado (ACTIVE)
//   ..._REFUSED   — banco/pagador recusou a autorização   → fallback
//   ..._CANCELLED — pagador/Asaas cancelou depois          → fallback
//   ..._EXPIRED   — passou de finishDate                   → fallback
// As mensalidades recorrentes disparam os PAYMENT_* padrão (tratados no
// handler principal do webhook), então aqui só cuidamos da autorização.
async function handlePixAutoAuthorizationEvent(req, res, db) {
  const event = req.body.event;
  const authObj = req.body.pixAutomaticRecurringAuthorization
    || req.body.pixAutomaticAuthorization
    || req.body.authorization
    || req.body.pixAutomatic
    || {};
  const authId = authObj.id || req.body.id || null;

  if (!authId) {
    return res.status(200).json({ received: true, handled: false, reason: 'no_auth_id', event });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, plan, billing_cycle, billing_status, extra_seats_granted,
              asaas_customer_id, pix_auto_status
         FROM companies WHERE asaas_pix_auto_authorization_id = $1 LIMIT 1`,
      [authId]
    );
    if (!rows.length) {
      return res.status(200).json({ received: true, company_found: false });
    }
    const company = rows[0];

    // Autorização ativada — o billing_status vira 'active' pelo PAYMENT_RECEIVED
    // da 1ª cobrança (fluxo padrão); aqui só marcamos o estado da autorização.
    if (event.endsWith('_ACTIVATED')) {
      await db.query(
        `UPDATE companies SET pix_auto_status='active', updated_at=NOW() WHERE id=$1`,
        [company.id]
      );
      return res.status(200).json({ received: true, handled: true, pix_auto_status: 'active' });
    }

    const newStatus = event.endsWith('_REFUSED') ? 'refused'
      : event.endsWith('_CANCELLED') ? 'cancelled'
      : event.endsWith('_EXPIRED') ? 'expired'
      : null;

    if (newStatus) {
      // Idempotência
      if (company.pix_auto_status === newStatus) {
        return res.status(200).json({ received: true, handled: false, reason: 'already_' + newStatus });
      }

      // Fallback assíncrono: cria assinatura PIX comum pra manter a cobrança viva.
      let fallback = null;
      try {
        const { PLANS, getTotalValue } = require('./billingPricing');
        const seats = parseInt(company.extra_seats_granted, 10) || 0;
        const cycle = company.billing_cycle || 'monthly';
        const value = getTotalValue(company.plan, cycle, 'PIX', seats);
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];
        let endDate;
        if (cycle === 'annual') {
          const e = new Date(); e.setFullYear(e.getFullYear() + 1);
          endDate = e.toISOString().split('T')[0];
        }
        const desc = (PLANS[company.plan]?.name || 'Assinatura') + (cycle === 'annual' ? ' (Anual)' : '');
        if (value != null && company.asaas_customer_id) {
          fallback = await createCommonPixSubscription({
            customerId: company.asaas_customer_id,
            value, nextDueDate: tomorrowStr, endDate,
            description: desc, externalReference: company.id,
          });
        }
      } catch (e) {
        console.error('[WEBHOOK][pix-auto] fallback PIX comum falhou:', e.message);
      }

      await db.query(
        `UPDATE companies
            SET pix_auto_status = $1,
                billing_method = COALESCE($2, billing_method),
                asaas_subscription_id = COALESCE($3, asaas_subscription_id),
                updated_at = NOW()
          WHERE id = $4`,
        [newStatus, fallback ? 'pix_common' : null, fallback?.subscription?.id || null, company.id]
      );

      // TODO(follow-up): reavisar o cliente por e-mail com o novo QR comum
      // (fallback?.pix?.payload). Hoje o cliente vê o PIX pendente em /billing/status.
      console.log('[WEBHOOK][pix-auto] ' + event + ' company=' + company.id +
        ' → fallback PIX comum ' + (fallback ? 'criado (' + fallback.subscription.id + ')' : 'NÃO criado'));

      return res.status(200).json({
        received: true, handled: true,
        pix_auto_status: newStatus,
        fallback_subscription_id: fallback?.subscription?.id || null,
      });
    }

    // CREATED e outros — só reconhece.
    return res.status(200).json({ received: true, handled: false, event_noted: event });
  } catch (err) {
    console.error('[WEBHOOK][pix-auto] erro:', err.message);
    return res.status(200).json({ received: true, error: true });
  }
}

module.exports = {
  isPixAutoEnabled,
  truncate35,
  shortContractId,
  createPixAutoAuthorization,
  createCommonPixSubscription,
  handlePixAutoAuthorizationEvent,
};
