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
// vínculo N:N (migration 277) mora aqui — buscar-ou-criar responsável,
// gravar os vínculos, rebaixar o principal, e o fragmento de SQL que
// devolve a lista na MESMA query da ficha. O service só chama.
//
// REGRA DO PRINCIPAL: no máximo UM is_primary por aluno (índice parcial
// uq_karate_dojo_student_guardians_primary). Quem escreve REBAIXA os
// outros (UPDATE ... SET is_primary = false) ANTES de gravar o novo —
// nenhum ON CONFLICT deste arquivo mira o índice parcial, só o UNIQUE
// TOTAL (student_id, guardian_id). Mirar índice parcial sem repetir o
// predicado é 42P10 → 500 genérico + ROLLBACK (armadilha conhecida).
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
// DEPLOY PARCIAL (CLAUDE.md #1): o backend sobe ANTES da migration 277.
// HAS_LINK_TABLE degrada na primeira 42P01/42703 da tabela nova e o
// sistema volta a se comportar EXATAMENTE como antes (responsável único
// por guardian_id) — nunca deixa de servir a ficha do aluno.
// ============================================================
'use strict';

const db = require('../config/database');

// migration 277 (F13). Ver comentário de topo.
let HAS_LINK_TABLE = true;

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
  console.warn('[karateDojoStudentGuardians] vínculo N:N ausente (migration 277 pendente) — degradando para responsável único:', e.message);
  return true;
}

function hasLinkTable() {
  return HAS_LINK_TABLE;
}

// ── Leitura: a lista vem na MESMA query da ficha ──
// Nenhuma query nova entra na frente de nada (armadilha da fila de mocks
// dos testes de integração, que contam db.query.mock.calls.length).
// Sem a migration 277, o fragmento vira um literal — o shape da resposta
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
// é o que mantém a ficha correta ANTES da migration 277 rodar e para
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
    out.unshift({ ...legacy, is_primary: !alreadyPrimary });
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

// Resolve a lista pedida pelo front em ids de responsável DESTE dojô.
// guardian_id existente é CONFERIDO no escopo do dojô (422 se for de
// outro) — nunca aceitamos id do corpo sem checar.
async function resolveGuardians(exec, dojoId, list) {
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

// INSERT multi-linha (uma query para os N vínculos, nunca uma por
// responsável). ON CONFLICT mira o UNIQUE TOTAL (student_id, guardian_id).
async function upsertLinks(exec, studentId, resolved) {
  if (!resolved.length) return;
  const params = [studentId];
  const tuples = resolved.map((g) => {
    params.push(g.guardian_id, g.relationship, g.is_primary);
    return `($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
  });
  await exec.query(
    `-- tag:student_guardian_link_upsert
     INSERT INTO karate_dojo_student_guardians (student_id, guardian_id, relationship, is_primary)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (student_id, guardian_id) DO UPDATE
        SET relationship = COALESCE(EXCLUDED.relationship, karate_dojo_student_guardians.relationship),
            is_primary   = EXCLUDED.is_primary`,
    params
  );
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
// continua viva — ver cabeçalho da migration 277). Escopado por dojo_id,
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
  findOrCreateGuardian,
  resolveGuardians,
  upsertLinks,
  demotePrimary,
  replaceLinks,
  syncPrimaryColumn,
  listForStudent,
};
