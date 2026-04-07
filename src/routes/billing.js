// ============================================================
// AURA. — F6: Asaas Billing Integration
// Mounted at: /companies/:id/billing
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
  const resp = await fetch(`${ASAAS_URL}${path}`, opts);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.errors?.[0]?.description || `Asaas error ${resp.status}`);
  return data;
}

const PLANS = {
  essencial: { name: 'Aura Essencial', value: 89 },
  negocio:   { name: 'Aura Negocio', value: 199 },
  expansao:  { name: 'Aura Expansao', value: 299 },
};

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

// POST /billing/subscribe
router.post('/subscribe', requireAuth, requireRole('client', 'admin'), async (req, res) => {
  const { plan, billing_type = 'UNDEFINED' } = req.body;
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'Plano invalido. Opcoes: essencial, negocio, expansao' });

  try {
    const { rows: companies } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companies[0];

    const { rows: users } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    const user = users[0];

    let customerId = company.asaas_customer_id;
    if (!customerId) {
      const customer = await asaas('POST', '/customers', {
        name: user.full_name,
        email: user.email,
        phone: user.phone || undefined,
        cpfCnpj: company.cnpj?.replace(/\D/g, '') || undefined,
        company: company.legal_name || company.trade_name,
        externalReference: company.id,
      });
      customerId = customer.id;
      await db.query('UPDATE companies SET asaas_customer_id=$1 WHERE id=$2', [customerId, company.id]);
    }

    if (company.asaas_subscription_id) {
      try { await asaas('DELETE', `/subscriptions/${company.asaas_subscription_id}`); } catch {}
    }

    const planConfig = PLANS[plan];
    const trialActive = company.trial_ends_at && new Date(company.trial_ends_at) > new Date();
    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + (trialActive ? 0 : 1));

    const subscription = await asaas('POST', '/subscriptions', {
      customer: customerId,
      billingType: billing_type,
      value: planConfig.value,
      nextDueDate: nextDueDate.toISOString().split('T')[0],
      cycle: 'MONTHLY',
      description: planConfig.name,
      externalReference: company.id,
    });

    await db.query(
      `UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status='active', next_billing_date=$3, updated_at=NOW() WHERE id=$4`,
      [plan, subscription.id, subscription.nextDueDate, company.id]
    );

    res.status(201).json({
      subscription_id: subscription.id,
      plan,
      value: planConfig.value,
      next_due_date: subscription.nextDueDate,
      billing_type: subscription.billingType,
      payment_link: subscription.paymentLink || null,
    });
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
    await asaas('DELETE', `/subscriptions/${rows[0].asaas_subscription_id}`);
    await db.query(
      `UPDATE companies SET billing_status='cancelled', asaas_subscription_id=NULL, updated_at=NOW() WHERE id=$1`,
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
    const data = await asaas('GET', `/payments?customer=${rows[0].asaas_customer_id}&limit=20`);
    const invoices = (data.data || []).map(p => ({
      id: p.id, value: p.value, status: p.status, due_date: p.dueDate,
      payment_date: p.paymentDate, billing_type: p.billingType,
      invoice_url: p.invoiceUrl, bank_slip_url: p.bankSlipUrl, pix_qr_code: p.pixQrCodeUrl,
    }));
    res.json({ total: invoices.length, invoices });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar faturas' }); }
});

// POST /billing/generate-pix/:paymentId
router.post('/generate-pix/:paymentId', requireAuth, async (req, res) => {
  try {
    const pix = await asaas('GET', `/payments/${req.params.paymentId}/pixQrCode`);
    res.json({ qr_code: pix.encodedImage, copy_paste: pix.payload, expiration: pix.expirationDate });
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar Pix' }); }
});

module.exports = router;
