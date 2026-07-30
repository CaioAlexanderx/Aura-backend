// ============================================================
// AURA DOJÔ — F7.2: SINCRONIZAÇÃO CONTÍNUA DA IDENTIDADE (dojô → federação)
//
// A DECISÃO (Caio, 30/07/2026):
//   "A federação não faz gestão de informação. O trabalho dela é apenas
//    receber a sincronização dos dados gerenciados pelos dojôs."
//
// A REGRA, EM UMA FRASE
//   Quando um aluno com practitioner_id cujo praticante está adotado por
//   ESTE dojô (customers.karate_identity_managed_by = 'dojo' E
//   karate_identity_dojo_id = o dojô dono do aluno) tem a identidade
//   alterada, o praticante recebe a mesma alteração, na MESMA transação,
//   com trilha — e nunca o contrário.
//
// ── POR QUE ESTE ARQUIVO EXISTE (o que a F7.1 deixou faltando) ──
// A F7.1 copia a ficha UMA VEZ, no instante do vínculo. Depois disso o
// sensei edita o aluno e a federação não fica sabendo: no dia seguinte a
// ficha já divergiu de novo. Sem o sync contínuo, "o dojô é a fonte da
// identidade" vale por um segundo e depois vira mentira.
//
// ── ONDE O SYNC MORA E POR QUÊ ──────────────────────────────
// Aqui — um módulo próprio, chamado pelos DOIS caminhos de escrita do
// aluno (PATCH individual e import em lote), recebendo sempre o `client`
// de uma transação já aberta pelo chamador. As alternativas foram
// descartadas por motivo, não por gosto:
//
//   • GATILHO no banco. Subiria para o SQL regras que são de produto:
//     o vocabulário do sexo (M/F/other → masculino/feminino/outro), o
//     rótulo humano de cada campo na trilha e QUEM fez a alteração
//     (actor vem do token, o banco não tem esse dado). Pior: dispararia
//     também durante a ADOÇÃO da F7.1, que já grava os dois lados e já
//     escreve a trilha — a mesma mudança apareceria duas vezes no
//     histórico, uma delas sem ator. Gatilho também é invisível para o
//     teste e para o code review.
//
//   • DENTRO de karateDojoStudentService. Duplicaria a lista de campos, o
//     comparador e o gravador de trilha que JÁ existem na F7.1 — e a
//     divergência entre as duas listas seria questão de semanas. Além
//     disso o import precisa da versão em LOTE, que não tem lugar natural
//     no meio do CRUD.
//
//   • Módulo próprio (escolhido). A lista de campos continua sendo UMA
//     (IDENTITY_FIELDS da F7.1, importada abaixo — não copiada), o
//     comparador é o mesmo, a trilha é a mesma, e PATCH e import entram
//     pela mesma porta com semânticas idênticas.
//
// ── O QUE SOBE (e só isso) ──────────────────────────────────
// A lista é IDENTITY_FIELDS de karateStudentIdentityLink.js, sem filtro:
// nome, nascimento, CPF, RG, sexo, telefone, e-mail, endereço completo e
// foto. Se um campo entrar naquela lista, ele sobe aqui automaticamente —
// é o mesmo motivo de existir da lista única.
//
// ── O QUE NUNCA SOBE ────────────────────────────────────────
// Matrícula FPKT, papéis federativos (is_arbiter/is_instructor/
// is_examiner/is_assistant), is_active da filiação, dojo_id (onde a
// federação acha que a pessoa treina), faixa/dan/graduação e as próprias
// colunas de gestão da ficha. Isso é o que a federação EMITE — e o que
// ela emite ninguém edita por fora. A proteção não é "tomar cuidado":
// FEDERATION_OWNED_COLS abaixo é conferida contra IDENTITY_FIELDS no
// carregamento do módulo e o require ESTOURA se alguém acrescentar uma
// coluna da federação à lista de identidade.
//
// ── CAMPO ESVAZIADO: O DOJÔ NUNCA APAGA A FEDERAÇÃO ─────────
// Se o sensei apaga o telefone do aluno, o telefone do praticante NÃO é
// apagado. Só valor PREENCHIDO sobe; vazio do dojô é omissão, não ordem
// de apagar. Cinco razões, na ordem em que pesam:
//
//   1. HOJE O DOJÔ TEM MENOS DADO QUE A FEDERAÇÃO. RG e endereço só
//      passaram a existir no aluno com a migration 262 (ontem). Todo
//      aluno cadastrado antes disso tem rg/endereço NULL. Com a regra
//      oposta, o primeiro PATCH de telefone de um aluno adotado apagaria
//      o RG e o endereço do praticante na federação — sem ninguém pedir,
//      sem aparecer em tela, e sem volta.
//   2. "Dado faltante ≠ pendência" (regra da casa). Campo vazio é neutro:
//      significa "não digitei", nunca "esta pessoa não tem telefone".
//   3. É A MESMA REGRA QUE JÁ ESTÁ EM PRODUÇÃO. planResolution (F7.1):
//      "vencedor SEM valor = campo PULADO". Se o sync apagasse, o mesmo
//      gesto do sensei (editar a ficha) teria dois significados
//      diferentes conforme fosse a primeira ou a segunda gravação.
//   4. O ERRO É ASSIMÉTRICO. Manter um telefone velho é visível e se
//      conserta digitando o certo. Apagar um RG é invisível e não se
//      desfaz — a trilha guarda o valor, mas ninguém procura trilha de um
//      campo que não sabe que existia.
//   5. ESCALA. São 9.783 praticantes contra 6 alunos de dojô. A direção
//      "dojô manda" só é segura enquanto o dojô ACRESCENTA.
//
// Apagar continua sendo possível — mas como GESTO EXPLÍCITO, nunca como
// efeito colateral de um salvamento. Fica para a F7.3 (ver PR).
//
// ── FALHA DO SYNC NÃO DERRUBA O SALVAMENTO ──────────────────
// Tudo aqui roda dentro de SAVEPOINT. Erro → ROLLBACK TO SAVEPOINT: o
// UPDATE do aluno, que aconteceu ANTES na mesma transação, sobrevive ao
// COMMIT; só o sync é descartado. Nunca há try/catch nu dentro do BEGIN
// (armadilha tx-poison: o COMMIT viraria rollback silencioso).
// E não passa silencioso: vai para o log de erro E para a resposta da
// API (identity_sync: { status, fields, reason }).
//
// ── DEFENSIVO A SCHEMA (42703 / 42P01) ──────────────────────
// Não há sonda de information_schema aqui de propósito: a PRIMEIRA query
// do sync já é o guarda. Sem a migration 262 não existe
// karate_identity_managed_by, a query falha com 42703 dentro do
// SAVEPOINT, o sync é descartado com reason SCHEMA_PENDING e o aluno é
// salvo assim mesmo — que é exatamente o comportamento desejado, porque
// sem a 262 também não existe ficha adotada para sincronizar.
// ============================================================
'use strict';

const {
  IDENTITY_FIELDS,
  compareKey,
  hasValue,
  storeForFederation,
  writeIdentityAudit,
} = require('./karateStudentIdentityLink');

// Migration 263 fixou o CHECK de `source` em
// (dojo_federate | dojo_unfederate | federation_admin | sync_job | import).
// Nenhum valor novo é inventado aqui: um source fora do CHECK viraria
// 23514, a trilha seria perdida e o sync inteiro descartado — trocar
// clareza de rótulo por perda de rastro seria péssimo negócio. A
// desambiguação de rótulo, se um dia fizer falta, é DDL da F7.3.
const SOURCE_STUDENT_EDIT = 'sync_job'; // PATCH/ficha do aluno
const SOURCE_IMPORT = 'import';         // lote

// O que é da FEDERAÇÃO. Esta lista não é usada para montar SQL — ela
// existe para que a proteção seja EXECUTADA, e não apenas prometida em
// comentário (ver assertIdentityFieldsAreSafe).
const FEDERATION_OWNED_COLS = Object.freeze([
  'karate_registration_number',
  'federation_id',
  'dojo_id',
  'is_active',
  'is_arbiter',
  'is_instructor',
  'is_examiner',
  'is_assistant',
  'karate_belt',
  'karate_belt_label',
  'karate_belt_order',
  'karate_dan',
  'karate_graduation_date',
  'karate_identity_managed_by',
  'karate_identity_dojo_id',
  'affiliation_since',
  'annuity_status',
]);

// Guarda de carregamento: se alguém acrescentar uma coluna da federação a
// IDENTITY_FIELDS, o require estoura no boot (e no primeiro teste), em vez
// de a matrícula de alguém ser sobrescrita silenciosamente em produção.
function assertIdentityFieldsAreSafe() {
  const leak = IDENTITY_FIELDS
    .map((f) => f.fedCol)
    .filter((col) => FEDERATION_OWNED_COLS.includes(col));
  if (leak.length) {
    throw new Error(
      `[karateIdentitySync] campo da FEDERAÇÃO na lista de identidade: ${leak.join(', ')}. ` +
      'O dojô é dono da identidade da pessoa; a federação é dona do que ela EMITE. Reveja IDENTITY_FIELDS.'
    );
  }
}
assertIdentityFieldsAreSafe();

// Colunas do lado do ALUNO que disparam sync. Exportada para o service do
// aluno decidir, sem uma segunda lista, se o PATCH mexeu em identidade.
const DOJO_COLUMNS = Object.freeze(IDENTITY_FIELDS.map((f) => f.dojoCol));

// ============================================================
// LEITURA DOS DOIS LADOS
// ============================================================
// A foto é COALESCE(karate_photo_url, photo_url) dos dois lados —
// photo_url ficou DEPRECADA por COMMENT na 262, não foi dropada.
function readDojoValue(row, f) {
  if (!row) return null;
  if (f.coalescePhoto) {
    const v = row.karate_photo_url;
    return hasValue(v) ? v : (row.photo_url || null);
  }
  const v = row[f.dojoCol];
  return v === undefined ? null : v;
}

function fedSelectList(alias, prefix) {
  return IDENTITY_FIELDS.map((f) => {
    if (f.isDate) {
      // date puro via to_char: o driver devolveria Date com fuso e a data
      // voltaria um dia em UTC-3 (P0 de 15/07).
      return `to_char(${alias}.${f.fedCol}, 'YYYY-MM-DD') AS ${prefix}${f.key}`;
    }
    if (f.coalescePhoto) {
      return `COALESCE(${alias}.karate_photo_url, ${alias}.photo_url) AS ${prefix}${f.key}`;
    }
    return `${alias}.${f.fedCol} AS ${prefix}${f.key}`;
  }).join(', ');
}

function dojoSelectList(alias, prefix) {
  return IDENTITY_FIELDS.map((f) => {
    if (f.isDate) return `to_char(${alias}.${f.dojoCol}, 'YYYY-MM-DD') AS ${prefix}${f.key}`;
    if (f.coalescePhoto) {
      return `COALESCE(${alias}.karate_photo_url, ${alias}.photo_url) AS ${prefix}${f.key}`;
    }
    return `${alias}.${f.dojoCol} AS ${prefix}${f.key}`;
  }).join(', ');
}

// ============================================================
// O PLANO (a regra do esvaziamento mora aqui)
// ============================================================
// getDojo(f) / getFed(f) devolvem o valor CRU de cada lado. Nenhuma
// concatenação de identificador com dado do usuário: `col` sai sempre de
// IDENTITY_FIELDS.
function planSync(getDojo, getFed) {
  const writes = [];
  const changes = [];

  for (const f of IDENTITY_FIELDS) {
    const dojoRaw = getDojo(f);

    // ── A REGRA DO ESVAZIAMENTO (ver cabeçalho) ──
    // Vazio do dojô não apaga a federação. É a mesma linha de
    // planResolution da F7.1 ("vencedor SEM valor = campo PULADO").
    if (!hasValue(dojoRaw)) continue;

    const fedRaw = getFed(f);

    // Já dizem a mesma coisa (acento, caixa, máscara e vocabulário de sexo
    // normalizados só para COMPARAR — o que grava é o valor cru do dojô).
    if (hasValue(fedRaw) && compareKey(f.kind, dojoRaw) === compareKey(f.kind, fedRaw)) continue;

    const value = storeForFederation(f.kind, dojoRaw);
    // Valor que não sobrevive à normalização do lado da federação (CEP com
    // 5 dígitos, UF com 3 letras, sexo irreconhecível) é PULADO: gravá-lo
    // seria gravar NULL por cima de algo — a mesma destruição de dado que
    // a regra do esvaziamento existe para impedir.
    if (value === null) continue;

    writes.push({ col: f.fedCol, value });
    changes.push({
      field: f.key,
      label: f.label,
      winner: 'dojo',
      // O dojô não muda no sync: ele é a origem. before === after.
      dojo_before: dojoRaw,
      dojo_after: dojoRaw,
      federation_before: hasValue(fedRaw) ? fedRaw : null,
      federation_after: value,
    });
  }

  return { writes, changes };
}

// O UPDATE repete o guarda no WHERE mesmo já tendo o FOR UPDATE do SELECT.
// Redundante de propósito: é a última linha de defesa contra escrever numa
// ficha que a federação gerencia, e é o que o teste consegue asseverar.
function buildFederationUpdate(practitionerId, dojoId, writes) {
  const vals = [];
  const sets = writes.map((w) => {
    vals.push(w.value);
    return `${w.col} = $${vals.length}`;
  });
  sets.push('updated_at = now()');
  vals.push(practitionerId, dojoId);
  return {
    sql:
      `UPDATE customers SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1}
          AND karate_identity_managed_by = 'dojo'
          AND karate_identity_dojo_id = $${vals.length}
    RETURNING id`,
    vals,
  };
}

function skipped(reason) {
  return { status: 'skipped', synced: false, fields: [], reason };
}

function failed(e) {
  return {
    status: 'failed',
    synced: false,
    fields: [],
    reason: e && (e.code === '42703' || e.code === '42P01') ? 'SCHEMA_PENDING' : 'SYNC_ERROR',
    error_code: (e && e.code) || null,
  };
}

// ============================================================
// SYNC DE UM ALUNO (PATCH / ficha)
// ============================================================
// `client` é a conexão da transação JÁ ABERTA pelo chamador — o sync não
// abre transação nem faz COMMIT: quem salva o aluno é quem commita.
//
// NUNCA lança. Devolve sempre um resultado; a falha vai para o log e para
// a resposta da API. Derrubar o salvamento do aluno porque a federação não
// recebeu a cópia seria punir o sensei por um problema do outro lado.
const SINGLE_CANDIDATE_SQL = (alias) =>
  `SELECT c.id AS practitioner_id,
          c.name AS practitioner_label,
          c.karate_registration_number AS fpkt_number,
          ${fedSelectList(alias, '')}
     FROM customers c
    WHERE c.id = $1
      AND c.karate_identity_managed_by = 'dojo'
      AND c.karate_identity_dojo_id = $2
    LIMIT 1
      FOR UPDATE`;

async function syncStudentIdentity(client, {
  dojoId,
  federationId = null,
  studentId,
  practitionerId,
  student,
  studentLabel = null,
  actor = null,
  source = SOURCE_STUDENT_EDIT,
} = {}) {
  // Aluno sem praticante não tem o que sincronizar — e não custa uma query.
  if (!practitionerId) return skipped('NO_PRACTITIONER');
  if (!student) return skipped('NO_STUDENT_ROW');

  await client.query('SAVEPOINT sp_identity_sync');
  try {
    // UMA query resolve as três perguntas: o praticante existe, está
    // ADOTADO, e é ESTE dojô que o adotou. Sem linha = nada a fazer (os
    // 9.783 geridos pela federação caem aqui e continuam intactos).
    const { rows } = await client.query(SINGLE_CANDIDATE_SQL('c'), [practitionerId, dojoId]);
    if (!rows.length) {
      await client.query('RELEASE SAVEPOINT sp_identity_sync');
      return skipped('NOT_ADOPTED_BY_THIS_DOJO');
    }
    const fed = rows[0];

    // O sync compara a ficha INTEIRA, não só o campo que veio no PATCH.
    // De propósito: é idempotente e CONVERGE. Subir só o campo tocado
    // deixaria divergências antigas presas para sempre, e o sensei não tem
    // como saber quais são.
    const plan = planSync(
      (f) => readDojoValue(student, f),
      (f) => fed[f.key]
    );

    if (!plan.writes.length) {
      await client.query('RELEASE SAVEPOINT sp_identity_sync');
      return { status: 'ok', synced: false, fields: [], reason: 'ALREADY_IN_SYNC' };
    }

    const upd = buildFederationUpdate(fed.practitioner_id, dojoId, plan.writes);
    const res = await client.query(upd.sql, upd.vals);
    if (!res.rows.length) {
      // A ficha deixou de ser deste dojô entre o SELECT e o UPDATE (não
      // deveria, o FOR UPDATE segura) — desiste sem escrever trilha.
      await client.query('ROLLBACK TO SAVEPOINT sp_identity_sync');
      return skipped('NOT_ADOPTED_BY_THIS_DOJO');
    }

    // Sync sem rastro não existe: se a trilha não puder ser gravada (nem na
    // 263 nem no fallback de roster_events), writeIdentityAudit lança e o
    // catch abaixo descarta o sync inteiro.
    await writeIdentityAudit(client, { hasIdentityAudit: true }, {
      federationId,
      dojoId,
      practitionerId: fed.practitioner_id,
      practitionerLabel: fed.practitioner_label || null,
      fpktNumber: fed.fpkt_number || null,
      studentId,
      studentLabel: studentLabel || (student && student.full_name) || null,
      action: 'sync',
      source,
      changes: plan.changes,
      actorUserId: actor && actor.userId,
      actorLabel: actor && actor.label,
    });

    await client.query('RELEASE SAVEPOINT sp_identity_sync');
    return {
      status: 'ok',
      synced: true,
      practitioner_id: fed.practitioner_id,
      fields: plan.changes.map((c) => c.field),
    };
  } catch (e) {
    // ROLLBACK TO SAVEPOINT: descarta SÓ o sync. O UPDATE do aluno, que
    // veio antes nesta transação, continua de pé e será commitado.
    try {
      await client.query('ROLLBACK TO SAVEPOINT sp_identity_sync');
    } catch (_) {
      // Se nem o rollback do savepoint passou, a conexão morreu — o COMMIT
      // do chamador vai falhar e ele trata. Nada a fazer aqui.
    }
    console.error(
      '[karateIdentitySync] sync dojô→federação falhou (aluno salvo mesmo assim):',
      (e && e.code) || '',
      e && e.message
    );
    return failed(e);
  }
}

// ============================================================
// SYNC EM LOTE (import de até 500 linhas)
// ============================================================
// O import roda numa transação ÚNICA. Fazer 500 syncs individuais seriam
// 500 SELECTs de candidato — por isso o lote tem porta própria:
//
//   1 SELECT para TODOS os alunos do lote (só volta quem está adotado por
//     ESTE dojô: hoje, ninguém — o import não federa ninguém);
//   1 UPDATE apenas para as fichas que REALMENTE divergem (não por linha
//     importada: por ficha com diferença);
//   1 trilha por ficha sincronizada.
//
// Lista vazia = ZERO query. Como o INSERT do import nunca grava
// practitioner_id, hoje o custo do sync no lote é literalmente nada — o
// caminho existe para que, quando o import passar a aceitar número FPKT,
// o lote já suba por aqui e não por 500 idas ao banco.
const BATCH_CANDIDATE_SQL =
  `SELECT s.id AS student_id,
          s.full_name AS student_label,
          c.id AS practitioner_id,
          c.name AS practitioner_label,
          c.karate_registration_number AS fpkt_number,
          ${dojoSelectList('s', 'd_')},
          ${fedSelectList('c', 'f_')}
     FROM karate_dojo_students s
     JOIN customers c ON c.id = s.practitioner_id
    WHERE s.dojo_id = $2
      AND s.id = ANY($1::uuid[])
      AND c.karate_identity_managed_by = 'dojo'
      AND c.karate_identity_dojo_id = $2
    ORDER BY s.id
      FOR UPDATE OF c`;

async function syncStudentsBatch(client, {
  dojoId,
  federationId = null,
  studentIds = [],
  actor = null,
  source = SOURCE_IMPORT,
} = {}) {
  const ids = Array.isArray(studentIds) ? studentIds.filter(Boolean) : [];
  if (!ids.length) {
    return { status: 'ok', synced: 0, checked: 0, fields: [], reason: 'NOTHING_TO_SYNC' };
  }

  await client.query('SAVEPOINT sp_identity_sync_batch');
  try {
    const { rows } = await client.query(BATCH_CANDIDATE_SQL, [ids, dojoId]);
    let synced = 0;
    const fields = [];

    for (const row of rows) {
      const plan = planSync(
        (f) => row[`d_${f.key}`],
        (f) => row[`f_${f.key}`]
      );
      if (!plan.writes.length) continue;

      const upd = buildFederationUpdate(row.practitioner_id, dojoId, plan.writes);
      const res = await client.query(upd.sql, upd.vals);
      if (!res.rows.length) continue;

      await writeIdentityAudit(client, { hasIdentityAudit: true }, {
        federationId,
        dojoId,
        practitionerId: row.practitioner_id,
        practitionerLabel: row.practitioner_label || null,
        fpktNumber: row.fpkt_number || null,
        studentId: row.student_id,
        studentLabel: row.student_label || null,
        action: 'sync',
        source,
        changes: plan.changes,
        actorUserId: actor && actor.userId,
        actorLabel: actor && actor.label,
      });

      synced++;
      for (const c of plan.changes) if (!fields.includes(c.field)) fields.push(c.field);
    }

    await client.query('RELEASE SAVEPOINT sp_identity_sync_batch');
    return { status: 'ok', synced, checked: rows.length, fields };
  } catch (e) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT sp_identity_sync_batch');
    } catch (_) { /* conexão pode ter caído */ }
    console.error(
      '[karateIdentitySync] sync em lote falhou (import preservado):',
      (e && e.code) || '',
      e && e.message
    );
    return Object.assign(failed(e), { synced: 0, checked: 0 });
  }
}

module.exports = {
  DOJO_COLUMNS,
  FEDERATION_OWNED_COLS,
  SOURCE_STUDENT_EDIT,
  SOURCE_IMPORT,
  syncStudentIdentity,
  syncStudentsBatch,
  // Exportados para teste/inspeção: o plano é a regra de negócio deste PR
  // (em especial a regra do esvaziamento) e precisa ser testável sem banco.
  planSync,
  readDojoValue,
  assertIdentityFieldsAreSafe,
};
