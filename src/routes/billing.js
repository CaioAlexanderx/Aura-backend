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
//
// 13/07/2026 — CUPOM NO CHECKOUT (access_code no body):
//   Até aqui, access_codes.discount_pct e trial_days só eram lidos no
//   /auth/register — e o discount_pct nem lá tocava a cobrança. Um cupom de 50%
//   cobrava o valor cheio. Agora o código vale aqui, com dois efeitos:
//
//     discount_pct → PRIMEIRA mensalidade com desconto (só sobre o plano; o
//       acesso extra de R$19/seat continua cheio, mesma regra do desconto
//       anual). A subscription recorrente é criada com o valor CHEIO — não há
//       estado pra restaurar depois, nem job de expiração.
//
//     trial_days → NENHUMA cobrança hoje. O cartão é tokenizado e salvo e a
//       subscription já nasce agendada pra D+N (billing_status='trial',
//       trial_ends_at=D+N). É o formato da campanha de indicação: 30 dias
//       grátis com o cartão já cadastrado, então a conversão no fim do trial
//       não depende do cliente voltar e digitar cartão.
//
//   Ordem importa: reserva o uso do cupom ANTES de cobrar e libera se o Asaas
//   recusar — cobrança recusada não pode queimar o cupom do cliente.
//   Resgate auditado em coupon_redemptions (migration 228).
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { asaas } = require('../services/asaasClient');
const {
  PLANS,
  ANNUAL_DISCOUNT,
  MIN_CHARGE_BRL,
  getPlanValue,
  getTotalValue,
  getFirstChargeValue,
} = require('../services/billingPricing');
const {
  validateCoupon,
  reserveCoupon,
  releaseCoupon,
  recordRedemption,
} = require('../services/checkoutCoupon');

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

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
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

// GET /billing/karate-gate — estado BINÁRIO do gate de cobrança da federação
// karatê (checkout "invisível"): 'ok' quando em dia; 'blocked' no vencimento /
// atraso. Valor fixo R$169 (plano Negócio), sem seleção de plano. Read-only —
// não cria cobrança nem toca no Asaas; só interpreta o estado já mantido pelo
// webhook (billing_status) + datas.
router.get('/karate-gate', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, plan, billing_status, trial_ends_at, next_billing_date, asaas_subscription_id
         FROM companies WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = rows[0];
    const AMOUNT = 169; // plano Negócio (billingPricing.PLANS.negocio.monthly)
    const now = new Date();
    const dueRaw = c.next_billing_date || c.trial_ends_at || null;

    // Regra binária, sem avisos prévios: a federação está EM DIA (invisível) só
    // quando a assinatura está paga (billing_status='active') OU ainda dentro do
    // trial. Qualquer outro estado — overdue, pending (PIX aguardando), inactive,
    // trial expirado — BLOQUEIA. (Assim gerar o PIX não desbloqueia antes do
    // pagamento; o webhook confirma → 'active' → gate some.)
    const overdue = c.billing_status === 'overdue';
    const trialActive = c.trial_ends_at && new Date(c.trial_ends_at) > now;
    const active = c.billing_status === 'active';
    // 'overdue' (Asaas marcou cobrança vencida) SEMPRE bloqueia, mesmo se o
    // trial_ends_at ainda for futuro. Fora disso: em dia = active OU trial vigente.
    const blocked = overdue || (!active && !trialActive);

    res.json({
      state: blocked ? 'blocked' : 'ok',
      amount: AMOUNT,
      billing_status: c.billing_status || null,
      due_date: dueRaw || null,
      has_subscription: !!c.asaas_subscription_id,
    });
  } catch (err) {
    console.error('[BILLING] karate-gate error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar estado de cobranca' });
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

// POST /billing/validate-coupon — checagem do cupom ANTES de assinar.
// Autenticada e por empresa (diferente do /auth/validate-code publico, que e do
// cadastro): aqui a gente ja sabe QUEM esta resgatando, entao da pra barrar
// resgate repetido da mesma empresa e devolver o valor exato que sera cobrado.
router.post('/validate-coupon', requireAuth, requireRole('client', 'admin'), async (req, res) => {
  const { code, plan, cycle = 'monthly', billing_type = 'PIX' } = req.body || {};

  try {
    const { rows: companies } = await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companies[0];

    const coupon = await validateCoupon(code, company.id);
    if (!coupon.valid) {
      return res.json({ valid: false, error: coupon.error });
    }

    const selectedPlan = PLANS[plan] ? plan : (company.plan || 'essencial');
    const extraSeats = parseInt(company.extra_seats_granted, 10) || 0;

    const recurring = getTotalValue(selectedPlan, cycle, billing_type, extraSeats);
    const first = coupon.trial_days > 0
      ? 0
      : getFirstChargeValue(selectedPlan, cycle, billing_type, extraSeats, coupon.discount_pct);

    res.json({
      valid: true,
      code: coupon.code,
      type: coupon.type,
      discount_pct: coupon.discount_pct,
      trial_days: coupon.trial_days,
      // O que o cliente paga HOJE e o que ele passa a pagar depois.
      first_charge_value: first,
      recurring_value: recurring,
      first_charge_date: coupon.trial_days > 0 ? addDaysIso(coupon.trial_days) : addDaysIso(0),
      extra_seats: extraSeats,
    });
  } catch (err) {
    console.error('[BILLING] validate-coupon error:', err.message);
    res.status(500).json({ error: 'Erro ao validar cupom' });
  }
});

// POST /billing/subscribe
router.post('/subscribe', requireAuth, requireRole('client', 'admin'), async (req, res) => {
  const {
    plan,
    billing_type = 'PIX',
    cycle = 'monthly',
    end_date,
    access_code,
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

  // Cupom reservado — precisa ser liberado se qualquer coisa falhar depois.
  let reservedCouponId = null;

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

    // Valor RECORRENTE (o que vai pra assinatura no Asaas). Cupom nao entra aqui.
    const value = getTotalValue(plan, cycle, billing_type, extraSeats);
    const seatsSuffix = extraSeats > 0 ? ' + ' + extraSeats + ' acesso(s) extra' : '';

    // ── Cupom (13/07/2026) ────────────────────────────────────
    let coupon = null;
    if (access_code) {
      coupon = await validateCoupon(access_code, company.id);
      if (!coupon.valid) {
        return res.status(400).json({ error: coupon.error, stage: 'coupon' });
      }
    }
    const discountPct = coupon ? coupon.discount_pct : 0;
    const trialDays = coupon ? coupon.trial_days : 0;

    // Valor da PRIMEIRA cobranca (desconto so no plano). Com trial_days nao ha
    // cobranca imediata nenhuma — o desconto e ignorado de proposito (ver
    // comentario em checkoutCoupon.js).
    const firstValue = getFirstChargeValue(plan, cycle, billing_type, extraSeats, discountPct);

    if (trialDays === 0 && discountPct > 0 && firstValue < MIN_CHARGE_BRL) {
      return res.status(400).json({
        error: 'O desconto deixa a primeira mensalidade abaixo do minimo de R$ ' + MIN_CHARGE_BRL +
               ' aceito pelo provedor. Use um cupom de dias gratis para isentar o periodo.',
        stage: 'coupon',
      });
    }

    // Reserva o uso ANTES de cobrar. Se o Asaas recusar, liberamos (finally/catch).
    if (coupon) {
      const reserved = await reserveCoupon(coupon.id);
      if (!reserved) {
        return res.status(409).json({ error: 'Cupom esgotado.', stage: 'coupon' });
      }
      reservedCouponId = coupon.id;
    }

    if (company.asaas_subscription_id) {
      try { await asaas('DELETE', '/subscriptions/' + company.asaas_subscription_id); } catch {}
    }

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Data da primeira cobranca: hoje (ou amanha no Pix) — ou D+N com cupom de
    // dias gratis.
    const trialEndsStr = trialDays > 0 ? addDaysIso(trialDays) : null;

    const cardHolderInfo = credit_card_holder_name ? {
      name: credit_card_holder_name,
      cpfCnpj: (credit_card_holder_cpf || company.cnpj || '').replace(/\D/g, ''),
      email: user.email,
      phone: user.phone || undefined,
      postalCode: credit_card_holder_postal_code || company.address_zip || undefined,
      addressNumber: credit_card_holder_address_number || undefined,
      address: credit_card_holder_address || undefined,
    } : undefined;

    // ════════════════════════════════════════════════════════════════
    // CARTAO + CUPOM DE DIAS GRATIS: nao cobra nada agora.
    // O cartao ja fica salvo (creditCardToken na subscription) e a primeira
    // cobranca e agendada pra D+N. billing_status='trial' + trial_ends_at
    // mantem o cliente com acesso (o gate do app le trial_ends_at).
    // ════════════════════════════════════════════════════════════════
    if (billing_type === 'CREDIT_CARD' && trialDays > 0) {
      console.log('[BILLING] Cupom ' + coupon.code + ': ' + trialDays + ' dias gratis — company=' +
                  company.id + ' 1a cobranca em ' + trialEndsStr + ' value=' + value);

      let subscriptionEndDate = undefined;
      if (cycle === 'annual' && end_date) subscriptionEndDate = end_date;

      const subscriptionBody = {
        customer: customerId,
        billingType: 'CREDIT_CARD',
        value: value,
        nextDueDate: trialEndsStr,
        cycle: 'MONTHLY',
        endDate: subscriptionEndDate,
        description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual)' : '') + seatsSuffix +
                     ' — ' + trialDays + ' dias gratis (' + coupon.code + ')',
        externalReference: company.id,
        creditCardToken: credit_card_token,
      };
      if (cardHolderInfo) subscriptionBody.creditCardHolderInfo = cardHolderInfo;

      const subscription = await asaas('POST', '/subscriptions', subscriptionBody);

      await db.query(
        `UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status='trial',
           billing_cycle=$3, trial_ends_at=$4, next_billing_date=$5, updated_at=NOW()
         WHERE id=$6`,
        [plan, subscription.id, cycle, trialEndsStr, subscription.nextDueDate || trialEndsStr, company.id]
      );

      await recordRedemption({
        companyId: company.id,
        userId: user.id,
        codeId: coupon.id,
        code: coupon.code,
        type: coupon.type,
        discountPct: discountPct,
        trialDays: trialDays,
        plan, cycle,
        billingType: 'CREDIT_CARD',
        recurringValue: value,
        chargedValue: null, // nao houve cobranca imediata
        paymentId: null,
        subscriptionId: subscription.id,
      });
      reservedCouponId = null; // resgate concluido — nao liberar

      return res.status(201).json({
        subscription_id: subscription.id,
        payment_id: null,
        plan, cycle, value, billing_type: 'CREDIT_CARD',
        extra_seats: extraSeats,
        coupon: { code: coupon.code, trial_days: trialDays, discount_pct: discountPct },
        charged_now: 0,
        trial_ends_at: trialEndsStr,
        next_due_date: subscription.nextDueDate || trialEndsStr,
        confirmed: true,
        message: trialDays + ' dias gratis ativados! Seu cartao ficou salvo e a primeira cobranca de ' +
                 'R$ ' + value.toFixed(2).replace('.', ',') + ' sera em ' + trialEndsStr + '.',
      });
    }

    // ════════════════════════════════════════════════════════════════
    // CREDIT_CARD: cobrar PRIMEIRO MÊS imediato + criar subscription
    // pra recorrência a partir do mês seguinte. Só marca billing_status=
    // 'active' se a primeira cobrança vier CONFIRMED/RECEIVED.
    // 13/07: o valor da 1a cobranca vira firstValue (cupom de desconto).
    // ════════════════════════════════════════════════════════════════
    if (billing_type === 'CREDIT_CARD') {
      console.log('[BILLING] Cobranca imediata cartao — company=' + company.id + ' first=' + firstValue +
                  ' recorrente=' + value + ' cycle=' + cycle + ' seats=' + extraSeats +
                  (coupon ? ' cupom=' + coupon.code + ' (-' + discountPct + '%)' : ''));

      // 1. Cobrar primeira mensalidade AGORA (captura sincrona via cartao)
      let firstPayment;
      try {
        const firstChargeBody = {
          customer: customerId,
          billingType: 'CREDIT_CARD',
          value: firstValue,
          dueDate: todayStr,
          description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual - 1ª mensalidade)' : '') + seatsSuffix +
                       (coupon ? ' — cupom ' + coupon.code + ' (-' + discountPct + '%)' : ''),
          externalReference: company.id,
          creditCardToken: credit_card_token,
        };
        if (cardHolderInfo) firstChargeBody.creditCardHolderInfo = cardHolderInfo;
        firstPayment = await asaas('POST', '/payments', firstChargeBody);
      } catch (err) {
        console.error('[BILLING] Cobranca imediata FALHOU:', err.message);
        if (reservedCouponId) { await releaseCoupon(reservedCouponId); reservedCouponId = null; }
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
        if (reservedCouponId) { await releaseCoupon(reservedCouponId); reservedCouponId = null; }
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
        // Recorrencia SEMPRE no valor cheio — o cupom valeu so na 1a.
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
        // O cupom FOI usado (a cobranca com desconto passou) — registra e nao libera.
        if (coupon) {
          await recordRedemption({
            companyId: company.id, userId: user.id, codeId: coupon.id, code: coupon.code,
            type: coupon.type, discountPct, trialDays, plan, cycle, billingType: 'CREDIT_CARD',
            recurringValue: value, chargedValue: firstValue,
            paymentId: firstPayment.id, subscriptionId: null,
          });
          reservedCouponId = null;
        }
        return res.status(isPaid ? 201 : 202).json({
          payment_id: firstPayment.id,
          subscription_id: null,
          payment_status: firstPayment.status,
          plan, cycle, value, billing_type: 'CREDIT_CARD',
          extra_seats: extraSeats,
          charged_now: firstValue,
          coupon: coupon ? { code: coupon.code, discount_pct: discountPct, trial_days: 0 } : null,
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

      if (coupon) {
        await recordRedemption({
          companyId: company.id, userId: user.id, codeId: coupon.id, code: coupon.code,
          type: coupon.type, discountPct, trialDays, plan, cycle, billingType: 'CREDIT_CARD',
          recurringValue: value, chargedValue: firstValue,
          paymentId: firstPayment.id, subscriptionId: subscription.id,
        });
        reservedCouponId = null;
      }

      console.log('[BILLING] Subscription ' + subscription.id + ' criada — billing_status=' + finalStatus + ' (payment_status=' + firstPayment.status + ')');

      return res.status(isPaid ? 201 : 202).json({
        payment_id: firstPayment.id,
        subscription_id: subscription.id,
        plan, cycle, value, billing_type: 'CREDIT_CARD',
        extra_seats: extraSeats,
        charged_now: firstValue,
        coupon: coupon ? { code: coupon.code, discount_pct: discountPct, trial_days: 0 } : null,
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
    //
    // 13/07 — cupom no Pix:
    //   dias gratis → nextDueDate = D+N e NENHUM QR agora (nao ha o que pagar).
    //   desconto    → a subscription gera a 1a cobranca no valor cheio, entao
    //                 damos PUT /payments/{id} com o valor descontado ANTES de
    //                 pedir o QR. O cliente ve o QR ja no valor certo.
    // ════════════════════════════════════════════════════════════════
    const pixFirstDue = trialDays > 0 ? trialEndsStr : tomorrowStr;

    const subscriptionBody = {
      customer: customerId,
      billingType: 'PIX',
      value: value,
      nextDueDate: pixFirstDue,
      cycle: 'MONTHLY',
      endDate: cycle === 'annual' ? end_date : undefined,
      description: PLANS[plan].name + (cycle === 'annual' ? ' (Anual)' : '') + seatsSuffix +
                   (trialDays > 0 ? ' — ' + trialDays + ' dias gratis (' + coupon.code + ')' : ''),
      externalReference: company.id,
    };

    const subscription = await asaas('POST', '/subscriptions', subscriptionBody);

    let pixData = null;
    let firstPaymentId = null;
    try {
      const payments = await asaas('GET', '/subscriptions/' + subscription.id + '/payments?limit=1');
      firstPaymentId = payments.data?.[0]?.id || null;

      if (firstPaymentId && trialDays === 0) {
        // Cupom de desconto: reduz a 1a cobranca ANTES de gerar o QR.
        if (discountPct > 0 && firstValue !== value) {
          try {
            await asaas('PUT', '/payments/' + firstPaymentId, {
              value: firstValue,
              description: PLANS[plan].name + seatsSuffix + ' — cupom ' + coupon.code + ' (-' + discountPct + '%)',
            });
            console.log('[BILLING] Pix 1a cobranca ajustada pelo cupom: ' + value + ' → ' + firstValue);
          } catch (putErr) {
            // Nao conseguiu descontar: melhor abortar do que cobrar cheio de quem
            // aplicou cupom valido.
            console.error('[BILLING] PUT payment (cupom) falhou:', putErr.message);
            if (reservedCouponId) { await releaseCoupon(reservedCouponId); reservedCouponId = null; }
            return res.status(502).json({
              error: 'Nao foi possivel aplicar o cupom na cobranca. Tente novamente.',
              stage: 'coupon_apply',
            });
          }
        }
        pixData = await asaas('GET', '/payments/' + firstPaymentId + '/pixQrCode');
      }
    } catch (err) {
      console.error('[BILLING] Pix QR/ajuste falhou:', err.message);
    }

    const pixStatus = trialDays > 0 ? 'trial' : 'pending';
    await db.query(
      `UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status=$3,
         billing_cycle=$4, next_billing_date=$5,
         trial_ends_at = CASE WHEN $6::date IS NOT NULL THEN $6::date ELSE trial_ends_at END,
         updated_at=NOW()
       WHERE id=$7`,
      [plan, subscription.id, pixStatus, cycle, subscription.nextDueDate || pixFirstDue, trialEndsStr, company.id]
    );

    if (coupon) {
      await recordRedemption({
        companyId: company.id, userId: user.id, codeId: coupon.id, code: coupon.code,
        type: coupon.type, discountPct, trialDays, plan, cycle, billingType: 'PIX',
        recurringValue: value,
        chargedValue: trialDays > 0 ? null : firstValue,
        paymentId: firstPaymentId, subscriptionId: subscription.id,
      });
      reservedCouponId = null;
    }

    const response = {
      subscription_id: subscription.id,
      plan, cycle, value, billing_type: 'PIX',
      extra_seats: extraSeats,
      charged_now: trialDays > 0 ? 0 : firstValue,
      coupon: coupon ? { code: coupon.code, discount_pct: discountPct, trial_days: trialDays } : null,
      trial_ends_at: trialEndsStr,
      next_due_date: subscription.nextDueDate || pixFirstDue,
      pix_qr_code: pixData?.encodedImage || null,
      pix_copy_paste: pixData?.payload || null,
      pix_expiration: pixData?.expirationDate || null,
      message: trialDays > 0
        ? trialDays + ' dias gratis ativados! A primeira cobranca sera em ' + trialEndsStr + '.'
        : undefined,
    };

    res.status(201).json(response);
  } catch (err) {
    console.error('[BILLING] Subscribe error:', err.message);
    // Qualquer falha depois da reserva: devolve o uso do cupom.
    if (reservedCouponId) { await releaseCoupon(reservedCouponId); reservedCouponId = null; }
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
