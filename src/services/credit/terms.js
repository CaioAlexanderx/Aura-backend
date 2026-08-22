// =============================================================
// AURA. -- Credito: termos, periodicidade e tetos CDC (puro)
// Extraido de creditLedger.js (refactor 11/06/2026, sem mudanca de comportamento).
// =============================================================

// ─── F2 PR1: tetos CDC (imutaveis) ──────────────────────
// Multa unica <= 2% do principal; mora <= 1% ao mes (linear, 0.01/30/dia).
// Acima do teto na ESCRITA -> rejeitar (422). Na LEITURA o engine sempre clampa.
const LATE_FEE_MAX            = 0.02;       // multa unica maxima
const LATE_INTEREST_DAILY_MAX = 0.01 / 30;  // mora diaria maxima (1% a.m.)

// ─── Teto de parcelas (21/08/2026) ──────────────────────
// Era 12 (default de config) + 100 (hard cap espalhado pelo codigo). A Valen
// vende em 36x/54x: o 12 barrava PDV e parcelamento direto enquanto a
// renegociacao, sem teto, passava -- e o PDV ainda CLAMPAVA em silencio,
// gravando 12x numa venda pedida em 54x sem erro em lugar nenhum.
// Agora o teto e um so, alto, e serve de guarda-corpo contra entrada absurda
// (dedo escorregando no 5000). Loja que quiser teto de verdade configura
// max_installments em PUT /credit/plan-config -- e ai o pedido acima do teto
// vira ERRO EXPLICITO, nunca corte silencioso.
const MAX_INSTALLMENTS_CEILING = 500;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─── periodicidade de pagamento ──────────────────────
function resolvePeriod(unit, count, config) {
  let u = unit || config?.period_unit || 'month';
  if (!['day', 'week', 'month'].includes(u)) u = 'month';
  let c = parseInt(count != null ? count : (config?.period_count != null ? config.period_count : 1), 10);
  if (!Number.isFinite(c) || c < 1 || c > 365) c = 1;
  return { unit: u, count: c };
}

function dueDateForIndex(firstDueStr, unit, count, idx) {
  const d = new Date(firstDueStr);
  const step = (parseInt(count, 10) || 1) * idx;
  if (unit === 'week') d.setDate(d.getDate() + 7 * step);
  else if (unit === 'day') d.setDate(d.getDate() + step);
  else d.setMonth(d.getMonth() + step);
  return d.toISOString().split('T')[0];
}

// ─── F2: resolveTerms ──────────────────────
// Retorna termos efetivos com precedencia:
//   override do cliente (term_*) ?? config da loja ?? default hardcoded
// Juros e sempre opt-in: null/0 = sem juros.
function resolveTerms(profile, config) {
  const defaults = {
    interest_rate:       0,
    max_installments:    MAX_INSTALLMENTS_CEILING,
    period_unit:         'month',
    period_count:        1,
    due_day:             null,
    late_fee_rate:       0,
    late_interest_daily: 0,
  };

  const effective = {
    interest_rate:       profile?.term_interest_rate       ?? config?.interest_rate       ?? defaults.interest_rate,
    max_installments:    profile?.term_max_installments    ?? config?.max_installments    ?? defaults.max_installments,
    period_unit:         profile?.term_period_unit         ?? config?.period_unit         ?? defaults.period_unit,
    period_count:        profile?.term_period_count        ?? config?.period_count        ?? defaults.period_count,
    due_day:             profile?.term_due_day             ?? config?.due_day             ?? defaults.due_day,
    late_fee_rate:       profile?.term_late_fee_rate       ?? config?.late_fee_rate       ?? defaults.late_fee_rate,
    late_interest_daily: profile?.term_late_interest_daily ?? config?.late_interest_daily ?? defaults.late_interest_daily,
  };

  // Normaliza tipos
  effective.interest_rate       = parseFloat(effective.interest_rate)       || 0;
  effective.max_installments    = parseInt(effective.max_installments)       || MAX_INSTALLMENTS_CEILING;
  effective.period_count        = parseInt(effective.period_count)           || 1;
  effective.late_fee_rate       = parseFloat(effective.late_fee_rate)        || 0;
  effective.late_interest_daily = parseFloat(effective.late_interest_daily)  || 0;
  if (!['day', 'week', 'month'].includes(effective.period_unit)) effective.period_unit = 'month';

  const overrides = {
    interest_rate:       profile?.term_interest_rate       ?? null,
    max_installments:    profile?.term_max_installments    ?? null,
    period_unit:         profile?.term_period_unit         ?? null,
    period_count:        profile?.term_period_count        ?? null,
    due_day:             profile?.term_due_day             ?? null,
    late_fee_rate:       profile?.term_late_fee_rate       ?? null,
    late_interest_daily: profile?.term_late_interest_daily ?? null,
  };

  return { effective, overrides };
}

module.exports = {
  round2,
  LATE_FEE_MAX,
  LATE_INTEREST_DAILY_MAX,
  MAX_INSTALLMENTS_CEILING,
  resolvePeriod,
  dueDateForIndex,
  resolveTerms,
};
