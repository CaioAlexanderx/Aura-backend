// ============================================================
// AURA. — Sincroniza o valor da assinatura no Asaas com os
// acessos extras concedidos (R$19/seat).
//
// 15/06/2026: quando o admin concede/ajusta extra_seats_granted na
// Gestao Aura (ou no checkout), a assinatura recorrente do Asaas
// precisa passar a cobrar plano + 19xseats AUTOMATICAMENTE no cartao
// ja salvo — sem refazer checkout. Isso e feito via
// PUT /v3/subscriptions/{id} com updatePendingPayments:true
// (so afeta mensalidades futuras + as pendentes ja geradas).
//
// E best-effort: se nao houver assinatura, se estiver cancelada, ou
// se o Asaas falhar, NUNCA lanca — retorna um objeto descritivo pra
// quem chamou registrar/avisar. O registro em companies.extra_seats_
// granted continua sendo a fonte de verdade do que foi contratado.
// ============================================================

const db = require('../config/database');
const { asaas } = require('./asaasClient');
const {
  getTotalValue, PLANS, MIN_CHARGE_BRL, getCustomSubscription, customMatches,
} = require('./billingPricing');
const { getSyncAdjustment } = require('./subscriptionDiscount');

// Status de assinatura no Asaas que aceitam atualizacao de valor.
const SYNCABLE_STATUSES = new Set(['ACTIVE', 'active']);

// 14/10/2026: valor combinado (migration 386). Os chamadores do sync passam um
// objeto parcial da empresa (sem as colunas custom_subscription_*); quando as
// colunas nao vieram, le do banco. Pre-migration (42703) ou qualquer falha de
// leitura = sem valor combinado: o sync segue o caminho de sempre.
async function lerValorCustomizado(company) {
  if (company.custom_subscription_value !== undefined) return getCustomSubscription(company);
  try {
    const { rows } = await db.query(
      `SELECT custom_subscription_value, custom_subscription_plan, custom_subscription_cycle
         FROM companies WHERE id = $1`,
      [company.id]
    );
    return getCustomSubscription(rows && rows[0]);
  } catch (err) {
    if (err && err.code !== '42703') {
      console.error('[seatSubscription] leitura do valor combinado falhou:', err.message);
    }
    return null;
  }
}

/**
 * Recalcula o valor recorrente (plano + acessos extras) e atualiza a
 * assinatura no Asaas. Best-effort — nunca lanca.
 *
 * @param {object} company — row de companies (precisa: id, plan,
 *   billing_cycle, billing_status, asaas_subscription_id,
 *   extra_seats_granted)
 * @returns {Promise<{updated:boolean, skipped?:string, value?:number,
 *   previousValue?:number, subscriptionId?:string, error?:string}>}
 */
async function syncSubscriptionSeatValue(company) {
  try {
    if (!company || !company.asaas_subscription_id) {
      return { updated: false, skipped: 'no_subscription' };
    }
    if (!PLANS[company.plan]) {
      return { updated: false, skipped: 'invalid_plan' };
    }
    if (company.billing_status === 'cancelled') {
      return { updated: false, skipped: 'cancelled' };
    }

    const subId = company.asaas_subscription_id;
    const cycle = company.billing_cycle || 'monthly';
    const seats = parseInt(company.extra_seats_granted, 10) || 0;

    // 14/10/2026: empresa com valor combinado para ESTE plano e ciclo. O valor
    // da assinatura ja inclui os acessos extras e e' definido pela equipe —
    // conceder/tirar acesso extra nao pode reajusta-lo (nem 'ajustar' pra
    // tabela). Nao faz PUT nem le a Asaas; quem chamou registra o skip no audit.
    const combinado = await lerValorCustomizado(company);
    if (customMatches(combinado, company.plan, cycle)) {
      return { updated: false, skipped: 'valor_customizado', value: combinado.value, subscriptionId: subId, seats };
    }

    // Le a assinatura pra saber a forma de pagamento atual (cartao/pix)
    // e o valor vigente — assim o recalculo respeita o ciclo real.
    let sub;
    try {
      sub = await asaas('GET', '/subscriptions/' + subId);
    } catch (err) {
      return { updated: false, skipped: 'fetch_failed', error: err.message };
    }

    if (sub && sub.status && !SYNCABLE_STATUSES.has(sub.status)) {
      return { updated: false, skipped: 'subscription_' + String(sub.status).toLowerCase(), subscriptionId: subId };
    }

    const billingType = sub?.billingType || 'CREDIT_CARD';
    const tableValue = getTotalValue(company.plan, cycle, billingType, seats);
    if (tableValue === null) {
      return { updated: false, skipped: 'invalid_plan' };
    }

    // 11/09/2026: desconto de varios meses em andamento. Sem este ajuste,
    // conceder um acesso extra no 2o mes gravaria o valor de tabela e apagaria
    // o desconto em silencio (ver services/subscriptionDiscount.js).
    const adjust = await getSyncAdjustment(db, company.id, subId);
    const newValue = Math.max(MIN_CHARGE_BRL, Math.round((tableValue - adjust.discountAmount) * 100) / 100);

    // Sem mudanca de valor → nada a fazer.
    if (typeof sub?.value === 'number' && Math.abs(sub.value - newValue) < 0.005) {
      return { updated: false, skipped: 'value_unchanged', value: newValue, subscriptionId: subId };
    }

    const desc = PLANS[company.plan].name
      + (cycle === 'annual' ? ' (Anual)' : '')
      + (seats > 0 ? ' + ' + seats + ' acesso(s) extra' : '');

    await asaas('PUT', '/subscriptions/' + subId, {
      value: newValue,
      // Durante o desconto a descricao mantem o cupom (a rotina tira no fim) e
      // as cobrancas ja geradas nao mudam.
      description: adjust.discountAmount > 0 && sub?.description ? sub.description : desc,
      updatePendingPayments: adjust.updatePendingPayments,
    });

    return {
      updated: true,
      value: newValue,
      previousValue: typeof sub?.value === 'number' ? sub.value : undefined,
      subscriptionId: subId,
      seats,
    };
  } catch (err) {
    // Blindagem final — sync nunca derruba a operacao que a chamou.
    return { updated: false, skipped: 'error', error: err.message };
  }
}

module.exports = { syncSubscriptionSeatValue };
