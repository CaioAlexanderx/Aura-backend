// =============================================================
// AURA. -- Credito: termos, periodicidade e tetos CDC (puro)
// Extraido de creditLedger.js (refactor 11/06/2026, sem mudanca de comportamento).
// =============================================================

// ─── F2 PR1: tetos de encargo de atraso ──────────────────────
// Multa unica <= 2% do principal; mora <= 2% ao mes (linear, 0.02/30/dia).
// Acima do teto na ESCRITA -> rejeitar (422). Na LEITURA o engine sempre clampa.
// Teto de mora elevado de 1% para 2% a.m. em 04/09/2026, a pedido do usuario
// apos validacao juridica/contabil propria (nao mais o teto CDC original).
const LATE_FEE_MAX            = 0.02;       // multa unica maxima
const LATE_INTEREST_DAILY_MAX = 0.02 / 30;  // mora diaria maxima (2% a.m.)

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

// 13/10/2026: a soma de meses agora e feita em UTC e FICA no ultimo dia do mes
// quando o dia da primeira parcela nao existe la (31/01 + 1 mes = 28/02, nao
// 03/03). Antes, `setMonth` estourava para o mes seguinte: 30/01 gerava 02/03 e
// 30/03, e fevereiro ficava sem parcela. Para dias 1..28 o resultado e o mesmo
// de sempre. Cada parcela e calculada a partir da PRIMEIRA data (nao da
// anterior), entao 31/01 -> 28/02 -> 31/03 e nao 28/02 -> 28/03.
function dueDateForIndex(firstDueStr, unit, count, idx) {
  const d = new Date(firstDueStr);
  const step = (parseInt(count, 10) || 1) * idx;
  if (unit === 'week' || unit === 'day') {
    d.setUTCDate(d.getUTCDate() + (unit === 'week' ? 7 : 1) * step);
    return d.toISOString().split('T')[0];
  }
  const total = d.getUTCMonth() + step;
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), total + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDay);
  return new Date(Date.UTC(d.getUTCFullYear(), total, day)).toISOString().split('T')[0];
}

// ─── Primeira parcela (13/10/2026) ────────────────────
// Vender em dezembro para a primeira parcela cair em janeiro. A data e livre
// dentro de uma janela: nem no passado, nem alem de FIRST_DUE_MAX_DAYS a frente.
// O teto e um so (a tela le em GET /credit/plan-config). A validacao vale para
// POST /credit/installments; /pdv/sale e /credit/manual-entry aceitam o mesmo
// campo sem esta janela porque lancam venda retroativa (sale_date/entry_date).
const FIRST_DUE_MAX_DAYS = 90;

function todayBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

function isoAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Mesmo "um mes depois" do default de /manual-entry e do PDV, mas ancorado em
// Brasilia e preso ao fim do mes.
function defaultFirstDueDate(today = todayBrt()) {
  return dueDateForIndex(today, 'month', 1, 1);
}

// @returns { ok:true, date:'YYYY-MM-DD' }
//        | { ok:false, status, code, error, ...extras }
function validateFirstDueDate(raw, { today = todayBrt(), maxDays = FIRST_DUE_MAX_DAYS } = {}) {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 10) : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const real = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === s;
  if (!real) {
    return {
      ok: false, status: 400, code: 'FIRST_DUE_DATE_INVALID',
      error: 'first_due_date invalido. Use o formato YYYY-MM-DD.',
    };
  }
  if (s < today) {
    return {
      ok: false, status: 422, code: 'FIRST_DUE_DATE_PAST',
      error: 'A primeira parcela nao pode vencer no passado.',
      today,
    };
  }
  const maxDate = isoAddDays(today, maxDays);
  if (s > maxDate) {
    return {
      ok: false, status: 422, code: 'FIRST_DUE_DATE_TOO_FAR',
      error: `A primeira parcela pode vencer em ate ${maxDays} dias (${maxDate}).`,
      max_days: maxDays, max_date: maxDate,
    };
  }
  return { ok: true, date: s };
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
  FIRST_DUE_MAX_DAYS,
  validateFirstDueDate,
  defaultFirstDueDate,
};
