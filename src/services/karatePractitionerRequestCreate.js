// ============================================================
// AURA KARATÊ — Criação da solicitação de praticante (H1) — ponto ÚNICO
//
// Esta lógica nasceu dentro de POST /federation/:id/dojo/practitioner-requests
// (src/routes/karateDojoPractitionerRequests.js). A F5a passou a precisar
// dela num SEGUNDO caminho — POST /dojo/students/:sid/federate sem número
// FPKT abre exatamente a mesma solicitação —, então ela sai da rota e vira
// service. NADA foi reescrito no caminho: mesma validação, mesmo
// dedup_key/idempotência, mesma SQL (os testes de integração casam por
// SQL; qualquer reescrita cosmética quebraria o CI).
//
// O que a F5a acrescenta: studentId opcional → grava
// karate_practitioner_requests.student_id (migration 253), que é o fio que
// leva o practitioner_id de volta ao aluno quando a federação aprova.
// Defensivo 42703 (coluna ausente / migration 253 pendente): grava sem ela
// e segue — perder o fio é ruim, não criar a solicitação é pior.
//
// NÃO faz gate de conexão do dojô: quem chama decide (a rota H1 e a rota
// de federar já bloqueiam com 409 DOJO_NAO_CONECTADO antes de chegar aqui).
//
// Contrato: devolve { status, body } — nunca escreve na resposta HTTP.
// Erros de banco (42P01 etc.) sobem para o caller mapear.
// ============================================================
'use strict';

const db = require('../config/database');
const { buildDedupKey, lookupByFpktNumber, normalizeFpktNumber } = require('./karatePractitionerDedup');
const { validatePractitionerRequestPayload } = require('./karatePractitionerRequestValidation');

const VALID_SEX_VALUES = ['M', 'F', 'other'];

// migration 253 — karate_practitioner_requests.student_id. Flag module-level
// no mesmo espírito de HAS_PHONE_MOBILE_COL (karatePractitionerRequestsAdmin):
// o backend sobe antes da migration em deploy parcial.
let HAS_STUDENT_ID_COL = true;

function validationError(message, errors) {
  return {
    status: 422,
    body: { error: message, errors: errors || [message], code: 'VALIDATION_ERROR' },
  };
}

// Best-effort: nunca derruba a solicitação por falta da tabela de eventos
// (deploy parcial) — SEM SAVEPOINT porque aqui NÃO estamos dentro de uma
// transação do caller; db.query é autocommit por statement.
async function logRosterEventBestEffort({ dojoId, federationId, event, affected, actorId = null }) {
  try {
    await db.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dojoId, federationId, event, JSON.stringify(affected), actorId]
    );
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[karatePractitionerRequestCreate] karate_dojo_roster_events ausente (schema pendente)');
    } else {
      console.error('[karatePractitionerRequestCreate] falha ao gravar roster event (não bloqueia):', e.message);
    }
  }
}

// INSERT com student_id quando a coluna existe. O 42703 é tratado AQUI
// (não sobe): a solicitação tem que nascer mesmo sem o fio para o aluno.
async function insertRequest(values, studentId) {
  const withStudent = Boolean(studentId) && HAS_STUDENT_ID_COL;
  const sql =
    `INSERT INTO karate_practitioner_requests
         (federation_id, dojo_id, full_name, birth_date, cpf, rg, phone, email,
          claimed_belt, payload, fpkt_number_claimed, dedup_key,
          requested_by_channel, requested_by_label${withStudent ? ', student_id' : ''})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14${withStudent ? ',$15' : ''})
       ON CONFLICT (dojo_id, dedup_key) WHERE status = 'pendente' DO NOTHING
       RETURNING id, status, created_at`;
  const params = withStudent ? [...values, studentId] : values;

  try {
    return await db.query(sql, params);
  } catch (e) {
    if (e.code === '42703' && withStudent && /student_id/i.test(e.message || '')) {
      HAS_STUDENT_ID_COL = false;
      console.warn('[karatePractitionerRequestCreate] student_id ausente (migration 253 pendente) — solicitação criada sem o vínculo com o aluno');
      return insertRequest(values, null);
    }
    throw e;
  }
}

// Idempotência + F5a: se já existia uma solicitação PENDENTE para esta
// pessoa e ela nasceu sem student_id (ex.: criada pelo fluxo H1 antigo),
// amarra o aluno agora. Best-effort puro.
async function attachStudentBestEffort(requestId, studentId) {
  if (!requestId || !studentId || !HAS_STUDENT_ID_COL) return;
  try {
    await db.query(
      `UPDATE karate_practitioner_requests SET student_id = $1
        WHERE id = $2 AND student_id IS NULL`,
      [studentId, requestId]
    );
  } catch (e) {
    if (e.code === '42703') {
      HAS_STUDENT_ID_COL = false;
      return;
    }
    console.error('[karatePractitionerRequestCreate] falha ao amarrar aluno à solicitação (não bloqueia):', e.message);
  }
}

// createPractitionerRequest({...}) → { status, body }
//   201 criada | 200 já pendente (idempotente) | 422 ficha inválida
async function createPractitionerRequest({
  federationId,
  dojoId,
  body,
  channel = null,
  actorLabel = null,
  studentId = null,
}) {
  const b = body || {};

  const full_name = b.full_name != null ? String(b.full_name).trim() : '';
  if (!full_name) {
    return { status: 422, body: { error: 'Campo full_name é obrigatório', code: 'VALIDATION_ERROR' } };
  }

  const birth_date = (typeof b.birth_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.birth_date))
    ? b.birth_date
    : null;
  if (b.birth_date && !birth_date) {
    return { status: 422, body: { error: 'birth_date deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' } };
  }

  if (b.sex !== undefined && b.sex !== null && b.sex !== '' && !VALID_SEX_VALUES.includes(b.sex)) {
    return { status: 422, body: { error: `sex inválido. Use: ${VALID_SEX_VALUES.join(', ')}`, code: 'VALIDATION_ERROR' } };
  }

  const cpf = b.cpf != null ? String(b.cpf).trim() || null : null;
  const rg = b.rg != null ? String(b.rg).trim() || null : null;
  const phone = b.phone != null ? String(b.phone).trim() || null : null;
  const email = b.email != null ? String(b.email).trim() || null : null;
  const claimed_belt = b.claimed_belt != null ? String(b.claimed_belt).trim() || null : null;
  const fpktClaimed = b.fpkt_number_claimed != null ? normalizeFpktNumber(b.fpkt_number_claimed) || null : null;

  // Ficha completa — sempre a versão bruta do que o sensei mandou, mesmo os
  // campos que também viram coluna própria. dojo_id/federation_id NUNCA
  // entram aqui (vêm do token, no caller).
  const payload = {
    full_name, birth_date, cpf, rg, phone, email, sex: b.sex || null,
    claimed_belt, fpkt_number_claimed: fpktClaimed,
    street: b.street || null, number: b.number || null, complement: b.complement || null,
    neighborhood: b.neighborhood || null, city: b.city || null, state: b.state || null, zip_code: b.zip_code || null,
    guardian_name: b.guardian_name || null, guardian_cpf: b.guardian_cpf || null,
    guardian_phone: b.guardian_phone || null, guardian_relationship: b.guardian_relationship || null,
  };

  // Item 6 (revisão Atualização Cadastral, 15/07/2026): TODOS os campos da
  // ficha são obrigatórios — validado no backend, não só no front.
  const validationErrors = validatePractitionerRequestPayload(payload);
  if (validationErrors.length) {
    return validationError(validationErrors[0], validationErrors);
  }

  const dedupKey = buildDedupKey(full_name, birth_date);

  const insertRes = await insertRequest(
    [
      federationId, dojoId, full_name, birth_date, cpf, rg, phone, email,
      claimed_belt, JSON.stringify(payload), fpktClaimed, dedupKey,
      channel, actorLabel,
    ],
    studentId
  );

  if (!insertRes.rows.length) {
    // Já existe uma solicitação PENDENTE idêntica (mesmo dojô + nome
    // normalizado + nascimento) — idempotente: não cria duplicata,
    // devolve a existente.
    const existing = await db.query(
      `SELECT id, status, created_at FROM karate_practitioner_requests
        WHERE dojo_id = $1 AND dedup_key = $2 AND status = 'pendente'
        LIMIT 1`,
      [dojoId, dedupKey]
    );
    const row = existing.rows[0];
    if (!row) {
      // Corrida rara (a pendente foi resolvida entre o INSERT e o SELECT).
      return {
        status: 409,
        body: {
          error: 'Não foi possível criar a solicitação agora. Tente novamente.',
          code: 'CONFLICT',
        },
      };
    }
    await attachStudentBestEffort(row.id, studentId);
    return {
      status: 200,
      body: {
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        already_pending: true,
        message: 'Já existe uma solicitação pendente para esta pessoa neste dojô.',
      },
    };
  }

  const created = insertRes.rows[0];

  // Hint imediato: se o sensei já digitou um número FPKT, avisa na hora se
  // ele já pertence a alguém (provável transferência). A decisão continua
  // sendo da federação na aprovação — isto é só um aviso amigável.
  let fpktHint = null;
  if (fpktClaimed) {
    try {
      fpktHint = await lookupByFpktNumber(db, { federationId, number: fpktClaimed });
    } catch (e) {
      console.error('[karatePractitionerRequestCreate] fpkt hint falhou (não bloqueia):', e.message);
    }
  }

  await logRosterEventBestEffort({
    dojoId, federationId, event: 'practitioner_request_created',
    affected: [{ request_id: created.id, full_name, student_id: studentId || null }],
  });

  return {
    status: 201,
    body: {
      id: created.id,
      status: created.status,
      created_at: created.created_at,
      already_pending: false,
      fpkt_lookup: fpktHint,
    },
  };
}

module.exports = { createPractitionerRequest };
