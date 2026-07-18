// ============================================================
// AURA. — Pricing unico de assinatura (plano + acessos extras + cupom)
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
// 13/07/2026: CUPOM (getFirstChargeValue). O desconto do cupom incide
//   SO NO PLANO — mesma regra ja vigente pro desconto anual: acesso extra
//   nunca e descontado. Ex.: Essencial anual + 1 seat, cupom 50%:
//     recorrente     = 74,17 + 19,00 = R$ 93,17/mes  (getTotalValue)
//     1a mensalidade = 37,09 + 19,00 = R$ 56,09      (getFirstChargeValue)
//   A assinatura no Asaas e criada com o valor CHEIO — o desconto vive
//   apenas na cobranca imediata, entao nao existe nada pra "restaurar"
//   depois (sem estado persistente, sem job de expiracao).
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

// Piso do Asaas pra emitir cobranca. Um cupom nunca pode gerar uma cobranca
// abaixo disso (100% de desconto deve virar trial_days, nao cobranca de R$0).
const MIN_CHARGE_BRL = 5;

// Aura Dojô (karate_dojo) — plano único R$140/mês; gate ainda DESLIGADO (F3c)
// De propósito FORA do objeto PLANS: não pode aparecer no checkout do varejo
// (getPlanValue/getTotalValue seguem só com essencial/negocio/expansao) e não
// mexe no karate-gate existente da federação.
const KARATE_DOJO_MONTHLY_BRL = 140;

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
// ciclo nem de cupom — R$19 cheio sempre.
function getSeatsValue(extraSeats, cycle, billingType) {
  const seats = Number.isFinite(extraSeats) && extraSeats > 0 ? Math.floor(extraSeats) : 0;
  if (seats === 0) return 0;
  return round2(SEAT_PRICE_BRL * seats);
}

// Valor total RECORRENTE = plano + acessos extras. E o valor que vai pra
// assinatura do Asaas. Cupom NAO entra aqui de proposito. Retorna null se
// plano invalido.
function getTotalValue(plan, cycle, billingType, extraSeats = 0) {
  const planValue = getPlanValue(plan, cycle, billingType);
  if (planValue === null) return null;
  return round2(planValue + getSeatsValue(extraSeats, cycle, billingType));
}

// Valor da PRIMEIRA mensalidade, com o cupom aplicado.
// discountPct incide SO sobre o plano (acesso extra fica cheio).
// discountPct = 0 → identico a getTotalValue (caminho sem cupom nao muda).
function getFirstChargeValue(plan, cycle, billingType, extraSeats = 0, discountPct = 0) {
  const planValue = getPlanValue(plan, cycle, billingType);
  if (planValue === null) return null;

  const pct = Number.isFinite(discountPct) && discountPct > 0 ? Math.min(discountPct, 100) : 0;
  const discountedPlan = round2(planValue * (1 - pct / 100));

  return round2(discountedPlan + getSeatsValue(extraSeats, cycle, billingType));
}

module.exports = {
  PLANS,
  ANNUAL_DISCOUNT,
  SEAT_PRICE_BRL,
  MIN_CHARGE_BRL,
  KARATE_DOJO_MONTHLY_BRL,
  applyCycle,
  getPlanValue,
  getSeatsValue,
  getTotalValue,
  getFirstChargeValue,
};
