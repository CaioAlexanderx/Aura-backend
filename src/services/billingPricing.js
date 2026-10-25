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
// 14/10/2026: VALOR CUSTOMIZADO POR EMPRESA (migration 386). A equipe pode
//   combinar um valor mensal total com um cliente (ex.: R$ 211,20 para 2
//   lojas no Negocio anual). valorDaAssinatura() e' a ENTRADA UNICA do valor
//   de uma assinatura: devolve o customizado quando plano E ciclo escolhidos
//   batem com os gravados na empresa, senao o getTotalValue de sempre. O
//   valor customizado ja inclui os acessos extras e NAO leva o desconto anual
//   (o ciclo e' parte do combinado). Cupom/promocao seguem como hoje, sobre
//   esse valor (ver getCouponDiscountAmount com baseValue).
//
// 25/10/2026: MULTI-CNPJ NA TABELA (decisao do Caio, confirmada no chat do
//   Teo). Antes a regra morava em utils/multicnpjBilling.js com precos
//   proprios (Negocio 169,90, extra fixo R$ 85, 2 CNPJs incluidos) que
//   divergiam desta tabela. Agora a fonte e' esta:
//     - Negocio: 1 CNPJ incluido; cada CNPJ a mais custa 50% do valor do
//       plano NO CICLO da assinatura, arredondado com centavo para cima
//       (arredondarCentavoParaCima). Ex.: anual 140,83 + 70,42 = 211,25;
//       mensal 169,00 + 84,50 = 253,50.
//     - Essencial e Expansao: sem mudanca (1 e 2 incluidos; extra fixo de
//       R$ 45 e R$ 135 por mes, sem desconto de ciclo, como era).
//     - Excecao explicita: NEGOCIO_DOIS_CNPJS_INCLUIDOS (Davi).
//   getMulticnpjBreakdown() e' a entrada unica do valor de um grupo.
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

// 11/09/2026: quanto o cupom abate de CADA mensalidade, em reais.
// O cupom agora pode ser em percentual (discount_pct) OU em valor fixo
// (discount_value, ex.: R$ 50). Nos dois casos incide so no plano e nunca
// passa do valor do plano. Para discount_pct o resultado bate centavo a
// centavo com getFirstChargeValue (total - abatimento = primeira cobranca).
//
// 14/10/2026: baseValue (opcional) = valor combinado da empresa. Quando vem,
// o cupom incide sobre ELE (e' o "plano" desse cliente) em vez do valor de
// tabela do plano. Sem baseValue o calculo e' exatamente o de antes.
function getCouponDiscountAmount(plan, cycle, billingType, { discountPct = 0, discountValue = 0, baseValue = null } = {}) {
  const tablePlanValue = getPlanValue(plan, cycle, billingType);
  if (tablePlanValue === null) return null;
  const planValue = Number.isFinite(baseValue) && baseValue > 0 ? round2(baseValue) : tablePlanValue;

  const pct = Number.isFinite(discountPct) && discountPct > 0 ? Math.min(discountPct, 100) : 0;
  if (pct > 0) return round2(planValue - round2(planValue * (1 - pct / 100)));

  const fixed = Number.isFinite(discountValue) && discountValue > 0 ? discountValue : 0;
  return round2(Math.min(fixed, planValue));
}

// ── Valor customizado por empresa (migration 386) ──────────────────────────
const CYCLES = ['monthly', 'annual'];

// Normaliza o que a linha de companies guarda. null = empresa sem valor
// combinado (ou valor invalido: nunca cobra um valor que nao faz sentido).
// NUMERIC chega do driver como string ('211.20').
function getCustomSubscription(company) {
  if (!company) return null;
  const raw = company.custom_subscription_value;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return {
    value: round2(value),
    plan: company.custom_subscription_plan || null,
    cycle: company.custom_subscription_cycle || null,
    note: company.custom_subscription_note || null,
  };
}

// O valor combinado vale para este plano E este ciclo?
function customMatches(custom, plan, cycle) {
  if (!custom || !custom.plan || !custom.cycle) return false;
  return custom.plan === plan && custom.cycle === (cycle || 'monthly');
}

// Valor RECORRENTE (mensal) da assinatura de uma empresa para plano + ciclo.
// Fonte unica usada pelo checkout (/subscribe, /validate-coupon, /quote).
//   custom=false → valor === getTotalValue(...) (comportamento de sempre)
//   custom=true  → valor combinado (ja inclui acessos extras)
// table_value = o que o checkout cobraria sem o valor combinado.
// Retorna null se o plano for invalido (igual a getTotalValue).
function valorDaAssinatura(company, plan, cycle, billingType, extraSeats = 0) {
  const tableValue = getTotalValue(plan, cycle, billingType, extraSeats);
  if (tableValue === null) return null;
  const custom = getCustomSubscription(company);
  if (customMatches(custom, plan, cycle)) {
    return { value: custom.value, custom: true, table_value: tableValue, note: custom.note };
  }
  return { value: tableValue, custom: false, table_value: tableValue, note: null };
}

// ── Multi-CNPJ (25/10/2026) ─────────────────────────────────────────────────

// Arredondamento da Aura para valores derivados de percentual: CENTAVO PARA
// CIMA. Definido UMA vez aqui. O toFixed(6) tira o ruido de ponto flutuante
// antes do ceil: 140,83 x 0,5 = 70,415 vira 7041,5 centavos -> 7042 -> 70,42;
// 169 x 0,5 = 84,5 -> 8450 centavos -> 84,50 (nao sobe para 84,51); e um
// valor que ja esta em centavos, como 70,42, continua 70,42 (7042,000000001
// nao vira 7043).
function arredondarCentavoParaCima(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const centavos = Math.ceil(Number((n * 100).toFixed(6)));
  return centavos / 100;
}

// Quantas empresas (CNPJs) a assinatura cobre sem custo extra.
// 'personalizado' nao tem preco nesta tabela: nunca gera extra automatico.
const INCLUDED_COMPANIES = {
  essencial:     1,
  negocio:       1,
  expansao:      2,
  personalizado: 999,
};

// Preco de cada empresa alem das incluidas, por plano.
//   percentualDoPlano: fracao do valor do plano no ciclo (getPlanValue),
//                      arredondada com arredondarCentavoParaCima.
//   fixoMensal:        valor fixo por mes, igual no mensal e no anual
//                      (regra que ja valia para Essencial e Expansao).
const EXTRA_COMPANY_RULE = {
  essencial: { fixoMensal: 45 },
  negocio:   { percentualDoPlano: 0.5 },
  expansao:  { fixoMensal: 135 },
};

// EXCECAO EXPLICITA (decisao do Caio, 25/10/2026): o Davi Rodrigues continua
// com 2 CNPJs incluidos no Negocio, como foi vendido a ele. A chave e' a
// empresa Davi Calcados Matriz (principal do grupo; a Villa Branca e' a
// segunda). A excecao vale para o GRUPO que contem esta empresa, entao
// continua valendo se a principal for transferida para a Villa Branca.
// Nova excecao: so com decisao do Caio, registrada aqui com data e motivo.
const NEGOCIO_DOIS_CNPJS_INCLUIDOS = Object.freeze({
  '08c05f0e-b75b-4c12-870e-d7fb65f1dca0':
    'Davi Rodrigues (Davi Calcados Matriz + Villa Branca): 2 CNPJs incluidos. Decisao do Caio, 25/10/2026.',
});

function excecaoDoGrupo(plan, companyIds) {
  if (plan !== 'negocio' || !Array.isArray(companyIds)) return null;
  for (const id of companyIds) {
    const motivo = NEGOCIO_DOIS_CNPJS_INCLUIDOS[String(id)];
    if (motivo) return { company_id: String(id), included: 2, motivo };
  }
  return null;
}

// CNPJs incluidos para o grupo (companyIds = ids das empresas do grupo, so
// para checar a excecao). Plano desconhecido = 1, como era.
function getIncludedCompanies(plan, companyIds = []) {
  const excecao = excecaoDoGrupo(plan, companyIds);
  if (excecao) return excecao.included;
  return INCLUDED_COMPANIES[plan] || 1;
}

// Valor MENSAL de cada empresa extra para plano + ciclo. null se o plano nao
// tem regra (personalizado / invalido).
function getExtraCompanyValue(plan, cycle, billingType) {
  const rule = EXTRA_COMPANY_RULE[plan];
  if (!rule) return null;
  if (rule.percentualDoPlano) {
    const planValue = getPlanValue(plan, cycle, billingType);
    if (planValue === null) return null;
    return arredondarCentavoParaCima(planValue * rule.percentualDoPlano);
  }
  return round2(rule.fixoMensal);
}

// Valor RECORRENTE (mensal) de um grupo multi-CNPJ pela tabela:
//   plano no ciclo + acessos extras + (empresas alem das incluidas x extra).
// totalCompanies conta a principal. Retorna null se o plano nao tem preco
// nesta tabela (quem chama nao deve cobrar nada automatico).
function getMulticnpjBreakdown(plan, cycle, { totalCompanies = 1, companyIds = [], extraSeats = 0, billingType } = {}) {
  const ciclo = cycle === 'annual' ? 'annual' : 'monthly';
  const basePrice = getPlanValue(plan, ciclo, billingType);
  const extraUnit = getExtraCompanyValue(plan, ciclo, billingType);
  if (basePrice === null || extraUnit === null) return null;

  const total = Number.isFinite(totalCompanies) && totalCompanies > 0 ? Math.floor(totalCompanies) : 1;
  const excecao = excecaoDoGrupo(plan, companyIds);
  const included = getIncludedCompanies(plan, companyIds);
  const extras = Math.max(0, total - included);
  const extrasValue = round2(extras * extraUnit);
  const seatsValue = getSeatsValue(extraSeats, ciclo, billingType);
  const rule = EXTRA_COMPANY_RULE[plan];

  return {
    plan,
    cycle: ciclo,
    base_price: basePrice,
    seats_value: seatsValue,
    included_in_plan: included,
    total_companies: total,
    extra_cnpjs: extras,
    extra_unit_price: extraUnit,
    extras_value: extrasValue,
    total_monthly: round2(basePrice + seatsValue + extrasValue),
    extra_rule: rule.percentualDoPlano
      ? { tipo: 'percentual_do_plano', percentual: rule.percentualDoPlano * 100 }
      : { tipo: 'fixo_mensal', valor: rule.fixoMensal },
    excecao: excecao ? excecao.motivo : null,
  };
}

module.exports = {
  PLANS,
  CYCLES,
  getCustomSubscription,
  customMatches,
  valorDaAssinatura,
  ANNUAL_DISCOUNT,
  SEAT_PRICE_BRL,
  MIN_CHARGE_BRL,
  KARATE_DOJO_MONTHLY_BRL,
  applyCycle,
  getPlanValue,
  getSeatsValue,
  getTotalValue,
  getFirstChargeValue,
  getCouponDiscountAmount,
  arredondarCentavoParaCima,
  INCLUDED_COMPANIES,
  EXTRA_COMPANY_RULE,
  NEGOCIO_DOIS_CNPJS_INCLUIDOS,
  getIncludedCompanies,
  getExtraCompanyValue,
  getMulticnpjBreakdown,
};
