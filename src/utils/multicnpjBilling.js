// ============================================================
// AURA. — Multi-CNPJ Billing Helper (M2-01 + M2-02)
//
// Calcula o valor real da assinatura quando o user tem 2+ CNPJs:
//   total = plano_base + (extras × valor_unitario)
//
// E sincroniza com o Asaas (PUT /subscriptions/:id) sempre que:
//   - usuario adiciona 2° CNPJ      (M2-02 hook em POST /me/companies)
//   - usuario remove um CNPJ extra  (futuro, M2-04)
//   - usuario faz upgrade de plano  (futuro, hook em billing.js)
//   - admin transfere primary       (futuro, M2-03)
//
// Tudo ancorado na PRIMARY company. Cada user tem 1 subscription
// no Asaas, no companies.asaas_subscription_id da primary.
// ============================================================

const db = require('../config/database');

const ASAAS_URL = process.env.ASAAS_URL || 'https://api.asaas.com/v3';
const ASAAS_KEY = process.env.ASAAS_API_KEY;

// Tabela de pricing — espelha billing.js (PLANS) + userCompanies.js
// Idealmente isso vira um único módulo no futuro pra evitar drift.
const PLAN_PRICES = {
  essencial: 89,
  negocio:   169.90,
  expansao:  269.90,
};

const EXTRA_PRICES = {
  essencial: 45,
  negocio:   85,
  expansao:  135,
};

const INCLUDED_CNPJS = {
  essencial:     1,
  negocio:       2,
  expansao:      2,
  personalizado: 999,
};

// ── Asaas helper local ──────────────────────────────────────
// Não importa de billing.js pra evitar dependência circular se
// futuramente billing.js consumir multicnpjBilling.
async function asaas(method, path, body) {
  if (!ASAAS_KEY) throw new Error('ASAAS_API_KEY não configurada');
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': ASAAS_KEY },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(ASAAS_URL + path, opts);
  const data = await resp.json();
  if (!resp.ok) {
    const msg = data.errors?.[0]?.description || ('Asaas error ' + resp.status);
    const err = new Error(msg);
    err.asaasStatus = resp.status;
    err.asaasData = data;
    throw err;
  }
  return data;
}

// ────────────────────────────────────────────────────────────
// calculateMulticnpjValue(primaryCompanyId)
// Retorna o valor mensal real considerando extras.
//
// Exemplo:
//   - Plano Negocio (R$ 169,90), inclui 2 CNPJs
//   - User tem 4 CNPJs no total → 2 extras × R$ 85 = R$ 170
//   - Total mensal = 169,90 + 170 = R$ 339,90
//
// Se o user tem só 1 empresa, retorna o valor base do plano
// (sem extras). Se o plano não suporta multi-CNPJ (Essencial)
// e o user tem 2+ empresas, ainda calcula extras pra que o
// caller decida o que fazer (na prática, o POST /me/companies
// já bloqueia Essencial antes de chegar aqui).
//
// Retorna null se a empresa primary não existir.
// ────────────────────────────────────────────────────────────
async function calculateMulticnpjValue(primaryCompanyId) {
  if (!primaryCompanyId) return null;

  // Pega a primary pra saber o plano
  const { rows: primaryRows } = await db.query(
    `SELECT id, plan, owner_id FROM companies WHERE id = $1 AND is_primary = true`,
    [primaryCompanyId]
  );
  if (!primaryRows.length) return null;
  const primary = primaryRows[0];
  const plan = (primary.plan || 'essencial').toLowerCase();

  const basePrice = PLAN_PRICES[plan] || 0;
  const extraPrice = EXTRA_PRICES[plan] || 0;
  const included = INCLUDED_CNPJS[plan] || 1;

  // Conta TODAS as empresas que faturam por essa primary.
  // Inclui a própria primary (por isso billing_owner = primary).
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total
       FROM companies
      WHERE billing_owner_company_id = $1
        AND is_active = true`,
    [primaryCompanyId]
  );
  const total = countRows[0]?.total || 1;

  const extras = Math.max(0, total - included);
  const extrasValue = extras * extraPrice;
  const totalMonthly = Math.round((basePrice + extrasValue) * 100) / 100;

  return {
    primary_id: primary.id,
    plan: plan,
    base_price: basePrice,
    extra_unit_price: extraPrice,
    included_in_plan: included,
    total_companies: total,
    extra_cnpjs: extras,
    extras_value: Math.round(extrasValue * 100) / 100,
    total_monthly: totalMonthly,
  };
}

// ────────────────────────────────────────────────────────────
// syncSubscriptionValue(primaryCompanyId)
// Recalcula o valor e atualiza o Asaas se houver subscription.
//
// Comportamento:
//   - Sem subscription Asaas (trial / nunca pagou) → retorna
//     { synced: false, reason: 'no_subscription', new_value }
//     e NÃO falha. O valor correto será cobrado quando o user
//     ativar pagamento via /billing/subscribe.
//
//   - Com subscription mas sem mudança de valor → retorna
//     { synced: false, reason: 'no_change' }
//
//   - Com subscription + mudança → PUT /subscriptions/:id e
//     retorna { synced: true, old_value, new_value }
//
// Erros do Asaas são propagados (caller decide se rollback).
// ────────────────────────────────────────────────────────────
async function syncSubscriptionValue(primaryCompanyId) {
  const calc = await calculateMulticnpjValue(primaryCompanyId);
  if (!calc) {
    return { synced: false, reason: 'primary_not_found' };
  }

  // Pega subscription_id e valor atual do Asaas (se existir)
  const { rows } = await db.query(
    `SELECT asaas_subscription_id, asaas_customer_id
       FROM companies WHERE id = $1`,
    [primaryCompanyId]
  );
  const company = rows[0];
  if (!company || !company.asaas_subscription_id) {
    return {
      synced: false,
      reason: 'no_subscription',
      new_value: calc.total_monthly,
      preview: calc,
    };
  }

  // Consulta valor atual no Asaas
  let currentValue = null;
  try {
    const sub = await asaas('GET', '/subscriptions/' + company.asaas_subscription_id);
    currentValue = sub.value || null;
  } catch (err) {
    console.error('[multicnpjBilling] Failed to GET subscription:', err.message);
    // Se a sub foi deletada externamente, marca como sem-sub e segue
    if (err.asaasStatus === 404) {
      await db.query(
        `UPDATE companies SET asaas_subscription_id=NULL WHERE id=$1`,
        [primaryCompanyId]
      );
      return {
        synced: false,
        reason: 'subscription_not_found_in_asaas',
        new_value: calc.total_monthly,
        preview: calc,
      };
    }
    throw err;
  }

  // Sem mudança? evita PUT desnecessário (cada PUT no Asaas
  // pode disparar email de notificação ao cliente)
  if (currentValue !== null && Math.abs(currentValue - calc.total_monthly) < 0.01) {
    return {
      synced: false,
      reason: 'no_change',
      current_value: currentValue,
      preview: calc,
    };
  }

  // Atualiza valor no Asaas
  let updated;
  try {
    updated = await asaas('POST', '/subscriptions/' + company.asaas_subscription_id, {
      value: calc.total_monthly,
      // updatePendingPayments=true: aplica novo valor a faturas pendentes ainda
      // não pagas. Se false (default), só vale pra próximas faturas — o que pode
      // gerar inconsistência se o user adiciona CNPJ no dia do vencimento.
      updatePendingPayments: true,
    });
  } catch (err) {
    console.error('[multicnpjBilling] PUT subscription failed:', err.message);
    throw err;
  }

  console.log('[multicnpjBilling] Synced subscription ' + company.asaas_subscription_id +
              ' from R$ ' + currentValue + ' to R$ ' + calc.total_monthly +
              ' (' + calc.total_companies + ' empresas, ' + calc.extra_cnpjs + ' extras)');

  return {
    synced: true,
    old_value: currentValue,
    new_value: calc.total_monthly,
    asaas_subscription_id: company.asaas_subscription_id,
    preview: calc,
  };
}

// ────────────────────────────────────────────────────────────
// safeSyncSubscriptionValue(primaryCompanyId)
// Versão "fire-and-forget" que NUNCA throws — pra usar dentro
// de POST /me/companies sem risco de fazer rollback do INSERT.
//
// Loga erros mas devolve sempre um objeto. Usa essa quando o
// sync é melhoria (não bloqueante); usa syncSubscriptionValue
// direto quando precisa que erro propague.
// ────────────────────────────────────────────────────────────
async function safeSyncSubscriptionValue(primaryCompanyId) {
  try {
    return await syncSubscriptionValue(primaryCompanyId);
  } catch (err) {
    console.error('[multicnpjBilling] safe sync caught error:', err.message);
    return { synced: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  calculateMulticnpjValue,
  syncSubscriptionValue,
  safeSyncSubscriptionValue,
  PLAN_PRICES,
  EXTRA_PRICES,
  INCLUDED_CNPJS,
};
