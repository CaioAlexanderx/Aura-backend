// ============================================================
// AURA. — F6: Asaas Billing Integration (Hybrid Checkout)
// Pix inline + Credit Card recurring via tokenization
// FIX: Added /billing/tokenize endpoint for card tokenization
// FIX: Desconto unificado 1/6 (2 meses grátis), endDate para anual cartão
// FIX: addressNumber no creditCardHolderInfo (tokenize + subscribe)
// FIX (02/05): address (logradouro) também no creditCardHolderInfo + logs de debug
// FIX (02/05): reutilizar token existente quando cartão já tokenizado
// PRICING 21/04: Negocio 199->169.90, Expansao 299->269.90
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const ASAAS_URL = process.env.ASAAS_URL || 'https://api.asaas.com/v3';
const ASAAS_KEY = process.env.ASAAS_API_KEY;

async function asaas(method, path, body) {
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY nao configurada');
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(ASAAS_URL + path, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.errors?.[0]?.description || 'Asaas error ' + resp.status);
  return data;
}

const PLANS = {
  essencial: { name: 'Aura Essencial', monthly: 89 },
  negocio:   { name: 'Aura Negocio',   monthly: 169.90 },
  expansao:  { name: 'Aura Expansao',  monthly: 269.90 },
};

// 2 meses grátis: paga 10, leva 12 — aplica tanto no Pix quanto no Cartão
const ANNUAL_DISCOUNT = 1 / 6;

function getPlanValue(plan, cycle, billingType) {
  const cfg = PLANS[plan];
  if (!cfg) return null;
  if (cycle === 'annual') {
    if (billingType === 'PIX') {
      // Pix anual: pagamento único à vista com desconto de 2 meses
      return Math.round(cfg.monthly * 12 * (1 - ANNUAL_DISCOUNT) * 100) / 100;
    }
    // Cartão anual: assinatura mensal com valor descontado + endDate em 12 meses
    return Math.round(cfg.monthly * (1 - ANNUAL_DISCOUNT) * 100) / 100;
  }
  return cfg.monthly;
}

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

  const value = getPlanValue(plan, cycle, billing_type);
  if (!value) return res.status(400).json({ error: 'Erro ao calcular valor' });

  try {
    const { rows: companies } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companies[0];

    const { rows: users } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = users[0];

    const customerId = await ensureAsaasCustomer(company, user);

    if (company.asaas_subscription_id) {
      try { await asaas('DELETE', '/subscriptions/' + company.asaas_subscription_id); } catch {}
    }

    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + 1);
    const dueDateStr = nextDueDate.toISOString().split('T')[0];

    // PIX Annual: single upfront payment
    if (billing_type === 'PIX' && cycle === 'annual') {
      const payment = await asaas('POST', '/payments', {
        customer: customerId,
        billingType: 'PIX',
        value: value,
        dueDate: dueDateStr,
        description: PLANS[plan].name + ' - Anual (Pix a vista)',
        externalReference: company.id,
      });

      let pixData = null;
      try { pixData = await asaas('GET', '/payments/' + payment.id + '/pixQrCode'); } catch {}

      await db.query(
        'UPDATE companies SET plan=$1, billing_cycle=\'annual\', billing_status=\'pending\', asaas_pending_payment_id=$2, updated_at=NOW() WHERE id=$3',
        [plan, payment.id, company.id]
      );

      return res.status(201).json({
        payment_id: payment.id, plan: plan, cycle: 'annual', value: value, billing_type: 'PIX',
        pix_qr_code: pixData?.encodedImage || null,
        pix_copy_paste: pixData?.payload || null,
        pix_expiration: pixData?.expirationDate || null,
      });
    }

    // Monthly subscription (PIX or CARD)
    // Para anual no cartão: valor mensal descontado + endDate 12 meses à frente
    const subscriptionBody = {
      customer: customerId,
      billingType: billing_type,
      value: value,
      nextDueDate: dueDateStr,
      cycle: 'MONTHLY',
      endDate: cycle === 'annual' ? end_date : undefined,
      description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual)' : ''),
      externalReference: company.id,
    };

    if (billing_type === 'CREDIT_CARD' && credit_card_token) {
      subscriptionBody.creditCardToken = credit_card_token;
      if (credit_card_holder_name) {
        subscriptionBody.creditCardHolderInfo = {
          name: credit_card_holder_name,
          cpfCnpj: (credit_card_holder_cpf || company.cnpj || '').replace(/\D/g, ''),
          email: user.email,
          phone: user.phone || undefined,
          postalCode: credit_card_holder_postal_code || company.address_zip || undefined,
          addressNumber: credit_card_holder_address_number || undefined,
          address: credit_card_holder_address || undefined,
        };
      }

      // Log sanitizado — nunca logar token completo
      console.log('[BILLING] Subscribe for company ' + company.id + ' — holderInfo:', JSON.stringify({
        hasName: !!credit_card_holder_name,
        hasCpf: !!credit_card_holder_cpf,
        hasPostalCode: !!credit_card_holder_postal_code,
        addressNumber: credit_card_holder_address_number || '(empty)',
        address: credit_card_holder_address || '(empty)',
      }));
    }

    const subscription = await asaas('POST', '/subscriptions', subscriptionBody);

    let pixData = null;
    if (billing_type === 'PIX') {
      try {
        const payments = await asaas('GET', '/subscriptions/' + subscription.id + '/payments?limit=1');
        if (payments.data?.[0]?.id) {
          pixData = await asaas('GET', '/payments/' + payments.data[0].id + '/pixQrCode');
        }
      } catch {}
    }

    await db.query(
      'UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status=$3, billing_cycle=$4, next_billing_date=$5, updated_at=NOW() WHERE id=$6',
      [plan, subscription.id, billing_type === 'CREDIT_CARD' ? 'active' : 'pending', cycle, subscription.nextDueDate, company.id]
    );

    const response = {
      subscription_id: subscription.id,
      plan: plan, cycle: cycle, value: value, billing_type: billing_type,
      next_due_date: subscription.nextDueDate,
    };

    if (billing_type === 'PIX' && pixData) {
      response.pix_qr_code = pixData.encodedImage || null;
      response.pix_copy_paste = pixData.payload || null;
      response.pix_expiration = pixData.expirationDate || null;
    }

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
router.get('/plans', async (req, res) => {
  const plans = Object.entries(PLANS).map(function(entry) {
    var key = entry[0];
    var cfg = entry[1];
    var annualMonthly = Math.round(cfg.monthly * (1 - ANNUAL_DISCOUNT) * 100) / 100;
    return {
      key: key, name: cfg.name, monthly: cfg.monthly,
      annual_monthly: annualMonthly,
      annual_pix_total: Math.round(cfg.monthly * 12 * (1 - ANNUAL_DISCOUNT) * 100) / 100,
      annual_discount: Math.round(ANNUAL_DISCOUNT * 100) + '%',
    };
  });
  res.json({ plans: plans });
});

module.exports = router;
