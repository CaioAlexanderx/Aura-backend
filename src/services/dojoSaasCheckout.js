// ============================================================
// AURA DOJÔ — F3c: Checkout do plano Aura Dojô (SaaS, R$140/mês)
//
// Ramo do /billing/subscribe extraído para arquivo próprio (billing.js tem
// ~40KB e o fluxo do varejo é delicado): quando o front manda plan:'dojo',
// billing.js delega para cá SEM tocar no caminho essencial/negócio/expansão.
//
// Cobra o TOTAL do dojô (KARATE_DOJO_MONTHLY_BRL + R$19 × acessos extras)
// via conta Asaas MÃE (é o SaaS da Aura — NADA a ver com a subconta BaaS do
// dojô, que é o recebedor das MENSALIDADES DOS ALUNOS). Sem cupom, sem
// PLANS do varejo: o plano 'dojo' vive FORA de PLANS de propósito
// (billingPricing.js), então o checkout do varejo nunca o lista.
//
// PIX: subscription MONTHLY (webhook confirma → billing_status active).
// CREDIT_CARD: cobra a 1ª mensalidade imediata + subscription recorrente.
// NÃO sobrescreve companies.plan (que o varejo usa em gates) — só os campos
// de billing (status/ciclo/datas/assinatura). O gate lê billing_status +
// trial_ends_at, não o plano.
// ============================================================
'use strict';

const db = require('../config/database');
const { asaas } = require('./asaasClient');
const { KARATE_DOJO_MONTHLY_BRL, SEAT_PRICE_BRL } = require('./billingPricing');

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

async function ensureAsaasCustomer(company, user) {
  if (company.asaas_customer_id) return company.asaas_customer_id;
  const customer = await asaas('POST', '/customers', {
    name: user.full_name || user.name,
    email: user.email,
    phone: user.phone || undefined,
    cpfCnpj: (company.cnpj || '').replace(/\D/g, '') || undefined,
    company: company.legal_name || company.trade_name,
    externalReference: company.id,
  });
  await db.query('UPDATE companies SET asaas_customer_id=$1 WHERE id=$2', [customer.id, company.id]);
  return customer.id;
}

// Handler express. requireAuth + requireRole('client','admin') já rodaram
// em billing.js antes da delegação (req.user + req.params.id garantidos).
async function subscribeDojoSaas(req, res) {
  const {
    billing_type = 'PIX',
    end_date,
    credit_card_token,
    credit_card_holder_name,
    credit_card_holder_cpf,
    credit_card_holder_postal_code,
    credit_card_holder_address_number,
    credit_card_holder_address,
  } = req.body || {};

  if (billing_type === 'CREDIT_CARD' && !credit_card_token) {
    return res.status(400).json({ error: 'credit_card_token obrigatorio para cartao' });
  }

  try {
    const { rows: companies } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companies[0];

    // Só empresas da vertical dojô podem assinar o plano Aura Dojô.
    const isDojo = company.vertical === 'karate_dojo' || company.vertical_active === 'karate_dojo';
    if (!isDojo) {
      return res.status(400).json({
        error: 'O plano Aura Dojô só está disponível para dojôs.',
        stage: 'plan_vertical',
      });
    }

    const { rows: users } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = users[0];

    const customerId = await ensureAsaasCustomer(company, user);

    const extraSeats = parseInt(company.extra_seats_granted, 10) || 0;
    const value = round2(KARATE_DOJO_MONTHLY_BRL + extraSeats * SEAT_PRICE_BRL);
    const seatsSuffix = extraSeats > 0 ? ' + ' + extraSeats + ' acesso(s) extra' : '';
    const description = 'Aura Dojô' + seatsSuffix;

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    const cardHolderInfo = credit_card_holder_name ? {
      name: credit_card_holder_name,
      cpfCnpj: (credit_card_holder_cpf || company.cnpj || '').replace(/\D/g, ''),
      email: user.email,
      phone: user.phone || undefined,
      postalCode: credit_card_holder_postal_code || company.address_zip || undefined,
      addressNumber: credit_card_holder_address_number || undefined,
      address: credit_card_holder_address || undefined,
    } : undefined;

    if (company.asaas_subscription_id) {
      try { await asaas('DELETE', '/subscriptions/' + company.asaas_subscription_id); } catch (_) {}
    }

    // ── CREDIT_CARD: 1ª mensalidade imediata + subscription recorrente ──
    if (billing_type === 'CREDIT_CARD') {
      let firstPayment;
      try {
        const firstChargeBody = {
          customer: customerId,
          billingType: 'CREDIT_CARD',
          value,
          dueDate: todayStr,
          description: description + ' (1ª mensalidade)',
          externalReference: company.id,
          creditCardToken: credit_card_token,
        };
        if (cardHolderInfo) firstChargeBody.creditCardHolderInfo = cardHolderInfo;
        firstPayment = await asaas('POST', '/payments', firstChargeBody);
      } catch (err) {
        return res.status(402).json({
          error: 'Cobrança recusada: ' + (err.message || 'verifique os dados do cartão'),
          stage: 'first_charge',
        });
      }

      const isPaid = firstPayment.status === 'CONFIRMED' || firstPayment.status === 'RECEIVED';
      const isPending = firstPayment.status === 'PENDING' || firstPayment.status === 'AWAITING_RISK_ANALYSIS';
      if (!isPaid && !isPending) {
        return res.status(402).json({
          error: 'Cobrança não aprovada (status: ' + firstPayment.status + '). Tente outro cartão.',
          stage: 'first_charge_status',
          payment_status: firstPayment.status,
          payment_id: firstPayment.id,
        });
      }

      const nextMonth = new Date(today);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const subStartStr = nextMonth.toISOString().split('T')[0];

      const subscriptionBody = {
        customer: customerId,
        billingType: 'CREDIT_CARD',
        value,
        nextDueDate: subStartStr,
        cycle: 'MONTHLY',
        endDate: end_date || undefined,
        description,
        externalReference: company.id,
        creditCardToken: credit_card_token,
      };
      if (cardHolderInfo) subscriptionBody.creditCardHolderInfo = cardHolderInfo;

      let subscription = null;
      try {
        subscription = await asaas('POST', '/subscriptions', subscriptionBody);
      } catch (subErr) {
        await db.query(
          `UPDATE companies SET asaas_pending_payment_id=$1, billing_status=$2,
             billing_cycle='monthly', last_payment_date=$3, updated_at=NOW() WHERE id=$4`,
          [firstPayment.id, isPaid ? 'active' : 'pending', isPaid ? todayStr : null, company.id]
        );
        return res.status(isPaid ? 201 : 202).json({
          payment_id: firstPayment.id, subscription_id: null,
          plan: 'dojo', value, billing_type: 'CREDIT_CARD', extra_seats: extraSeats,
          charged_now: value, confirmed: isPaid,
          warning: 'Primeira mensalidade capturada, mas falha ao agendar recorrência. Reconciliação manual necessária.',
        });
      }

      const finalStatus = isPaid ? 'active' : 'pending';
      await db.query(
        `UPDATE companies SET asaas_subscription_id=$1, billing_status=$2, billing_cycle='monthly',
           asaas_pending_payment_id=$3, last_payment_date=$4, next_billing_date=$5, updated_at=NOW()
         WHERE id=$6`,
        [subscription.id, finalStatus, isPaid ? null : firstPayment.id, isPaid ? todayStr : null,
         subscription.nextDueDate, company.id]
      );

      return res.status(isPaid ? 201 : 202).json({
        payment_id: firstPayment.id, subscription_id: subscription.id,
        plan: 'dojo', value, billing_type: 'CREDIT_CARD', extra_seats: extraSeats,
        charged_now: value, payment_status: firstPayment.status,
        next_due_date: subscription.nextDueDate, confirmed: isPaid,
        message: isPaid ? 'Pagamento confirmado! Sua assinatura Aura Dojô está ativa.'
                        : 'Cobrança em análise pelo emissor. Você receberá confirmação em alguns minutos.',
      });
    }

    // ── PIX: subscription MONTHLY + QR da 1ª cobrança ──
    const subscriptionBody = {
      customer: customerId,
      billingType: 'PIX',
      value,
      nextDueDate: tomorrowStr,
      cycle: 'MONTHLY',
      endDate: end_date || undefined,
      description,
      externalReference: company.id,
    };
    const subscription = await asaas('POST', '/subscriptions', subscriptionBody);

    let pixData = null;
    let firstPaymentId = null;
    try {
      const payments = await asaas('GET', '/subscriptions/' + subscription.id + '/payments?limit=1');
      firstPaymentId = (payments.data && payments.data[0] && payments.data[0].id) || null;
      if (firstPaymentId) pixData = await asaas('GET', '/payments/' + firstPaymentId + '/pixQrCode');
    } catch (err) {
      console.error('[BILLING][dojo] Pix QR falhou:', err.message);
    }

    await db.query(
      `UPDATE companies SET asaas_subscription_id=$1, billing_status='pending',
         billing_cycle='monthly', next_billing_date=$2, updated_at=NOW() WHERE id=$3`,
      [subscription.id, subscription.nextDueDate || tomorrowStr, company.id]
    );

    return res.status(201).json({
      subscription_id: subscription.id,
      plan: 'dojo', value, billing_type: 'PIX', extra_seats: extraSeats,
      charged_now: value,
      next_due_date: subscription.nextDueDate || tomorrowStr,
      pix_qr_code: (pixData && pixData.encodedImage) || null,
      pix_copy_paste: (pixData && pixData.payload) || null,
      pix_expiration: (pixData && pixData.expirationDate) || null,
    });
  } catch (err) {
    console.error('[BILLING][dojo] Subscribe error:', err.message);
    return res.status(500).json({ error: err.message || 'Erro ao criar assinatura do dojô' });
  }
}

module.exports = { subscribeDojoSaas };
