// ============================================================
// AURA. — Pricing unico de assinatura (plano + acessos extras)
//
// 15/06/2026: extraido de billing.js pra ser fonte unica de calculo
// de valor, usada tanto pelo checkout (billing.js) quanto pela
// sincronizacao da assinatura no Asaas quando o admin concede um
// acesso extra (seatSubscription.js).
//
// Regra de acessos extras: R$19/mes por seat acima do plano
// (SEAT_PRICE_BRL em memberSeats). O seat segue o MESMO tratamento de
// ciclo do plano:
//   - mensal           → R$19 cheio por mes
//   - anual no cartao   → R$19 com o mesmo desconto mensal do plano
//                         (assinatura mensal descontada, 2 meses gratis)
//   - anual no Pix      → R$19 x 12 com desconto (cobranca unica a vista)
//
// getPlanValue() reproduz EXATAMENTE o comportamento que existia em
// billing.js (validado por teste). getTotalValue() = plano + seats.
// ============================================================

const { SEAT_PRICE_BRL } = require('./memberSeats');

const PLANS = {
  essencial: { name: 'Aura Essencial', monthly: 89 },
  negocio:   { name: 'Aura Negocio',   monthly: 169.90 },
  expansao:  { name: 'Aura Expansao',  monthly: 269.90 },
};

// 2 meses gratis: paga 10, leva 12 — aplica no Pix e no Cartao
const ANNUAL_DISCOUNT = 1 / 6;

function round2(v) {
  return Math.round(v * 100) / 100;
}

// Aplica a matematica de ciclo a um valor MENSAL base (plano ou seats).
function applyCycle(monthlyAmount, cycle, billingType) {
  if (cycle === 'annual') {
    if (billingType === 'PIX') {
      // Pix anual: pagamento unico a vista com desconto de 2 meses
      return round2(monthlyAmount * 12 * (1 - ANNUAL_DISCOUNT));
    }
    // Cartao anual: assinatura mensal com valor descontado + endDate em 12 meses
    return round2(monthlyAmount * (1 - ANNUAL_DISCOUNT));
  }
  return round2(monthlyAmount);
}

// Valor SO do plano (mantem comportamento historico de billing.js).
function getPlanValue(plan, cycle, billingType) {
  const cfg = PLANS[plan];
  if (!cfg) return null;
  return applyCycle(cfg.monthly, cycle, billingType);
}

// Valor SO dos acessos extras (0 se nenhum).
function getSeatsValue(extraSeats, cycle, billingType) {
  const seats = Number.isFinite(extraSeats) && extraSeats > 0 ? Math.floor(extraSeats) : 0;
  if (seats === 0) return 0;
  return applyCycle(SEAT_PRICE_BRL * seats, cycle, billingType);
}

// Valor total cobrado = plano + acessos extras. Retorna null se plano invalido.
function getTotalValue(plan, cycle, billingType, extraSeats = 0) {
  const planValue = getPlanValue(plan, cycle, billingType);
  if (planValue === null) return null;
  return round2(planValue + getSeatsValue(extraSeats, cycle, billingType));
}

module.exports = {
  PLANS,
  ANNUAL_DISCOUNT,
  SEAT_PRICE_BRL,
  applyCycle,
  getPlanValue,
  getSeatsValue,
  getTotalValue,
};
