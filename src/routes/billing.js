// ============================================================
// AURA. — F6: Asaas Billing Integration (Hybrid Checkout)
// Pix inline + Credit Card recurring via tokenization
// FIX: Added /billing/tokenize endpoint for card tokenization
// FIX: Desconto unificado 1/6 (2 meses grátis), endDate para anual cartão
// FIX: addressNumber no creditCardHolderInfo (tokenize + subscribe)
// FIX (02/05): address (logradouro) também no creditCardHolderInfo + logs de debug
// FIX (02/05): reutilizar token existente quando cartão já tokenizado
// FIX (03/05): cartão agora cobra primeira mensalidade IMEDIATAMENTE via POST /payments
//              (antes criava subscription com nextDueDate=amanhã, que ficava PENDING
//              e o cliente via "active" sem pagamento real). Subscription só agenda
//              próximas mensalidades a partir do mês seguinte. Status active só
//              quando primeira cobrança CONFIRMED/RECEIVED.
// PRICING 21/04: Negocio 199->169.90, Expansao 299->269.90
// PRICING 18/06: Negocio 169.90->169, Expansao 269.90->269 (alinhado a /planos)
// 15/06/2026: acessos extras (R$19/seat) agora entram no value cobrado
//             (plano + 19*extra_seats_granted), tanto na 1a cobrança quanto
//             na subscription recorrente. Cálculo em services/billingPricing.
//             asaas()/PLANS/getPlanValue movidos pra services compartilhados.
// 18/06/2026: PIX anual agora é subscription MONTHLY com endDate=12 meses
//             (valor mensal descontado). Bloco 'Pix a vista' removido.
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asaas } = require('../services/asaasClient');
const {
  PLANS,
  ANNUAL_DISCOUNT,
  getPlanValue,
  getTotalValue,
} = require('../services/billingPricing');

async function ensureAsaasCustomer(company, user) {
  if (company.asaas_customer_id) return company.asaas_customer_id;
  const customer = await asaas('POST', '/customers', {
    name: user.full_name || user.name,
    email: user.email,
    phone: user.phone || undefined,
    cpfCnpj: company.cnpj?.replace(/\D/g, '') || undefined,
    company: company.legal_name || company.trade_name,
    externalReference: company.id,
  });
  await db.query('UPDATE companies SET asaas_customer_id=$1 WHERE id=$2', [customer.id, company.id]);
  return customer.id;
}

// GET /billing/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = rows[0];
    const trialActive = c.trial_ends_at && new Date(c.trial_ends_at) > new Date();
    const daysLeft = trialActive ? Math.ceil((new Date(c.trial_ends_at) - new Date()) / 86400000) : 0;
    res.json({
      plan: c.plan || 'essencial',
      billing_status: c.billing_status || (trialActive ? 'trial' : 'inactive'),
      billing_cycle: c.billing_cycle || 'monthly',
      trial_active: !!trialActive,
      trial_days_left: daysLeft,
      trial_ends_at: c.trial_ends_at || null,
      next_billing_date: c.next_billing_date || null,
      has_payment_method: !!c.asaas_subscription_id,
    });
  } catch (err) {
    console.error('[BILLING] Status error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar status' });
  }
});

// POST /billing/tokenize — Tokenize credit card via Asaas
// Card data flows through server but is NEVER stored
// Returns only the token for use in /subscribe
router.post('/tokenize', requireAuth, requireRole('client', 'admin'), async (req, res) => {
  const {
    card_number, card_expiry_month, card_expiry_year, card_ccv,
    holder_name, holder_cpf, holder_postal_code, holder_address_number, holder_address,
  } = req.body;

  if (!card_number || !card_expiry_month || !card_expiry_year || !card_ccv || !holder_name) {
    return res.status(400).json({ error: 'Dados do cartao incompletos' });
  }

  // Hoisted so catch block pode acessar para recuperar token existente
  let company = null;
  let customerId = null;

  try {
    const { rows: companies } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    company = companies[0];

    const { rows: users } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = users[0];

    customerId = await ensureAsaasCustomer(company, user);

    // Log sanitizado — nunca logar dados de cartão
    console.log('[BILLING] Tokenize for company ' + company.id + ' — holderInfo:', JSON.stringify({
      hasName: !!holder_name,
      hasCpf: !!holder_cpf,
      hasPostalCode: !!holder_postal_code,
      addressNumber: holder_address_number || '(empty)',
      address: holder_address || '(empty)',
    }));

    const tokenData = await asaas('POST', '/creditCard/tokenize', {
      customer: customerId,
      creditCard: {
        holderName: holder_name,
        number: card_number.replace(/\D/g, ''),
        expiryMonth: String(card_expiry_month).padStart(2, '0'),
        expiryYear: String(card_expiry_year).length === 2 ? '20' + card_expiry_year : String(card_expiry_year),
        ccv: String(card_ccv),
      },
      creditCardHolderInfo: {
        name: holder_name,
        email: user.email,
        cpfCnpj: (holder_cpf || company.cnpj || '').replace(/\D/g, ''),
        postalCode: holder_postal_code || company.address_zip || undefined,
        addressNumber: holder_address_number || undefined,
        address: holder_address || undefined,
        phone: user.phone || undefined,
      },
    });

    // Return ONLY the token — never the card data
    console.log('[BILLING] Card tokenized for company ' + company.id + ', brand: ' + (tokenData.creditCardBrand || 'unknown'));

    res.json({
      credit_card_token: tokenData.creditCardToken,
      credit_card_brand: tokenData.creditCardBrand || null,
      credit_card_last4: tokenData.creditCardNumber || null,
    });
  } catch (err) {
    // Cartão já tokenizado no Asaas (ocorre quando o cliente foi deletado e recriado
    // mas o token do cartão ainda existe). Busca o token existente e reutiliza.
    const msg = (err.message || '').toLowerCase();
    const isAlreadyTokenized = msg.includes('já tokenizado') || msg.includes('ja tokenizado') || msg.includes('already tokenized');
    if (isAlreadyTokenized && customerId) {
      try {
        console.log('[BILLING] Card already tokenized — fetching existing token for customer ' + customerId);
        const existing = await asaas('GET', '/creditCards?customer=' + customerId);
        const card = existing?.data?.[0];
        if (card?.creditCardToken) {
          console.log('[BILLING] Reusing existing token for company ' + (company?.id || '?') + ', brand: ' + (card.creditCardBrand || 'unknown'));
          return res.json({
            credit_card_token: card.creditCardToken,
            credit_card_brand: card.creditCardBrand || null,
            credit_card_last4: card.creditCardNumber || null,
          });
        }
      } catch (fetchErr) {
        console.error('[BILLING] Failed to fetch existing token:', fetchErr.message);
      }
    }
    console.error('[BILLING] Tokenize error:', err.message);
    res.status(400).json({ error: err.message || 'Erro ao tokenizar cartao' });
  }
});

// POST /billing/subscribe
router.post('/subscribe', requireAuth, requireRole('client', 'admin'), async (req, res) => {
  const {
    plan,
    billing_type = 'PIX',
    cycle = 'monthly',
    end_date,
    credit_card_token,
    credit_card_holder_name,
    credit_card_holder_cpf,
    credit_card_holder_postal_code,
    credit_card_holder_address_number,
    credit_card_holder_address,
  } = req.body;

  if (!plan || !PLANS[plan]) {
    return res.status(400).json({ error: 'Plano invalido. Opcoes: essencial, negocio, expansao' });
  }
  if (billing_type === 'CREDIT_CARD' && !credit_card_token) {
    return res.status(400).json({ error: 'credit_card_token obrigatorio para cartao' });
  }

  // Validacao de valor do plano (sem seats ainda — seats dependem da empresa).
  const planValue = getPlanValue(plan, cycle, billing_type);
  if (planValue === null) return res.status(400).json({ error: 'Erro ao calcular valor' });

  try {
    const { rows: companies } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companies[0];

    const { rows: users } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = users[0];

    const customerId = await ensureAsaasCustomer(company, user);

    // 15/06/2026: acessos extras pagos (R$19/seat) entram no valor cobrado.
    // Cliente sem seat extra → extraSeats=0 → value identico ao de antes.
    // Coluna pode nao existir pre-migration 110 → undefined → 0 (seguro).
    const extraSeats = parseInt(company.extra_seats_granted, 10) || 0;
    const value = getTotalValue(plan, cycle, billing_type, extraSeats);
    const seatsSuffix = extraSeats > 0 ? ' + ' + extraSeats + ' acesso(s) extra' : '';

    if (company.asaas_subscription_id) {
      try { await asaas('DELETE', '/subscriptions/' + company.asaas_subscription_id); } catch {}
    }

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // ════════════════════════════════════════════════════════════════
    // CREDIT_CARD: cobrar PRIMEIRO MÊS imediato + criar subscription
    // pra recorrência a partir do mês seguinte. Só marca billing_status=
    // 'active' se a primeira cobrança vier CONFIRMED/RECEIVED do Asaas.
    // ════════════════════════════════════════════════════════════════
    if (billing_type === 'CREDIT_CARD') {
      const cardHolderInfo = credit_card_holder_name ? {
        name: credit_card_holder_name,
        cpfCnpj: (credit_card_holder_cpf || company.cnpj || '').replace(/\D/g, ''),
        email: user.email,
        phone: user.phone || undefined,
        postalCode: credit_card_holder_postal_code || company.address_zip || undefined,
        addressNumber: credit_card_holder_address_number || undefined,
        address: credit_card_holder_address || undefined,
      } : undefined;

      console.log('[BILLING] Cobranca imediata cartao — company=' + company.id + ' value=' + value + ' cycle=' + cycle + ' seats=' + extraSeats);

      // 1. Cobrar primeira mensalidade AGORA (captura sincrona via cartao)
      let firstPayment;
      try {
        const firstChargeBody = {
          customer: customerId,
          billingType: 'CREDIT_CARD',
          value: value,
          dueDate: todayStr,
          description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual - 1ª mensalidade)' : '') + seatsSuffix,
          externalReference: company.id,
          creditCardToken: credit_card_token,
        };
        if (cardHolderInfo) firstChargeBody.creditCardHolderInfo = cardHolderInfo;
        firstPayment = await asaas('POST', '/payments', firstChargeBody);
      } catch (err) {
        console.error('[BILLING] Cobranca imediata FALHOU:', err.message);
        return res.status(402).json({
          error: 'Cobrança recusada: ' + (err.message || 'verifique os dados do cartão'),
          stage: 'first_charge',
        });
      }

      const isPaid = firstPayment.status === 'CONFIRMED' || firstPayment.status === 'RECEIVED';
      const isPending = firstPayment.status === 'PENDING' || firstPayment.status === 'AWAITING_RISK_ANALYSIS';

      // Status nao reconhecido como sucesso nem como pendente → falha
      if (!isPaid && !isPending) {
        console.warn('[BILLING] Cobranca imediata nao aprovada — status=' + firstPayment.status);
        return res.status(402).json({
          error: 'Cobrança não aprovada (status: ' + firstPayment.status + '). Tente outro cartão.',
          stage: 'first_charge_status',
          payment_status: firstPayment.status,
          payment_id: firstPayment.id,
        });
      }

      // 2. Criar subscription pra cobranças recorrentes a partir do mês seguinte
      const nextMonth = new Date(today);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const subStartStr = nextMonth.toISOString().split('T')[0];

      // Pra anual: subscription endDate = end_date - 1 mês (já cobrei 1 imediato,
      // restam 11 mensalidades pra subscription gerar entre subStartStr e endDt).
      let subscriptionEndDate = undefined;
      if (cycle === 'annual' && end_date) {
        const endDt = new Date(end_date);
        endDt.setMonth(endDt.getMonth() - 1);
        subscriptionEndDate = endDt.toISOString().split('T')[0];
      }

      const subscriptionBody = {
        customer: customerId,
        billingType: 'CREDIT_CARD',
        value: value,
        nextDueDate: subStartStr,
        cycle: 'MONTHLY',
        endDate: subscriptionEndDate,
        description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual)' : '') + seatsSuffix,
        externalReference: company.id,
        creditCardToken: credit_card_token,
      };
      if (cardHolderInfo) subscriptionBody.creditCardHolderInfo = cardHolderInfo;

      let subscription = null;
      try {
        subscription = await asaas('POST', '/subscriptions', subscriptionBody);
      } catch (subErr) {
        // Subscription falhou mas a primeira cobranca ja foi capturada.
        // Persistir payment_id e marcar pra reconciliacao manual.
        console.error('[BILLING] Subscription falhou apos primeira cobranca OK:', subErr.message);
        await db.query(
          `UPDATE companies SET plan=$1, asaas_pending_payment_id=$2, billing_status=$3,
             billing_cycle=$4, last_payment_date=$5, updated_at=NOW() WHERE id=$6`,
          [plan, firstPayment.id, isPaid ? 'active' : 'pending', cycle,
           isPaid ? todayStr : null, company.id]
        );
        return res.status(isPaid ? 201 : 202).json({
          payment_id: firstPayment.id,
          subscription_id: null,
          payment_status: firstPayment.status,
          plan, cycle, value, billing_type: 'CREDIT_CARD',
          extra_seats: extraSeats,
          confirmed: isPaid,
          warning: 'Primeira mensalidade capturada com sucesso, mas falha ao agendar recorrência. Suporte foi notificado para reconciliação manual.',
        });
      }

      // 3. Atualizar empresa
      const finalStatus = isPaid ? 'active' : 'pending';
      await db.query(
        `UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status=$3,
           billing_cycle=$4, asaas_pending_payment_id=$5, last_payment_date=$6,
           next_billing_date=$7, updated_at=NOW() WHERE id=$8`,
        [plan, subscription.id, finalStatus, cycle,
         isPaid ? null : firstPayment.id,
         isPaid ? todayStr : null,
         subscription.nextDueDate, company.id]
      );

      console.log('[BILLING] Subscription ' + subscription.id + ' criada — billing_status=' + finalStatus + ' (payment_status=' + firstPayment.status + ')');

      return res.status(isPaid ? 201 : 202).json({
        payment_id: firstPayment.id,
        subscription_id: subscription.id,
        plan, cycle, value, billing_type: 'CREDIT_CARD',
        extra_seats: extraSeats,
        payment_status: firstPayment.status,
        next_due_date: subscription.nextDueDate,
        confirmed: isPaid,
        message: isPaid
          ? 'Pagamento confirmado! Sua assinatura está ativa.'
          : 'Cobrança em análise pelo emissor. Você receberá confirmação em alguns minutos.',
      });
    }

    // ════════════════════════════════════════════════════════════════
    // PIX (mensal ou anual): subscription MONTHLY com nextDueDate=amanhã.
    // Para anual: endDate limita a 12 mensalidades; valor ja vem descontado
    // de billingPricing.applyCycle (ex: Negocio = R$140,83/mes).
    // Cliente paga o Pix gerado; webhook ativa quando confirma.
    // ════════════════════════════════════════════════════════════════
    const subscriptionBody = {
      customer: customerId,
      billingType: 'PIX',
      value: value,
      nextDueDate: tomorrowStr,
      cycle: 'MONTHLY',
      endDate: cycle === 'annual' ? end_date : undefined,
      description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual)' : '') + seatsSuffix,
      externalReference: company.id,
    };

    const subscription = await asaas('POST', '/subscriptions', subscriptionBody);

    let pixData = null;
    try {
      const payments = await asaas('GET', '/subscriptions/' + subscription.id + '/payments?limit=1');
      if (payments.data?.[0]?.id) {
        pixData = await asaas('GET', '/payments/' + payments.data[0].id + '/pixQrCode');
      }
    } catch {}

    await db.query(
      'UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status=\'pending\', billing_cycle=$3, next_billing_date=$4, updated_at=NOW() WHERE id=$5',
      [plan, subscription.id, cycle, subscription.nextDueDate, company.id]
    );

    const response = {
      subscription_id: subscription.id,
      plan, cycle, value, billing_type: 'PIX',
      extra_seats: extraSeats,
      next_due_date: subscription.nextDueDate,
      pix_qr_code: pixData?.encodedImage || null,
      pix_copy_paste: pixData?.payload || null,
      pix_expiration: pixData?.expirationDate || null,
    };

    res.status(201).json(response);
  } catch (err) {
    console.error('[BILLING] Subscribe error:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao criar assinatura' });
  }
});

// POST /billing/cancel
router.post('/cancel', requireAuth, requireRole('client', 'admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT asaas_subscription_id FROM companies WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].asaas_subscription_id) {
      return res.status(400).json({ error: 'Nenhuma assinatura ativa' });
    }
    await asaas('DELETE', '/subscriptions/' + rows[0].asaas_subscription_id);
    await db.query(
      'UPDATE companies SET billing_status=\'cancelled\', asaas_subscription_id=NULL, updated_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    res.json({ message: 'Assinatura cancelada', cancelled_at: new Date().toISOString() });
  } catch (err) { res.status(500).json({ error: 'Erro ao cancelar' }); }
});

// GET /billing/invoices
router.get('/invoices', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT asaas_customer_id FROM companies WHERE id=$1', [req.params.id]);
    if (!rows[0]?.asaas_customer_id) return res.json({ invoices: [] });
    const data = await asaas('GET', '/payments?customer=' + rows[0].asaas_customer_id + '&limit=20');
    const invoices = (data.data || []).map(function(p) {
      return {
        id: p.id, value: p.value, status: p.status, due_date: p.dueDate,
        payment_date: p.paymentDate, billing_type: p.billingType,
        invoice_url: p.invoiceUrl, bank_slip_url: p.bankSlipUrl,
      };
    });
    res.json({ total: invoices.length, invoices: invoices });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar faturas' }); }
});

// POST /billing/generate-pix/:paymentId
router.post('/generate-pix/:paymentId', requireAuth, async (req, res) => {
  try {
    const pix = await asaas('GET', '/payments/' + req.params.paymentId + '/pixQrCode');
    res.json({ qr_code: pix.encodedImage, copy_paste: pix.payload, expiration: pix.expirationDate });
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar Pix' }); }
});

// GET /billing/plans
// Expõe valores mensais e anuais para uso pelo frontend e terceiros.
// annual_total = custo total pago ao longo dos 12 meses (informativo).
router.get('/plans', async (req, res) => {
  const plans = Object.entries(PLANS).map(function(entry) {
    var key = entry[0];
    var cfg = entry[1];
    var annualMonthly = Math.round(cfg.monthly * (1 - ANNUAL_DISCOUNT) * 100) / 100;
    return {
      key: key, name: cfg.name, monthly: cfg.monthly,
      annual_monthly: annualMonthly,
      annual_total: Math.round(annualMonthly * 12 * 100) / 100,
      annual_discount: Math.round(ANNUAL_DISCOUNT * 100) + '%',
    };
  });
  res.json({ plans: plans });
});

module.exports = router;
