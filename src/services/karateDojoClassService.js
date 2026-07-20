// ============================================================
// AURA DOJÔ — F4: Service de turmas, matrículas e presença
//
// DECISÃO CENTRAL: o dojô organiza os alunos (karate_dojo_students, F2) em
// TURMAS com grade semanal (weekdays 0=domingo..6=sábado + horário). A
// matrícula (karate_dojo_class_enrollments) é o vínculo aluno↔turma; a
// PRESENÇA (karate_dojo_attendance, uma linha por turma+aluno+data) é o
// registro que futuramente alimenta os critérios de exame de faixa (F5) —
// por isso o resumo por aluno importa.
//
// CHAMADA MANUAL é o caminho PRIMÁRIO (a professora marca presente/ausente
// numa data). CHECK-IN POR QR é OPCIONAL, ligado por TOGGLE por dojô
// (karate_dojo_class_settings.qr_checkin_enabled, default OFF — nem toda
// academia exige). O token do QR é STATELESS: base64url(payload)+'.'+HMAC-
// SHA256, payload = student_id + dojo_id, SEM expiração — é credencial de
// PRESENÇA (não de acesso). Verificação por comparação em tempo constante.
//
// Regra da casa: dado faltante ≠ pendência (present null = não marcado, é
// neutro). DELETE de turma COM presenças → 409 HAS_HISTORY (preserva a
// trilha; sugere inativar). Remover matrícula NÃO apaga presenças.
//
// Datas são date-puras tz-safe: weekday é derivado da STRING 'YYYY-MM-DD'
// (via Date.UTC, sem conversão de fuso) e "hoje"/hora atual são calculados
// em America/Sao_Paulo (Intl) — NUNCA new Date('YYYY-MM-DD') (voltaria um
// dia em UTC-3). Leituras de date usam to_char(...,'YYYY-MM-DD').
// ============================================================
'use strict';

const crypto = require('crypto');
const db = require('../config/database');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();

// Segredo dedicado (opcional) com fallback pro JWT_SECRET global — mesmo
// padrão de karatePixPublicToken.js / OTP_SECRET. O token do QR é uma
// credencial de presença stateless (não um JWT de acesso).
const QR_SECRET = process.env.DOJO_QR_TOKEN_SECRET || env.JWT_SECRET;
const QR_CONTEXT = 'karate-dojo-qr-v1';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// ── Datas / horário (tz-safe) ──
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// weekday (0=domingo..6=sábado) derivado da STRING de data, sem fuso.
function weekdayOf(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// "Agora" em America/Sao_Paulo: { dateStr:'YYYY-MM-DD', minutes: 0..1439 }.
function brtNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  let hh = parseInt(p.hour, 10);
  if (!Number.isFinite(hh) || hh === 24) hh = 0; // alguns runtimes devolvem '24' à meia-noite
  const minutes = hh * 60 + parseInt(p.minute, 10);
  return { dateStr: `${p.year}-${p.month}-${p.day}`, minutes };
}

function timeToMinutes(t) {
  if (!t || !TIME_RE.test(String(t).slice(0, 5))) return null;
  const [h, mi] = String(t).slice(0, 5).split(':').map(Number);
  return h * 60 + mi;
}

// ── Token do QR (stateless, HMAC-SHA256; payload student_id+dojo_id) ──
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function qrSign(payloadB64) {
  return b64url(crypto.createHmac('sha256', QR_SECRET).update(`${QR_CONTEXT}:${payloadB64}`).digest());
}

// Formato compacto (bom pra QR): { s: student_id, d: dojo_id }. Sem
// expiração — é credencial de presença, revogável só trocando o segredo.
function signQrToken({ student_id, dojo_id }) {
  const payload = { s: String(student_id), d: String(dojo_id) };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${qrSign(payloadB64)}`;
}

// Verifica assinatura em tempo constante. Retorna { student_id, dojo_id }
// ou null (ausente/adulterado/malformado) — nunca lança.
function verifyQrToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sig] = parts;
    if (!payloadB64 || !sig) return null;
    const expected = qrSign(payloadB64);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    if (!payload || !payload.s || !payload.d) return null;
    return { student_id: String(payload.s), dojo_id: String(payload.d) };
  } catch (_) {
    return null;
  }
}

// ── Turmas ──
function shapeClass(r) {
  return {
    id: r.id,
    name: r.name,
    weekdays: Array.isArray(r.weekdays) ? r.weekdays.map(Number) : [],
    start_time: r.start_time || null,
    end_time: r.end_time || null,
    modality: r.modality || null,
    active: r.active !== false,
    students_count: r.students_count != null ? Number(r.students_count) : 0,
  };
}

function validateClassPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.name !== undefined) {
    const name = b.name != null ? String(b.name).trim() : '';
    if (!name) errors.push('Campo name é obrigatório');
    else data.name = name;
  }

  if (b.weekdays !== undefined) {
    if (!Array.isArray(b.weekdays)) {
      errors.push('weekdays deve ser um array de inteiros entre 0 (domingo) e 6 (sábado)');
    } else {
      const wd = [];
      let bad = false;
      for (const w of b.weekdays) {
        const n = Number(w);
        if (!Number.isInteger(n) || n < 0 || n > 6) { bad = true; break; }
        if (!wd.includes(n)) wd.push(n);
      }
      if (bad) errors.push('weekdays deve conter apenas inteiros entre 0 (domingo) e 6 (sábado)');
      else { wd.sort((x, y) => x - y); data.weekdays = wd; }
    }
  }

  for (const f of ['start_time', 'end_time']) {
    if (b[f] === undefined) continue;
    if (b[f] === null || String(b[f]).trim() === '') { data[f] = null; }
    else {
      const v = String(b[f]).trim();
      if (!TIME_RE.test(v)) errors.push(`${f} deve estar no formato HH:MM`);
      else data[f] = v;
    }
  }

  if (b.modality !== undefined) {
    data.modality = b.modality != null && String(b.modality).trim() !== '' ? String(b.modality).trim() : null;
  }

  if (partial && b.active !== undefined) {
    data.active = b.active === true || b.active === 'true';
  }

  return { errors, data };
}

const CLASS_COLS = 'c.id, c.name, c.weekdays, c.start_time, c.end_time, c.modality, c.active';

async function listClasses(dojoId) {
  const { rows } = await db.query(
    `SELECT ${CLASS_COLS}, count(e.id)::int AS students_count
       FROM karate_dojo_classes c
       LEFT JOIN karate_dojo_class_enrollments e ON e.class_id = c.id
      WHERE c.dojo_id = $1
      GROUP BY c.id
      ORDER BY c.name ASC
      LIMIT 500`,
    [dojoId]
  );
  return rows.map(shapeClass);
}

async function getClass(dojoId, classId) {
  const { rows } = await db.query(
    `SELECT ${CLASS_COLS}, count(e.id)::int AS students_count
       FROM karate_dojo_classes c
       LEFT JOIN karate_dojo_class_enrollments e ON e.class_id = c.id
      WHERE c.id = $1 AND c.dojo_id = $2
      GROUP BY c.id
      LIMIT 1`,
    [classId, dojoId]
  );
  return rows.length ? shapeClass(rows[0]) : null;
}

async function createClass(dojoId, data) {
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_classes (dojo_id, name, weekdays, start_time, end_time, modality)
     VALUES ($1, $2, COALESCE($3::int[], '{}'::int[]), $4, $5, $6)
     RETURNING id, name, weekdays, start_time, end_time, modality, active`,
    [
      dojoId,
      data.name,
      data.weekdays !== undefined ? data.weekdays : null,
      data.start_time !== undefined ? data.start_time : null,
      data.end_time !== undefined ? data.end_time : null,
      data.modality !== undefined ? data.modality : null,
    ]
  );
  const c = shapeClass(rows[0]);
  c.students_count = 0;
  return c;
}

const CLASS_UPDATABLE = ['name', 'weekdays', 'start_time', 'end_time', 'modality', 'active'];

async function updateClass(dojoId, classId, data) {
  const sets = [];
  const vals = [];
  for (const col of CLASS_UPDATABLE) {
    if (data[col] === undefined) continue;
    vals.push(data[col]);
    sets.push(col === 'weekdays' ? `weekdays = $${vals.length}::int[]` : `${col} = $${vals.length}`);
  }
  if (!sets.length) {
    const cur = await getClass(dojoId, classId);
    if (!cur) throw svcError(404, 'NOT_FOUND', 'Turma não encontrada neste dojô');
    return cur;
  }
  sets.push('updated_at = now()');
  vals.push(classId, dojoId);
  const upd = await db.query(
    `UPDATE karate_dojo_classes SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
      RETURNING id`,
    vals
  );
  if (!upd.rows.length) throw svcError(404, 'NOT_FOUND', 'Turma não encontrada neste dojô');
  return getClass(dojoId, classId);
}

async function deleteClass(dojoId, classId) {
  const ex = await db.query(
    `SELECT id FROM karate_dojo_classes WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [classId, dojoId]
  );
  if (!ex.rows.length) throw svcError(404, 'NOT_FOUND', 'Turma não encontrada neste dojô');

  // Turma COM presenças registradas nunca é apagada (preserva a trilha que
  // alimenta os critérios de exame — F5). Sugere inativar.
  const hist = await db.query(
    `SELECT 1 FROM karate_dojo_attendance WHERE class_id = $1 AND dojo_id = $2 LIMIT 1`,
    [classId, dojoId]
  );
  if (hist.rows.length) {
    throw svcError(409, 'HAS_HISTORY', 'Turma com presenças registradas não pode ser excluída. Inative-a para preservar o histórico.');
  }

  // Sem histórico: delete real (cascade nas matrículas via FK).
  await db.query(`DELETE FROM karate_dojo_classes WHERE id = $1 AND dojo_id = $2`, [classId, dojoId]);
  return { deleted: true, id: classId };
}

// ── Matrículas ──
async function assertClass(dojoId, classId) {
  const { rows } = await db.query(
    `SELECT id, name FROM karate_dojo_classes WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [classId, dojoId]
  );
  if (!rows.length) throw svcError(404, 'CLASS_NOT_FOUND', 'Turma não encontrada neste dojô');
  return rows[0];
}

async function listClassStudents(dojoId, classId) {
  await assertClass(dojoId, classId);
  const { rows } = await db.query(
    `SELECT s.id AS student_id, s.full_name, s.belt_label, s.status,
            to_char(e.enrolled_at, 'YYYY-MM-DD') AS enrolled_at
       FROM karate_dojo_class_enrollments e
       JOIN karate_dojo_students s ON s.id = e.student_id
      WHERE e.class_id = $1 AND e.dojo_id = $2
      ORDER BY s.full_name ASC
      LIMIT 2000`,
    [classId, dojoId]
  );
  return rows.map((r) => ({
    student_id: r.student_id,
    full_name: r.full_name,
    belt_label: r.belt_label || null,
    status: r.status,
    enrolled_at: r.enrolled_at || null,
  }));
}

async function enrollStudent(dojoId, classId, studentId) {
  await assertClass(dojoId, classId);
  const st = await db.query(
    `SELECT id, status FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [studentId, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'STUDENT_NOT_FOUND', 'Aluno não encontrado neste dojô');
  if (st.rows[0].status !== 'active') {
    throw svcError(422, 'STUDENT_INACTIVE', 'Aluno inativo não pode ser matriculado em turma');
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO karate_dojo_class_enrollments (dojo_id, class_id, student_id)
       VALUES ($1, $2, $3)
       RETURNING class_id, student_id, to_char(enrolled_at, 'YYYY-MM-DD') AS enrolled_at`,
      [dojoId, classId, studentId]
    );
    const r = rows[0];
    return { enrolled: true, class_id: r.class_id, student_id: r.student_id, enrolled_at: r.enrolled_at };
  } catch (e) {
    if (e && e.code === '23505') {
      throw svcError(409, 'ALREADY_ENROLLED', 'Aluno já matriculado nesta turma');
    }
    throw e;
  }
}

async function unenrollStudent(dojoId, classId, studentId) {
  // Remove a matrícula. As PRESENÇAS ficam (histórico preservado).
  const del = await db.query(
    `DELETE FROM karate_dojo_class_enrollments
      WHERE class_id = $1 AND student_id = $2 AND dojo_id = $3
      RETURNING id`,
    [classId, studentId, dojoId]
  );
  if (!del.rows.length) throw svcError(404, 'NOT_FOUND', 'Matrícula não encontrada nesta turma');
  return { removed: true, class_id: classId, student_id: studentId };
}

// ── Presença ──
async function getAttendance(dojoId, classId, dateArg) {
  await assertClass(dojoId, classId);
  const date = dateArg != null && String(dateArg).trim() !== '' ? String(dateArg).trim() : brtNow().dateStr;
  if (!isValidDateStr(date)) throw svcError(422, 'VALIDATION_ERROR', 'date deve estar no formato YYYY-MM-DD');

  const { rows } = await db.query(
    `SELECT s.id AS student_id, s.full_name, s.belt_label, a.present, a.method
       FROM karate_dojo_class_enrollments e
       JOIN karate_dojo_students s ON s.id = e.student_id
       LEFT JOIN karate_dojo_attendance a
              ON a.class_id = e.class_id AND a.student_id = e.student_id AND a.date = $3::date
      WHERE e.class_id = $1 AND e.dojo_id = $2
      ORDER BY s.full_name ASC
      LIMIT 2000`,
    [classId, dojoId, date]
  );
  return {
    date,
    data: rows.map((r) => ({
      student_id: r.student_id,
      full_name: r.full_name,
      belt_label: r.belt_label || null,
      present: r.present === null || r.present === undefined ? null : r.present === true,
      method: r.method || null,
    })),
  };
}

// Upsert em lote (chamada manual). Statement ÚNICO com unnest (atômico, sem
// BEGIN → sem tx-poison). Só grava presença de quem está MATRICULADO na
// turma (JOIN em enrollments); re-salvar sobrescreve (ON CONFLICT DO UPDATE,
// method fixado em 'manual'). saved = linhas efetivamente gravadas.
async function putAttendance(dojoId, classId, dateArg, records) {
  await assertClass(dojoId, classId);
  const date = dateArg != null && String(dateArg).trim() !== '' ? String(dateArg).trim() : null;
  if (!isValidDateStr(date)) throw svcError(422, 'VALIDATION_ERROR', 'date deve estar no formato YYYY-MM-DD');
  if (!Array.isArray(records)) {
    throw svcError(422, 'VALIDATION_ERROR', 'records deve ser um array de { student_id, present }');
  }
  if (!records.length) return { saved: 0 };

  const ids = [];
  const presents = [];
  for (const rec of records) {
    const r = rec || {};
    const sid = r.student_id != null ? String(r.student_id).trim() : '';
    if (!sid) continue;
    ids.push(sid);
    presents.push(r.present === true || r.present === 'true');
  }
  if (!ids.length) return { saved: 0 };

  const { rows } = await db.query(
    `INSERT INTO karate_dojo_attendance (dojo_id, class_id, student_id, date, present, method)
     SELECT $1, $2, e.student_id, $3::date, v.present, 'manual'
       FROM unnest($4::uuid[], $5::boolean[]) AS v(student_id, present)
       JOIN karate_dojo_class_enrollments e
         ON e.class_id = $2 AND e.dojo_id = $1 AND e.student_id = v.student_id
     ON CONFLICT (class_id, student_id, date)
     DO UPDATE SET present = EXCLUDED.present, method = 'manual'
     RETURNING id`,
    [dojoId, classId, date, ids, presents]
  );
  return { saved: rows.length };
}

// ── Resumo de presença por aluno (alimenta critérios de exame — F5) ──
async function getAttendanceSummary(dojoId, studentId) {
  const st = await db.query(
    `SELECT id FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [studentId, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');

  const today = brtNow().dateStr;

  const totals = await db.query(
    `SELECT
       count(*) FILTER (WHERE present)::int AS total_present,
       count(*) FILTER (WHERE present AND date >= $3::date - 30)::int AS present_30d,
       count(*) FILTER (WHERE present AND date >= $3::date - 90)::int AS present_90d
       FROM karate_dojo_attendance
      WHERE dojo_id = $1 AND student_id = $2`,
    [dojoId, studentId, today]
  );

  const byClass = await db.query(
    `SELECT c.id AS class_id, c.name AS class_name,
            count(*)::int AS present_count,
            to_char(max(a.date), 'YYYY-MM-DD') AS last_present_date
       FROM karate_dojo_attendance a
       JOIN karate_dojo_classes c ON c.id = a.class_id
      WHERE a.dojo_id = $1 AND a.student_id = $2 AND a.present
      GROUP BY c.id, c.name
      ORDER BY present_count DESC, c.name ASC`,
    [dojoId, studentId]
  );

  const recent = await db.query(
    `SELECT to_char(a.date, 'YYYY-MM-DD') AS date, c.name AS class_name, a.present, a.method
       FROM karate_dojo_attendance a
       JOIN karate_dojo_classes c ON c.id = a.class_id
      WHERE a.dojo_id = $1 AND a.student_id = $2
      ORDER BY a.date DESC, a.created_at DESC
      LIMIT 15`,
    [dojoId, studentId]
  );

  const t = totals.rows[0] || {};
  return {
    total_present: Number(t.total_present) || 0,
    present_30d: Number(t.present_30d) || 0,
    present_90d: Number(t.present_90d) || 0,
    by_class: byClass.rows.map((r) => ({
      class_id: r.class_id,
      class_name: r.class_name,
      present_count: Number(r.present_count) || 0,
      last_present_date: r.last_present_date || null,
    })),
    recent: recent.rows.map((r) => ({
      date: r.date,
      class_name: r.class_name,
      present: r.present === true,
      method: r.method || null,
    })),
  };
}

// ── Toggle do check-in por QR (settings por dojô) ──
async function getSettings(dojoId) {
  const { rows } = await db.query(
    `SELECT qr_checkin_enabled FROM karate_dojo_class_settings WHERE dojo_id = $1 LIMIT 1`,
    [dojoId]
  );
  return { qr_checkin_enabled: rows.length ? rows[0].qr_checkin_enabled === true : false };
}

async function putSettings(dojoId, body) {
  const b = body || {};
  const enabled = b.qr_checkin_enabled === true || b.qr_checkin_enabled === 'true';
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_class_settings (dojo_id, qr_checkin_enabled, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (dojo_id) DO UPDATE SET qr_checkin_enabled = EXCLUDED.qr_checkin_enabled, updated_at = now()
     RETURNING qr_checkin_enabled`,
    [dojoId, enabled]
  );
  return { qr_checkin_enabled: rows[0].qr_checkin_enabled === true };
}

// ── QR do aluno + check-in ──
async function getStudentQrToken(dojoId, studentId) {
  const st = await db.query(
    `SELECT id FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [studentId, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  return { token: signQrToken({ student_id: studentId, dojo_id: dojoId }) };
}

// Resolve o aluno do token, valida o dojô e o toggle, escolhe a turma e
// marca present=true method='qr'. Idempotente (repetir → already_checked).
async function checkin(dojoId, body) {
  const b = body || {};

  const payload = verifyQrToken(b.token);
  if (!payload) throw svcError(422, 'INVALID_TOKEN', 'QR de check-in inválido');
  // O QR é escopado ao dojô — um QR de outro dojô nunca marca presença aqui.
  if (payload.dojo_id !== String(dojoId)) {
    throw svcError(403, 'DOJO_MISMATCH', 'Este QR pertence a outro dojô');
  }

  const settings = await getSettings(dojoId);
  if (!settings.qr_checkin_enabled) {
    throw svcError(409, 'QR_DESABILITADO', 'O check-in por QR está desativado neste dojô');
  }

  const st = await db.query(
    `SELECT id, full_name, belt_label FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [payload.student_id, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno do QR não encontrado neste dojô');
  const student = st.rows[0];

  const date = b.date != null && String(b.date).trim() !== '' ? String(b.date).trim() : brtNow().dateStr;
  if (!isValidDateStr(date)) throw svcError(422, 'VALIDATION_ERROR', 'date deve estar no formato YYYY-MM-DD');

  let klass;
  const explicitClass = b.class_id != null && String(b.class_id).trim() !== '' ? String(b.class_id).trim() : null;
  if (explicitClass) {
    const c = await db.query(
      `SELECT id, name FROM karate_dojo_classes WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [explicitClass, dojoId]
    );
    if (!c.rows.length) throw svcError(404, 'CLASS_NOT_FOUND', 'Turma não encontrada neste dojô');
    const en = await db.query(
      `SELECT 1 FROM karate_dojo_class_enrollments WHERE class_id = $1 AND student_id = $2 LIMIT 1`,
      [explicitClass, student.id]
    );
    if (!en.rows.length) throw svcError(409, 'NOT_ENROLLED', 'Aluno não está matriculado nesta turma');
    klass = c.rows[0];
  } else {
    // Sem class_id: turma do DIA (weekday da data) em que o aluno está
    // matriculado. Se houver 2+, a com start_time mais próxima da hora atual
    // (BRT); turma sem horário fica por último. Nenhuma → 409 NO_CLASS_TODAY.
    const weekday = weekdayOf(date);
    const cand = await db.query(
      `SELECT c.id, c.name, c.start_time
         FROM karate_dojo_classes c
         JOIN karate_dojo_class_enrollments e ON e.class_id = c.id AND e.student_id = $2
        WHERE c.dojo_id = $1 AND c.active = true AND $3 = ANY(c.weekdays)`,
      [dojoId, student.id, weekday]
    );
    if (!cand.rows.length) {
      throw svcError(409, 'NO_CLASS_TODAY', 'O aluno não tem turma matriculada para esta data');
    }
    if (cand.rows.length === 1) {
      klass = cand.rows[0];
    } else {
      const nowMin = brtNow().minutes;
      let best = null;
      let bestDist = Infinity;
      for (const r of cand.rows) {
        const tm = timeToMinutes(r.start_time);
        const dist = tm == null ? Infinity : Math.abs(tm - nowMin);
        if (dist < bestDist) { bestDist = dist; best = r; }
      }
      klass = best || cand.rows[0];
    }
  }

  // already_checked reflete o estado ANTES deste check-in (presente=true).
  const existing = await db.query(
    `SELECT present FROM karate_dojo_attendance
      WHERE class_id = $1 AND student_id = $2 AND date = $3::date LIMIT 1`,
    [klass.id, student.id, date]
  );
  const already = existing.rows.length > 0 && existing.rows[0].present === true;

  await db.query(
    `INSERT INTO karate_dojo_attendance (dojo_id, class_id, student_id, date, present, method)
     VALUES ($1, $2, $3, $4::date, true, 'qr')
     ON CONFLICT (class_id, student_id, date)
     DO UPDATE SET present = true, method = 'qr'`,
    [dojoId, klass.id, student.id, date]
  );

  return {
    student: { id: student.id, full_name: student.full_name, belt_label: student.belt_label || null },
    class: { id: klass.id, name: klass.name },
    date,
    already_checked: already,
  };
}

module.exports = {
  // token (exportado p/ o front/testes gerarem/validarem)
  signQrToken,
  verifyQrToken,
  // turmas
  validateClassPayload,
  listClasses,
  getClass,
  createClass,
  updateClass,
  deleteClass,
  // matrículas
  listClassStudents,
  enrollStudent,
  unenrollStudent,
  // presença
  getAttendance,
  putAttendance,
  getAttendanceSummary,
  // QR / settings
  getSettings,
  putSettings,
  getStudentQrToken,
  checkin,
}
