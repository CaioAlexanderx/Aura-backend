// ============================================================
// AURA DOJÔ — F2: Service de alunos do dojô (registro PRÓPRIO)
//
// DECISÃO CENTRAL: o aluno do dojô NÃO é o praticante federado
// (karate_practitioners/customers, que são da FEDERAÇÃO). É um registro
// próprio do dojô em karate_dojo_students (migration 242).
//
// F5a (26/07/2026) — QUEM FEDERA É O SENSEI, A FEDERAÇÃO CONFIRMA:
//   practitioner_id deixou de ser "vínculo futuro" e passou a ser gravado
//   por dois caminhos, ambos reusando o que já existia:
//     1) o aluno JÁ tem número FPKT → lookupByFpktNumber (H1) confirma e
//        o vínculo é gravado na hora;
//     2) o aluno é NOVO na federação → abre a solicitação H1
//        (createPractitionerRequest) com student_id; quando a federação
//        aprova, o practitioner_id volta para o aluno.
//   is_federated (migration 253) é a DECLARAÇÃO do sensei;
//   practitioner_id é a CONFIRMAÇÃO. Aluno não federado é cadastro
//   privado do dojô e a federação não o enxerga.
//
// F7.0 (30/07/2026) — O FLUXO DE INFORMAÇÃO SOBE: dojô → federação.
//   "A federação não faz gestão de informação. O trabalho dela é apenas
//    receber a sincronização dos dados gerenciados pelos dojôs." (Caio)
//   Consequência prática AQUI: a ficha do aluno passa a ter onde guardar a
//   identidade INTEIRA da pessoa — RG, endereço completo e foto de
//   carteirinha (migration 262) —, campos que a ficha H1 exige e que até
//   hoje só existiam do lado da federação. Sem isso, "o dojô é a fonte da
//   identidade" seria uma frase sem coluna.
//   SEXO: a borda de escrita passa a ACEITAR os dois vocabulários
//   ('M'/'F'/'other' e 'masculino'/'feminino'/'outro') via
//   src/utils/personIdentity.js e continua GRAVANDO M/F/other — zero
//   mudança visível no app. A conversão do dado é F7.2.
//   FOTO: karate_photo_url (nome idêntico ao lado da federação) substitui
//   photo_url, que sempre foi coluna morta. photo_url continua aceita e a
//   leitura devolve COALESCE(karate_photo_url, photo_url).
//   NÃO ENTRA NESTE PR: a conferência ao federar (F7.1), a tela de adoção
//   e a sincronização dojô→federação (F7.2).
//
// Família é entidade de primeira classe (billing familiar na F3):
// responsável em karate_dojo_guardians; um responsável → N alunos.
//
// Regra da casa "dado faltante ≠ pendência": campo ausente é neutro e
// salvar incompleto é permitido silenciosamente; campo INVÁLIDO é erro
// (422). EXCEÇÃO (espelha migrations 197/231 — LGPD): menor de 18 sem
// responsável vinculado → 422 MENOR_SEM_RESPONSAVEL no create/update que
// torne isso verdadeiro. O import em lote é TOLERANTE: importa mesmo
// assim, com warning na resposta (o bloqueio é só no form).
//
// PAGINAÇÃO (QA 27/07/2026): a lista tinha LIMIT 1000 FIXO e ignorava o
// limit do cliente — limit=50 e limit=200 devolviam os mesmos 205 alunos
// (105 KB). Agora é limit/offset de verdade, com o total (sem paginação)
// vindo por count(*) OVER() na MESMA query.
//
// Idade tz-safe: birth_date é date puro — NUNCA new Date('YYYY-MM-DD')
// (interpretaria como UTC e voltaria um dia em UTC-3); split manual.
// Todas as leituras de date usam to_char(...,'YYYY-MM-DD') para o driver
// não converter para Date com timezone.
// ============================================================
'use strict';

const db = require('../config/database');
const { lookupByFpktNumber, normalizeFpktNumber } = require('./karatePractitionerDedup');
const { createPractitionerRequest } = require('./karatePractitionerRequestCreate');
const { normalizeCpf, toDojoSex, normalizeUf, normalizeZipCode } = require('../utils/personIdentity');

const VALID_STATUS = ['active', 'inactive'];
const VALID_SEX_VALUES = ['M', 'F', 'other'];
const IMPORT_MAX_ROWS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Paginação da lista de alunos. 100 cobre a tela; 500 é o teto para quem
// exporta/imprime sem virar payload de 100 KB de novo.
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

// F7.0 — identidade da pessoa (migration 262). Lista ÚNICA: alimenta o
// SELECT, o INSERT, o UPDATE e o fallback de schema. Uma lista só evita a
// divergência clássica "adicionei no PATCH e esqueci no POST".
const IDENTITY_COLS = [
  'rg', 'zip_code', 'street', 'number', 'complement',
  'neighborhood', 'city', 'state', 'karate_photo_url',
];

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// limit/offset chegam como string da query — lixo vira default (nunca 422:
// "dado faltante ≠ pendência" também vale para parâmetro de paginação).
function parsePaging({ limit, offset } = {}) {
  let l = Number(limit);
  if (!Number.isFinite(l) || l <= 0) l = LIST_DEFAULT_LIMIT;
  l = Math.min(Math.floor(l), LIST_MAX_LIMIT);

  let o = Number(offset);
  if (!Number.isFinite(o) || o < 0) o = 0;
  return { limit: l, offset: Math.floor(o) };
}

// ── Schema em deploy parcial (CLAUDE.md #1/#10) ──
// O backend sobe ANTES da migration. Flags module-level: na primeira
// 42703/42P01 das colunas NOVAS, degradamos e seguimos servindo a lista —
// esconder os alunos porque uma coluna ainda não existe seria muito pior
// que mostrar todo mundo como não federado / sem endereço.
let HAS_IS_FEDERATED_COL = true;      // migration 253
let HAS_REQUEST_STUDENT_ID_COL = true; // migration 253
let HAS_IDENTITY_COLS = true;          // migration 262 (F7.0)

// Sem a coluna, practitioner_id NOT NULL é a melhor verdade disponível
// (é o vínculo real; is_federated é só a declaração).
function isFederatedExpr(p) {
  return HAS_IS_FEDERATED_COL ? `${p}is_federated` : `(${p}practitioner_id IS NOT NULL)`;
}

function pendingRequestExpr(p) {
  return HAS_REQUEST_STUDENT_ID_COL
    ? `EXISTS (SELECT 1 FROM karate_practitioner_requests pr_req
                 WHERE pr_req.student_id = ${p}id AND pr_req.status = 'pendente')`
    : 'false';
}

// Campos federativos ADITIVOS, sempre na MESMA query da leitura do aluno —
// nenhuma query nova entra na frente de nada (armadilha da fila de mocks).
function federationFields(p) {
  return (
    `${isFederatedExpr(p)} AS is_federated, ` +
    `${pendingRequestExpr(p)} AS has_pending_request, ` +
    `fp.karate_registration_number AS fpkt_number, fp.name AS practitioner_name`
  );
}

function federationJoin(p) {
  return `LEFT JOIN customers fp ON fp.id = ${p}practitioner_id`;
}

// F7.0: quando a migration 262 ainda não rodou, as colunas de identidade
// viram NULL::text com o MESMO alias — o shape da resposta não muda de
// formato, só vem vazio. Nenhuma query extra, nenhum campo some do JSON.
function identityFields(p) {
  if (!HAS_IDENTITY_COLS) {
    return IDENTITY_COLS.map((c) => `NULL::text AS ${c}`).join(', ');
  }
  return IDENTITY_COLS.map((c) => `${p}${c}`).join(', ');
}

function isFederationSchemaError(e) {
  if (!e || (e.code !== '42703' && e.code !== '42P01')) return false;
  // Só degrada por causa das coisas NOVAS. 42P01 de karate_dojo_students
  // continua subindo (a rota responde schema_pending, migration 242).
  return /is_federated|student_id|karate_practitioner_requests/i.test(e.message || '');
}

// Só 42703 (coluna): a AUSÊNCIA da tabela nunca é problema de identidade.
function isIdentitySchemaError(e) {
  if (!e || e.code !== '42703') return false;
  return new RegExp(`\\b(${IDENTITY_COLS.join('|')})\\b`, 'i').test(e.message || '');
}

// UMA única retentativa degradada (armadilha "retry chain 42P01": nunca
// re-tentar em cadeia — se falhar de novo, o erro sobe). As duas famílias
// de flag são avaliadas no MESMO catch para que um ambiente sem 253 E sem
// 262 degrade de uma vez, em vez de exigir duas voltas.
async function withStudentSchemaFallback(run) {
  try {
    return await run();
  } catch (e) {
    let degraded = false;

    if (HAS_IDENTITY_COLS && isIdentitySchemaError(e)) {
      HAS_IDENTITY_COLS = false;
      degraded = true;
      console.warn('[karateDojoStudentService] schema da F7.0 ausente (migration 262 pendente) — degradando identidade:', e.message);
    }

    if ((HAS_IS_FEDERATED_COL || HAS_REQUEST_STUDENT_ID_COL) && isFederationSchemaError(e)) {
      HAS_IS_FEDERATED_COL = false;
      HAS_REQUEST_STUDENT_ID_COL = false;
      degraded = true;
      console.warn('[karateDojoStudentService] schema da F5a ausente (migration 253 pendente) — degradando:', e.message);
    }

    if (!degraded) throw e;
    return run();
  }
}

// ── Datas / idade (tz-safe: split manual, nunca new Date('YYYY-MM-DD')) ──
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function computeAge(birthDateStr, refDateStr = null) {
  if (!birthDateStr) return null;
  const raw = String(birthDateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  let ry, rm, rd;
  if (refDateStr) {
    [ry, rm, rd] = String(refDateStr).slice(0, 10).split('-').map(Number);
  } else {
    const now = new Date();
    ry = now.getFullYear();
    rm = now.getMonth() + 1;
    rd = now.getDate();
  }
  let age = ry - y;
  if (rm < m || (rm === m && rd < d)) age--;
  return age;
}

function isMinor(birthDateStr) {
  const age = computeAge(birthDateStr);
  return age != null && age < 18;
}

// ── Validações de payload (form: inválido = erro; ausente = neutro) ──
function validateStudentPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.full_name !== undefined) {
    const name = b.full_name != null ? String(b.full_name).trim() : '';
    if (!name) errors.push('Campo full_name é obrigatório');
    else data.full_name = name;
  }

  for (const field of ['birth_date', 'enrolled_at']) {
    if (b[field] === undefined) continue;
    if (b[field] === null || String(b[field]).trim() === '') {
      data[field] = null;
    } else {
      const v = String(b[field]).trim();
      if (!isValidDateStr(v)) errors.push(`${field} deve ser uma data válida no formato YYYY-MM-DD`);
      else data[field] = v;
    }
  }

  if (b.cpf !== undefined) {
    if (b.cpf === null || String(b.cpf).trim() === '') {
      data.cpf = null;
    } else {
      // F7.0: helper único (src/utils/personIdentity.js) — o mesmo que a
      // borda da federação usa. O UNIQUE (dojo_id, cpf) depende disso.
      const digits = normalizeCpf(b.cpf);
      if (!digits || digits.length !== 11) errors.push('cpf inválido (esperados 11 dígitos)');
      else data.cpf = digits;
    }
  }

  if (b.email !== undefined) {
    if (b.email === null || String(b.email).trim() === '') {
      data.email = null;
    } else {
      const v = String(b.email).trim();
      if (!EMAIL_RE.test(v)) errors.push('email inválido');
      else data.email = v;
    }
  }

  if (b.sex !== undefined) {
    if (b.sex === null || b.sex === '') data.sex = null;
    else {
      // F7.0: ACEITA os dois vocabulários, GRAVA o do dojô (M/F/other).
      // 'masculino' entra sem quebrar nada; 'xyz' continua sendo 422.
      const dojoSex = toDojoSex(b.sex);
      if (!dojoSex) errors.push(`sex inválido. Use: ${VALID_SEX_VALUES.join(', ')}`);
      else data.sex = dojoSex;
    }
  }

  if (b.status !== undefined) {
    if (!VALID_STATUS.includes(b.status)) errors.push(`status inválido. Use: ${VALID_STATUS.join(', ')}`);
    else data.status = b.status;
  }

  if (b.belt_order !== undefined) {
    if (b.belt_order === null || b.belt_order === '') data.belt_order = null;
    else if (!Number.isInteger(Number(b.belt_order))) errors.push('belt_order deve ser um inteiro');
    else data.belt_order = Number(b.belt_order);
  }

  if (b.consent_lgpd !== undefined) {
    data.consent_lgpd = b.consent_lgpd === true || b.consent_lgpd === 'true';
  }

  for (const field of ['phone', 'photo_url', 'belt_label', 'notes']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  // ── F7.0: identidade da pessoa (migration 262) ──
  // Whitelist explícita, mesmo espírito de UPDATABLE_COLS: nada entra por
  // spread do body. Texto livre é neutro; CEP e UF têm forma conhecida e
  // por isso são 422 quando vêm errados ("inválido é erro").
  for (const field of ['rg', 'street', 'number', 'complement', 'neighborhood', 'city', 'karate_photo_url']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  if (b.zip_code !== undefined) {
    if (b.zip_code === null || String(b.zip_code).trim() === '') {
      data.zip_code = null;
    } else {
      const cep = normalizeZipCode(b.zip_code);
      if (!cep) errors.push('zip_code inválido (esperados 8 dígitos)');
      else data.zip_code = cep;
    }
  }

  if (b.state !== undefined) {
    if (b.state === null || String(b.state).trim() === '') {
      data.state = null;
    } else {
      const uf = normalizeUf(b.state);
      if (!uf) errors.push('state inválido (esperada a UF com 2 letras)');
      else data.state = uf;
    }
  }

  if (b.guardian_id !== undefined) {
    data.guardian_id = b.guardian_id != null && String(b.guardian_id).trim() !== '' ? String(b.guardian_id).trim() : null;
  }

  return { errors, data };
}

function validateGuardianPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.full_name !== undefined) {
    const name = b.full_name != null ? String(b.full_name).trim() : '';
    if (!name) errors.push('Campo full_name é obrigatório');
    else data.full_name = name;
  }

  if (b.cpf !== undefined) {
    if (b.cpf === null || String(b.cpf).trim() === '') {
      data.cpf = null;
    } else {
      const digits = normalizeCpf(b.cpf);
      if (!digits || digits.length !== 11) errors.push('cpf inválido (esperados 11 dígitos)');
      else data.cpf = digits;
    }
  }

  if (b.email !== undefined) {
    if (b.email === null || String(b.email).trim() === '') {
      data.email = null;
    } else {
      const v = String(b.email).trim();
      if (!EMAIL_RE.test(v)) errors.push('email inválido');
      else data.email = v;
    }
  }

  for (const field of ['phone', 'relationship']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  return { errors, data };
}

// ── Shapes / SQL helpers ──
function studentFields(p) {
  return (
    `${p}id, ${p}full_name, to_char(${p}birth_date, 'YYYY-MM-DD') AS birth_date, ` +
    `${p}cpf, ${p}sex, ${p}phone, ${p}email, ${p}photo_url, ${p}belt_label, ${p}belt_order, ` +
    `${p}status, ${p}guardian_id, ${p}consent_lgpd, ${p}notes, ${p}practitioner_id, ` +
    `to_char(${p}enrolled_at, 'YYYY-MM-DD') AS enrolled_at, ${p}created_at, ${p}updated_at, ` +
    identityFields(p)
  );
}

function shapeStudent(row) {
  // federated: a coluna manda quando existe. Quando ela NÃO vem na row
  // (migration 253 pendente, RETURNING de create/update), o vínculo real
  // (practitioner_id) é a verdade — nunca inventamos "federado" do nada.
  const federated = row.is_federated === true || (row.is_federated == null && !!row.practitioner_id);
  // linked  = a federação confirmou (existe praticante vinculado)
  // pending = existe solicitação H1 pendente para este aluno
  // none    = cadastro privado do dojô
  const linkStatus = row.practitioner_id
    ? 'linked'
    : (row.has_pending_request === true ? 'pending' : 'none');

  return {
    id: row.id,
    full_name: row.full_name,
    birth_date: row.birth_date || null,
    age: computeAge(row.birth_date),
    cpf: row.cpf || null,
    sex: row.sex || null,
    phone: row.phone || null,
    email: row.email || null,
    photo_url: row.photo_url || null,
    belt_label: row.belt_label || null,
    belt_order: row.belt_order != null ? Number(row.belt_order) : null,
    status: row.status,
    guardian_id: row.guardian_id || null,
    guardian: null, // preenchido pelos callers quando disponível (ficha/list)
    consent_lgpd: row.consent_lgpd === true,
    notes: row.notes || null,
    practitioner_id: row.practitioner_id || null,
    // ── F5a (aditivo) ──
    federated,
    fpkt_number: row.fpkt_number || null,
    practitioner_name: row.practitioner_name || null,
    federation_link_status: linkStatus,
    // ── F7.0 (aditivo): identidade da pessoa, dona pelo DOJÔ ──
    rg: row.rg || null,
    zip_code: row.zip_code || null,
    street: row.street || null,
    number: row.number || null,
    complement: row.complement || null,
    neighborhood: row.neighborhood || null,
    city: row.city || null,
    state: row.state || null,
    // photo_url é coluna MORTA (migration 242, nenhuma UI escreveu nela).
    // COALESCE mantém compatível quem por acaso tenha algo lá.
    karate_photo_url: row.karate_photo_url || row.photo_url || null,
    enrolled_at: row.enrolled_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Consultas ──
// federated: true | false | null (null/ausente = todos)
//
// count(*) OVER() dá o total SEM paginação na PRÓPRIA query — de propósito:
// um SELECT COUNT separado entraria na fila de queries e desalinharia os
// mocks posicionais dos testes que já existem (armadilha conhecida). O
// único caso em que a window function não serve é página VAZIA com offset
// > 0 (não há linha para carregar o total) — aí sim vai um COUNT dedicado.
async function listStudentsPaged(dojoId, opts = {}) {
  const { status = null, q = null, belt = null, federated = null } = opts;
  const { limit, offset } = parsePaging(opts);

  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')},
            g.full_name AS guardian_full_name, g.phone AS guardian_phone,
            g.relationship AS guardian_relationship,
            ${federationFields('s.')},
            count(*) OVER() AS total_count
       FROM karate_dojo_students s
       LEFT JOIN karate_dojo_guardians g ON g.id = s.guardian_id
       ${federationJoin('s.')}
      WHERE s.dojo_id = $1
        AND ($2::text IS NULL OR s.status = $2)
        AND ($3::text IS NULL OR s.full_name ILIKE '%' || $3 || '%'
             OR s.cpf = regexp_replace($3, '\\D', '', 'g'))
        AND ($4::text IS NULL OR s.belt_label = $4)
        AND ($5::boolean IS NULL OR ${isFederatedExpr('s.')} = $5)
      ORDER BY s.full_name ASC
      LIMIT $6 OFFSET $7`,
    [dojoId, status, q, belt, federated, limit, offset]
  ));

  const data = rows.map((r) => {
    const s = shapeStudent(r);
    s.guardian = r.guardian_id
      ? {
          id: r.guardian_id,
          full_name: r.guardian_full_name || null,
          phone: r.guardian_phone || null,
          relationship: r.guardian_relationship || null,
        }
      : null;
    return s;
  });

  let count;
  if (rows.length) {
    count = rows[0].total_count != null ? Number(rows[0].total_count) : rows.length;
  } else if (offset > 0) {
    count = await countStudents(dojoId, { status, q, belt, federated });
  } else {
    count = 0;
  }

  return { data, count, limit, offset };
}

// Só usado quando a página vem vazia com offset > 0 (ver acima).
async function countStudents(dojoId, { status = null, q = null, belt = null, federated = null } = {}) {
  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT count(*)::int AS total
       FROM karate_dojo_students s
      WHERE s.dojo_id = $1
        AND ($2::text IS NULL OR s.status = $2)
        AND ($3::text IS NULL OR s.full_name ILIKE '%' || $3 || '%'
             OR s.cpf = regexp_replace($3, '\\D', '', 'g'))
        AND ($4::text IS NULL OR s.belt_label = $4)
        AND ($5::boolean IS NULL OR ${isFederatedExpr('s.')} = $5)`,
    [dojoId, status, q, belt, federated]
  ));
  return rows.length && rows[0].total != null ? Number(rows[0].total) : 0;
}

// Compat: assinatura antiga (devolve o ARRAY). Sem limit/offset explicitos
// vale o default da paginação.
async function listStudents(dojoId, opts = {}) {
  const page = await listStudentsPaged(dojoId, opts);
  return page.data;
}

async function getSummary(dojoId) {
  const totalsRes = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'inactive')::int AS inactive
       FROM karate_dojo_students
      WHERE dojo_id = $1`,
    [dojoId]
  );
  // Pirâmide de faixas: só alunos ATIVOS contam (inativo sai da pirâmide).
  const beltRes = await db.query(
    `SELECT belt_label, belt_order, count(*)::int AS count
       FROM karate_dojo_students
      WHERE dojo_id = $1 AND status = 'active'
      GROUP BY belt_label, belt_order
      ORDER BY belt_order ASC NULLS LAST, belt_label ASC NULLS LAST`,
    [dojoId]
  );
  const t = totalsRes.rows[0] || { total: 0, active: 0, inactive: 0 };
  return {
    total: Number(t.total) || 0,
    active: Number(t.active) || 0,
    inactive: Number(t.inactive) || 0,
    by_belt: beltRes.rows.map((r) => ({
      belt_label: r.belt_label || null,
      belt_order: r.belt_order != null ? Number(r.belt_order) : null,
      count: Number(r.count) || 0,
    })),
  };
}

async function getStudent(dojoId, studentId) {
  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')},
            g.full_name AS guardian_full_name, g.cpf AS guardian_cpf,
            g.phone AS guardian_phone, g.email AS guardian_email,
            g.relationship AS guardian_relationship,
            ${federationFields('s.')}
       FROM karate_dojo_students s
       LEFT JOIN karate_dojo_guardians g ON g.id = s.guardian_id
       ${federationJoin('s.')}
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!rows.length) return null;
  const r = rows[0];
  const s = shapeStudent(r);
  s.guardian = r.guardian_id
    ? {
        id: r.guardian_id,
        full_name: r.guardian_full_name || null,
        cpf: r.guardian_cpf || null,
        phone: r.guardian_phone || null,
        email: r.guardian_email || null,
        relationship: r.guardian_relationship || null,
      }
    : null;
  return s;
}

async function resolveGuardianOrThrow(dojoId, guardianId) {
  const g = await db.query(
    `SELECT id, full_name, phone, relationship
       FROM karate_dojo_guardians
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [guardianId, dojoId]
  );
  if (!g.rows.length) {
    throw svcError(422, 'GUARDIAN_NOT_FOUND', 'Responsável não encontrado neste dojô');
  }
  return g.rows[0];
}

// Colunas/params BASE do INSERT. Os campos da F7.0 são acrescentados DEPOIS
// ($16+), nunca no meio: os testes de integração conferem a posição do
// dojo_id ($1) e do cpf ($4) na fila de params.
const CREATE_BASE_COLS =
  'dojo_id, full_name, birth_date, cpf, sex, phone, email, photo_url, ' +
  'belt_label, belt_order, status, guardian_id, consent_lgpd, notes, enrolled_at';
const CREATE_BASE_VALUES =
  "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'active'), $12, COALESCE($13, false), $14, $15";

async function createStudent(dojoId, data) {
  let guardian = null;
  if (data.guardian_id) {
    guardian = await resolveGuardianOrThrow(dojoId, data.guardian_id);
  }
  // EXCEÇÃO à regra "dado faltante ≠ pendência" (LGPD, espelha migr 197/231):
  // menor de 18 SEM responsável vinculado não pode ser salvo pelo form.
  if (data.birth_date && isMinor(data.birth_date) && !data.guardian_id) {
    throw svcError(422, 'MENOR_SEM_RESPONSAVEL', 'Aluno menor de 18 anos precisa de um responsável vinculado (LGPD). Cadastre o responsável e vincule antes de salvar.');
  }

  const baseParams = [
    dojoId,
    data.full_name,
    data.birth_date !== undefined ? data.birth_date : null,
    data.cpf !== undefined ? data.cpf : null,
    data.sex !== undefined ? data.sex : null,
    data.phone !== undefined ? data.phone : null,
    data.email !== undefined ? data.email : null,
    data.photo_url !== undefined ? data.photo_url : null,
    data.belt_label !== undefined ? data.belt_label : null,
    data.belt_order !== undefined ? data.belt_order : null,
    data.status !== undefined ? data.status : null,
    data.guardian_id !== undefined ? data.guardian_id : null,
    data.consent_lgpd !== undefined ? data.consent_lgpd : null,
    data.notes !== undefined ? data.notes : null,
    data.enrolled_at !== undefined ? data.enrolled_at : null,
  ];

  const attempt = (withIdentity) => {
    let cols = CREATE_BASE_COLS;
    let values = CREATE_BASE_VALUES;
    const params = baseParams.slice();
    if (withIdentity) {
      for (const c of IDENTITY_COLS) {
        params.push(data[c] !== undefined ? data[c] : null);
        cols += `, ${c}`;
        values += `, $${params.length}`;
      }
    }
    return db.query(
      `INSERT INTO karate_dojo_students (${cols})
       VALUES (${values})
       RETURNING ${studentFields('')}`,
      params
    );
  };

  let rows;
  try {
    ({ rows } = await attempt(HAS_IDENTITY_COLS));
  } catch (e) {
    // Defensivo (CLAUDE.md #1): o backend sobe antes da migration 262. UMA
    // retentativa sem os campos novos — perder o RG do cadastro é ruim,
    // não conseguir cadastrar o aluno é inaceitável.
    if (!HAS_IDENTITY_COLS || !isIdentitySchemaError(e)) throw e;
    HAS_IDENTITY_COLS = false;
    console.warn('[karateDojoStudentService] identidade F7.0 ausente (migration 262 pendente) — aluno criado sem RG/endereço/foto:', e.message);
    ({ rows } = await attempt(false));
  }

  // Aluno recém-criado nunca nasce federado nem com solicitação pendente:
  // shapeStudent devolve federated:false / federation_link_status:'none'
  // sem precisar de NENHUMA query extra (o INSERT não muda de lugar).
  const s = shapeStudent(rows[0]);
  s.guardian = guardian
    ? { id: guardian.id, full_name: guardian.full_name, phone: guardian.phone, relationship: guardian.relationship }
    : null;
  return s;
}

const UPDATABLE_COLS = [
  'full_name', 'birth_date', 'cpf', 'sex', 'phone', 'email', 'photo_url',
  'belt_label', 'belt_order', 'status', 'guardian_id', 'consent_lgpd',
  'notes', 'enrolled_at',
];

// Whitelist efetiva: os campos da F7.0 só entram quando a migration 262 já
// rodou. Continua sendo whitelist — nada vem do spread do body.
function updatableCols() {
  return HAS_IDENTITY_COLS ? UPDATABLE_COLS.concat(IDENTITY_COLS) : UPDATABLE_COLS;
}

async function updateStudent(dojoId, studentId, data) {
  // O SELECT que já existia ganhou os campos federativos (mesma query, sem
  // custo de round-trip novo): o PATCH não altera practitioner_id nem
  // is_federated (não estão em UPDATABLE_COLS — federar tem rota própria),
  // então o estado federativo lido aqui vale para a resposta.
  const existing = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')}, ${federationFields('s.')}
       FROM karate_dojo_students s
       ${federationJoin('s.')}
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!existing.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  const cur = existing.rows[0];
  if (!Object.keys(data).length) return shapeStudent(cur); // PATCH vazio = no-op

  let guardian = null;
  if (data.guardian_id) {
    guardian = await resolveGuardianOrThrow(dojoId, data.guardian_id);
  }

  // Estado RESULTANTE (existente + patch): a regra do menor vale para o
  // update que TORNE isso verdadeiro (mudar birth_date ou remover guardian).
  const mergedBirth = data.birth_date !== undefined ? data.birth_date : cur.birth_date;
  const mergedGuardian = data.guardian_id !== undefined ? data.guardian_id : cur.guardian_id;
  if (mergedBirth && isMinor(mergedBirth) && !mergedGuardian) {
    throw svcError(422, 'MENOR_SEM_RESPONSAVEL', 'Aluno menor de 18 anos precisa de um responsável vinculado (LGPD). Vincule um responsável antes de salvar.');
  }

  const runUpdate = () => {
    const sets = [];
    const vals = [];
    for (const col of updatableCols()) {
      if (data[col] !== undefined) {
        vals.push(data[col]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    sets.push('updated_at = now()');
    vals.push(studentId, dojoId);
    return db.query(
      `UPDATE karate_dojo_students SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
        RETURNING ${studentFields('')}`,
      vals
    );
  };

  let upd;
  try {
    upd = await runUpdate();
  } catch (e) {
    if (!HAS_IDENTITY_COLS || !isIdentitySchemaError(e)) throw e;
    HAS_IDENTITY_COLS = false;
    console.warn('[karateDojoStudentService] identidade F7.0 ausente (migration 262 pendente) — PATCH aplicado sem RG/endereço/foto:', e.message);
    upd = await runUpdate();
  }

  // RETURNING não faz JOIN: o estado federativo vem do SELECT acima.
  const s = shapeStudent({
    ...upd.rows[0],
    is_federated: cur.is_federated,
    has_pending_request: cur.has_pending_request,
    fpkt_number: cur.fpkt_number,
    practitioner_name: cur.practitioner_name,
  });
  s.guardian = guardian
    ? { id: guardian.id, full_name: guardian.full_name, phone: guardian.phone, relationship: guardian.relationship }
    : null;
  return s;
}

async function deleteStudent(dojoId, studentId) {
  // Por ora DELETE REAL: o aluno da F2 ainda não tem dependências. Quando a
  // F3 criar cobranças (histórico financeiro), este service deve passar a
  // responder 409 HAS_HISTORY em vez de apagar (preserva trilha).
  const del = await db.query(
    `DELETE FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 RETURNING id`,
    [studentId, dojoId]
  );
  if (!del.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  return { deleted: true, id: studentId };
}

// ============================================================
// F5a — FEDERAR / DESFEDERAR o aluno
// ============================================================

// Leitura crua do aluno (sem JOIN): usada pelos fluxos de federação, que
// precisam da ficha para pré-preencher a solicitação H1.
async function loadStudentOrThrow(dojoId, studentId) {
  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('')} FROM karate_dojo_students
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  return rows[0];
}

// Escreve as DUAS colunas do vínculo de uma vez. Defensivo 42703
// (migration 253 pendente): grava só practitioner_id — o vínculo REAL não
// pode se perder por causa da coluna de declaração.
async function writeFederationLink(dojoId, studentId, { practitionerId, federated }) {
  const attempt = async (withCol) => {
    const sets = ['practitioner_id = $1'];
    if (withCol) sets.push(`is_federated = ${federated ? 'true' : 'false'}`);
    sets.push('updated_at = now()');
    return db.query(
      `UPDATE karate_dojo_students SET ${sets.join(', ')}
        WHERE id = $2 AND dojo_id = $3
        RETURNING id`,
      [practitionerId, studentId, dojoId]
    );
  };

  try {
    const r = await attempt(HAS_IS_FEDERATED_COL);
    return r.rows.length > 0;
  } catch (e) {
    if (e.code === '42703' && HAS_IS_FEDERATED_COL && /is_federated/i.test(e.message || '')) {
      HAS_IS_FEDERATED_COL = false;
      console.warn('[karateDojoStudentService] is_federated ausente (migration 253 pendente) — gravando só practitioner_id');
      const r = await attempt(false);
      return r.rows.length > 0;
    }
    throw e;
  }
}

async function findPendingRequestForStudent(dojoId, studentId) {
  if (!HAS_REQUEST_STUDENT_ID_COL) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, status, created_at FROM karate_practitioner_requests
        WHERE dojo_id = $1 AND student_id = $2 AND status = 'pendente'
        ORDER BY created_at DESC
        LIMIT 1`,
      [dojoId, studentId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') {
      HAS_REQUEST_STUDENT_ID_COL = false;
      console.warn('[karateDojoStudentService] student_id/karate_practitioner_requests ausente — sem estado "pendente" por aluno');
      return null;
    }
    throw e;
  }
}

// Caminho 1: o aluno JÁ tem número FPKT (veio de outro dojô / já tem
// carteirinha). MESMA lógica do lookup-fpkt do H1 — nada reimplementado.
//
// IMPORTANTE: vincular NÃO move o praticante de dojô na federação. Isso é
// decisão da FEDERAÇÃO (approve-transfer). Aqui o dojô só reivindica o
// vínculo local; is_transfer avisa o front de que o praticante está hoje
// em outro dojô e que a transferência formal continua sendo com a FPKT.
async function federateStudentByFpktNumber(dojoId, federationId, studentId, rawNumber) {
  const number = normalizeFpktNumber(rawNumber);
  if (!number) {
    throw svcError(422, 'VALIDATION_ERROR', 'Informe o número FPKT do aluno');
  }

  await loadStudentOrThrow(dojoId, studentId);

  const lookup = await lookupByFpktNumber(db, { federationId, number });
  if (!lookup || !lookup.found) {
    throw svcError(
      404,
      'FPKT_NUMBER_NOT_FOUND',
      'Número FPKT não encontrado nesta federação. Confira o número ou marque o aluno como novo para solicitar o cadastro à federação.'
    );
  }
  const practitioner = lookup.practitioner || {};

  // O mesmo praticante não pode ser reivindicado por dois alunos do MESMO
  // dojô (viraria dois cadastros disputando um número FPKT).
  //
  // F7.0: a partir da migration 262 existe também um UNIQUE GLOBAL parcial
  // em practitioner_id — a checagem abaixo continua servindo para dar a
  // mensagem BOA quando o conflito é dentro do próprio dojô ("já vinculado
  // ao aluno Fulano"), e o índice cobre o caso entre dojôs DIFERENTES, que
  // esta query nunca viu (ela filtra por dojo_id). O 23505 resultante é
  // mapeado pela rota. A conferência humana ao federar é F7.1.
  const dup = await db.query(
    `SELECT id, full_name FROM karate_dojo_students
      WHERE dojo_id = $1 AND practitioner_id = $2 AND id <> $3
      LIMIT 1`,
    [dojoId, practitioner.id, studentId]
  );
  if (dup.rows.length) {
    throw svcError(
      409,
      'PRACTITIONER_JA_VINCULADO',
      `Este número FPKT já está vinculado ao aluno "${dup.rows[0].full_name}" deste dojô.`
    );
  }

  const ok = await writeFederationLink(dojoId, studentId, { practitionerId: practitioner.id, federated: true });
  if (!ok) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }

  const isTransfer = Boolean(practitioner.current_dojo_id) &&
    String(practitioner.current_dojo_id) !== String(dojoId);

  return {
    linked: true,
    student_id: studentId,
    federated: true,
    federation_link_status: 'linked',
    is_transfer: isTransfer,
    practitioner: {
      id: practitioner.id,
      name: practitioner.name || null,
      fpkt_number: number,
      current_dojo_id: practitioner.current_dojo_id || null,
      current_dojo_name: practitioner.current_dojo_name || null,
    },
  };
}

// Ficha da solicitação = dados do ALUNO como base + o que o sensei mandou
// no corpo (o corpo vence). Evita redigitar o que o dojô já tem.
//
// F7.0: com RG e endereço no aluno, a solicitação H1 deixa de exigir que o
// sensei redigite o que ele já cadastrou — é o "fluxo que sobe" na prática.
function mergeStudentIntoRequestPayload(student, body) {
  const b = body || {};
  const pick = (key, fallback) => {
    const v = b[key];
    return v !== undefined && v !== null && String(v).trim() !== '' ? v : (fallback || null);
  };
  const merged = { ...b };
  delete merged.request; // flag de controle, não é campo da ficha
  merged.full_name = pick('full_name', student.full_name);
  merged.birth_date = pick('birth_date', student.birth_date);
  merged.cpf = pick('cpf', student.cpf);
  merged.rg = pick('rg', student.rg);
  merged.phone = pick('phone', student.phone);
  merged.email = pick('email', student.email);
  merged.sex = pick('sex', student.sex);
  merged.zip_code = pick('zip_code', student.zip_code);
  merged.street = pick('street', student.street);
  merged.number = pick('number', student.number);
  merged.complement = pick('complement', student.complement);
  merged.neighborhood = pick('neighborhood', student.neighborhood);
  merged.city = pick('city', student.city);
  merged.state = pick('state', student.state);
  merged.claimed_belt = pick('claimed_belt', student.belt_label);
  return merged;
}

// Caminho 2: o aluno é NOVO na federação — abre a solicitação H1 que já
// existe (createPractitionerRequest), agora carimbada com student_id.
// NÃO marca is_federated: pendente não é federado; o marcador só vira true
// quando a federação aprova (ou quando o número existente é confirmado).
async function federateStudentByRequest(dojoId, federationId, studentId, { body, channel = null, actorLabel = null } = {}) {
  const student = await loadStudentOrThrow(dojoId, studentId);

  if (student.practitioner_id) {
    throw svcError(409, 'JA_FEDERADO', 'Este aluno já está vinculado a um praticante da federação.');
  }

  // Idempotente: pedir de novo devolve a solicitação pendente que existe.
  const pending = await findPendingRequestForStudent(dojoId, studentId);
  if (pending) {
    return {
      linked: false,
      student_id: studentId,
      federated: false,
      request_id: pending.id,
      status: 'pending',
      federation_link_status: 'pending',
      already_pending: true,
      created_at: pending.created_at,
      message: 'Já existe uma solicitação pendente para este aluno.',
    };
  }

  const result = await createPractitionerRequest({
    federationId,
    dojoId,
    body: mergeStudentIntoRequestPayload(student, body),
    channel,
    actorLabel,
    studentId,
  });

  if (result.status >= 400) {
    const e = svcError(result.status, result.body.code || 'ERROR', result.body.error);
    if (result.body.errors) e.errors = result.body.errors;
    throw e;
  }

  return {
    linked: false,
    student_id: studentId,
    federated: false,
    request_id: result.body.id,
    status: 'pending',
    federation_link_status: 'pending',
    already_pending: result.body.already_pending === true,
    created_at: result.body.created_at,
    fpkt_lookup: result.body.fpkt_lookup || null,
  };
}

// Desfederar = o DOJÔ deixa de reivindicar o praticante.
//
// ⚠️ NÃO APAGA NADA em karate_practitioners/customers de propósito: o
// praticante pertence à FEDERAÇÃO e continua existindo (com número, faixa,
// histórico) mesmo que o dojô tenha marcado o aluno errado. Sair do
// cadastro federado é ato da federação, nunca efeito colateral de um
// clique no portal do dojô. (A FK da migration 262 é ON DELETE SET NULL
// justamente pela mesma razão, no sentido contrário.)
async function unfederateStudent(dojoId, studentId) {
  const ok = await writeFederationLink(dojoId, studentId, { practitionerId: null, federated: false });
  if (!ok) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  return {
    unlinked: true,
    id: studentId,
    student_id: studentId,
    federated: false,
    practitioner_id: null,
    fpkt_number: null,
    federation_link_status: 'none',
  };
}

// ── Import em lote (até 500 linhas JSON já parseadas pelo front) ──
// Formato da linha: { full_name, birth_date?, cpf?, phone?, email?,
//                     belt_label?, guardian_name?, guardian_phone? }
// Transação ÚNICA: ou o lote inteiro entra, ou nada entra. Contadores são
// computados em JS — NENHUM try/catch best-effort DENTRO do BEGIN (evita
// tx-poison); qualquer falha inesperada aborta o lote com ROLLBACK.
//
// F7.0: o import continua com o conjunto de colunas de sempre, de
// propósito. Ele roda DENTRO de um BEGIN e um 42703 (migration 262
// pendente) envenenaria a transação inteira; a retentativa degradada
// exigiria SAVEPOINT por linha. RG/endereço entram pelo form/PATCH, que
// são fora de transação e têm o fallback.
async function importStudents(dojoId, rows) {
  if (!Array.isArray(rows)) {
    throw svcError(422, 'VALIDATION_ERROR', 'Corpo esperado: { rows: [...] } (array de linhas já parseadas)');
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    throw svcError(422, 'IMPORT_TOO_LARGE', `Máximo de ${IMPORT_MAX_ROWS} linhas por importação`);
  }
  const warnings = [];
  let created = 0;
  let skipped = 0;
  if (!rows.length) return { created, skipped, warnings };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const seenCpfs = new Set();
    const guardianCache = new Map(); // lower(nome)|phone → id (dedupe no lote)

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 1;
      const r = rows[i] || {};

      const fullName = r.full_name != null ? String(r.full_name).trim() : '';
      if (!fullName) {
        skipped++;
        warnings.push({ row: rowNum, code: 'MISSING_NAME', message: 'Linha sem full_name — ignorada' });
        continue;
      }

      // Import é TOLERANTE: campo inválido vira warning + campo NULL (a linha
      // entra mesmo assim). Diferente do form, onde inválido é 422.
      let birthDate = null;
      if (r.birth_date != null && String(r.birth_date).trim() !== '') {
        const v = String(r.birth_date).trim();
        if (isValidDateStr(v)) birthDate = v;
        else warnings.push({ row: rowNum, code: 'INVALID_BIRTH_DATE', message: `birth_date inválido ("${v}") — aluno importado sem data de nascimento` });
      }

      let cpf = null;
      if (r.cpf != null && String(r.cpf).trim() !== '') {
        const digits = normalizeCpf(r.cpf);
        if (digits && digits.length === 11) cpf = digits;
        else warnings.push({ row: rowNum, code: 'INVALID_CPF', message: 'cpf inválido — aluno importado sem CPF' });
      }

      let email = null;
      if (r.email != null && String(r.email).trim() !== '') {
        const v = String(r.email).trim();
        if (EMAIL_RE.test(v)) email = v;
        else warnings.push({ row: rowNum, code: 'INVALID_EMAIL', message: 'email inválido — aluno importado sem e-mail' });
      }

      const phone = r.phone != null && String(r.phone).trim() !== '' ? String(r.phone).trim() : null;
      const beltLabel = r.belt_label != null && String(r.belt_label).trim() !== '' ? String(r.belt_label).trim() : null;

      // Dedupe por (dojo_id, cpf): no lote (Set) e no banco (SELECT na MESMA
      // conexão/transação — também enxerga linhas já inseridas neste lote).
      // Checar ANTES de inserir evita 23505 no UNIQUE parcial (que abortaria
      // a transação inteira).
      if (cpf) {
        if (seenCpfs.has(cpf)) {
          skipped++;
          warnings.push({ row: rowNum, code: 'DUP_CPF', message: 'CPF duplicado no lote — linha ignorada' });
          continue;
        }
        const dup = await client.query(
          `SELECT id FROM karate_dojo_students WHERE dojo_id = $1 AND cpf = $2 LIMIT 1`,
          [dojoId, cpf]
        );
        if (dup.rows.length) {
          skipped++;
          warnings.push({ row: rowNum, code: 'DUP_CPF', message: 'CPF já cadastrado neste dojô — linha ignorada' });
          continue;
        }
        seenCpfs.add(cpf);
      }

      // Responsável on-the-fly quando guardian_name vier (dedupe por
      // nome+phone no mesmo lote/dojô).
      let guardianId = null;
      if (r.guardian_name != null && String(r.guardian_name).trim() !== '') {
        const gName = String(r.guardian_name).trim();
        const gPhone = r.guardian_phone != null && String(r.guardian_phone).trim() !== '' ? String(r.guardian_phone).trim() : null;
        const key = `${gName.toLowerCase()}|${gPhone || ''}`;
        if (guardianCache.has(key)) {
          guardianId = guardianCache.get(key);
        } else {
          const found = await client.query(
            `SELECT id FROM karate_dojo_guardians
              WHERE dojo_id = $1 AND lower(full_name) = lower($2)
                AND COALESCE(phone, '') = COALESCE($3, '')
              LIMIT 1`,
            [dojoId, gName, gPhone]
          );
          if (found.rows.length) {
            guardianId = found.rows[0].id;
          } else {
            const ins = await client.query(
              `INSERT INTO karate_dojo_guardians (dojo_id, full_name, phone)
               VALUES ($1, $2, $3) RETURNING id`,
              [dojoId, gName, gPhone]
            );
            guardianId = ins.rows[0].id;
          }
          guardianCache.set(key, guardianId);
        }
      }

      // Import TOLERANTE: menor sem responsável na planilha entra MESMO
      // ASSIM, com warning (o bloqueio 422 MENOR_SEM_RESPONSAVEL é só no form).
      if (birthDate && isMinor(birthDate) && !guardianId) {
        warnings.push({ row: rowNum, code: 'MENOR_SEM_RESPONSAVEL', message: 'Menor de 18 anos sem responsável vinculado — importado mesmo assim; vincule um responsável depois' });
      }

      await client.query(
        `INSERT INTO karate_dojo_students
           (dojo_id, full_name, birth_date, cpf, phone, email, belt_label, guardian_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
         RETURNING id`,
        [dojoId, fullName, birthDate, cpf, phone, email, beltLabel, guardianId]
      );
      created++;
    }

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    throw e;
  } finally {
    client.release();
  }

  return { created, skipped, warnings };
}

// ── Responsáveis (CRUD mínimo) ──
async function listGuardians(dojoId) {
  const { rows } = await db.query(
    `SELECT g.id, g.full_name, g.cpf, g.phone, g.email, g.relationship,
            g.created_at, g.updated_at,
            count(s.id)::int AS students_count
       FROM karate_dojo_guardians g
       LEFT JOIN karate_dojo_students s ON s.guardian_id = g.id
      WHERE g.dojo_id = $1
      GROUP BY g.id
      ORDER BY g.full_name ASC
      LIMIT 1000`,
    [dojoId]
  );
  return rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    cpf: r.cpf || null,
    phone: r.phone || null,
    email: r.email || null,
    relationship: r.relationship || null,
    students_count: Number(r.students_count) || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

async function createGuardian(dojoId, data) {
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_guardians (dojo_id, full_name, cpf, phone, email, relationship)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, full_name, cpf, phone, email, relationship, created_at, updated_at`,
    [
      dojoId,
      data.full_name,
      data.cpf !== undefined ? data.cpf : null,
      data.phone !== undefined ? data.phone : null,
      data.email !== undefined ? data.email : null,
      data.relationship !== undefined ? data.relationship : null,
    ]
  );
  return rows[0];
}

const GUARDIAN_UPDATABLE_COLS = ['full_name', 'cpf', 'phone', 'email', 'relationship'];

async function updateGuardian(dojoId, guardianId, data) {
  const existing = await db.query(
    `SELECT id, full_name, cpf, phone, email, relationship, created_at, updated_at
       FROM karate_dojo_guardians
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [guardianId, dojoId]
  );
  if (!existing.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Responsável não encontrado neste dojô');
  }
  const sets = [];
  const vals = [];
  for (const col of GUARDIAN_UPDATABLE_COLS) {
    if (data[col] !== undefined) {
      vals.push(data[col]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return existing.rows[0]; // PATCH vazio = no-op
  sets.push('updated_at = now()');
  vals.push(guardianId, dojoId);
  const upd = await db.query(
    `UPDATE karate_dojo_guardians SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
      RETURNING id, full_name, cpf, phone, email, relationship, created_at, updated_at`,
    vals
  );
  return upd.rows[0];
}

module.exports = {
  IMPORT_MAX_ROWS,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  IDENTITY_COLS,
  computeAge,
  isMinor,
  parsePaging,
  validateStudentPayload,
  validateGuardianPayload,
  listStudents,
  listStudentsPaged,
  countStudents,
  getSummary,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
  importStudents,
  listGuardians,
  createGuardian,
  updateGuardian,
  // F5a
  federateStudentByFpktNumber,
  federateStudentByRequest,
  unfederateStudent,
};
