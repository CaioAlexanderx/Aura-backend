// ============================================================
// AURA. — Agenda odonto: máquina de estados, conflitos e validações
// (QA odonto 16/09/2026 — fase 1, itens 1.1 e 1.5)
//
// Funções PURAS (sem banco) para a rota e os testes usarem a mesma regra.
//
// ── Tabela de transições de dental_appointments.status ──────────────────
//
//   agendado             → confirmado, avaliacao, em_atendimento, cancelado,
//                          faltou, falta_justificada, paciente_consultorio,
//                          concluido*
//   confirmado           → agendado (desconfirmar), paciente_consultorio,
//                          em_atendimento, cancelado, faltou,
//                          falta_justificada, concluido*
//   paciente_consultorio → em_atendimento, cancelado, concluido*
//   avaliacao            → aprovado, cancelado
//   aprovado             → em_atendimento, cancelado
//   em_atendimento       → concluido, cancelado
//   faltou               → agendado (desfazer marcação), falta_justificada
//   falta_justificada    → agendado, faltou
//   concluido, cancelado → (terminais)
//
//   * concluido direto (sem ter passado por em_atendimento): o dentista
//     encerrou a consulta sem clicar em "iniciar". started_at é preenchido
//     com o horário marcado (ou agora, se o horário marcado é futuro), para
//     a consulta concluída nunca ficar sem início.
//
// Mudar para o MESMO status é aceito como no-op (idempotente).
//
// Os status novos (confirmado, paciente_consultorio, falta_justificada)
// entraram no enum pela migration 345.
// ============================================================

const TRANSITIONS = Object.freeze({
  agendado: ['confirmado', 'avaliacao', 'em_atendimento', 'cancelado', 'faltou',
    'falta_justificada', 'paciente_consultorio', 'concluido'],
  confirmado: ['agendado', 'paciente_consultorio', 'em_atendimento', 'cancelado',
    'faltou', 'falta_justificada', 'concluido'],
  paciente_consultorio: ['em_atendimento', 'cancelado', 'concluido'],
  avaliacao: ['aprovado', 'cancelado'],
  aprovado: ['em_atendimento', 'cancelado'],
  em_atendimento: ['concluido', 'cancelado'],
  faltou: ['agendado', 'falta_justificada'],
  falta_justificada: ['agendado', 'faltou'],
  concluido: [],
  cancelado: [],
});

const DENTAL_APPOINTMENT_STATUSES = Object.freeze(Object.keys(TRANSITIONS));

// Status que NÃO ocupam o horário (não entram no cálculo de conflito nem na
// disponibilidade da agenda online).
const NON_BLOCKING_STATUSES = Object.freeze(['cancelado', 'faltou', 'falta_justificada']);

// Consulta "ativa" (ainda vai acontecer / está acontecendo).
const ACTIVE_STATUSES = Object.freeze([
  'agendado', 'confirmado', 'paciente_consultorio', 'avaliacao', 'aprovado', 'em_atendimento',
]);

class ScheduleError extends Error {
  constructor(message, code, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.httpStatus = status;
    Object.assign(this, extra);
  }
}

function isKnownStatus(s) {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, s);
}

function canTransition(from, to) {
  if (!isKnownStatus(to)) return false;
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

/** Lança ScheduleError se a transição não é permitida. */
function assertTransition(from, to) {
  if (!isKnownStatus(to)) {
    throw new ScheduleError(`Status inválido: "${to}"`, 'INVALID_STATUS');
  }
  if (!canTransition(from, to)) {
    throw new ScheduleError(`Não é possível mudar de "${from}" para "${to}"`, 'INVALID_TRANSITION',
      400, { from, to });
  }
}

/**
 * Fragmentos SQL de SET com os timestamps coerentes com a transição.
 * Só usa colunas da própria linha (nenhum parâmetro de usuário).
 */
function timestampSetsFor(from, to) {
  if (from === to) return [];
  switch (to) {
    case 'em_atendimento':
      return ['started_at = COALESCE(started_at, NOW())'];
    case 'concluido':
      return [
        'started_at = COALESCE(started_at, LEAST(scheduled_at, NOW()))',
        'concluded_at = NOW()',
      ];
    case 'cancelado':
      return ['cancelled_at = NOW()'];
    default:
      return [];
  }
}

// ── Datas ────────────────────────────────────────────────────────────────

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** scheduled_at aceito: string ISO (data ou data+hora, com ou sem fuso) com calendário válido. */
function isValidTimestamp(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value !== 'string') return false;
  const m = TS_RE.exec(value.trim());
  if (!m) return false;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const Y = +y, M = +mo, D = +d;
  if (M < 1 || M > 12 || D < 1) return false;
  const daysInMonth = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  if (D > daysInMonth) return false;
  if (+h > 23 || +mi > 59 || +s > 59) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** duration_min: inteiro entre 1 e 1440 (aceita string numérica). */
function isValidDuration(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= 1440;
}

/** 'AAAA-MM-DD' de hoje no fuso de São Paulo. */
function todayInSaoPaulo(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * true quando birth_date é uma data (AAAA-MM-DD, opcionalmente com hora)
 * posterior a hoje em São Paulo. Vazio/nulo/formato desconhecido → false
 * (fica com o comportamento de antes).
 */
function isBirthDateInFuture(value, now = new Date()) {
  if (value == null || value === '') return false;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  if (!m) return false;
  return m[1] > todayInSaoPaulo(now);
}

// ── Conflitos ────────────────────────────────────────────────────────────

function toMs(v) {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

/** Intervalos semiabertos [início, fim): encostar (fim == início) não é conflito. */
function overlaps(aStart, aDurMin, bStart, bDurMin) {
  const a0 = toMs(aStart), b0 = toMs(bStart);
  const a1 = a0 + Number(aDurMin) * 60000;
  const b1 = b0 + Number(bDurMin) * 60000;
  return a0 < b1 && b0 < a1;
}

/**
 * Filtra, dentre `candidates`, os agendamentos que conflitam com `target`.
 * Regra: mesmo practitioner_id (null só conflita com null), status que
 * ocupa horário, id diferente do próprio agendamento, horários sobrepostos.
 *
 * target:     { id?, scheduled_at, duration_min, practitioner_id }
 * candidates: [{ id, patient_name, scheduled_at, duration_min, practitioner_id, status }]
 * retorna:    [{ id, patient_name, scheduled_at, duration_min }] em ordem de horário
 */
function findConflicts(target, candidates) {
  const tPrac = target.practitioner_id || null;
  return (candidates || [])
    .filter((c) => !(target.id && c.id === target.id))
    .filter((c) => (c.practitioner_id || null) === tPrac)
    .filter((c) => !NON_BLOCKING_STATUSES.includes(c.status))
    .filter((c) => overlaps(target.scheduled_at, target.duration_min, c.scheduled_at, c.duration_min))
    .sort((a, b) => toMs(a.scheduled_at) - toMs(b.scheduled_at))
    .map((c) => ({
      id: c.id,
      patient_name: c.patient_name ?? null,
      scheduled_at: c.scheduled_at,
      duration_min: c.duration_min,
    }));
}

/**
 * Busca candidatos no banco e devolve os conflitos. `conn` é o pool ou um
 * client de transação. A janela SQL é larga (1 dia antes) e o filtro exato
 * é o findConflicts — a mesma função que os testes cobrem.
 */
async function queryConflicts(conn, companyId, target) {
  const { rows } = await conn.query(
    `SELECT a.id, a.scheduled_at, a.duration_min, a.practitioner_id,
            a.status::text AS status, c.name AS patient_name
       FROM dental_appointments a
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.company_id = $1
        AND a.practitioner_id IS NOT DISTINCT FROM $2::uuid
        AND a.status::text <> ALL($3::text[])
        AND a.scheduled_at <  $4::timestamptz + make_interval(mins => $5::int)
        AND a.scheduled_at >  $4::timestamptz - INTERVAL '1 day'
        AND ($6::uuid IS NULL OR a.id <> $6::uuid)`,
    [companyId, target.practitioner_id || null, NON_BLOCKING_STATUSES,
      target.scheduled_at, Number(target.duration_min), target.id || null]
  );
  return findConflicts(target, rows);
}

module.exports = {
  TRANSITIONS,
  DENTAL_APPOINTMENT_STATUSES,
  NON_BLOCKING_STATUSES,
  ACTIVE_STATUSES,
  ScheduleError,
  isKnownStatus,
  canTransition,
  assertTransition,
  timestampSetsFor,
  isValidTimestamp,
  isValidDuration,
  todayInSaoPaulo,
  isBirthDateInFuture,
  overlaps,
  findConflicts,
  queryConflicts,
};
