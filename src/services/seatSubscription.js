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

const { asaas } = require('./asaasClient');
const { getTotalValue, PLANS } = require('./billingPricing');

// Status de assinatura no Asaas que aceitam atualizacao de valor.
const SYNCABLE_STATUSES = new Set(['ACTIVE', 'active']);

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
    const newValue = getTotalValue(company.plan, cycle, billingType, seats);
    if (newValue === null) {
      return { updated: false, skipped: 'invalid_plan' };
    }

    // Sem mudanca de valor → nada a fazer.
    if (typeof sub?.value === 'number' && Math.abs(sub.value - newValue) < 0.005) {
      return { updated: false, skipped: 'value_unchanged', value: newValue, subscriptionId: subId };
    }

    const desc = PLANS[company.plan].name
      + (cycle === 'annual' ? ' (Anual)' : '')
      + (seats > 0 ? ' + ' + seats + ' acesso(s) extra' : '');

    await asaas('PUT', '/subscriptions/' + subId, {
      value: newValue,
      description: desc,
      updatePendingPayments: true,
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
