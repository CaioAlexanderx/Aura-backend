// ============================================================
// AURA DOJÔ — F11: Tags configuráveis do aluno (migration 274)
//
// Pedido do dono do produto: a planilha real do 1º dojô a entrar (Areikan,
// Araraquara/SP, 484 alunos) tem uma coluna "Academia" (4 locais de
// treino) que não existe no modelo. Decisão: vira TAG configurável pelo
// sensei — NÃO é "unidade" nem dojô separado. Um aluno pode ter VÁRIAS
// tags (começa em "academia" e cresce para "bolsista", "competição",
// "turma da manhã" etc). Gerida em Configurações (CRUD completo).
//
// ANCORAGEM: karate_dojo_tags (catálogo por dojô) + karate_dojo_student_tags
// (vínculo N:N aluno↔tag), sempre em karate_dojo_students — NUNCA em
// customers (tag é do dojô; aluno não federado também tem tag).
//
// DESATIVAR, NÃO APAGAR: DELETE só é aceito quando a tag NUNCA foi usada
// (0 vínculos) — corrige o "oops" de nome digitado errado. Tag em uso é
// 409 TAG_EM_USO; o caminho é PATCH {active:false}, que preserva os
// vínculos (histórico intacto) e só bloqueia NOVAS atribuições.
//
// Escopo SEMPRE por dojoId (vem de req.dojoId no guard — nunca do
// body/query). Toda SQL abaixo carrega uma âncora `-- dtag:<nome>` (mesmo
// espírito do `-- f81:` de karateDojoBeltExamService.js) para permitir
// mock por SQL nos testes — dispatch por regex sobre a âncora, NUNCA fila
// posicional (CLAUDE.md deste repo: já derrubou o CI 4 vezes).
//
//   parseActiveFilter, validateTagPayload
//   listTags, getTag, createTag, updateTag, deleteTag
//   listStudentTags, assignTag, removeTagFromStudent
// ============================================================
'use strict';

const db = require('../config/database');

const NAME_MAX_LEN = 60; // rótulo curto — "SESC Areikan", não um parágrafo
const COLOR_MAX_LEN = 20; // sem formato imposto (hex ou nome), só um teto de tamanho

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

const TAG_FIELDS = 't.id, t.dojo_id, t.name, t.color, t.active, t.created_at, t.updated_at';
const TAG_FIELDS_PLAIN = 'id, dojo_id, name, color, active, created_at, updated_at';

// student_count conta TODOS os vínculos (independente do status do aluno —
// active/inactive). É "quantos alunos têm esta tag", não "quantos ativos
// têm esta tag"; quem quiser cruzar com status combina no front com o
// ?status= de GET /dojo/students.
function shapeTag(row, { withCount = true } = {}) {
  const out = {
    id: row.id,
    dojo_id: row.dojo_id,
    name: row.name,
    color: row.color || null,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withCount) out.student_count = row.student_count != null ? Number(row.student_count) : 0;
  return out;
}

// ?active=true|false — ausente/inválido = TODOS ("dado faltante ≠
// pendência": o sensei precisa ver as desativadas pra poder reativar).
function parseActiveFilter(raw) {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

function validateTagPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.name !== undefined) {
    const name = b.name != null ? String(b.name).trim() : '';
    if (!name) errors.push('Campo name é obrigatório');
    else if (name.length > NAME_MAX_LEN) errors.push(`name deve ter no máximo ${NAME_MAX_LEN} caracteres`);
    else data.name = name;
  }

  if (b.color !== undefined) {
    if (b.color === null || String(b.color).trim() === '') {
      data.color = null;
    } else {
      const v = String(b.color).trim();
      if (v.length > COLOR_MAX_LEN) errors.push(`color deve ter no máximo ${COLOR_MAX_LEN} caracteres`);
      else data.color = v;
    }
  }

  if (b.active !== undefined) {
    data.active = b.active === true || b.active === 'true';
  }

  return { errors, data };
}

// ── Listagem + leitura ──
async function listTags(dojoId, { active = null } = {}) {
  const { rows } = await db.query(
    `-- dtag:list
     SELECT ${TAG_FIELDS}, count(st.student_id)::int AS student_count
       FROM karate_dojo_tags t
       LEFT JOIN karate_dojo_student_tags st ON st.tag_id = t.id
      WHERE t.dojo_id = $1
        AND ($2::boolean IS NULL OR t.active = $2)
      GROUP BY t.id
      ORDER BY t.name ASC`,
    [dojoId, active]
  );
  return rows.map((r) => shapeTag(r));
}

async function getTag(dojoId, tagId) {
  const { rows } = await db.query(
    `-- dtag:get
     SELECT ${TAG_FIELDS}, count(st.student_id)::int AS student_count
       FROM karate_dojo_tags t
       LEFT JOIN karate_dojo_student_tags st ON st.tag_id = t.id
      WHERE t.id = $1 AND t.dojo_id = $2
      GROUP BY t.id`,
    [tagId, dojoId]
  );
  return rows.length ? shapeTag(rows[0]) : null;
}

// ── Escrita ──
async function createTag(dojoId, data) {
  try {
    const { rows } = await db.query(
      `-- dtag:create
       INSERT INTO karate_dojo_tags (dojo_id, name, color, active)
       VALUES ($1, $2, $3, COALESCE($4, true))
       RETURNING ${TAG_FIELDS_PLAIN}`,
      [dojoId, data.name, data.color !== undefined ? data.color : null, data.active !== undefined ? data.active : null]
    );
    return shapeTag({ ...rows[0], student_count: 0 });
  } catch (e) {
    if (e && e.code === '23505') {
      // uq_karate_dojo_tags_dojo_name_ci — nome já existe neste dojô
      // (case-insensitive): "SESC" bate com "sesc" já cadastrada.
      throw svcError(409, 'DUPLICATE_TAG_NAME', 'Já existe uma tag com este nome neste dojô');
    }
    throw e;
  }
}

async function updateTag(dojoId, tagId, data) {
  if (!Object.keys(data).length) {
    const existing = await getTag(dojoId, tagId);
    if (!existing) throw svcError(404, 'NOT_FOUND', 'Tag não encontrada neste dojô');
    return existing; // PATCH vazio = no-op, mesmo espírito de updateStudent
  }

  const sets = [];
  const vals = [];
  for (const col of ['name', 'color', 'active']) {
    if (data[col] !== undefined) {
      vals.push(data[col]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  sets.push('updated_at = now()');
  vals.push(tagId, dojoId);

  try {
    const { rows } = await db.query(
      `-- dtag:update
       UPDATE karate_dojo_tags SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
        RETURNING id`,
      vals
    );
    if (!rows.length) throw svcError(404, 'NOT_FOUND', 'Tag não encontrada neste dojô');
    // Recarrega com student_count atualizado (o UPDATE não recalcula isso).
    return getTag(dojoId, rows[0].id);
  } catch (e) {
    if (e && e.status) throw e;
    if (e && e.code === '23505') {
      throw svcError(409, 'DUPLICATE_TAG_NAME', 'Já existe uma tag com este nome neste dojô');
    }
    throw e;
  }
}

// DELETE de verdade só quando a tag NUNCA foi usada — preserva o
// histórico de quem já foi marcado (regra do produto: "desativar, não
// apagar"). Uma tag em uso é 409 TAG_EM_USO; o caminho é PATCH
// {active:false} (ver comentário no topo do arquivo e na migration 274).
async function deleteTag(dojoId, tagId) {
  const { rows: found } = await db.query(
    `-- dtag:delete-lookup
     SELECT id FROM karate_dojo_tags WHERE id = $1 AND dojo_id = $2`,
    [tagId, dojoId]
  );
  if (!found.length) throw svcError(404, 'NOT_FOUND', 'Tag não encontrada neste dojô');

  const { rows: usage } = await db.query(
    `-- dtag:delete-usage
     SELECT count(*)::int AS n FROM karate_dojo_student_tags WHERE tag_id = $1`,
    [tagId]
  );
  if (usage.length && Number(usage[0].n) > 0) {
    throw svcError(
      409,
      'TAG_EM_USO',
      'Esta tag está atribuída a alunos. Desative em vez de excluir para preservar o histórico.'
    );
  }

  await db.query(
    `-- dtag:delete
     DELETE FROM karate_dojo_tags WHERE id = $1 AND dojo_id = $2`,
    [tagId, dojoId]
  );
  return { deleted: true, id: tagId };
}

// ── Atribuição aluno↔tag ──
// Escopo SEMPRE pelo dojo_id do token: confere ALUNO e TAG contra
// req.dojoId (nunca confia num tag_id/student_id "solto" vindo do body).
async function assertStudentInDojo(dojoId, studentId) {
  const { rows } = await db.query(
    `-- dtag:assert-student
     SELECT id FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2`,
    [studentId, dojoId]
  );
  if (!rows.length) throw svcError(404, 'STUDENT_NOT_FOUND', 'Aluno não encontrado neste dojô');
}

async function assertTagInDojo(dojoId, tagId) {
  const { rows } = await db.query(
    `-- dtag:assert-tag
     SELECT id, active FROM karate_dojo_tags WHERE id = $1 AND dojo_id = $2`,
    [tagId, dojoId]
  );
  if (!rows.length) throw svcError(404, 'TAG_NOT_FOUND', 'Tag não encontrada neste dojô');
  return rows[0];
}

async function listStudentTags(dojoId, studentId) {
  await assertStudentInDojo(dojoId, studentId);
  const { rows } = await db.query(
    `-- dtag:list-student-tags
     SELECT ${TAG_FIELDS}
       FROM karate_dojo_student_tags st
       JOIN karate_dojo_tags t ON t.id = st.tag_id
      WHERE st.student_id = $1 AND t.dojo_id = $2
      ORDER BY t.name ASC`,
    [studentId, dojoId]
  );
  return rows.map((r) => shapeTag(r, { withCount: false }));
}

// Atribuir uma tag DESATIVADA é bloqueado (422 TAG_INATIVA) — desativada
// significa "parar de usar", não teria sentido crescer o uso dela.
// Remover uma tag desativada continua liberado (ver removeTagFromStudent).
async function assignTag(dojoId, studentId, tagId) {
  await assertStudentInDojo(dojoId, studentId);
  const tag = await assertTagInDojo(dojoId, tagId);
  if (!tag.active) {
    throw svcError(422, 'TAG_INATIVA', 'Não é possível atribuir uma tag desativada. Reative a tag ou escolha outra.');
  }
  await db.query(
    `-- dtag:assign
     INSERT INTO karate_dojo_student_tags (student_id, tag_id)
     VALUES ($1, $2)
     ON CONFLICT (student_id, tag_id) DO NOTHING`,
    [studentId, tagId]
  );
  return listStudentTags(dojoId, studentId);
}

// Remoção é idempotente: tag não atribuída não é erro (mesmo espírito do
// DELETE .../federate — desfazer algo que já não existe não deve travar).
async function removeTagFromStudent(dojoId, studentId, tagId) {
  await assertStudentInDojo(dojoId, studentId);
  await db.query(
    `-- dtag:remove
     DELETE FROM karate_dojo_student_tags
      WHERE student_id = $1
        AND tag_id = $2
        AND tag_id IN (SELECT id FROM karate_dojo_tags WHERE dojo_id = $3)`,
    [studentId, tagId, dojoId]
  );
  return listStudentTags(dojoId, studentId);
}

module.exports = {
  parseActiveFilter,
  validateTagPayload,
  listTags,
  getTag,
  createTag,
  updateTag,
  deleteTag,
  listStudentTags,
  assignTag,
  removeTagFromStudent,
  assertStudentInDojo,
  assertTagInDojo,
};
