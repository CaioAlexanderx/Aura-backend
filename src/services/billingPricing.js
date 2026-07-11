// ============================================================
// AURA. — Pricing unico de assinatura (plano + acessos extras)
//
// 15/06/2026: extraido de billing.js pra ser fonte unica de calculo
// de valor, usada tanto pelo checkout (billing.js) quanto pela
// sincronizacao da assinatura no Asaas quando o admin concede um
// acesso extra (seatSubscription.js).
//
// Regra de acessos extras: R$19/mes por seat acima do plano
// (SEAT_PRICE_BRL em memberSeats). O seat e' cobrado CHEIO,
// independente do ciclo do plano:
//   - mensal → R$19 cheio por mes
//   - anual  → R$19 cheio por mes tambem (SEM o desconto de 2 meses
//              gratis que se aplica ao plano). Regra de negocio
//              confirmada em 10/07/2026 — antes o codigo aplicava o
//              mesmo desconto do plano ao seat, subestimando o valor
//              cobrado (R$15,83 em vez de R$19,00).
//
// 18/06/2026: precos alinhados a tabela app.getaura.com.br/planos
//   Negocio 169.90→169, Expansao 269.90→269 (valores sem centavos).
//   PIX anual unificado com cartao anual: assinatura mensal descontada,
//   endDate 12 meses controla duracao. Branch 'Pix a vista' removida.
//   Negocio anual: 169 × (5/6) = R$140,83/mes ✓
//
// getPlanValue() reproduz EXATAMENTE o comportamento que existia em
// billing.js (validado por teste). getTotalValue() = plano + seats.
// ============================================================

const { SEAT_PRICE_BRL } = require('./memberSeats');

const PLANS = {
  essencial: { name: 'Aura Essencial', monthly: 89 },
  negocio:   { name: 'Aura Negocio',   monthly: 169 },
  expansao:  { name: 'Aura Expansao',  monthly: 269 },
};

// 2 meses gratis: paga 10, leva 12 — aplica no Pix e no Cartao (SO no plano)
const ANNUAL_DISCOUNT = 1 / 6;

function round2(v) {
  return Math.round(v * 100) / 100;
}

// Aplica a matematica de ciclo a um valor MENSAL base (plano).
// Anual sempre cobra mensalmente com valor descontado (PIX e cartao iguais).
// O endDate em 12 meses controla a duracao da assinatura no Asaas.
function applyCycle(monthlyAmount, cycle, billingType) {
  if (cycle === 'annual') {
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

// Valor SO dos acessos extras (0 se nenhum). Seat NUNCA tem desconto de
// ciclo — R$19 cheio tanto no mensal quanto no anual.
function getSeatsValue(extraSeats, cycle, billingType) {
  const seats = Number.isFinite(extraSeats) && extraSeats > 0 ? Math.floor(extraSeats) : 0;
  if (seats === 0) return 0;
  return round2(SEAT_PRICE_BRL * seats);
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
