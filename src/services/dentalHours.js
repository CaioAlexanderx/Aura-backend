// ============================================================
// AURA. — Horário de funcionamento do consultório odonto
// (mockup aprovado pelo dono em 17/09/2026)
//
// Formato (`hours`) — sempre 7 posições, seg=1 … dom=7:
//   [{ weekday: 1, open: true,  shifts: [{ start: '08:00', end: '12:00' },
//                                        { start: '14:00', end: '18:00' }] },
//    …
//    { weekday: 7, open: false, shifts: [] }]
//
// O almoço é o vão entre turnos (não existe campo de almoço). Horários
// HH:MM em passos de 15 min; '24:00' só vale como fim de turno.
//
// Tudo aqui é PURO (sem banco), exceto loadClinicHours no fim, que recebe a
// conexão como parâmetro (mesmo padrão de queryConflicts).
//
// Fuso: as datas vêm em UTC (timestamptz) e são lidas em America/Sao_Paulo
// — 20:30 BRT é 23:30Z do mesmo dia; 22:00 BRT é 01:00Z do dia seguinte.
// ============================================================

const TZ = 'America/Sao_Paulo';
const MAX_SHIFTS = 3;
const STEP_MIN = 15;
const DEFAULT_INTERVALS = Object.freeze([15, 20, 30, 45, 60]);

// Grade da agenda quando a clínica ainda não configurou (comportamento atual do app).
const DEFAULT_GRID = Object.freeze({ start_hour: 7, end_hour: 19 });

const WEEKDAY_NAMES = Object.freeze({
  1: 'Segunda-feira', 2: 'Terça-feira', 3: 'Quarta-feira', 4: 'Quinta-feira',
  5: 'Sexta-feira', 6: 'Sábado', 7: 'Domingo',
});

// ── Conversões ───────────────────────────────────────────────────────────

const HHMM_RE = /^([01]\d|2[0-4]):([0-5]\d)$/;

/** 'HH:MM' (ou 'HH:MM:SS') → minutos do dia; null se inválido. Aceita '24:00'. */
function toMinutes(value) {
  if (typeof value !== 'string') return null;
  const m = HHMM_RE.exec(value.trim().slice(0, 5));
  if (!m) return null;
  const rest = value.trim().slice(5);
  if (rest && !/^:[0-5]\d$/.test(rest)) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** seg=1 … dom=7 → Date.getDay() (dom=0). */
function toJsDay(weekday) { return weekday % 7; }
/** Date.getDay() (dom=0) → seg=1 … dom=7. */
function fromJsDay(day) { return day === 0 ? 7 : day; }

/**
 * Dia da semana (seg=1…dom=7) e minutos do dia de um instante, em São Paulo.
 * Aceita Date ou string ISO.
 */
function localParts(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[get('weekday')];
  return {
    weekday: wd,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

// ── Sugestão / vazio ─────────────────────────────────────────────────────

function suggestedHours() {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => (weekday <= 5
    ? { weekday, open: true, shifts: [{ start: '08:00', end: '18:00' }] }
    : { weekday, open: false, shifts: [] }));
}

function suggestion() {
  return { hours: suggestedHours(), default_interval_min: null };
}

// ── Validação ────────────────────────────────────────────────────────────

/**
 * Valida e normaliza o body do PUT.
 * Retorna { ok: true, hours, default_interval_min } ou
 *         { ok: false, errors: [{ weekday?, shift?, field, message }] }.
 * Dias ausentes viram "fechado"; dia fechado é gravado com shifts [].
 */
function validateHours(input, defaultInterval) {
  const errors = [];
  const push = (e) => errors.push(e);

  if (!Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'hours', message: 'Envie o horário como uma lista de dias da semana.' }] };
  }

  const byDay = new Map();
  input.forEach((day, idx) => {
    const wd = day && Number(day.weekday);
    if (!Number.isInteger(wd) || wd < 1 || wd > 7) {
      push({ field: 'weekday', message: `Dia na posição ${idx + 1}: dia da semana inválido (use 1 = segunda … 7 = domingo).` });
      return;
    }
    if (byDay.has(wd)) {
      push({ weekday: wd, field: 'weekday', message: `${WEEKDAY_NAMES[wd]} aparece mais de uma vez.` });
      return;
    }
    byDay.set(wd, day);
  });

  const hours = [];
  for (let wd = 1; wd <= 7; wd++) {
    const day = byDay.get(wd);
    const name = WEEKDAY_NAMES[wd];
    if (!day || day.open !== true) {
      if (day && day.open !== false && day.open !== undefined) {
        push({ weekday: wd, field: 'open', message: `${name}: informe se o consultório abre (sim ou não).` });
      }
      hours.push({ weekday: wd, open: false, shifts: [] });
      continue;
    }

    const shifts = Array.isArray(day.shifts) ? day.shifts : null;
    if (!shifts || shifts.length === 0) {
      push({ weekday: wd, field: 'shifts', message: `${name}: informe pelo menos um turno ou marque o dia como fechado.` });
      hours.push({ weekday: wd, open: true, shifts: [] });
      continue;
    }
    if (shifts.length > MAX_SHIFTS) {
      push({ weekday: wd, field: 'shifts', message: `${name}: no máximo ${MAX_SHIFTS} turnos por dia.` });
    }

    const parsed = [];
    shifts.slice(0, MAX_SHIFTS).forEach((sh, i) => {
      const label = `${name}, turno ${i + 1}`;
      const s = toMinutes(sh && sh.start);
      const e = toMinutes(sh && sh.end);
      let bad = false;
      if (s === null || s === 24 * 60) {
        push({ weekday: wd, shift: i + 1, field: 'start', message: `${label}: horário de início inválido (use HH:MM).` });
        bad = true;
      } else if (s % STEP_MIN) {
        push({ weekday: wd, shift: i + 1, field: 'start', message: `${label}: o início (${sh.start}) precisa ser em intervalos de 15 minutos.` });
        bad = true;
      }
      if (e === null) {
        push({ weekday: wd, shift: i + 1, field: 'end', message: `${label}: horário de fim inválido (use HH:MM).` });
        bad = true;
      } else if (e % STEP_MIN) {
        push({ weekday: wd, shift: i + 1, field: 'end', message: `${label}: o fim (${sh.end}) precisa ser em intervalos de 15 minutos.` });
        bad = true;
      }
      if (!bad && e <= s) {
        push({ weekday: wd, shift: i + 1, field: 'end', message: `${label}: o fim (${fromMinutes(e)}) precisa ser depois do início (${fromMinutes(s)}).` });
        bad = true;
      }
      if (!bad) parsed.push({ n: i + 1, s, e });
    });

    const sorted = [...parsed].sort((a, b) => a.s - b.s);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.s < prev.e) {
        push({
          weekday: wd, shift: cur.n, field: 'shifts',
          message: `${name}: os turnos ${fromMinutes(prev.s)}–${fromMinutes(prev.e)} e ${fromMinutes(cur.s)}–${fromMinutes(cur.e)} se sobrepõem.`,
        });
      }
    }

    hours.push({
      weekday: wd,
      open: true,
      shifts: sorted.map((x) => ({ start: fromMinutes(x.s), end: fromMinutes(x.e) })),
    });
  }

  if (!errors.length && !hours.some((d) => d.open)) {
    push({ field: 'hours', message: 'Abra o consultório em pelo menos um dia da semana.' });
  }

  let interval = null;
  if (defaultInterval !== undefined && defaultInterval !== null && defaultInterval !== '') {
    const n = Number(defaultInterval);
    if (!DEFAULT_INTERVALS.includes(n)) {
      push({ field: 'default_interval_min', message: 'Intervalo padrão entre consultas deve ser 15, 20, 30, 45 ou 60 minutos (ou nenhum).' });
    } else {
      interval = n;
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, hours, default_interval_min: interval };
}

/**
 * Normaliza o que veio do banco (tolerante: descarta lixo em vez de lançar).
 * Retorna sempre 7 dias.
 */
function normalizeStored(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (let wd = 1; wd <= 7; wd++) {
    const d = list.find((x) => x && Number(x.weekday) === wd);
    const shifts = d && d.open === true && Array.isArray(d.shifts)
      ? d.shifts
        .map((s) => ({ s: toMinutes(s && s.start), e: toMinutes(s && s.end) }))
        .filter((x) => x.s !== null && x.e !== null && x.e > x.s)
        .sort((a, b) => a.s - b.s)
        .map((x) => ({ start: fromMinutes(x.s), end: fromMinutes(x.e) }))
      : [];
    out.push({ weekday: wd, open: shifts.length > 0, shifts });
  }
  return out;
}

// ── Consultas ────────────────────────────────────────────────────────────

function shiftsOf(hours, weekday) {
  const d = (hours || []).find((x) => x && x.weekday === weekday);
  if (!d || !d.open) return [];
  return (d.shifts || []).map((s) => ({ s: toMinutes(s.start), e: toMinutes(s.end) }));
}

/**
 * true quando o instante `date` (lido em São Paulo) cai dentro de algum turno.
 * Com `durationMin`, exige que o atendimento inteiro [início, fim] caiba num
 * mesmo turno (terminar exatamente no fim do turno vale). Atendimento que
 * atravessa a meia-noite → false.
 */
function isWithinHours(hours, date, durationMin = 0) {
  const p = localParts(date);
  if (!p) return false;
  const start = p.minutes;
  const end = start + Math.max(0, Number(durationMin) || 0);
  return shiftsOf(hours, p.weekday).some((sh) => (durationMin > 0
    ? start >= sh.s && end <= sh.e
    : start >= sh.s && start < sh.e));
}

/**
 * Interseção do horário da clínica com uma janela de agendamento online
 * { from: 'HH:MM', to: 'HH:MM', days: [1..7] }. A janela só restringe:
 * dia fora de `days` fica fechado e cada turno é recortado em [from, to].
 */
function intersectWindow(hours, window) {
  const from = window ? toMinutes(window.from) : null;
  const to = window ? toMinutes(window.to) : null;
  const days = window && Array.isArray(window.days) ? window.days.map(Number) : null;
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const allowedDay = !days || days.includes(weekday);
    const shifts = allowedDay
      ? shiftsOf(hours, weekday)
        .map((sh) => ({ s: Math.max(sh.s, from ?? 0), e: Math.min(sh.e, to ?? 24 * 60) }))
        .filter((sh) => sh.e > sh.s)
        .map((sh) => ({ start: fromMinutes(sh.s), end: fromMinutes(sh.e) }))
      : [];
    return { weekday, open: shifts.length > 0, shifts };
  });
}

/**
 * Faixa de horas da grade da agenda: 1h antes da primeira abertura até 1h
 * depois do último fechamento (arredondado para hora cheia, limitado a 0–24).
 * Sem nenhum dia aberto → 07–19 (comportamento atual do app).
 */
function gridRange(hours) {
  let min = Infinity;
  let max = -Infinity;
  for (let wd = 1; wd <= 7; wd++) {
    for (const sh of shiftsOf(hours, wd)) {
      if (sh.s < min) min = sh.s;
      if (sh.e > max) max = sh.e;
    }
  }
  if (min === Infinity) return { ...DEFAULT_GRID };
  return {
    start_hour: Math.max(0, Math.floor(min / 60) - 1),
    end_hour: Math.min(24, Math.ceil(max / 60) + 1),
  };
}

/** Horários de início 'HH:MM' que cabem inteiros nos turnos, a cada `slotMin`. */
function generateSlots(shifts, slotMin) {
  const step = Number(slotMin);
  if (!Number.isInteger(step) || step <= 0) return [];
  const out = [];
  for (const sh of shifts || []) {
    const s = toMinutes(sh.start);
    const e = toMinutes(sh.end);
    if (s === null || e === null) continue;
    for (let t = s; t + step <= e; t += step) out.push(fromMinutes(t));
  }
  return out;
}

// ── Agendamento online ───────────────────────────────────────────────────

/**
 * Valida `online_window` do PUT /booking/config.
 * null → ok (sem janela). Retorna { ok, value } ou { ok: false, error }.
 */
function validateOnlineWindow(w) {
  if (w === null) return { ok: true, value: null };
  if (!w || typeof w !== 'object' || Array.isArray(w)) {
    return { ok: false, error: 'online_window deve ser um objeto { from, to, days }' };
  }
  const f = toMinutes(w.from);
  const t = toMinutes(w.to);
  if (f === null || f === 24 * 60 || f % STEP_MIN) {
    return { ok: false, error: 'Janela online: horário inicial inválido (HH:MM em intervalos de 15 minutos).' };
  }
  if (t === null || t % STEP_MIN) {
    return { ok: false, error: 'Janela online: horário final inválido (HH:MM em intervalos de 15 minutos).' };
  }
  if (t <= f) return { ok: false, error: 'Janela online: o horário final precisa ser depois do inicial.' };
  const days = w.days;
  if (!Array.isArray(days) || !days.length
    || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
    || new Set(days).size !== days.length) {
    return { ok: false, error: 'Janela online: dias devem ser uma lista de 1 (segunda) a 7 (domingo), sem repetir.' };
  }
  return { ok: true, value: { from: fromMinutes(f), to: fromMinutes(t), days: [...days].sort((a, b) => a - b) } };
}

/** Janela equivalente aos campos antigos start_hour/end_hour/available_days (0=dom). */
function legacyWindow(config) {
  const sh = Number.isInteger(config.start_hour) ? config.start_hour : 8;
  const eh = Number.isInteger(config.end_hour) ? config.end_hour : 18;
  const days = Array.isArray(config.available_days) ? config.available_days : [1, 2, 3, 4, 5];
  return {
    from: fromMinutes(Math.max(0, Math.min(sh, 23)) * 60),
    to: fromMinutes(Math.max(1, Math.min(eh, 24)) * 60),
    days: days.map((d) => fromJsDay(Number(d))).filter((d) => d >= 1 && d <= 7),
  };
}

/**
 * Horário efetivo do agendamento online.
 *   clinic: { configured, hours, default_interval_min }
 *   config: linha de dental_booking_config
 * Retorna { source: 'clinic' | 'window' | 'legacy', hours, slot_duration_min }.
 *   - clínica configurada + use_clinic_hours       → horário da clínica
 *   - clínica configurada + !use_clinic_hours      → interseção com a janela
 *     (online_window, ou a janela antiga start_hour/end_hour/available_days)
 *   - clínica não configurada + use_clinic_hours   → comportamento antigo
 *   - clínica não configurada + !use_clinic_hours  → online_window (ou antigo)
 * Duração: intervalo padrão da clínica, salvo se o dentista escolheu outra
 * (slot_duration_custom) ou a clínica não definiu intervalo.
 */
function effectiveOnlineHours(clinic, config) {
  const useClinic = config.use_clinic_hours !== false;
  const configured = !!(clinic && clinic.configured);
  const legacy = legacyWindow(config);
  const everyDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday, open: true, shifts: [{ start: '00:00', end: '24:00' }],
  }));

  let source;
  let hours;
  if (configured && useClinic) {
    source = 'clinic';
    hours = normalizeStored(clinic.hours);
  } else if (configured) {
    source = 'window';
    hours = intersectWindow(clinic.hours, config.online_window || legacy);
  } else if (!useClinic && config.online_window) {
    source = 'window';
    hours = intersectWindow(everyDay, config.online_window);
  } else {
    source = 'legacy';
    hours = intersectWindow(everyDay, legacy);
  }

  const clinicInterval = configured ? clinic.default_interval_min : null;
  const slot = !config.slot_duration_custom && clinicInterval
    ? clinicInterval
    : (config.slot_duration_min || 60);

  return { source, hours, slot_duration_min: slot };
}

/** { '0': [{start,end}], …, '6': [...] } — chaves no padrão Date.getDay() (0=dom). */
function toDayWindows(hours) {
  const out = {};
  for (const d of hours) out[String(toJsDay(d.weekday))] = d.open ? d.shifts : [];
  return out;
}

/** 'AAAA-MM-DD' → seg=1…dom=7 (data de calendário, sem fuso). */
function weekdayOfDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : fromJsDay(d.getUTCDay());
}

/** O horário pedido (data + 'HH:MM') é um dos horários oferecidos? */
function isOfferedSlot(hours, slotMin, ymd, time) {
  const wd = weekdayOfDate(ymd);
  const t = toMinutes(String(time || '').slice(0, 5));
  if (wd === null || t === null) return false;
  const d = hours.find((x) => x.weekday === wd);
  if (!d || !d.open) return false;
  return generateSlots(d.shifts, slotMin).includes(fromMinutes(t));
}

// ── Banco ────────────────────────────────────────────────────────────────

/** { configured, hours, default_interval_min } da empresa. `conn` = pool ou client. */
async function loadClinicHours(conn, companyId) {
  const { rows } = await conn.query(
    `SELECT business_hours, default_interval_min
       FROM dental_clinic_hours
      WHERE company_id = $1`,
    [companyId]
  );
  if (!rows.length) return { configured: false, hours: null, default_interval_min: null };
  return {
    configured: true,
    hours: normalizeStored(rows[0].business_hours),
    default_interval_min: rows[0].default_interval_min ?? null,
  };
}

/**
 * `outside_hours` para a resposta das rotas de agendamento. undefined quando
 * a clínica não configurou horário (o campo não vai na resposta).
 */
async function outsideHoursFlag(conn, companyId, scheduledAt, durationMin) {
  if (!scheduledAt) return undefined;
  // Informativo: nunca derruba a rota (o agendamento já foi gravado).
  let clinic;
  try {
    clinic = await loadClinicHours(conn, companyId);
  } catch (err) {
    console.error('[dentalHours outsideHoursFlag]', err.message);
    return undefined;
  }
  if (!clinic.configured) return undefined;
  return !isWithinHours(clinic.hours, scheduledAt, Number(durationMin) || 0);
}

module.exports = {
  TZ,
  MAX_SHIFTS,
  DEFAULT_INTERVALS,
  DEFAULT_GRID,
  WEEKDAY_NAMES,
  toMinutes,
  fromMinutes,
  toJsDay,
  fromJsDay,
  localParts,
  suggestedHours,
  suggestion,
  validateHours,
  normalizeStored,
  isWithinHours,
  intersectWindow,
  gridRange,
  generateSlots,
  validateOnlineWindow,
  legacyWindow,
  effectiveOnlineHours,
  toDayWindows,
  weekdayOfDate,
  isOfferedSlot,
  loadClinicHours,
  outsideHoursFlag,
};
