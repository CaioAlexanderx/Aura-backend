// ============================================================
// AURA. — Multi-CNPJ Billing Helper (M2-01 + M2-02)
//
// Calcula o valor real da assinatura quando o user tem 2+ CNPJs e
// sincroniza com o Asaas (POST /subscriptions/:id) quando a LOJA:
//   - adiciona uma empresa  (POST /me/companies)
//   - remove uma empresa    (DELETE /me/companies/:id)
// Nenhum outro caminho chama syncSubscriptionValue (conferido em 25/10/2026:
// nao ha job, troca de plano, transfer-primary nem rota de admin que chame).
//
// Tudo ancorado na PRIMARY company. Cada user tem 1 subscription
// no Asaas, no companies.asaas_subscription_id da primary.
//
// 25/10/2026 (segundo CNPJ do Negocio a 50%): os precos sairam daqui. A
// tabela unica e' services/billingPricing.js (getMulticnpjBreakdown): plano
// no ciclo da assinatura (companies.billing_cycle) + acessos extras +
// empresas alem das incluidas. Antes este arquivo tinha PLAN_PRICES proprios
// (Negocio 169,90), ignorava o ciclo anual e os acessos extras.
//
// SEM RETROATIVIDADE. O sync so grava um valor novo na Asaas quando a
// assinatura de hoje bate com a tabela para as empresas que a loja tinha
// ANTES da acao (descontado o cupom em andamento). Se nao bate, a assinatura
// tem uma condicao que a tabela nao conhece (acordo, preco antigo, regra
// antiga de 2 CNPJs incluidos) e o sync NAO mexe: devolve o calculo para a
// tela e avisa a equipe no sino da empresa Aura. O mesmo vale para empresa
// com valor combinado (custom_subscription_*, migration 386).
// ============================================================

const db = require('../config/database');
const { getSyncAdjustment } = require('../services/subscriptionDiscount');
const {
  MIN_CHARGE_BRL,
  PLANS,
  INCLUDED_COMPANIES,
  getMulticnpjBreakdown,
  getCustomSubscription,
  customMatches,
} = require('../services/billingPricing');
const { getExtraSeatsForCompany } = require('../services/extraSeats');

const ASAAS_URL = process.env.ASAAS_URL || 'https://api.asaas.com/v3';
const ASAAS_KEY = process.env.ASAAS_API_KEY;

// Compat: alguns chamadores ainda importam estes nomes. Os valores vem da
// tabela unica (billingPricing) e nao sao mais usados para calcular nada aqui.
const PLAN_PRICES = Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, v.monthly]));
const INCLUDED_CNPJS = INCLUDED_COMPANIES;

// ── Asaas helper local ──────────────────────────────────────
// Não importa de billing.js pra evitar dependência circular se
// futuramente billing.js consumir multicnpjBilling.
async function asaasLocal(method, path, body) {
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

function round2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

// Valor combinado da empresa (migration 386). Base sem a coluna (42703) ou
// qualquer falha de leitura = sem valor combinado.
async function lerValorCombinado(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT custom_subscription_value, custom_subscription_plan,
              custom_subscription_cycle, custom_subscription_note
         FROM companies WHERE id = $1`,
      [companyId]
    );
    return getCustomSubscription(rows && rows[0]);
  } catch (err) {
    if (err && err.code !== '42703') {
      console.error('[multicnpjBilling] leitura do valor combinado falhou:', err.message);
    }
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// calculateMulticnpjValue(primaryCompanyId, { totalOverride })
// Valor mensal pela tabela (billingPricing.getMulticnpjBreakdown).
//
// Exemplos (Negocio, 1 CNPJ incluido, extra = 50% do plano no ciclo):
//   - mensal, 2 empresas: 169,00 + 84,50 = R$ 253,50
//   - anual,  2 empresas: 140,83 + 70,42 = R$ 211,25
//
// totalOverride simula outra quantidade de empresas (billing-preview e a
// conferencia do sync usam). Retorna null se a primary nao existir.
// Plano sem preco na tabela (personalizado) devolve o objeto com
// total_monthly = null e no_table_price = true: ninguem cobra nada sozinho.
// ────────────────────────────────────────────────────────────
async function calculateMulticnpjValue(primaryCompanyId, { totalOverride } = {}) {
  if (!primaryCompanyId) return null;

  const { rows: primaryRows } = await db.query(
    `SELECT id, plan, owner_id, billing_cycle FROM companies WHERE id = $1 AND is_primary = true`,
    [primaryCompanyId]
  );
  if (!primaryRows.length) return null;
  const primary = primaryRows[0];
  const plan = String(primary.plan || 'essencial').toLowerCase();
  const cycle = primary.billing_cycle === 'annual' ? 'annual' : 'monthly';

  // Empresas ativas que faturam por essa primary, contando a própria primary
  // mesmo quando billing_owner_company_id dela está vazio.
  const { rows: groupRows } = await db.query(
    `SELECT id
       FROM companies
      WHERE (id = $1 OR billing_owner_company_id = $1)
        AND is_active = true`,
    [primaryCompanyId]
  );
  const companyIds = groupRows.map((r) => r.id);
  if (!companyIds.includes(primary.id)) companyIds.push(primary.id);
  const realTotal = companyIds.length || 1;
  const total = Number.isFinite(totalOverride) && totalOverride > 0 ? Math.floor(totalOverride) : realTotal;

  const extraSeats = await getExtraSeatsForCompany(primary.id).catch(() => 0);
  const breakdown = getMulticnpjBreakdown(plan, cycle, { totalCompanies: total, companyIds, extraSeats });

  if (!breakdown) {
    return {
      primary_id: primary.id,
      plan,
      cycle,
      base_price: null,
      seats_value: 0,
      extra_unit_price: null,
      included_in_plan: INCLUDED_COMPANIES[plan] || 1,
      total_companies: total,
      extra_cnpjs: 0,
      extras_value: 0,
      total_monthly: null,
      no_table_price: true,
      excecao: null,
    };
  }

  return {
    primary_id: primary.id,
    plan,
    cycle,
    base_price: breakdown.base_price,
    seats_value: breakdown.seats_value,
    extra_unit_price: breakdown.extra_unit_price,
    included_in_plan: breakdown.included_in_plan,
    total_companies: breakdown.total_companies,
    extra_cnpjs: breakdown.extra_cnpjs,
    extras_value: breakdown.extras_value,
    total_monthly: breakdown.total_monthly,
    extra_rule: breakdown.extra_rule,
    excecao: breakdown.excecao,
  };
}

// ────────────────────────────────────────────────────────────
// Aviso no sino da empresa Aura: assinatura que o sync não ajusta sozinho.
// Nunca lança.
// ────────────────────────────────────────────────────────────
async function avisarEquipe({ primaryId, evento, motivo, companyId, companyName, calc, valorAtual, deps = {} }) {
  try {
    const notifications = deps.notifications || require('../services/appNotifications');
    const { empresaDoSino } = require('../services/avisoDeChamado');
    const env = deps.env || process.env;

    let loja = null;
    try {
      const { rows } = await db.query(
        `SELECT COALESCE(trade_name, legal_name) AS loja FROM companies WHERE id = $1`,
        [primaryId]
      );
      loja = rows && rows[0] ? rows[0].loja : null;
    } catch (_) { /* sem nome, segue */ }

    const acao = evento === 'remove' ? 'removeu' : 'adicionou';
    const condicao = motivo === 'valor_combinado' ? 'valor combinado' : 'valor fora da tabela';
    const tabela = calc && calc.total_monthly != null ? 'R$ ' + calc.total_monthly.toFixed(2) : 'sem preço de tabela';
    const atual = valorAtual != null ? 'R$ ' + Number(valorAtual).toFixed(2) : 'não lido';

    return await notifications.notifyCompany(empresaDoSino(env), {
      title: `Assinatura com ${condicao}: ${loja || 'loja'} ${acao} uma empresa`,
      body: `${loja || primaryId} ${acao} ${companyName ? '"' + companyName + '"' : 'uma empresa'}. ` +
        `Hoje cobra ${atual}; pela tabela, com ${calc ? calc.total_companies : '?'} empresas, seria ${tabela}. ` +
        'Nada foi alterado na Asaas: a equipe confirma o ajuste com a loja.',
      dedupeKey: `multicnpj:${motivo}:${evento}:${primaryId}:${companyId || 'sem-empresa'}`,
    });
  } catch (err) {
    console.error('[multicnpjBilling] aviso à equipe falhou:', err && err.message);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// syncSubscriptionValue(primaryCompanyId, opts)
//   opts.evento    'add' | 'remove' (a ação da loja que disparou o sync).
//                  Sem evento não há como conferir o estado anterior, então
//                  o sync não grava nada (reason 'sem_acao_da_loja').
//   opts.companyId / opts.companyName  empresa adicionada/removida (aviso)
//   opts.deps      { asaas, notifications } injetáveis para teste
//
// Resultados:
//   no_subscription          sem assinatura (trial) → nada a gravar
//   valor_combinado          empresa com valor combinado → não grava, avisa
//   fora_da_tabela           Asaas cobra diferente da tabela de antes → não
//                            grava, avisa (sem retroatividade)
//   no_change                valor novo = valor atual
//   synced                   gravou o valor novo
//   no_table_price           plano sem preço na tabela (personalizado)
//   subscription_not_found_in_asaas
//
// Erros do Asaas são propagados (caller decide; use safeSync na rota).
// ────────────────────────────────────────────────────────────
async function syncSubscriptionValue(primaryCompanyId, opts = {}) {
  const { evento = null, companyId = null, companyName = null, deps = {} } = opts;
  const asaas = deps.asaas || asaasLocal;

  const calc = await calculateMulticnpjValue(primaryCompanyId);
  if (!calc) {
    return { synced: false, reason: 'primary_not_found' };
  }
  if (calc.total_monthly === null) {
    return { synced: false, reason: 'no_table_price', preview: calc };
  }

  // Valor combinado para ESTE plano e ciclo: o valor da assinatura é
  // definido pela equipe. Empresa nova/removida não sobrescreve.
  const combinado = await lerValorCombinado(primaryCompanyId);
  if (customMatches(combinado, calc.plan, calc.cycle)) {
    if (evento) {
      await avisarEquipe({
        primaryId: primaryCompanyId, evento, motivo: 'valor_combinado',
        companyId, companyName, calc, valorAtual: combinado.value, deps,
      });
    }
    return {
      synced: false,
      reason: 'valor_combinado',
      combined_value: combinado.value,
      new_value: calc.total_monthly,
      preview: calc,
    };
  }

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

  // Sem ação da loja não existe "antes" para conferir: não grava nada.
  if (evento !== 'add' && evento !== 'remove') {
    return { synced: false, reason: 'sem_acao_da_loja', new_value: calc.total_monthly, preview: calc };
  }

  // Consulta valor atual no Asaas
  let currentValue = null;
  try {
    const sub = await asaas('GET', '/subscriptions/' + company.asaas_subscription_id);
    currentValue = typeof sub?.value === 'number' ? sub.value : null;
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

  // 11/09/2026: desconto de varios meses em andamento (services/subscriptionDiscount).
  // Sem este ajuste, adicionar um CNPJ no 2o mes gravaria o valor de tabela e
  // apagaria o desconto em silencio.
  const adjust = await getSyncAdjustment(db, primaryCompanyId, company.asaas_subscription_id);
  const comDesconto = (v) => Math.max(MIN_CHARGE_BRL, round2(v - adjust.discountAmount));
  const targetValue = comDesconto(calc.total_monthly);

  // 25/10/2026: sem retroatividade. A assinatura de hoje precisa bater com a
  // tabela para as empresas de ANTES da ação. Se não bate, existe uma
  // condição que a tabela não conhece e o sync não mexe.
  const totalAntes = evento === 'add' ? calc.total_companies - 1 : calc.total_companies + 1;
  const antes = await calculateMulticnpjValue(primaryCompanyId, { totalOverride: Math.max(1, totalAntes) });
  const esperadoAntes = antes && antes.total_monthly !== null ? comDesconto(antes.total_monthly) : null;
  if (currentValue === null || esperadoAntes === null || Math.abs(currentValue - esperadoAntes) >= 0.01) {
    await avisarEquipe({
      primaryId: primaryCompanyId, evento, motivo: 'fora_da_tabela',
      companyId, companyName, calc, valorAtual: currentValue, deps,
    });
    return {
      synced: false,
      reason: 'fora_da_tabela',
      current_value: currentValue,
      expected_before: esperadoAntes,
      new_value: targetValue,
      preview: calc,
    };
  }

  // Sem mudança? evita PUT desnecessário (cada PUT no Asaas
  // pode disparar email de notificação ao cliente)
  if (Math.abs(currentValue - targetValue) < 0.01) {
    return {
      synced: false,
      reason: 'no_change',
      current_value: currentValue,
      preview: calc,
    };
  }

  // Atualiza valor no Asaas
  try {
    await asaas('POST', '/subscriptions/' + company.asaas_subscription_id, {
      value: targetValue,
      // updatePendingPayments=true: aplica novo valor a faturas pendentes ainda
      // não pagas. Se false (default), só vale pra próximas faturas — o que pode
      // gerar inconsistência se o user adiciona CNPJ no dia do vencimento.
      // Durante um desconto de varios meses fica false: uma mensalidade com
      // desconto ainda por vencer nao pode subir pro valor cheio.
      updatePendingPayments: adjust.updatePendingPayments,
    });
  } catch (err) {
    console.error('[multicnpjBilling] PUT subscription failed:', err.message);
    throw err;
  }

  console.log('[multicnpjBilling] Synced subscription ' + company.asaas_subscription_id +
              ' from R$ ' + currentValue + ' to R$ ' + targetValue +
              ' (' + calc.total_companies + ' empresas, ' + calc.extra_cnpjs + ' extras' +
              (adjust.discountAmount > 0 ? ', desconto em andamento -' + adjust.discountAmount : '') + ')');

  return {
    synced: true,
    old_value: currentValue,
    new_value: targetValue,
    asaas_subscription_id: company.asaas_subscription_id,
    preview: calc,
  };
}

// ────────────────────────────────────────────────────────────
// safeSyncSubscriptionValue(primaryCompanyId, opts)
// Versão "fire-and-forget" que NUNCA throws — pra usar dentro
// de POST /me/companies sem risco de fazer rollback do INSERT.
// ────────────────────────────────────────────────────────────
async function safeSyncSubscriptionValue(primaryCompanyId, opts = {}) {
  try {
    return await syncSubscriptionValue(primaryCompanyId, opts);
  } catch (err) {
    console.error('[multicnpjBilling] safe sync caught error:', err.message);
    return { synced: false, reason: 'error', error: err.message };
  }
}

// ────────────────────────────────────────────────────────────
// previewDaAssinatura(primaryCompanyId, { deps })
// Para GET /me/companies/billing-preview: o que a loja paga HOJE e o que
// a próxima empresa custaria. Só lê (GET na Asaas); nunca grava.
//
//   current.total_monthly  o valor que a loja paga hoje: o combinado, ou o
//                          que a Asaas cobra; sem assinatura (ou Asaas fora),
//                          o da tabela.
//   current.table_monthly  o valor pela tabela com as empresas de hoje.
//   ajuste_pela_equipe     true quando a próxima empresa não ajusta sozinha
//                          (valor combinado ou assinatura fora da tabela).
// ────────────────────────────────────────────────────────────
async function previewDaAssinatura(primaryCompanyId, { deps = {} } = {}) {
  const asaas = deps.asaas || asaasLocal;
  const tabela = await calculateMulticnpjValue(primaryCompanyId);
  if (!tabela) return null;
  const next = await calculateMulticnpjValue(primaryCompanyId, { totalOverride: tabela.total_companies + 1 });

  const tableNow = tabela.total_monthly;
  let charged = null;
  let fonte = 'tabela';
  let ajustePelaEquipe = tableNow === null;

  const combinado = await lerValorCombinado(primaryCompanyId);
  if (customMatches(combinado, tabela.plan, tabela.cycle)) {
    charged = combinado.value;
    fonte = 'valor_combinado';
    ajustePelaEquipe = true;
  } else {
    try {
      const { rows } = await db.query(
        `SELECT asaas_subscription_id FROM companies WHERE id = $1`,
        [primaryCompanyId]
      );
      const subId = rows && rows[0] ? rows[0].asaas_subscription_id : null;
      if (subId) {
        const sub = await asaas('GET', '/subscriptions/' + subId);
        if (typeof sub?.value === 'number') {
          charged = sub.value;
          fonte = 'asaas';
          if (tableNow !== null) {
            const adjust = await getSyncAdjustment(db, primaryCompanyId, subId);
            const esperado = Math.max(MIN_CHARGE_BRL, round2(tableNow - adjust.discountAmount));
            if (Math.abs(charged - esperado) >= 0.01) ajustePelaEquipe = true;
          }
        }
      }
    } catch (err) {
      console.error('[multicnpjBilling] preview: leitura da assinatura falhou:', err.message);
    }
  }

  // Assinatura com condição especial: o valor cobrado não se decompõe pela
  // tabela, então `current` mostra só o total cobrado (sem "extras") e a
  // composição da tabela vai em `current.tabela`. Assim ninguém vê na tela
  // um extra que não paga.
  const especial = ajustePelaEquipe && charged !== null;
  const current = {
    ...tabela,
    base_price: tabela.base_price ?? 0,
    extra_unit_price: tabela.extra_unit_price ?? 0,
    extra_cnpjs: especial ? 0 : tabela.extra_cnpjs,
    extras_value: especial ? 0 : tabela.extras_value,
    total_monthly: charged !== null ? round2(charged) : (tableNow ?? 0),
    table_monthly: tableNow,
    fonte,
    tabela,
  };

  const novoTotal = next ? next.total_monthly : null;
  const delta = novoTotal !== null && tableNow !== null ? round2(novoTotal - tableNow) : 0;

  return {
    current,
    if_add_one: {
      total_companies: tabela.total_companies + 1,
      extra_cnpjs: next ? next.extra_cnpjs : 0,
      extra_unit_price: next ? next.extra_unit_price : null,
      new_total_monthly: novoTotal ?? 0,
      delta_monthly: delta,
      ajuste_pela_equipe: ajustePelaEquipe,
    },
  };
}

module.exports = {
  calculateMulticnpjValue,
  syncSubscriptionValue,
  safeSyncSubscriptionValue,
  previewDaAssinatura,
  avisarEquipe,
  PLAN_PRICES,
  INCLUDED_CNPJS,
};
