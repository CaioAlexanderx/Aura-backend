// src/utils/commercialDates.js
// Cálculo puro de datas do calendário comercial.
// Tipos de regra:
//   fixed         -> { month, day }
//   nth_weekday   -> { month, weekday(0=domingo..6=sabado), nth(1..5, -1 = ultimo), offset_days? }
//   easter_offset -> { offset_days }  (relativo ao domingo de Páscoa)
// Janela default de antecedência por intensidade: 3 = 60d, 2 = 30d, 1 = 20d.

var WINDOW_BY_INTENSITY = { 1: 20, 2: 30, 3: 60 };
var MS_DAY = 86400000;

// Páscoa gregoriana (algoritmo Anonymous Gregorian / Meeus-Jones-Butcher).
function easterUTC(year) {
  var a = year % 19;
  var b = Math.floor(year / 100);
  var c = year % 100;
  var d = Math.floor(b / 4);
  var e = b % 4;
  var f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3);
  var h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4);
  var k = c % 4;
  var l = (32 + 2 * e + 2 * i - h - k) % 7;
  var m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31); // 3=março, 4=abril
  var day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// n-ésima ocorrência de um weekday no mês (month 1..12). nth = -1 -> última.
function nthWeekdayUTC(year, month, weekday, nth) {
  if (nth === -1) {
    var last = new Date(Date.UTC(year, month, 0)); // último dia do mês
    var lastDow = last.getUTCDay();
    var diff = (lastDow - weekday + 7) % 7;
    return new Date(Date.UTC(year, month - 1, last.getUTCDate() - diff));
  }
  var first = new Date(Date.UTC(year, month - 1, 1));
  var firstDow = first.getUTCDay();
  var offset = (weekday - firstDow + 7) % 7;
  var day = 1 + offset + (nth - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day));
}

// Resolve a data (Date UTC à meia-noite) de uma entrada para um dado ano.
function resolveOccurrence(ruleType, ruleConfig, year) {
  var cfg = ruleConfig || {};
  if (ruleType === 'fixed') {
    return new Date(Date.UTC(year, (cfg.month || 1) - 1, cfg.day || 1));
  }
  if (ruleType === 'nth_weekday') {
    var base = nthWeekdayUTC(year, cfg.month, cfg.weekday, cfg.nth);
    if (cfg.offset_days) base = new Date(base.getTime() + cfg.offset_days * MS_DAY);
    return base;
  }
  if (ruleType === 'easter_offset') {
    return new Date(easterUTC(year).getTime() + (cfg.offset_days || 0) * MS_DAY);
  }
  throw new Error('rule_type desconhecido: ' + ruleType);
}

function windowBeforeDays(intensity, override) {
  if (override !== null && override !== undefined) return override;
  return WINDOW_BY_INTENSITY[intensity] || 20;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// "Hoje" em America/Sao_Paulo (UTC-3, sem horário de verão), normalizado à meia-noite UTC.
function brtToday(now) {
  var t = now ? new Date(now) : new Date();
  var brt = new Date(t.getTime() - 3 * 3600000);
  return new Date(Date.UTC(brt.getUTCFullYear(), brt.getUTCMonth(), brt.getUTCDate()));
}

// Recebe entradas normalizadas { slug, name, description, intensity, rule_type,
// rule_config, is_period, window_before_days, is_custom } e devolve a lista da
// próxima ocorrência de cada uma, ordenada por proximidade.
function buildUpcoming(entries, opts) {
  opts = opts || {};
  var ref = brtToday(opts.now);
  var refYear = ref.getUTCFullYear();
  var horizon = opts.horizonDays || 400;

  var out = [];
  for (var idx = 0; idx < entries.length; idx++) {
    var e = entries[idx];
    var occ = resolveOccurrence(e.rule_type, e.rule_config, refYear);
    if (occ.getTime() < ref.getTime()) {
      occ = resolveOccurrence(e.rule_type, e.rule_config, refYear + 1);
    }
    var daysUntil = Math.round((occ.getTime() - ref.getTime()) / MS_DAY);
    if (daysUntil > horizon) continue;
    var wb = windowBeforeDays(e.intensity, e.window_before_days);
    var windowStart = new Date(occ.getTime() - wb * MS_DAY);
    out.push({
      slug: e.slug,
      name: e.name,
      description: e.description || null,
      intensity: e.intensity,
      date: isoDate(occ),
      days_until: daysUntil,
      is_period: !!e.is_period,
      window_before_days: wb,
      window_start: isoDate(windowStart),
      in_window: ref.getTime() >= windowStart.getTime(),
      is_custom: !!e.is_custom,
    });
  }
  out.sort(function (a, b) {
    if (a.days_until !== b.days_until) return a.days_until - b.days_until;
    return b.intensity - a.intensity;
  });
  return { reference_date: isoDate(ref), dates: out };
}

module.exports = {
  easterUTC: easterUTC,
  nthWeekdayUTC: nthWeekdayUTC,
  resolveOccurrence: resolveOccurrence,
  windowBeforeDays: windowBeforeDays,
  buildUpcoming: buildUpcoming,
  WINDOW_BY_INTENSITY: WINDOW_BY_INTENSITY,
};
