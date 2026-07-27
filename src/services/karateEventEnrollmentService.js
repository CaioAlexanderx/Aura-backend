// ============================================================
// AURA KARATÊ — Inscrição em evento da FEDERAÇÃO (ponto compartilhado)
//
// POR QUE ESTE ARQUIVO EXISTE (F5b, 26/07/2026)
// Até aqui, inscrever alguém num evento da federação existia em DOIS
// lugares inline, nenhum reaproveitável:
//   1. src/routes/karatePublic.js  — POST /public/karate/:slug/inscricao/:eventId
//      (inscrição pública, 1 CPF por vez, com criação de convidado, lotes de
//       preço, PIX e e-mail grudados no mesmo handler)
//   2. src/routes/karateExams.js   — POST /federation/:id/belt-exams/:examId/candidates
//      (lado FEDERAÇÃO, guards.staffWrite, 1 aluno por vez, com target_belt)
//
// A F5b precisa do MESMO ato pelo lado do DOJÔ e em LOTE. Duplicar a regra
// pela terceira vez seria garantir divergência; então ela sai para cá.
//
// ⚠️ SQL PRESERVADA BYTE A BYTE do caminho público (lição do PR #425): a
// resolução do evento, o SELECT de duplicata e os dois INSERTs são os
// MESMOS strings de karatePublic.js. Testes que casam por SQL continuam
// casando; mock posicional continua alinhado (mesma ordem de queries).
//
// ── MODELO DE EVENTO (3 tabelas, discriminador `kind`) ──────
//   kind='exam'        → karate_belt_exams (migr 157/192/200/212)
//                        cobre EXAME de faixa E CURSO (exam_type='curso').
//                        Inscrição em karate_belt_exam_candidates,
//                        UNIQUE (exam_id, student_id).
//   kind='course'      → karate_events (migr 160) — caminho LEGADO de curso.
//                        Inscrição em karate_event_enrollments,
//                        UNIQUE (event_id, student_id).
//   kind='competition' → karate_competitions (migr 168/169). Inscrição exige
//                        category_id POR ATLETA — não existe "inscrever o
//                        dojô inteiro" sem escolher categoria de cada um.
//                        Este service NÃO inscreve em competição de propósito;
//                        o caller devolve COMPETICAO_NAO_SUPORTADA.
//
// ── TX-POISON ───────────────────────────────────────────────
// O INSERT otimista com registration_responses (migration 200) tem um
// fallback em 42703. Dentro de um BEGIN, um try/catch nu ali ENVENENA a
// transação (armadilha_tx_poison_best_effort_savepoint): o catch roda com a
// tx já abortada e o INSERT de fallback morre em 25P02.
// Por isso: quem chama de dentro de uma transação passa opts.savepoint e o
// service emite SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE SAVEPOINT.
// Fora de transação (o caso do lote do dojô) nada disso é emitido.
// ============================================================
'use strict';

const db = require('../config/database');

// Migration 200 — registration_fields (karate_belt_exams) /
// registration_responses (karate_belt_exam_candidates + karate_event_enrollments).
// Cache module-level OTIMISTA (armadilha_schema_pre_migration): começa true e
// vira false no primeiro 42703. Sem cadeia infinita de retry — UMA degradação.
let HAS_REGISTRATION_FIELDS_COL = true;
let HAS_REGISTRATION_RESPONSES_COL = true;

// Mesmo teste de karatePublic.resolveEvent: evita 22P02 ao passar um path
// que não é UUID para uma coluna uuid.
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

// Status em que NENHUM evento aceita inscrição nova (mesma lista do
// caminho público). 'cancelled' não existe no CHECK do banco, mas está aqui
// pelo mesmo motivo que lá: defensivo barato.
const CLOSED_EVENT_STATUSES = ['done', 'cancelled', 'closed'];

// O caller pode passar um client de transação OU nada (usa o pool).
function runnerOf(runner) {
  return runner && typeof runner.query === 'function' ? runner : db;
}

function isEventClosed(ev) {
  return !ev || CLOSED_EVENT_STATUSES.includes(ev.status);
}

// Nome de SAVEPOINT nunca vem de input do usuário; ainda assim sanitizamos —
// SAVEPOINT não aceita bind parameter, o nome entra concatenado.
function safeSavepointName(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  return s || 'sp_enroll';
}

// ── resolveFederationEvent ──────────────────────────────────
// Mesmas 3 queries (e mesmos strings) de karatePublic.resolveEvent.
// Devolve a row do evento + `kind`, ou null se não existir na federação.
async function resolveFederationEvent(federationId, eventId, runner) {
  const r = runnerOf(runner);
  if (!eventId || !UUID_RE.test(String(eventId))) return null;

  if (HAS_REGISTRATION_FIELDS_COL) {
    try {
      const ex = await r.query(
        `SELECT id, name, exam_type, event_date, location, fee_amount, max_candidates, status,
                hours, registration_fields, description, 'exam' AS kind
         FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
        [eventId, federationId]
      );
      if (ex.rows.length) return ex.rows[0];
    } catch (e) {
      if (e.code === '42703') {
        HAS_REGISTRATION_FIELDS_COL = false;
        console.warn('[karateEventEnrollment] registration_fields ausente (migration 200 pendente)');
      } else if (e.code === '42P01') {
        // Sem a tabela de exames não há evento nenhum para resolver.
        console.warn('[karateEventEnrollment] karate_belt_exams ausente (schema pendente)');
        throw e;
      } else throw e;
    }
  }
  if (!HAS_REGISTRATION_FIELDS_COL) {
    const ex = await r.query(
      `SELECT id, name, exam_type, event_date, location, fee_amount, max_candidates, status, hours, description, 'exam' AS kind
       FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [eventId, federationId]
    );
    if (ex.rows.length) return ex.rows[0];
  }

  // Curso LEGADO. karatePublic não protege esta query; aqui protegemos
  // porque o fluxo do dojô precisa degradar, não estourar 500.
  try {
    const co = await r.query(
      `SELECT id, name, event_type, event_date, location, fee_amount, status, 'course' AS kind
       FROM karate_events WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [eventId, federationId]
    );
    if (co.rows.length) return co.rows[0];
  } catch (e) {
    if (e.code !== '42P01') throw e;
    console.warn('[karateEventEnrollment] karate_events ausente (deployment parcial)');
  }

  try {
    const comp = await r.query(
      `SELECT id, name, event_date, location, fee_amount, status, 'competition' AS kind
       FROM karate_competitions WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [eventId, federationId]
    );
    if (comp.rows.length) return comp.rows[0];
  } catch (e) {
    if (e.code !== '42P01') throw e;
    console.warn('[karateEventEnrollment] karate_competitions ausente (deployment parcial)');
  }

  return null;
}

// ── EXAME / CURSO canônico (karate_belt_exams) ──────────────

// SELECT de duplicata — string idêntica à do caminho público.
async function findExamCandidate(runner, examId, studentId) {
  const r = runnerOf(runner);
  const dup = await r.query(
    `SELECT id, status FROM karate_belt_exam_candidates WHERE exam_id = $1 AND student_id = $2 LIMIT 1`,
    [examId, studentId]
  );
  return dup.rows[0] || null;
}

// INSERT do candidato. `target_belt` NÃO é gravado de propósito: a decisão
// de 08/06 (mesma do caminho público) é que a BANCA define a faixa depois —
// o dojô submete a pessoa, não a graduação. A coluna é nullable em produção.
//
// opts: { responsesJson?: string|null, savepoint?: string }
//   savepoint SÓ quando o caller está dentro de um BEGIN (ver topo).
async function insertExamCandidate(runner, examId, studentId, opts) {
  const r = runnerOf(runner);
  const { responsesJson = null, savepoint = null } = opts || {};
  const sp = savepoint ? safeSavepointName(savepoint) : null;

  let ins;
  if (responsesJson != null && HAS_REGISTRATION_RESPONSES_COL) {
    if (sp) await r.query(`SAVEPOINT ${sp}`);
    try {
      ins = await r.query(
        `INSERT INTO karate_belt_exam_candidates
           (exam_id, student_id, status, fee_paid, registration_responses, created_at, updated_at)
         VALUES ($1,$2,'registered', false, $3::jsonb, NOW(), NOW())
         RETURNING id`,
        [examId, studentId, responsesJson]
      );
      if (sp) await r.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      if (e.code === '42703') {
        if (sp) await r.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        HAS_REGISTRATION_RESPONSES_COL = false;
        console.warn('[karateEventEnrollment] registration_responses ausente no INSERT candidate (migration 200 pendente)');
      } else {
        // 23505 e afins sobem para o caller decidir (JA_INSCRITO no lote).
        throw e;
      }
    }
  }
  if (!ins) {
    ins = await r.query(
      `INSERT INTO karate_belt_exam_candidates (exam_id, student_id, status, fee_paid, created_at, updated_at)
       VALUES ($1,$2,'registered', false, NOW(), NOW())
       RETURNING id`,
      [examId, studentId]
    );
  }
  return ins.rows[0];
}

// ── CURSO LEGADO (karate_events) ────────────────────────────

async function findCourseEnrollment(runner, eventId, studentId) {
  const r = runnerOf(runner);
  const dup = await r.query(
    `SELECT id FROM karate_event_enrollments WHERE event_id = $1 AND student_id = $2 LIMIT 1`,
    [eventId, studentId]
  );
  return dup.rows[0] || null;
}

// karate_event_enrollments TEM dojo_id (migration 160) — copiado no INSERT,
// como já fazem competições e certificados. Congela o dojô no momento da
// inscrição: transferir o praticante depois não muda quem o inscreveu.
async function insertCourseEnrollment(runner, eventId, studentId, opts) {
  const r = runnerOf(runner);
  const { dojoId = null, responsesJson = null, savepoint = null } = opts || {};
  const sp = savepoint ? safeSavepointName(savepoint) : null;

  let ins;
  if (responsesJson != null && HAS_REGISTRATION_RESPONSES_COL) {
    if (sp) await r.query(`SAVEPOINT ${sp}`);
    try {
      ins = await r.query(
        `INSERT INTO karate_event_enrollments
           (event_id, student_id, dojo_id, status, fee_paid, registration_responses, created_at)
         VALUES ($1,$2,$3,'enrolled', false, $4::jsonb, NOW())
         RETURNING id`,
        [eventId, studentId, dojoId, responsesJson]
      );
      if (sp) await r.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      if (e.code === '42703') {
        if (sp) await r.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        HAS_REGISTRATION_RESPONSES_COL = false;
        console.warn('[karateEventEnrollment] registration_responses ausente no INSERT enrollment (migration 200 pendente)');
      } else throw e;
    }
  }
  if (!ins) {
    ins = await r.query(
      `INSERT INTO karate_event_enrollments (event_id, student_id, dojo_id, status, fee_paid, created_at)
       VALUES ($1,$2,$3,'enrolled', false, NOW())
       RETURNING id`,
      [eventId, studentId, dojoId]
    );
  }
  return ins.rows[0];
}

module.exports = {
  CLOSED_EVENT_STATUSES,
  isEventClosed,
  resolveFederationEvent,
  findExamCandidate,
  insertExamCandidate,
  findCourseEnrollment,
  insertCourseEnrollment,
};
