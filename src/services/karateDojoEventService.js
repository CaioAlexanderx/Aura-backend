// ============================================================
// AURA DOJÔ — F9: EVENTOS DO DOJÔ (curso + seminário) — lógica
//
//   "Precisamos ter a opção também de criar evento, para criar exames de
//    faixa (Kyu), cursos, seminários, etc. Podemos usar a estrutura
//    idêntica de criação de eventos que já temos na federação."
//
// O exame de kyu JÁ EXISTE (karate_dojo_belt_exams / karateDojoBeltExamService,
// migrations 264/265) e não é tocado aqui — ele tem regra de negócio própria
// (teto do sensei, ligação com karate_belt_history, cascata de certificado)
// que não se aplica a curso/seminário. Este service cobre só o modelo NOVO
// (karate_dojo_events / karate_dojo_event_enrollments, migration 268) e
// FAZ A PONTE com o exame de kyu numa única função: listEventsHub. A UNION
// mora aqui, em JS — não no banco.
//
// Campeonato do dojô é fase separada e NÃO entra neste arquivo. O
// discriminador `source` da listagem unificada existe justamente para uma
// terceira fonte poder entrar depois sem quebrar o contrato dos dois
// primeiros (ver cabeçalho da migration 268).
//
// ── ESCOPO SEMPRE PELO dojo_id DO TOKEN ─────────────────────
// Toda query é escopada por dojo_id vindo de req.dojoId (nunca do corpo/
// query) — mesmo padrão de karateDojoBeltExamService.js.
//
// ── ÂNCORAS DE MOCK ──────────────────────────────────────────
// Toda SQL deste arquivo começa com um comentário `-- f9:<nome>`. Os
// testes despacham por ELE (regex sobre o INÍCIO da query), nunca por
// posição na fila de mockResolvedValueOnce — fila posicional já derrubou
// o CI deste repo quatro vezes.
//
// ── TRANSAÇÃO ────────────────────────────────────────────────
// Nada aqui abre BEGIN. createEvent/updateEvent/cancelEvent são um único
// statement cada. enrollBatch é uma sequência de operações INDEPENDENTES
// por aluno (mesmo idioma de karateDojoFederativeService.enrollBatch): um
// aluno que já existe/já está inscrito não pode envenenar os demais, e o
// UNIQUE (event_id, student_id) é a rede de segurança contra corrida.
// ============================================================
'use strict';

const db = require('../config/database');

const MAX_ENROLL_BATCH = 200;
const MAX_LIST_PAGE = 200;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const EVENT_KINDS = ['curso', 'seminario'];
const EVENT_STATUSES = ['scheduled', 'completed', 'cancelled'];

function serviceError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.isServiceError = true;
  if (extra) Object.assign(e, extra);
  return e;
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN; // NaN sinaliza "veio, mas não é número"
}

// ============================================================
// Leituras
// ============================================================

async function loadEvent(dojoId, eventId) {
  if (!isUuid(eventId)) return null;
  const { rows } = await db.query(
    `-- f9:load-event
     SELECT id, dojo_id, federation_id, kind, name, event_date::text AS event_date,
            location, fee_amount, max_participants, hours, description, status,
            created_by, created_by_name, created_at, updated_at
       FROM karate_dojo_events
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [eventId, dojoId]
  );
  return (rows && rows[0]) || null;
}

function publicEvent(row, extra) {
  if (!row) return null;
  return Object.assign(
    {
      id: row.id,
      dojo_id: row.dojo_id,
      federation_id: row.federation_id || null,
      kind: row.kind,
      name: row.name,
      event_date: row.event_date || null,
      location: row.location || null,
      fee_amount: row.fee_amount != null ? Number(row.fee_amount) : null,
      max_participants: row.max_participants != null ? Number(row.max_participants) : null,
      hours: row.hours != null ? Number(row.hours) : null,
      description: row.description || null,
      status: row.status,
      created_by_name: row.created_by_name || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    extra || {}
  );
}

// ── createEvent ──────────────────────────────────────────────
async function createEvent({ dojoId, federationId, body, createdBy, createdByName }) {
  const b = body || {};
  const errors = [];

  const kind = trimOrNull(b.kind);
  if (!kind) errors.push('kind é obrigatório (curso | seminario)');
  else if (EVENT_KINDS.indexOf(kind) === -1) {
    errors.push(`kind inválido — use: ${EVENT_KINDS.join(', ')}`);
  }

  const name = trimOrNull(b.name);
  if (!name) errors.push('name é obrigatório');

  const eventDate = trimOrNull(b.event_date);
  if (!eventDate) errors.push('event_date é obrigatório (YYYY-MM-DD)');
  else if (!isValidDateStr(eventDate.slice(0, 10))) errors.push('event_date inválida (use YYYY-MM-DD)');

  const location = trimOrNull(b.location);
  const description = trimOrNull(b.description);

  const feeAmount = numOrNull(b.fee_amount);
  if (Number.isNaN(feeAmount)) errors.push('fee_amount inválido');
  else if (feeAmount != null && feeAmount < 0) errors.push('fee_amount não pode ser negativo');

  const maxParticipants = numOrNull(b.max_participants);
  if (Number.isNaN(maxParticipants)) errors.push('max_participants inválido');
  else if (maxParticipants != null && (!Number.isInteger(maxParticipants) || maxParticipants <= 0)) {
    errors.push('max_participants deve ser um inteiro maior que zero');
  }

  const hours = numOrNull(b.hours);
  if (Number.isNaN(hours)) errors.push('hours inválido');
  else if (hours != null && hours < 0) errors.push('hours não pode ser negativo');

  if (errors.length) throw serviceError(422, 'VALIDATION_ERROR', errors[0], { errors });

  const { rows } = await db.query(
    `-- f9:insert-event
     INSERT INTO karate_dojo_events
       (dojo_id, federation_id, kind, name, event_date, location,
        fee_amount, max_participants, hours, description, status,
        created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, 'scheduled', $11, $12)
     RETURNING id, dojo_id, federation_id, kind, name, event_date::text AS event_date,
               location, fee_amount, max_participants, hours, description, status,
               created_by_name, created_at, updated_at`,
    [
      dojoId,
      federationId || null,
      kind,
      name,
      eventDate.slice(0, 10),
      location,
      feeAmount,
      maxParticipants,
      hours,
      description,
      createdBy || null,
      createdByName || null,
    ]
  );
  return publicEvent(rows[0], { participants_count: 0 });
}

// ── updateEvent — bloqueado só quando CANCELADO ───────────────
// Diferente do exame de kyu (que trava em 'completed' porque a graduação
// já foi gravada em karate_belt_history), o curso/seminário não tem
// nenhuma escrita a jusante que a edição possa desalinhar — então
// 'completed' continua editável (ex.: corrigir local depois do fato).
// Só 'cancelled' é estado final: reabrir um evento cancelado é ato
// explícito (recriar), não um PATCH de campo.
async function updateEvent({ dojoId, eventId, body }) {
  const event = await loadEvent(dojoId, eventId);
  if (!event) throw serviceError(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado neste dojô');
  if (event.status === 'cancelled') {
    throw serviceError(409, 'EVENTO_CANCELADO', 'Este evento foi cancelado e não pode mais ser editado');
  }

  const b = body || {};
  const sets = [];
  const vals = [];
  const errors = [];

  if (b.kind !== undefined) {
    const v = trimOrNull(b.kind);
    if (!v || EVENT_KINDS.indexOf(v) === -1) errors.push(`kind inválido — use: ${EVENT_KINDS.join(', ')}`);
    else {
      vals.push(v);
      sets.push(`kind = $${vals.length}`);
    }
  }
  if (b.name !== undefined) {
    const v = trimOrNull(b.name);
    if (!v) errors.push('name não pode ficar vazio');
    else {
      vals.push(v);
      sets.push(`name = $${vals.length}`);
    }
  }
  if (b.event_date !== undefined) {
    const v = trimOrNull(b.event_date);
    if (!v || !isValidDateStr(v.slice(0, 10))) errors.push('event_date inválida (use YYYY-MM-DD)');
    else {
      vals.push(v.slice(0, 10));
      sets.push(`event_date = $${vals.length}::date`);
    }
  }
  for (const col of ['location', 'description']) {
    if (b[col] === undefined) continue;
    vals.push(trimOrNull(b[col]));
    sets.push(`${col} = $${vals.length}`);
  }
  if (b.fee_amount !== undefined) {
    const v = numOrNull(b.fee_amount);
    if (Number.isNaN(v)) errors.push('fee_amount inválido');
    else if (v != null && v < 0) errors.push('fee_amount não pode ser negativo');
    else {
      vals.push(v);
      sets.push(`fee_amount = $${vals.length}`);
    }
  }
  if (b.max_participants !== undefined) {
    const v = numOrNull(b.max_participants);
    if (Number.isNaN(v)) errors.push('max_participants inválido');
    else if (v != null && (!Number.isInteger(v) || v <= 0)) errors.push('max_participants deve ser um inteiro maior que zero');
    else {
      vals.push(v);
      sets.push(`max_participants = $${vals.length}`);
    }
  }
  if (b.hours !== undefined) {
    const v = numOrNull(b.hours);
    if (Number.isNaN(v)) errors.push('hours inválido');
    else if (v != null && v < 0) errors.push('hours não pode ser negativo');
    else {
      vals.push(v);
      sets.push(`hours = $${vals.length}`);
    }
  }
  // status só aceita 'completed' por aqui — 'cancelled' tem rota própria
  // (cancelEvent), a mesma separação de responsabilidade do exame de kyu
  // (PATCH edita dado; ação de estado é um endpoint dedicado).
  if (b.status !== undefined) {
    const v = trimOrNull(b.status);
    if (v !== 'scheduled' && v !== 'completed') {
      errors.push("status só pode ser 'scheduled' ou 'completed' por aqui — use .../cancel para cancelar");
    } else {
      vals.push(v);
      sets.push(`status = $${vals.length}`);
    }
  }

  if (errors.length) throw serviceError(422, 'VALIDATION_ERROR', errors[0], { errors });
  if (!sets.length) return getEvent({ dojoId, eventId });

  sets.push('updated_at = now()');
  vals.push(eventId, dojoId);
  await db.query(
    `-- f9:update-event
     UPDATE karate_dojo_events SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}`,
    vals
  );
  return getEvent({ dojoId, eventId });
}

// ── cancelEvent ────────────────────────────────────────────
async function cancelEvent({ dojoId, eventId }) {
  const event = await loadEvent(dojoId, eventId);
  if (!event) throw serviceError(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado neste dojô');
  if (event.status === 'cancelled') return getEvent({ dojoId, eventId }); // idempotente
  if (event.status === 'completed') {
    throw serviceError(
      409,
      'EVENTO_CONCLUIDO',
      'Este evento já foi concluído — cancelar não desfaz o que já aconteceu'
    );
  }
  await db.query(
    `-- f9:cancel-event
     UPDATE karate_dojo_events SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND dojo_id = $2`,
    [eventId, dojoId]
  );
  return getEvent({ dojoId, eventId });
}

// ── listEvents ─────────────────────────────────────────────
async function listEvents(dojoId, params) {
  const p = params || {};
  const kind = EVENT_KINDS.indexOf(p.kind) !== -1 ? p.kind : null;
  const status = EVENT_STATUSES.indexOf(p.status) !== -1 ? p.status : null;
  const page = Math.max(parseInt(p.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(p.pageSize, 10) || 50, 1), MAX_LIST_PAGE);

  const vals = [dojoId];
  let where = 'e.dojo_id = $1';
  if (kind) {
    vals.push(kind);
    where += ` AND e.kind = $${vals.length}`;
  }
  if (status) {
    vals.push(status);
    where += ` AND e.status = $${vals.length}`;
  }
  vals.push(pageSize, (page - 1) * pageSize);

  const { rows } = await db.query(
    `-- f9:list-events
     SELECT e.id, e.dojo_id, e.federation_id, e.kind, e.name,
            e.event_date::text AS event_date, e.location, e.fee_amount,
            e.max_participants, e.hours, e.description, e.status,
            e.created_by_name, e.created_at, e.updated_at,
            (SELECT count(*) FROM karate_dojo_event_enrollments en
              WHERE en.event_id = e.id AND en.status = 'enrolled')::int
              AS participants_count
       FROM karate_dojo_events e
      WHERE ${where}
      ORDER BY e.event_date DESC, e.created_at DESC
      LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );

  return {
    data: (rows || []).map((r) =>
      publicEvent(r, { participants_count: Number(r.participants_count) || 0 })
    ),
    page,
    pageSize,
  };
}

// ── getEvent — ficha do evento com as inscrições ────────────
async function getEvent({ dojoId, eventId }) {
  const event = await loadEvent(dojoId, eventId);
  if (!event) throw serviceError(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado neste dojô');

  const { rows } = await db.query(
    `-- f9:list-enrollments
     SELECT en.id, en.student_id, en.practitioner_id, en.status, en.fee_paid,
            en.notes, en.created_at,
            s.full_name AS student_name, s.belt_label AS belt_label
       FROM karate_dojo_event_enrollments en
       LEFT JOIN karate_dojo_students s ON s.id = en.student_id
      WHERE en.event_id = $1 AND en.dojo_id = $2
      ORDER BY s.full_name ASC NULLS LAST`,
    [eventId, dojoId]
  );

  const enrollments = (rows || []).map((r) => ({
    id: r.id,
    student_id: r.student_id,
    name: r.student_name || null,
    belt_label: r.belt_label || null,
    practitioner_id: r.practitioner_id || null,
    federated: Boolean(r.practitioner_id),
    status: r.status,
    fee_paid: r.fee_paid === true,
    notes: r.notes || null,
    created_at: r.created_at,
  }));

  return {
    event: publicEvent(event, {
      participants_count: enrollments.filter((e) => e.status === 'enrolled').length,
    }),
    enrollments,
  };
}

// ============================================================
// Inscrição em lote — mesmo idioma de karateDojoFederativeService.enrollBatch
// (SEM transação única: cada aluno é independente; o UNIQUE
// (event_id, student_id) é a rede de segurança contra corrida).
// ============================================================
async function enrollBatch({ dojoId, eventId, studentIds }) {
  const event = await loadEvent(dojoId, eventId);
  if (!event) throw serviceError(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado neste dojô');
  if (event.status === 'cancelled') {
    throw serviceError(409, 'EVENTO_CANCELADO', 'Este evento foi cancelado — não é possível inscrever alunos');
  }

  const ids = Array.isArray(studentIds) ? studentIds : [];
  if (!ids.length) throw serviceError(422, 'VALIDATION_ERROR', 'Informe student_ids: [uuid]');
  if (ids.length > MAX_ENROLL_BATCH) {
    throw serviceError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_ENROLL_BATCH} alunos por lote`);
  }

  const skipped = [];
  const valid = [];
  for (const raw of ids) {
    const sid = raw != null ? String(raw).trim() : '';
    if (!isUuid(sid)) {
      skipped.push({ student_id: raw || null, reason: 'ID_INVALIDO', message: 'student_id inválido' });
      continue;
    }
    if (!valid.includes(sid)) valid.push(sid); // o mesmo id 2x no corpo não vira 2 inscrições
  }

  const { rows: studentRows } = valid.length
    ? await db.query(
        `-- f9:load-students
         SELECT id, full_name, practitioner_id, status
           FROM karate_dojo_students
          WHERE dojo_id = $1 AND id = ANY($2::uuid[])`,
        [dojoId, valid]
      )
    : { rows: [] };
  const students = new Map(studentRows.map((r) => [r.id, r]));

  const enrolled = [];
  for (const sid of valid) {
    const student = students.get(sid);
    if (!student) {
      skipped.push({ student_id: sid, reason: 'ALUNO_NAO_ENCONTRADO', message: 'Aluno não encontrado neste dojô' });
      continue;
    }

    try {
      const { rows: dupRows } = await db.query(
        `-- f9:find-enrollment
         SELECT id, status FROM karate_dojo_event_enrollments
          WHERE event_id = $1 AND student_id = $2
          LIMIT 1`,
        [eventId, sid]
      );
      const existing = dupRows[0];

      if (existing && existing.status === 'enrolled') {
        skipped.push({
          student_id: sid,
          name: student.full_name,
          reason: 'JA_INSCRITO',
          message: 'Aluno já inscrito neste evento',
          enrollment_id: existing.id,
        });
        continue;
      }

      if (existing) {
        // Inscrição CANCELADA anteriormente: reativa a MESMA linha (o
        // UNIQUE é (event_id, student_id) — um segundo INSERT colidiria).
        await db.query(
          `-- f9:reactivate-enrollment
           UPDATE karate_dojo_event_enrollments
              SET status = 'enrolled', practitioner_id = $1, created_at = now()
            WHERE id = $2`,
          [student.practitioner_id || null, existing.id]
        );
        enrolled.push({
          student_id: sid,
          name: student.full_name,
          practitioner_id: student.practitioner_id || null,
          enrollment_id: existing.id,
        });
        continue;
      }

      const ins = await db.query(
        `-- f9:insert-enrollment
         INSERT INTO karate_dojo_event_enrollments
           (event_id, dojo_id, student_id, practitioner_id, status)
         VALUES ($1, $2, $3, $4, 'enrolled')
         RETURNING id`,
        [eventId, dojoId, sid, student.practitioner_id || null]
      );
      enrolled.push({
        student_id: sid,
        name: student.full_name,
        practitioner_id: student.practitioner_id || null,
        enrollment_id: ins.rows[0].id,
      });
    } catch (e) {
      // Corrida entre o SELECT de duplicata e o INSERT: o UNIQUE resolve.
      if (e && e.code === '23505') {
        skipped.push({ student_id: sid, name: student.full_name, reason: 'JA_INSCRITO', message: 'Aluno já inscrito neste evento' });
        continue;
      }
      throw e;
    }
  }

  return { enrolled: enrolled.length, enrollments: enrolled, event: publicEvent(event), skipped };
}

// ── listEnrollments ────────────────────────────────────────
async function listEnrollments({ dojoId, eventId }) {
  const out = await getEvent({ dojoId, eventId });
  return { event: out.event, data: out.enrollments };
}

// ── unenroll — cancela a inscrição (soft: preserva histórico) ─
async function unenroll({ dojoId, eventId, studentId }) {
  const event = await loadEvent(dojoId, eventId);
  if (!event) throw serviceError(404, 'EVENTO_NAO_ENCONTRADO', 'Evento não encontrado neste dojô');

  const { rows } = await db.query(
    `-- f9:cancel-enrollment
     UPDATE karate_dojo_event_enrollments
        SET status = 'cancelled'
      WHERE event_id = $1 AND dojo_id = $2 AND student_id = $3
      RETURNING id`,
    [eventId, dojoId, studentId]
  );
  if (!rows.length) {
    throw serviceError(404, 'INSCRICAO_NAO_ENCONTRADA', 'Inscrição não encontrada para este aluno neste evento');
  }
  return { cancelled: true };
}

// ============================================================
// A LISTAGEM UNIFICADA — eventos do dojô + exames de kyu
//
// A UNION mora AQUI, em JS: as duas fontes têm colunas diferentes (o
// exame de kyu não tem local/taxa/vagas; o evento do dojô não tem
// examinador). Fazer o merge em SQL exigiria uma view acoplando dois
// modelos que evoluem por razões diferentes — e o exame de kyu é
// propriedade de karateDojoBeltExamService, não deste arquivo.
//
// Contrato de saída (mesmo formato para as duas fontes, "dado faltante é
// neutro" — nunca omite o campo, devolve null quando a fonte não tem):
//   id, source ('dojo_event' | 'belt_exam'), kind, name, event_date,
//   location, status (normalizado: 'scheduled' | 'completed' | 'cancelled'),
//   native_status (o valor cru da tabela de origem), participants_count
//
// `source` é o discriminador que permite o front rotear para o endpoint de
// detalhe certo (/dojo/own-events/:id vs /dojo/graduation-exams/:id) e é
// também o que deixa espaço para uma TERCEIRA fonte (campeonato) entrar
// depois sem quebrar o contrato das duas primeiras.
// ============================================================
function normalizeExamStatus(status) {
  if (status === 'draft') return 'scheduled';
  return status; // 'completed' | 'cancelled' já batem com o vocabulário comum
}

async function listOwnEventsForHub(dojoId) {
  const { rows } = await db.query(
    `-- f9:hub-own-events
     SELECT e.id, e.kind, e.name, e.event_date::text AS event_date, e.location,
            e.status,
            (SELECT count(*) FROM karate_dojo_event_enrollments en
              WHERE en.event_id = e.id AND en.status = 'enrolled')::int
              AS participants_count
       FROM karate_dojo_events e
      WHERE e.dojo_id = $1
      ORDER BY e.event_date DESC
      LIMIT 300`,
    [dojoId]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    source: 'dojo_event',
    kind: r.kind,
    name: r.name,
    event_date: r.event_date,
    location: r.location || null,
    status: r.status,
    native_status: r.status,
    participants_count: Number(r.participants_count) || 0,
  }));
}

// Defensivo 42P01/42703: a migration 264 (karate_dojo_belt_exams) pode
// estar pendente de deploy em algum ambiente. Degrada para lista vazia
// dessa fonte — o hub NÃO cai por causa de uma migration de outra feature.
async function listBeltExamsForHub(dojoId) {
  try {
    const { rows } = await db.query(
      `-- f9:hub-belt-exams
       SELECT e.id, e.title, e.exam_date::text AS exam_date, e.status,
              (SELECT count(*) FROM karate_dojo_belt_exam_results r
                WHERE r.exam_id = e.id)::int AS participants_count
         FROM karate_dojo_belt_exams e
        WHERE e.dojo_id = $1
        ORDER BY e.exam_date DESC
        LIMIT 300`,
      [dojoId]
    );
    return (rows || []).map((r) => ({
      id: r.id,
      source: 'belt_exam',
      kind: 'exame_kyu',
      name: r.title || 'Exame de faixa',
      event_date: r.exam_date,
      location: null, // karate_dojo_belt_exams não tem coluna de local
      status: normalizeExamStatus(r.status),
      native_status: r.status,
      participants_count: Number(r.participants_count) || 0,
    }));
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return [];
    throw e;
  }
}

async function listEventsHub(dojoId, params) {
  const p = params || {};
  const page = Math.max(parseInt(p.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(p.pageSize, 10) || 50, 1), MAX_LIST_PAGE);

  const [ownEvents, beltExams] = await Promise.all([
    listOwnEventsForHub(dojoId),
    listBeltExamsForHub(dojoId),
  ]);

  let merged = ownEvents.concat(beltExams);
  if (p.kind) merged = merged.filter((m) => m.kind === p.kind);
  merged.sort((a, b) => (a.event_date < b.event_date ? 1 : a.event_date > b.event_date ? -1 : 0));

  const total = merged.length;
  const start = (page - 1) * pageSize;
  const data = merged.slice(start, start + pageSize);

  return { data, count: total, page, pageSize };
}

module.exports = {
  EVENT_KINDS,
  EVENT_STATUSES,
  MAX_ENROLL_BATCH,
  createEvent,
  updateEvent,
  cancelEvent,
  listEvents,
  getEvent,
  loadEvent,
  enrollBatch,
  listEnrollments,
  unenroll,
  listEventsHub,
};
