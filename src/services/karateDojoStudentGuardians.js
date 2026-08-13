// ============================================================
// AURA DOJÔ — F13: DOIS responsáveis por aluno (camada de vínculo)
//
// DECISÃO DO DONO DO PRODUTO (Caio, 12/08/2026):
//   "Vamos usar os dois contatos separados, penso que em um caso de
//    emergência com uma criança, é bom ter o contato de ambos."
// Um aluno menor pode ter MÃE e PAI como responsáveis, cada um com o SEU
// contato — não um único responsável derivado.
//
// POR QUE UM MÓDULO PRÓPRIO: karateDojoStudentService.js já tem ~2.000
// linhas e três famílias de fallback de schema. Toda a mecânica do
// vínculo N:N (migration 280) mora aqui — buscar-ou-criar responsável,
// gravar os vínculos, rebaixar o principal, e o fragmento de SQL que
// devolve a lista na MESMA query da ficha. O service só chama.
//
// REGRA DO PRINCIPAL: no máximo UM is_primary por aluno (índice PARCIAL
// uq_kdsg_one_primary_per_student, migration 280). Quem escreve REBAIXA
// os outros (UPDATE ... SET is_primary = false) ANTES de gravar o novo —
// nenhum ON CONFLICT deste arquivo mira o índice parcial, só o UNIQUE
// TOTAL uq_kdsg_student_guardian (student_id, guardian_id). Mirar índice
// parcial sem repetir o predicado é 42P10 → 500 genérico + ROLLBACK
// (armadilha conhecida; trava estática em
// tests/unit/onConflictPartialIndexGuard.test.js).
//
// ESCOPO: esta tabela NÃO tem dojo_id (o escopo vem do aluno). Todo
// chamador aqui já recebe um studentId de um aluno JÁ escopado por
// dojo_id no service (mesmo caminho de escopo do GET — armadilha
// "group shared write path"), e o JOIN com karate_dojo_guardians ainda
// confere g.dojo_id, para nunca vazar responsável de outro dojô.
//
// ÂNCORAS `-- tag:nome` NAS SQL: os testes despacham o mock por essas
// âncoras, nunca por fila posicional nem por "o nome da tabela aparece na
// string" — assim uma query nova (ou renomeada) não rouba a resposta de
// outra, e mudar a formatação da SQL não quebra teste nenhum.
//
// DEPLOY PARCIAL (CLAUDE.md #1): o backend sobe ANTES da migration 280.
// HAS_LINK_TABLE degrada na primeira 42P01/42703 da tabela nova e o
// sistema volta a se comportar EXATAMENTE como antes (responsável único
// por guardian_id) — nunca deixa de servir a ficha do aluno.
//
// ⚠️ DENTRO DE TRANSAÇÃO A DEGRADAÇÃO PRECISA DE SAVEPOINT: um 42P01
// dentro de um BEGIN envenena a transação inteira (armadilha
// "tx poison best-effort"), então try/catch cru não serve. É por isso que
// upsertLinksBatchInTx existe: ela abre SAVEPOINT, tenta, e no erro dá
// ROLLBACK TO SAVEPOINT — a transação do import continua viva e os
// alunos entram com o responsável principal (guardian_id), como antes.
// ============================================================
'use strict';

const db = require('../config/database');

// migration 280 (F13). Ver comentário de topo.
let HAS_LINK_TABLE = true;

// Teto de responsáveis por aluno. Não é regra de negócio dura — é freio
// contra corpo malformado (um array de 500 "responsáveis" viraria 500
// INSERTs). Mãe, pai, e mais dois (avó, padrasto) cobrem o mundo real.
const MAX_GUARDIANS_PER_STUDENT = 4;

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// Só degrada por causa da coisa NOVA: 42P01 de karate_dojo_students
// continua subindo (a rota responde schema_pending, migration 242).
function isLinkSchemaError(e) {
  if (!e || (e.code !== '42P01' && e.code !== '42703')) return false;
  return /karate_dojo_student_guardians|is_primary/i.test(e.message || '');
}

// Devolve true quando ESTA chamada foi a que degradou — o chamador usa
// isso para decidir se vale UMA retentativa (nunca em cadeia).
function noteSchemaError(e) {
  if (!HAS_LINK_TABLE || !isLinkSchemaError(e)) return false;
  HAS_LINK_TABLE = false;
  console.warn('[karateDojoStudentGuardians] vínculo N:N ausente (migration 280 pendente) — degradando para responsável único:', e.message);
  return true;
}

function hasLinkTable() {
  return HAS_LINK_TABLE;
}

// ── Leitura: a lista vem na MESMA query da ficha ──
// Nenhuma query nova entra na frente de nada (armadilha da fila de mocks
// dos testes de integração, que contam db.query.mock.calls.length).
// Sem a migration 280, o fragmento vira um literal — o shape da resposta
// não muda de formato, só vem vazio (mesma mecânica de identityFields).
function guardiansJsonField(p) {
  if (!HAS_LINK_TABLE) return `'[]'::json AS guardians_json`;
  return `COALESCE((
             -- tag:student_guardians_json
             SELECT json_agg(json_build_object(
                      'id', g2.id,
                      'full_name', g2.full_name,
                      'cpf', g2.cpf,
                      'phone', g2.phone,
                      'email', g2.email,
                      'relationship', COALESCE(sg.relationship, g2.relationship),
                      'is_primary', sg.is_primary
                    ) ORDER BY sg.is_primary DESC, g2.full_name ASC)
               FROM karate_dojo_student_guardians sg
               JOIN karate_dojo_guardians g2
                 ON g2.id = sg.guardian_id AND g2.dojo_id = ${p}dojo_id
              WHERE sg.student_id = ${p}id
           ), '[]'::json) AS guardians_json`;
}

function shapeLink(raw) {
  if (!raw || !raw.id) return null;
  return {
    id: raw.id,
    full_name: raw.full_name || null,
    cpf: raw.cpf || null,
    phone: raw.phone || null,
    email: raw.email || null,
    relationship: raw.relationship || null,
    is_primary: raw.is_primary === true,
  };
}

// Monta a lista de responsáveis da ficha a partir da row do SELECT.
// `legacy` é o responsável que veio pelo guardian_id (LEFT JOIN de
// sempre): entra na lista quando ainda não houver vínculo para ele —
// é o que mantém a ficha correta ANTES da migration 280 rodar e para
// qualquer escrita antiga que só tenha mexido em guardian_id.
function guardiansFromRow(row, legacy) {
  const out = [];
  const seen = new Set();

  let raw = row && row.guardians_json;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { raw = []; }
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const g = shapeLink(item);
      if (g && !seen.has(g.id)) {
        seen.add(g.id);
        out.push(g);
      }
    }
  }

  if (legacy && legacy.id && !seen.has(legacy.id)) {
    // O principal do jeito antigo: entra na frente e é o principal, a
    // menos que a lista JÁ tenha declarado um.
    const alreadyPrimary = out.some((g) => g.is_primary);
    out.unshift({ ...shapeLink(legacy), is_primary: !alreadyPrimary });
    seen.add(legacy.id);
  }

  return out;
}

// Quem é o principal da lista (o que espelha students.guardian_id).
function primaryOf(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find((g) => g.is_primary) || list[0];
}

// ── Escrita ──
function trimOrNull(v) {
  return v != null && String(v).trim() !== '' ? String(v).trim() : null;
}

// Validação PURA do corpo (sem banco) — usada por
// validateStudentPayload. Devolve { errors, list }: `list` só existe
// quando não há erro. Regra da casa: ausente é neutro (o chamador nem
// chama), INVÁLIDO é 422.
function validateGuardiansInput(raw) {
  const errors = [];
  if (raw === null) return { errors, list: [] }; // null explícito = "sem responsável"
  if (!Array.isArray(raw)) {
    errors.push('guardians deve ser uma lista');
    return { errors, list: null };
  }
  if (raw.length > MAX_GUARDIANS_PER_STUDENT) {
    errors.push(`Máximo de ${MAX_GUARDIANS_PER_STUDENT} responsáveis por aluno`);
    return { errors, list: null };
  }
  const list = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`guardians[${i}] deve ser um objeto`);
      continue;
    }
    const guardianId = trimOrNull(item.guardian_id);
    const fullName = trimOrNull(item.full_name);
    if (!guardianId && !fullName) {
      errors.push(`guardians[${i}] precisa de guardian_id (responsável existente) ou full_name (para criar)`);
      continue;
    }
    list.push({
      guardian_id: guardianId,
      full_name: fullName,
      cpf: trimOrNull(item.cpf),
      phone: trimOrNull(item.phone),
      email: trimOrNull(item.email),
      relationship: trimOrNull(item.relationship),
      is_primary: item.is_primary === true || item.is_primary === 'true',
    });
  }
  return { errors, list: errors.length ? null : list };
}

// Busca-ou-cria por (dojo, lower(nome), telefone) — MESMA chave que o
// import usa no cache do lote, de propósito: é o que faz irmãos
// compartilharem o mesmo responsável em vez de duplicá-lo.
async function findOrCreateGuardian(exec, dojoId, entry) {
  const fullName = trimOrNull(entry.full_name);
  if (!fullName) {
    throw svcError(422, 'VALIDATION_ERROR', 'Responsável sem full_name (informe guardian_id de um responsável existente ou full_name para criar)');
  }
  const phone = trimOrNull(entry.phone);
  const found = await exec.query(
    `-- tag:guardian_find
     SELECT id FROM karate_dojo_guardians
      WHERE dojo_id = $1 AND lower(full_name) = lower($2)
        AND COALESCE(phone, '') = COALESCE($3, '')
      LIMIT 1`,
    [dojoId, fullName, phone]
  );
  if (found.rows.length) return found.rows[0].id;

  const ins = await exec.query(
    `-- tag:guardian_create
     INSERT INTO karate_dojo_guardians (dojo_id, full_name, cpf, phone, email, relationship)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [dojoId, fullName, trimOrNull(entry.cpf), phone, trimOrNull(entry.email), trimOrNull(entry.relationship)]
  );
  return ins.rows[0].id;
}

// Busca por NOME dentro do dojô, ignorando o telefone. Serve ao
// responsável SEM contato (o "segundo" do import: a planilha do Areikan
// traz um telefone só, então o pai entra nomeado e sem número para o
// sensei completar). Ignorar o telefone aqui é de propósito: sem isso, um
// pai já cadastrado COM telefone viraria um segundo cadastro SEM — e o
// dojô passaria a ter duas linhas da mesma pessoa.
async function findGuardianByName(exec, dojoId, fullName) {
  const name = trimOrNull(fullName);
  if (!name) return null;
  const found = await exec.query(
    `-- tag:guardian_find_by_name
     SELECT id FROM karate_dojo_guardians
      WHERE dojo_id = $1 AND lower(full_name) = lower($2)
      ORDER BY (phone IS NOT NULL) DESC, created_at ASC
      LIMIT 1`,
    [dojoId, name]
  );
  return found.rows.length ? found.rows[0].id : null;
}

// Resolve a lista pedida pelo front em ids de responsável DESTE dojô.
// guardian_id existente é CONFERIDO no escopo do dojô (422 se for de
// outro) — nunca aceitamos id do corpo sem checar.
async function resolveGuardians(exec, dojoId, list) {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_GUARDIANS_PER_STUDENT) {
    throw svcError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_GUARDIANS_PER_STUDENT} responsáveis por aluno`);
  }
  const resolved = [];
  const seen = new Set();
  for (const entry of list) {
    let guardianId = trimOrNull(entry.guardian_id);
    if (guardianId) {
      const g = await exec.query(
        `-- tag:guardian_scope_check
         SELECT id FROM karate_dojo_guardians WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
        [guardianId, dojoId]
      );
      if (!g.rows.length) {
        throw svcError(422, 'GUARDIAN_NOT_FOUND', 'Responsável não encontrado neste dojô');
      }
    } else {
      guardianId = await findOrCreateGuardian(exec, dojoId, entry);
    }
    if (seen.has(guardianId)) continue; // o mesmo adulto duas vezes é ruído, não erro
    seen.add(guardianId);
    resolved.push({
      guardian_id: guardianId,
      relationship: trimOrNull(entry.relationship),
      is_primary: entry.is_primary === true,
    });
  }
  // Exatamente UM principal: respeita o que veio marcado; sem marcação,
  // o primeiro da lista é o principal (é a ordem que o front mostra).
  if (resolved.length) {
    const idx = resolved.findIndex((g) => g.is_primary);
    resolved.forEach((g, i) => { g.is_primary = i === (idx >= 0 ? idx : 0); });
  }
  return resolved;
}

// Monta o INSERT multi-linha dos vínculos. `entries` é
// [{ student_id, guardian_id, relationship, is_primary }] — de UM aluno
// (PATCH) ou de VÁRIOS (import em lote): a SQL é a mesma, o que muda é
// quantas tuplas entram. UMA query, nunca uma por responsável.
//
// ON CONFLICT mira uq_kdsg_student_guardian, que é UNIQUE TOTAL — e
// índice total NÃO leva predicado (repetir um WHERE aqui seria o erro
// inverso). O índice PARCIAL uq_kdsg_one_primary_per_student NÃO é
// arbiter de nada neste arquivo: o principal é garantido rebaixando os
// outros ANTES (demotePrimary), não por upsert.
function buildLinkInsert(entries) {
  const params = [];
  const tuples = entries.map((e) => {
    params.push(e.student_id, e.guardian_id, e.relationship, e.is_primary === true);
    return `($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
  });
  const sql =
    `-- tag:student_guardian_link_upsert
     INSERT INTO karate_dojo_student_guardians (student_id, guardian_id, relationship, is_primary)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (student_id, guardian_id) DO UPDATE
        SET relationship = COALESCE(EXCLUDED.relationship, karate_dojo_student_guardians.relationship),
            is_primary   = EXCLUDED.is_primary,
            updated_at   = now()`;
  return { sql, params };
}

async function upsertLinks(exec, studentId, resolved) {
  if (!resolved.length) return;
  const { sql, params } = buildLinkInsert(
    resolved.map((g) => ({ student_id: studentId, ...g }))
  );
  await exec.query(sql, params);
}

// Versão para DENTRO de uma transação já aberta (o import). SAVEPOINT
// porque 42P01/42703 dentro de BEGIN envenena a transação inteira: sem
// isso, a migration 280 pendente derrubaria a importação dos 484 alunos
// em vez de só deixá-los com o responsável principal.
// Devolve true quando os vínculos foram gravados.
async function upsertLinksBatchInTx(client, entries) {
  if (!HAS_LINK_TABLE || !entries.length) return false;
  const { sql, params } = buildLinkInsert(entries);
  await client.query('SAVEPOINT sp_kdsg_links');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT sp_kdsg_links');
    return true;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_kdsg_links');
    if (!noteSchemaError(e)) throw e; // erro que NÃO é schema novo sobe
    return false;
  }
}

// Rebaixa TODOS os principais do aluno. Roda ANTES de gravar o novo
// principal — sem isso, dois is_primary = true coexistiriam por um
// instante e o índice PARCIAL estouraria 23505.
async function demotePrimary(exec, studentId) {
  await exec.query(
    `-- tag:student_guardian_demote
     UPDATE karate_dojo_student_guardians SET is_primary = false
      WHERE student_id = $1 AND is_primary`,
    [studentId]
  );
}

// Substitui o CONJUNTO de responsáveis do aluno (o que o PATCH da ficha
// faz): tira quem saiu, rebaixa o principal antigo, grava os atuais.
// `resolved` vazio = aluno fica SEM responsável (é uma escolha explícita
// do sensei; a regra do menor é checada no service, antes de chamar).
async function replaceLinks(exec, studentId, resolved) {
  const keep = resolved.map((g) => g.guardian_id);
  if (keep.length) {
    await exec.query(
      `-- tag:student_guardian_prune
       DELETE FROM karate_dojo_student_guardians
        WHERE student_id = $1 AND guardian_id <> ALL($2::uuid[])`,
      [studentId, keep]
    );
  } else {
    await exec.query(
      `-- tag:student_guardian_clear
       DELETE FROM karate_dojo_student_guardians WHERE student_id = $1`,
      [studentId]
    );
  }
  await demotePrimary(exec, studentId);
  await upsertLinks(exec, studentId, resolved);
}

// Espelha o principal em karate_dojo_students.guardian_id (a coluna
// continua viva — ver cabeçalho da migration 280). Escopado por dojo_id,
// mesmo caminho de escopo do GET.
async function syncPrimaryColumn(exec, dojoId, studentId, primaryGuardianId) {
  await exec.query(
    `-- tag:student_guardian_primary_sync
     UPDATE karate_dojo_students SET guardian_id = $1, updated_at = now()
      WHERE id = $2 AND dojo_id = $3`,
    [primaryGuardianId, studentId, dojoId]
  );
}

// Leitura avulsa (rotas de vínculo). Escopo pelo DOJÔ DO ALUNO — o JOIN
// com students é o que impede ler vínculo de aluno de outro dojô.
async function listForStudent(dojoId, studentId, exec = db) {
  if (!HAS_LINK_TABLE) return [];
  const { rows } = await exec.query(
    `-- tag:student_guardian_list
     SELECT g.id, g.full_name, g.cpf, g.phone, g.email,
            COALESCE(sg.relationship, g.relationship) AS relationship,
            sg.is_primary
       FROM karate_dojo_student_guardians sg
       JOIN karate_dojo_students s ON s.id = sg.student_id
       JOIN karate_dojo_guardians g ON g.id = sg.guardian_id AND g.dojo_id = s.dojo_id
      WHERE sg.student_id = $1 AND s.dojo_id = $2
      ORDER BY sg.is_primary DESC, g.full_name ASC`,
    [studentId, dojoId]
  );
  return rows.map(shapeLink).filter(Boolean);
}

module.exports = {
  MAX_GUARDIANS_PER_STUDENT,
  hasLinkTable,
  isLinkSchemaError,
  noteSchemaError,
  guardiansJsonField,
  guardiansFromRow,
  primaryOf,
  shapeLink,
  trimOrNull,
  validateGuardiansInput,
  findOrCreateGuardian,
  findGuardianByName,
  resolveGuardians,
  buildLinkInsert,
  upsertLinks,
  upsertLinksBatchInTx,
  demotePrimary,
  replaceLinks,
  syncPrimaryColumn,
  listForStudent,
};
