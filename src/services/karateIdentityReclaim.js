// ============================================================
// AURA DOJÔ — F7.4: DEVOLVER A GESTÃO DA FICHA QUANDO O DOJÔ SAI
//
// A PREMISSA (Caio, 30/07/2026)
//   "Quando o dojô sai, os dados permanecem visíveis para a federação, mas sem
//    o acesso e gestão do dojô. Ou seja, a gestão volta para a federação."
//
// É DEVOLUÇÃO DE GESTÃO, NÃO REMOÇÃO DE DADO. Este arquivo escreve DUAS
// colunas e nada mais:
//   customers.karate_identity_managed_by  'dojo' → 'federation'
//   customers.karate_identity_dojo_id     <dojô> → NULL
// Nome, CPF, RG, endereço, foto, matrícula, faixa, histórico: tudo continua
// exatamente onde estava. O aluno do dojô (karate_dojo_students) também não é
// tocado — inclusive practitioner_id, para que reconectar/re-federar volte a
// funcionar pela conferência da F7.1 (mostrar → perguntar → gravar).
//
// ── AS DUAS COLUNAS ANDAM JUNTAS (não é estilo, é CHECK) ────
// A migration 262 criou customers_karate_identity_coherent:
//   CHECK (karate_identity_managed_by <> 'dojo' OR karate_identity_dojo_id IS NOT NULL)
// Zerar só uma das duas é 23514. Todo UPDATE aqui escreve as duas no mesmo
// statement, e o WHERE sempre confere o dono ANTES
// (`AND karate_identity_dojo_id = $dojo`), que é o que impede um dojô/rotina
// de "devolver" a ficha que OUTRO dojô adotou.
//
// ── ZERO DDL: por que a 264 continua livre ──────────────────
// A trilha usa a 263 como está. `action` = 'release' (o CHECK fecha em
// adopt|release|sync e 'release' já é o verbo da devolução no
// DELETE .../federate da F7.1) e `source`:
//   • 'sync_job'         → devolução AUTOMÁTICA (o sistema percebeu a saída:
//                          guarda preguiçosa, regularização em lote, exclusão
//                          do dojô). É a rotina agindo, não uma pessoa.
//   • 'federation_admin' → devolução MANUAL, pedida pela federação com motivo.
// Inventar um source novo seria 23514 no CHECK da 263 → a trilha se perderia
// e, pela regra "devolução sem rastro não acontece", a operação inteira seria
// descartada. Trocar rótulo bonito por perda de rastro é péssimo negócio.
//
// ── DEVOLUÇÃO SEM RASTRO NÃO ACONTECE ───────────────────────
// writeIdentityAudit (karateStudentIdentityLink) grava na 263 e, se ela não
// existir, cai para karate_dojo_roster_events (event='identity_released').
// Se NENHUMA das duas puder ser gravada, ele lança — e o erro sobe para o
// ROLLBACK do chamador. A única exceção é o caminho BEST-EFFORT da guarda
// preguiçosa (releaseAbandonedIdentityBestEffort), que roda numa transação
// PRÓPRIA: se ela falhar, a federação escreve assim mesmo (a decisão de
// liberar já foi tomada pela guarda) e o marcador fica para a regularização
// em lote. O que não pode acontecer é a federação ficar travada.
//
// ── TX-POISON ───────────────────────────────────────────────
// Nenhum try/catch nu dentro de BEGIN. writeIdentityAudit já roda em
// SAVEPOINT interno; os UPDATEs daqui são statements simples cujo erro deve
// abortar a transação do chamador (é isso que se quer). O único catch de
// "melhor esforço" está em releaseAbandonedIdentityBestEffort, que abre e
// fecha a PRÓPRIA transação — nunca a de ninguém.
//
// ── DEFENSIVO A SCHEMA (42703 / 42P01) ──────────────────────
// Sem a 262 não existem as colunas de gestão — e, portanto, não existe ficha
// adotada para devolver. Todo caminho aqui degrada para "nada a fazer"
// (schema_pending: true) em vez de estourar.
// ============================================================
'use strict';

const db = require('../config/database');
const { writeIdentityAudit } = require('./karateStudentIdentityLink');
const {
  dojoStateSelect,
  evaluateDojoExitFromRow,
  describeExit,
} = require('./karateDojoExitState');

// source dentro do CHECK da 263 — ver cabeçalho.
const SOURCE_AUTOMATIC = 'sync_job';
const SOURCE_MANUAL = 'federation_admin';

// Teto de segurança do lote. 9.783 praticantes hoje; ninguém precisa varrer
// tudo numa requisição HTTP.
const DEFAULT_SCAN_LIMIT = 500;
const MAX_SCAN_LIMIT = 5000;

function isSchemaMissing(e) {
  return !!(e && (e.code === '42703' || e.code === '42P01'));
}

// ── Candidatos: fichas adotadas + o estado do dojô que as adotou ──
// UMA query resolve as duas perguntas ("quem está adotado?" e "esse dojô ainda
// está no Aura?"). O JOIN é LEFT de propósito: dojô APAGADO tem que aparecer
// como candidato (company_missing), não sumir do resultado.
function candidatesSql(withLock) {
  return `
    SELECT c.id                          AS practitioner_id,
           c.name                        AS practitioner_label,
           c.karate_registration_number   AS fpkt_number,
           c.federation_id               AS federation_id,
           c.karate_identity_dojo_id      AS dojo_id,
           COALESCE(d.trade_name, d.legal_name) AS dojo_name,
           ${dojoStateSelect('d')}
      FROM customers c
      LEFT JOIN companies d ON d.id = c.karate_identity_dojo_id
     WHERE c.karate_identity_managed_by = 'dojo'
       AND ($1::uuid IS NULL OR c.federation_id = $1)
       AND ($2::uuid IS NULL OR c.karate_identity_dojo_id = $2)
     ORDER BY c.karate_identity_dojo_id, c.name
     LIMIT $3${withLock ? '\n       FOR UPDATE OF c' : ''}`;
}

// O WHERE repete o dono mesmo já tendo lido a linha: é a última linha de
// defesa contra devolver a ficha de outro dojô, e é o que o teste consegue
// asseverar.
const RELEASE_SQL = `
  UPDATE customers
     SET karate_identity_managed_by = 'federation',
         karate_identity_dojo_id = NULL,
         updated_at = now()
   WHERE id = $1
     AND karate_identity_managed_by = 'dojo'
     AND karate_identity_dojo_id = $2
  RETURNING id, name, karate_registration_number, federation_id`;

// A linha de `changes` da trilha. Sempre o mesmo formato da 263:
// { field, label, winner, federation_before, federation_after }.
function releaseChanges({ reason, exitReason }) {
  return [
    {
      field: 'karate_identity_managed_by',
      label: 'Gestão da ficha',
      winner: 'federation',
      federation_before: 'dojo',
      federation_after: 'federation',
      exit_reason: exitReason || null,
      reason: reason || null,
    },
  ];
}

// ── A devolução de UMA ficha, dentro da transação do chamador ──
// `client` é a conexão de uma transação JÁ ABERTA. Devolve null quando o
// UPDATE não casou (a ficha deixou de ser daquele dojô entre a leitura e a
// escrita) — sem escrever trilha de coisa nenhuma.
async function releaseOne(client, {
  practitionerId,
  dojoId,
  federationId = null,
  practitionerLabel = null,
  fpktNumber = null,
  reason = null,
  exitReason = null,
  source = SOURCE_AUTOMATIC,
  actor = null,
}) {
  const upd = await client.query(RELEASE_SQL, [practitionerId, dojoId]);
  if (!upd.rows.length) return null;
  const row = upd.rows[0];

  await writeIdentityAudit(client, { hasIdentityAudit: true }, {
    federationId: federationId || row.federation_id || null,
    dojoId,
    practitionerId: row.id,
    practitionerLabel: practitionerLabel || row.name || null,
    fpktNumber: fpktNumber || row.karate_registration_number || null,
    studentId: null,
    studentLabel: null,
    action: 'release',
    source,
    changes: releaseChanges({ reason, exitReason }),
    actorUserId: actor && actor.userId,
    actorLabel: actor && actor.label,
  });

  return {
    practitioner_id: row.id,
    practitioner_label: row.name || null,
    fpkt_number: row.karate_registration_number || null,
    dojo_id: dojoId,
    exit_reason: exitReason || null,
  };
}

// ── DEVOLUÇÃO EM LOTE DE UM DOJÔ (dentro da tx do chamador) ──
// Usada pelo interceptador de DELETE de dojô e pela retomada manual. Devolve
// TODAS as fichas que aquele dojô mantém — independentemente de ele ter
// "saído" ou não, porque quem chama aqui já decidiu (apagar o dojô, ou o staff
// pedindo a retomada com motivo).
async function releaseAllForDojoInTx(client, {
  dojoId,
  federationId = null,
  reason = null,
  exitReason = null,
  source = SOURCE_MANUAL,
  actor = null,
  limit = MAX_SCAN_LIMIT,
} = {}) {
  if (!dojoId) return { released: [], count: 0, schema_pending: false };

  const { rows } = await client.query(candidatesSql(true), [federationId || null, dojoId, limit]);
  const released = [];
  for (const row of rows) {
    const out = await releaseOne(client, {
      practitionerId: row.practitioner_id,
      dojoId,
      federationId: federationId || row.federation_id || null,
      practitionerLabel: row.practitioner_label,
      fpktNumber: row.fpkt_number,
      reason,
      exitReason,
      source,
      actor,
    });
    if (out) released.push(Object.assign(out, { dojo_name: row.dojo_name || null }));
  }
  return { released, count: released.length, schema_pending: false };
}

// ── RETOMADA MANUAL PELA FEDERAÇÃO (transação própria) ──────
// "o dojô sumiu mas ninguém cancelou nada": um ato explícito, com motivo, que
// resolve o dojô INTEIRO — sem depender de override praticante a praticante.
async function reclaimDojoIdentities({
  federationId,
  dojoId,
  reason,
  actor = null,
} = {}) {
  const motivo = reason == null ? '' : String(reason).trim();
  if (!dojoId) {
    const e = new Error('dojoId é obrigatório');
    e.status = 422;
    e.code = 'VALIDATION_ERROR';
    throw e;
  }
  if (motivo.length < 5) {
    const e = new Error(
      'Informe o motivo da retomada (ele fica registrado na trilha de cada ficha devolvida).'
    );
    e.status = 422;
    e.code = 'RECLAIM_REASON_REQUIRED';
    throw e;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await releaseAllForDojoInTx(client, {
      dojoId,
      federationId,
      reason: motivo,
      exitReason: 'federation_reclaim',
      source: SOURCE_MANUAL,
      actor,
    });
    await client.query('COMMIT');
    return {
      reclaimed: true,
      dojo_id: dojoId,
      count: out.count,
      released: out.released,
      reason: motivo,
      schema_pending: false,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    if (isSchemaMissing(e)) {
      console.warn('[karateIdentityReclaim] schema de identidade pendente (262/263) na retomada:', e.code);
      return { reclaimed: false, dojo_id: dojoId, count: 0, released: [], schema_pending: true };
    }
    throw e;
  } finally {
    client.release();
  }
}

// ── REGULARIZAÇÃO EM LOTE (o que ficou para trás) ───────────
// Varre as fichas adotadas, avalia o estado do dojô de cada uma e devolve as
// dos dojôs que saíram. `dryRun` devolve o relatório SEM escrever — é assim
// que se olha antes de agir.
async function regularizeExitedIdentities({
  federationId = null,
  dojoId = null,
  limit = DEFAULT_SCAN_LIMIT,
  dryRun = false,
  actor = null,
} = {}) {
  const cap = Math.min(MAX_SCAN_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_SCAN_LIMIT));

  let scan;
  try {
    scan = await db.query(candidatesSql(false), [federationId, dojoId, cap]);
  } catch (e) {
    if (isSchemaMissing(e)) {
      console.warn('[karateIdentityReclaim] schema de identidade pendente (262) na varredura:', e.code);
      return { checked: 0, released: [], count: 0, still_managed: 0, dry_run: !!dryRun, schema_pending: true };
    }
    throw e;
  }

  const candidates = [];
  let stillManaged = 0;
  for (const row of scan.rows) {
    const exit = evaluateDojoExitFromRow(row);
    if (!exit.exited) { stillManaged++; continue; }
    candidates.push({ row, exit });
  }

  const report = candidates.map(({ row, exit }) => ({
    practitioner_id: row.practitioner_id,
    practitioner_label: row.practitioner_label || null,
    fpkt_number: row.fpkt_number || null,
    dojo_id: row.dojo_id,
    dojo_name: row.dojo_name || null,
    exit_reason: exit.reason,
    exit_label: exit.label,
  }));

  if (dryRun || !candidates.length) {
    return {
      checked: scan.rows.length,
      released: report,
      count: dryRun ? 0 : 0,
      candidates: report.length,
      still_managed: stillManaged,
      dry_run: !!dryRun,
      schema_pending: false,
    };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const released = [];
    for (const { row, exit } of candidates) {
      const out = await releaseOne(client, {
        practitionerId: row.practitioner_id,
        dojoId: row.dojo_id,
        federationId: row.federation_id || federationId || null,
        practitionerLabel: row.practitioner_label,
        fpktNumber: row.fpkt_number,
        reason: describeExit(exit, row.dojo_name),
        exitReason: exit.reason,
        source: SOURCE_AUTOMATIC,
        actor,
      });
      if (out) released.push(Object.assign(out, { dojo_name: row.dojo_name || null, exit_label: exit.label }));
    }
    await client.query('COMMIT');
    return {
      checked: scan.rows.length,
      released,
      count: released.length,
      candidates: report.length,
      still_managed: stillManaged,
      dry_run: false,
      schema_pending: false,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    if (isSchemaMissing(e)) {
      console.warn('[karateIdentityReclaim] schema pendente na regularização:', e.code);
      return { checked: scan.rows.length, released: [], count: 0, still_managed: stillManaged, dry_run: false, schema_pending: true };
    }
    throw e;
  } finally {
    client.release();
  }
}

// ── DEVOLUÇÃO PREGUIÇOSA, BEST-EFFORT (chamada pela guarda) ──
// A guarda JÁ decidiu liberar a escrita da federação (a decisão não depende
// disto). Aqui só se arruma o marcador, numa transação PRÓPRIA, para o banco
// parar de mentir. NUNCA lança: se falhar, a escrita da federação acontece do
// mesmo jeito e o marcador fica para a regularização em lote — travar a
// federação por causa de uma faxina seria trocar o certo pelo perfeito.
async function releaseAbandonedIdentityBestEffort({
  practitionerId,
  dojoId,
  federationId = null,
  practitionerLabel = null,
  fpktNumber = null,
  dojoName = null,
  exit = null,
  actor = null,
} = {}) {
  if (!practitionerId || !dojoId || !exit || !exit.exited) return { released: false, reason: 'NOT_APPLICABLE' };

  let client;
  try {
    client = await db.connect();
  } catch (e) {
    console.warn('[karateIdentityReclaim] sem conexão para regularizar ficha órfã:', e && e.message);
    return { released: false, reason: 'NO_CONNECTION' };
  }

  try {
    await client.query('BEGIN');
    const out = await releaseOne(client, {
      practitionerId,
      dojoId,
      federationId,
      practitionerLabel,
      fpktNumber,
      reason: describeExit(exit, dojoName),
      exitReason: exit.reason,
      source: SOURCE_AUTOMATIC,
      actor,
    });
    await client.query('COMMIT');
    return { released: !!out, reason: exit.reason, detail: out || null };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    console.warn(
      '[karateIdentityReclaim] devolução preguiçosa falhou (a escrita da federação segue liberada):',
      (e && e.code) || '',
      e && e.message
    );
    return { released: false, reason: 'RELEASE_FAILED', error_code: (e && e.code) || null };
  } finally {
    try { client.release(); } catch (_) { /* já liberada */ }
  }
}

// ── RELATÓRIO: quais dojôs saíram e quantas fichas seguram ──
// Read-only. É a tela "o que está para trás" antes de clicar em regularizar.
async function listExitedDojos({ federationId = null, limit = MAX_SCAN_LIMIT } = {}) {
  let scan;
  try {
    scan = await db.query(candidatesSql(false), [federationId, null, Math.min(MAX_SCAN_LIMIT, limit)]);
  } catch (e) {
    if (isSchemaMissing(e)) {
      return { data: [], count: 0, practitioners_pending: 0, schema_pending: true };
    }
    throw e;
  }

  const byDojo = new Map();
  let pending = 0;
  for (const row of scan.rows) {
    const exit = evaluateDojoExitFromRow(row);
    if (!exit.exited) continue;
    pending++;
    const key = String(row.dojo_id);
    if (!byDojo.has(key)) {
      byDojo.set(key, {
        dojo_id: row.dojo_id,
        dojo_name: row.dojo_name || null,
        exit_reason: exit.reason,
        exit_label: exit.label,
        practitioners: 0,
      });
    }
    byDojo.get(key).practitioners++;
  }

  const data = Array.from(byDojo.values()).sort((a, b) => b.practitioners - a.practitioners);
  return { data, count: data.length, practitioners_pending: pending, schema_pending: false };
}

module.exports = {
  SOURCE_AUTOMATIC,
  SOURCE_MANUAL,
  DEFAULT_SCAN_LIMIT,
  MAX_SCAN_LIMIT,
  RELEASE_SQL,
  candidatesSql,
  releaseOne,
  releaseAllForDojoInTx,
  reclaimDojoIdentities,
  regularizeExitedIdentities,
  releaseAbandonedIdentityBestEffort,
  listExitedDojos,
};
