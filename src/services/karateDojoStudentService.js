// ============================================================
// AURA DOJÔ — F2: Service de alunos do dojô (registro PRÓPRIO)
//
// DECISÃO CENTRAL: o aluno do dojô NÃO é o praticante federado
// (karate_practitioners/customers, que são da FEDERAÇÃO). É um registro
// próprio do dojô em karate_dojo_students (migration 242);
// practitioner_id fica NULL até o merge/sync com a FPKT ser definido —
// NENHUMA função aqui escreve nesse campo.
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
// Idade tz-safe: birth_date é date puro — NUNCA new Date('YYYY-MM-DD')
// (interpretaria como UTC e voltaria um dia em UTC-3); split manual.
// Todas as leituras de date usam to_char(...,'YYYY-MM-DD') para o driver
// não converter para Date com timezone.
// ============================================================
'use strict';

const db = require('../config/database');

const VALID_STATUS = ['active', 'inactive'];
const VALID_SEX_VALUES = ['M', 'F', 'other'];
const IMPORT_MAX_ROWS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
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
      const digits = String(b.cpf).replace(/\D/g, '');
      if (digits.length !== 11) errors.push('cpf inválido (esperados 11 dígitos)');
      else data.cpf = digits; // normalizado — o UNIQUE (dojo_id, cpf) depende disso
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
    else if (!VALID_SEX_VALUES.includes(b.sex)) errors.push(`sex inválido. Use: ${VALID_SEX_VALUES.join(', ')}`);
    else data.sex = b.sex;
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
      const digits = String(b.cpf).replace(/\D/g, '');
      if (digits.length !== 11) errors.push('cpf inválido (esperados 11 dígitos)');
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
    `to_char(${p}enrolled_at, 'YYYY-MM-DD') AS enrolled_at, ${p}created_at, ${p}updated_at`
  );
}

function shapeStudent(row) {
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
    enrolled_at: row.enrolled_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Consultas ──
async function listStudents(dojoId, { status = null, q = null, belt = null } = {}) {
  const { rows } = await db.query(
    `SELECT ${studentFields('s.')},
            g.full_name AS guardian_full_name, g.phone AS guardian_phone,
            g.relationship AS guardian_relationship
       FROM karate_dojo_students s
       LEFT JOIN karate_dojo_guardians g ON g.id = s.guardian_id
      WHERE s.dojo_id = $1
        AND ($2::text IS NULL OR s.status = $2)
        AND ($3::text IS NULL OR s.full_name ILIKE '%' || $3 || '%'
             OR s.cpf = regexp_replace($3, '\\D', '', 'g'))
        AND ($4::text IS NULL OR s.belt_label = $4)
      ORDER BY s.full_name ASC
      LIMIT 1000`,
    [dojoId, status, q, belt]
  );
  return rows.map((r) => {
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
  const { rows } = await db.query(
    `SELECT ${studentFields('s.')},
            g.full_name AS guardian_full_name, g.cpf AS guardian_cpf,
            g.phone AS guardian_phone, g.email AS guardian_email,
            g.relationship AS guardian_relationship
       FROM karate_dojo_students s
       LEFT JOIN karate_dojo_guardians g ON g.id = s.guardian_id
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  );
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

  const { rows } = await db.query(
    `INSERT INTO karate_dojo_students
       (dojo_id, full_name, birth_date, cpf, sex, phone, email, photo_url,
        belt_label, belt_order, status, guardian_id, consent_lgpd, notes, enrolled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             COALESCE($11, 'active'), $12, COALESCE($13, false), $14, $15)
     RETURNING ${studentFields('')}`,
    [
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
    ]
  );
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

async function updateStudent(dojoId, studentId, data) {
  const existing = await db.query(
    `SELECT ${studentFields('')} FROM karate_dojo_students
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  );
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

  const sets = [];
  const vals = [];
  for (const col of UPDATABLE_COLS) {
    if (data[col] !== undefined) {
      vals.push(data[col]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  sets.push('updated_at = now()');
  vals.push(studentId, dojoId);
  const upd = await db.query(
    `UPDATE karate_dojo_students SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
      RETURNING ${studentFields('')}`,
    vals
  );
  const s = shapeStudent(upd.rows[0]);
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

// ── Import em lote (até 500 linhas JSON já parseadas pelo front) ──
// Formato da linha: { full_name, birth_date?, cpf?, phone?, email?,
//                     belt_label?, guardian_name?, guardian_phone? }
// Transação ÚNICA: ou o lote inteiro entra, ou nada entra. Contadores são
// computados em JS — NENHUM try/catch best-effort DENTRO do BEGIN (evita
// tx-poison); qualquer falha inesperada aborta o lote com ROLLBACK.
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
        const digits = String(r.cpf).replace(/\D/g, '');
        if (digits.length === 11) cpf = digits;
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
  computeAge,
  isMinor,
  validateStudentPayload,
  validateGuardianPayload,
  listStudents,
  getSummary,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
  importStudents,
  listGuardians,
  createGuardian,
  updateGuardian,
};
