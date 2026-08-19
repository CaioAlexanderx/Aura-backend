// ============================================================
// AURA DOJÔ — F4: Service de turmas, matrículas e presença
// F9 (QR único do dojô): ver bloco "QR do dojô + check-in" no fim.
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
// SHA256, SEM expiração — é credencial de PRESENÇA (não de acesso).
// Verificação por comparação em tempo constante.
//
// F9 — DOIS formatos de token, MESMA assinatura/segredo (nenhum dos dois
// é adivinhável, ambos verificados por verifyQrToken):
//   • QR PESSOAL do aluno (F4, payload { s: student_id, d: dojo_id }) —
//     o de sempre. O dojô escaneia o QR do aluno (Canal A); a turma é
//     resolvida pelo weekday da data + start_time mais próxima da hora
//     atual quando há 2+ turmas no dia. ESTE CAMINHO NÃO MUDOU (F9
//     preserva 100% do comportamento validado em QA — nenhuma turma
//     nunca "some": sempre resolve para a mais próxima, sem janela).
//   • QR ÚNICO do dojô (F9, payload { d: dojo_id }, SEM 's') — um cartaz
//     só, impresso uma vez (GET /dojo/qr). Quem bipa esse token PRECISA
//     informar body.student_id (não há aluno embutido). A turma é
//     resolvida por JANELA DE TOLERÂNCIA ao redor do horário (ver
//     CHECKIN_WINDOW_*_MIN abaixo) — nenhuma turma na janela → 409
//     NO_CLASS_NOW (distinto de NOT_ENROLLED/NO_CLASS_TODAY); mais de
//     uma → 409 AMBIGUOUS_CLASS com as candidatas (o front pergunta ao
//     aluno/operador, o serviço NUNCA escolhe por adivinhação).
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

// ── F9 — janela de tolerância do check-in pelo QR único do dojô ──
// Escolha EXPLÍCITA (nada de número mágico espalhado pelo código): o
// aluno pode chegar ADIANTADO (comum — responsável deixa cedo antes de
// outro compromisso) ou ATRASADO / a aula ainda estar rolando (aulas de
// karatê costumam durar 60–90min). Se o dojô achar curto/longo demais
// pra realidade dele, é AQUI que se ajusta — não há outro lugar no
// código que decide "agora tem aula ou não".
//   30 min ANTES do horário de início da turma.
//   60 min DEPOIS do horário de início da turma.
// Turma SEM start_time cadastrado não tem janela pra violar — conta
// como sempre "na janela" (mesmo racional do fallback do F4: turma sem
// horário fica disponível, nunca bloqueia o check-in).
//
// LIMITE CONHECIDO E DELIBERADO — a janela é LINEAR DENTRO DE UMA DATA:
// NÃO cruza a meia-noite. `date` é resolvido primeiro (relógio BRT ou
// body.date), o weekday sai dessa data, e a janela compara minutos
// absolutos do dia (0..1439) sem aritmética circular. Consequência: uma
// turma de 00:00 é lida como 1430 min de distância de um check-in às
// 23:50 (não 10) → 409. E, antes disso, ela nem chega na janela: o
// filtro de weekday em classesEnrolledOnWeekday() já a descarta, porque
// a turma de 00:00 pertence ao weekday do dia SEGUINTE → 409
// NO_CLASS_TODAY. Ver tests/integration/karateDojoQrUnico.test.js.
//
// Por que NÃO foi consertado (19/08/2026): medido na base inteira —
// ZERO turmas com start_time em 23:xx ou 00:xx (a única turma cadastrada
// começa 18:00), e ZERO presenças method='qr_dojo' (o único caminho que
// usa esta janela). Consertar de verdade não é trocar por distância
// circular: exigiria enumerar OCORRÊNCIAS (turma + data em que ela cai,
// incluindo ontem/amanhã), gravar a presença na data da OCORRÊNCIA e não
// na do relógio — senão a presença cai num dia em que a turma não existe
// e a idempotência quebra (bipar 23:50 e 00:05 viraria 2 linhas) — e
// ainda mudar o contrato de `candidates` do 409 AMBIGUOUS_CLASS pra
// carregar `date` (o front teria que ecoar no reenvio). Backend + front
// pra um cenário com ZERO ocorrências.
//
// Em vez disso a porta é fechada no CADASTRO: validateClassPayload()
// recusa start_time na faixa em que a janela vazaria pra fora do dia
// (23:00–00:29, DERIVADA destas constantes — ver windowCrossesMidnight).
// Assim o estado quebrado deixa de ser alcançável, sem mexer em contrato
// nenhum. Se um dia um dojô real precisar de turma na virada, o caminho
// é o refactor de ocorrências acima — e aí a costura `opts.now` do
// checkin() permite testá-lo sem esperar a meia-noite.
// O comportamento atual fica FIXADO por teste em karateDojoQrUnico.
const CHECKIN_WINDOW_BEFORE_MIN = 30;
const CHECKIN_WINDOW_AFTER_MIN = 60;

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

// F9 — a turma está "na janela" do instante atual? Sem start_time
// cadastrado, não há janela pra violar (sempre true — mesmo fallback
// permissivo do F4 pra turma sem horário).
function inCheckinWindow(startMin, nowMin) {
  if (startMin == null) return true;
  return nowMin >= startMin - CHECKIN_WINDOW_BEFORE_MIN && nowMin <= startMin + CHECKIN_WINDOW_AFTER_MIN;
}

function minutesToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// A janela desta turma vazaria pra fora do dia dela? É a faixa em que o
// check-in por QR único fica quebrado (ver o bloco CHECKIN_WINDOW_* acima).
// DERIVADO das constantes, nunca hardcodado: se alguém afrouxar a janela
// pra 90/120 min, a faixa barrada acompanha sozinha.
const EARLIEST_SAFE_START_MIN = CHECKIN_WINDOW_BEFORE_MIN;            // 00:30
const LATEST_SAFE_START_MIN = 1439 - CHECKIN_WINDOW_AFTER_MIN;        // 22:59

function windowCrossesMidnight(startMin) {
  if (startMin == null) return false;
  return startMin < EARLIEST_SAFE_START_MIN || startMin > LATEST_SAFE_START_MIN;
}

// ── Token do QR (stateless, HMAC-SHA256) ──
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

// F9 — QR ÚNICO do dojô: MESMA assinatura, payload { d: dojo_id } SEM
// 's' (sem aluno embutido — um cartaz só, impresso uma vez). Quem bipa
// esse token informa o aluno explicitamente no corpo do check-in.
function signDojoQrToken({ dojo_id }) {
  const payload = { d: String(dojo_id) };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${qrSign(payloadB64)}`;
}

// Verifica assinatura em tempo constante. Retorna { student_id, dojo_id }
// (student_id é null quando o token é o QR ÚNICO do dojô — F9) ou null
// (ausente/adulterado/malformado) — nunca lança.
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
    // F9: payload sem 's' é válido (QR único do dojô); 'd' é sempre exigido.
    if (!payload || !payload.d) return null;
    return { student_id: payload.s ? String(payload.s) : null, dojo_id: String(payload.d) };
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

  // Turma na VIRADA DO DIA é barrada no cadastro. Só start_time importa —
  // end_time não entra na janela do check-in. A janela de tolerância é
  // linear dentro de uma data e não cruza a meia-noite (bloco
  // CHECKIN_WINDOW_* no topo); uma turma nessa faixa ficaria com o
  // check-in por QR único quebrado justamente na hora da aula. Em vez de
  // deixar cadastrar e falhar depois na cara do aluno, recusa aqui — a
  // faixa é estreita (23:00–00:29) e não existe turma real nela.
  if (data.start_time != null && windowCrossesMidnight(timeToMinutes(data.start_time))) {
    errors.push(
      `start_time deve estar entre ${minutesToHHMM(EARLIEST_SAFE_START_MIN)} e ${minutesToHHMM(LATEST_SAFE_START_MIN)} — ` +
      `turma que começa na virada do dia deixa o check-in por QR sem janela válida`
    );
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

// ── QR do aluno (F4) + QR do dojô (F9) ──
async function getStudentQrToken(dojoId, studentId) {
  const st = await db.query(
    `SELECT id FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [studentId, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  return { token: signQrToken({ student_id: studentId, dojo_id: dojoId }) };
}

// F9 — token ÚNICO do dojô (stateless: não consulta banco, é só a
// assinatura HMAC do dojo_id do próprio guard). O mesmo token de sempre
// pro mesmo dojô (não gira sozinho) — impresso uma vez, vale até o dojô
// pedir um novo cartaz (não há endpoint de "revogar"; troca de segredo
// global invalidaria todos os QRs, pessoais e único, igualmente).
function getDojoQrToken(dojoId) {
  return { token: signDojoQrToken({ dojo_id: dojoId }) };
}

// Busca as turmas ATIVAS em que o aluno está matriculado e filtra pelo
// weekday da data. UMA query (mesma posição de sempre); erros distinguem
// CADASTRO (NOT_ENROLLED: nenhuma matrícula) de AGENDA (NO_CLASS_TODAY:
// matriculado, mas nada nesse dia da semana). Compartilhada pelos dois
// formatos de QR — o aluno sem matrícula/sem aula hoje é o MESMO problema
// independente de qual cartaz foi bipado.
async function classesEnrolledOnWeekday(dojoId, studentId, weekday) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.start_time, c.end_time, c.weekdays
       FROM karate_dojo_classes c
       JOIN karate_dojo_class_enrollments e ON e.class_id = c.id AND e.student_id = $2
      WHERE c.dojo_id = $1 AND c.active = true`,
    [dojoId, studentId]
  );
  if (!rows.length) {
    throw svcError(409, 'NOT_ENROLLED', 'Aluno não está matriculado em nenhuma turma.');
  }
  const today = rows.filter((r) => Array.isArray(r.weekdays) && r.weekdays.map(Number).includes(weekday));
  if (!today.length) {
    throw svcError(409, 'NO_CLASS_TODAY', 'O aluno não tem turma matriculada para esta data');
  }
  return today;
}

// Turma explícita (class_id no corpo) — usado tanto pelo QR pessoal
// quanto pelo QR único (ex.: reenvio depois de um 409 AMBIGUOUS_CLASS,
// já com a turma escolhida). Só checa matrícula — não repete a janela
// de tolerância (quem mandou o class_id já resolveu a ambiguidade).
async function resolveExplicitClass(dojoId, studentId, classId) {
  const c = await db.query(
    `SELECT id, name FROM karate_dojo_classes WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [classId, dojoId]
  );
  if (!c.rows.length) throw svcError(404, 'CLASS_NOT_FOUND', 'Turma não encontrada neste dojô');
  const en = await db.query(
    `SELECT 1 FROM karate_dojo_class_enrollments WHERE class_id = $1 AND student_id = $2 LIMIT 1`,
    [classId, studentId]
  );
  if (!en.rows.length) throw svcError(409, 'NOT_ENROLLED', 'Aluno não está matriculado nesta turma');
  return c.rows[0];
}

// Resolve o aluno do token, valida o dojô e o toggle, escolhe a turma e
// marca present=true method='qr'|'qr_dojo'. Idempotente (repetir →
// already_checked).
//
// `opts.now` (Date) existe pra TESTE e só pra teste — a rota nunca passa,
// então em produção é sempre o relógio real. Sem essa costura o "agora" é
// o relógio do CI, e um teste de janela só consegue fabricar horário
// RELATIVO a ele (`agora ± 10`), que faz wrap em 1440 e quebra sozinho de
// madrugada — foi exatamente o flake do PR #525. Com o instante explícito,
// 23:50 é um caso de teste como outro qualquer, a qualquer hora do dia.
async function checkin(dojoId, body, opts = {}) {
  const b = body || {};
  const now = opts && opts.now instanceof Date ? opts.now : new Date();

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

  // F9 — payload.student_id ausente = QR ÚNICO do dojô: quem bipa precisa
  // informar o aluno explicitamente (não há aluno embutido no token).
  const isDojoQr = !payload.student_id;
  let studentId;
  if (isDojoQr) {
    studentId = b.student_id != null ? String(b.student_id).trim() : '';
    if (!studentId) {
      throw svcError(422, 'STUDENT_ID_REQUIRED', 'Informe o aluno para o check-in pelo QR único do dojô.');
    }
  } else {
    studentId = payload.student_id;
  }
  const method = isDojoQr ? 'qr_dojo' : 'qr';

  const st = await db.query(
    `SELECT id, full_name, belt_label FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
    [studentId, dojoId]
  );
  if (!st.rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno do QR não encontrado neste dojô');
  const student = st.rows[0];

  const date = b.date != null && String(b.date).trim() !== '' ? String(b.date).trim() : brtNow(now).dateStr;
  if (!isValidDateStr(date)) throw svcError(422, 'VALIDATION_ERROR', 'date deve estar no formato YYYY-MM-DD');

  let klass;
  const explicitClass = b.class_id != null && String(b.class_id).trim() !== '' ? String(b.class_id).trim() : null;

  if (explicitClass) {
    // Mesmo caminho pros dois formatos de QR — turma já escolhida (pelo
    // operador ou em resposta a um 409 AMBIGUOUS_CLASS anterior).
    klass = await resolveExplicitClass(dojoId, student.id, explicitClass);
  } else if (isDojoQr) {
    // F9 — QR único: resolve por JANELA DE TOLERANCIA (ver
    // CHECKIN_WINDOW_*_MIN no topo do arquivo). Nenhuma turma na janela →
    // erro distinto de "não matriculado"/"sem aula hoje". Mais de uma →
    // devolve as candidatas; o serviço NUNCA escolhe por adivinhação.
    const weekday = weekdayOf(date);
    const today = await classesEnrolledOnWeekday(dojoId, student.id, weekday);
    const nowMin = brtNow(now).minutes;
    const inWindow = today.filter((r) => inCheckinWindow(timeToMinutes(r.start_time), nowMin));

    if (!inWindow.length) {
      throw svcError(
        409,
        'NO_CLASS_NOW',
        `Não há aula agora (tolerância: ${CHECKIN_WINDOW_BEFORE_MIN} min antes e ${CHECKIN_WINDOW_AFTER_MIN} min depois do horário da turma).`
      );
    }
    if (inWindow.length > 1) {
      const err = svcError(409, 'AMBIGUOUS_CLASS', 'Mais de uma turma possível agora — escolha qual.');
      err.candidates = inWindow.map((r) => ({
        id: r.id,
        name: r.name,
        start_time: r.start_time || null,
        end_time: r.end_time || null,
      }));
      throw err;
    }
    klass = inWindow[0];
  } else {
    // QR PESSOAL do aluno (F4) — comportamento ORIGINAL preservado byte a
    // byte: turma do dia (weekday da data) em que o aluno está
    // matriculado; 2+ turmas no dia = a de start_time mais próxima da
    // hora atual (BRT); turma sem horário fica por último. SEM janela —
    // este caminho já foi validado em QA e não muda no F9.
    const weekday = weekdayOf(date);
    const today = await classesEnrolledOnWeekday(dojoId, student.id, weekday);
    if (today.length === 1) {
      klass = today[0];
    } else {
      const nowMin = brtNow(now).minutes;
      let best = null;
      let bestDist = Infinity;
      for (const r of today) {
        const tm = timeToMinutes(r.start_time);
        const dist = tm == null ? Infinity : Math.abs(tm - nowMin);
        if (dist < bestDist) { bestDist = dist; best = r; }
      }
      klass = best || today[0];
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
     VALUES ($1, $2, $3, $4::date, true, $5)
     ON CONFLICT (class_id, student_id, date)
     DO UPDATE SET present = true, method = $5`,
    [dojoId, klass.id, student.id, date, method]
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
  signDojoQrToken,
  verifyQrToken,
  // F9 — janela de tolerância (exportada pra testes não hardcodarem o
  // valor separadamente da fonte de verdade). inCheckinWindow vai junto
  // porque o teste de regressão da virada do dia precisa de um `nowMin`
  // explícito — pelo HTTP o "agora" é o relógio do CI, e o caso é
  // justamente 23:50 (ver o bloco CHECKIN_WINDOW_* no topo).
  CHECKIN_WINDOW_BEFORE_MIN,
  CHECKIN_WINDOW_AFTER_MIN,
  inCheckinWindow,
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
  getDojoQrToken,
  checkin,
}
