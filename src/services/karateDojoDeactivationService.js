// ============================================================
// AURA DOJÔ — "EXCLUIR DOJÔ" É DESATIVAR. NADA É APAGADO.
//
// POR QUE ESTE ARQUIVO EXISTE (compliance, 11/08/2026)
//   DELETE /federation/:id/dojos/:dojoId apagava a linha de `companies` de
//   verdade e, com ?cascade=true, arrastava na mesma transação HTTP os
//   `customers` do dojô — e com eles, por ON DELETE CASCADE do schema,
//   `karate_belt_history` (as GRADUAÇÕES), certificados e inscrições. Havia
//   207 FKs CASCADE apontando para `companies`.
//
//   Os termos de uso do Aura obrigam a guardar os dados por 60 dias. Apagar
//   na hora é descumprimento contratual — e o dado apagado incluía a
//   graduação de faixa, o registro mais importante da vida de um praticante.
//
//   Decisão do dono do produto (11/08/2026): "a rota passa a desativar em vez
//   de apagar. Dessa forma podemos disponibilizar os dados e também excluir
//   posteriormente sem nos impactar ou sem impactar a federação."
//
// O PADRÃO QUE ESTE MÓDULO SEGUE (não é invenção)
//   src/routes/userCompanies.js, DELETE /me/companies/:companyId: apesar do
//   verbo HTTP, faz `UPDATE companies SET is_active = false, updated_at = NOW()`.
//   Não existe deleted_at/archived_at em `companies` — o padrão é is_active.
//   A cascata dojô→praticantes é a MESMA do PATCH is_active=false
//   (cascadeInactivateDojo em src/routes/karateDojos.js): snapshot em
//   karate_dojo_roster_events + UPDATE customers SET is_active=false. É o que
//   torna a operação REVERSÍVEL por PATCH { is_active: true }, que já existe
//   e já restaura exatamente esse snapshot (cascadeReactivateDojo).
//
// O QUE ESTE MÓDULO NUNCA FAZ
//   Não emite DELETE. Nenhum. Nem em companies, nem em customers, nem em
//   karate_practitioner_transfers — e por isso NÃO liga o escape hatch
//   `SET LOCAL app.allow_transfer_purge` da migration 221: sem DELETE, o
//   trigger de imutabilidade das transferências não tem por que ser furado.
//
// RETENÇÃO ≠ EXPURGO
//   Este módulo só CARIMBA quando e por quem a remoção foi pedida (migration
//   277). A limpeza depois dos 60 dias é fase própria e não mora aqui. O job
//   futuro deve exigir `is_active = false AND removal_requested_at < now() -
//   60 days` — o is_active na condição é o que faz um dojô reativado sair da
//   fila sozinho, mesmo com o carimbo antigo ainda na linha.
//
// DEFENSIVO (armadilha_schema_pre_migration do CLAUDE.md)
//   A migration 277 NÃO é aplicada por este PR. Enquanto ela não roda,
//   HAS_REMOVAL_STAMP_COLS cai para false no primeiro 42703 e a desativação
//   segue normalmente sem o carimbo. Desativar nunca pode depender de coluna
//   de auditoria.
// ============================================================
'use strict';

const db = require('../config/database');

// Prazo dos termos de uso. Vive aqui para a resposta da API poder dizer ao
// operador, na hora, por quanto tempo o dado continua disponível.
const RETENTION_DAYS = 60;

// Migration 277: companies.removal_requested_at / _by / _reason.
let HAS_REMOVAL_STAMP_COLS = true;
function _resetRemovalStampCache() {
  HAS_REMOVAL_STAMP_COLS = true;
}

// Contagem de dependentes. NÃO é mais uma barreira (o 409 HAS_HISTORY saiu —
// ver o cabeçalho da rota): é informação para a resposta dizer o tamanho do
// que foi desativado junto. Best-effort: uma tabela auxiliar ausente devolve
// contagem vazia, nunca derruba a desativação.
const COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM customers WHERE dojo_id = $1)::int AS practitioners,
    (SELECT COUNT(*) FROM karate_dojo_annuity_history WHERE dojo_id = $1)::int AS annuities,
    (SELECT COUNT(*) FROM transactions
       WHERE reference_type = 'karate_dojo' AND reference_id = $1)::int AS transactions,
    (SELECT COUNT(*) FROM karate_belt_history bh
       JOIN customers cu ON cu.id = bh.student_id
       WHERE cu.dojo_id = $1)::int AS belt_history,
    (SELECT COUNT(*) FROM karate_practitioner_transfers
       WHERE (origin_dojo_id = $1 OR destination_dojo_id = $1)
         AND voided_at IS NULL)::int AS transfers,
    (SELECT COUNT(*) FROM karate_dojo_connections WHERE dojo_id = $1)::int AS connections`;

// SAVEPOINT + tolerância a schema pendente. Mesmo helper (mesma intenção) do
// safeRosterWrite de karateDojos.js: try/catch solto dentro de BEGIN envenena
// a transação (armadilha_tx_poison_best_effort_savepoint do CLAUDE.md).
async function safeAux(client, label, fn) {
  await client.query('SAVEPOINT sp_dojo_deactivate');
  try {
    const out = await fn();
    await client.query('RELEASE SAVEPOINT sp_dojo_deactivate');
    return out;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) {
      await client.query('ROLLBACK TO SAVEPOINT sp_dojo_deactivate');
      console.warn(`[karateDojoDeactivation] passo ignorado (schema pendente): ${label}`);
      return null;
    }
    throw e;
  }
}

// Cascata dojô→praticantes, idêntica em efeito à cascadeInactivateDojo do
// PATCH: snapshot de quem estava ATIVO (para a reativação restaurar só esses)
// + desativação. Nenhum praticante é apagado.
async function snapshotAndDeactivateRoster(client, { dojoId, federationId, actorId }) {
  const snap = await client.query(
    `SELECT id, is_active FROM customers WHERE dojo_id = $1`,
    [dojoId]
  );
  const affected = snap.rows
    .filter((r) => r.is_active !== false) // COALESCE(is_active, true) === true
    .map((r) => ({ student_id: r.id, was_active: true }));

  await safeAux(client, 'inactivate_cascade event', () => client.query(
    `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
     VALUES ($1, $2, 'inactivate_cascade', $3::jsonb, $4)`,
    [dojoId, federationId, JSON.stringify(affected), actorId]
  ));

  await client.query(
    `UPDATE customers SET is_active = false, updated_at = NOW()
     WHERE dojo_id = $1 AND COALESCE(is_active, true) = true`,
    [dojoId]
  );

  return { affected_count: affected.length };
}

// O carimbo de retenção. Só reinicia o relógio quando o dojô estava ATIVO
// (é aí que a remoção foi pedida de fato); num dojô já inativo, preserva o
// carimbo que já existir e só preenche se estiver vazio.
const STAMPED_UPDATE_SQL = `
  UPDATE companies
     SET is_active = false,
         updated_at = NOW(),
         removal_requested_at = CASE WHEN COALESCE(companies.is_active, true) = true
                                     THEN NOW()
                                     ELSE COALESCE(companies.removal_requested_at, NOW()) END,
         removal_requested_by = CASE WHEN COALESCE(companies.is_active, true) = true
                                     THEN $3
                                     ELSE COALESCE(companies.removal_requested_by, $3) END,
         removal_reason       = CASE WHEN COALESCE(companies.is_active, true) = true
                                     THEN $4
                                     ELSE COALESCE(companies.removal_reason, $4) END
   WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
   RETURNING id, name, is_active, removal_requested_at`;

const PLAIN_UPDATE_SQL = `
  UPDATE companies
     SET is_active = false,
         updated_at = NOW()
   WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
   RETURNING id, name, is_active`;

async function deactivateDojo({ federationId, dojoId, actorId = null, reason = null } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Existência + escopo (federação + vertical). FOR UPDATE trava a linha
    // para dois pedidos concorrentes não decidirem o "estava ativo?" errado.
    const found = await client.query(
      `SELECT id, name, is_active FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
       FOR UPDATE`,
      [dojoId, federationId]
    );
    if (!found.rows.length) {
      await client.query('ROLLBACK');
      return { found: false };
    }

    const wasActive = found.rows[0].is_active !== false;

    const countsRes = await safeAux(client, 'contagem de dependentes', () =>
      client.query(COUNTS_SQL, [dojoId]));
    const counts = (countsRes && countsRes.rows[0]) || {};

    let updated = null;
    if (HAS_REMOVAL_STAMP_COLS) {
      const r = await safeAux(client, 'carimbo de retenção (migration 277)', () =>
        client.query(STAMPED_UPDATE_SQL, [dojoId, federationId, actorId, reason]));
      if (r) updated = r;
      else HAS_REMOVAL_STAMP_COLS = false;
    }
    if (!updated) {
      updated = await client.query(PLAIN_UPDATE_SQL, [dojoId, federationId]);
    }

    // Só cascateia na TRANSIÇÃO ativo→inativo. Num dojô já inativo, um novo
    // snapshot (vazio) viraria o último 'inactivate_cascade' e a reativação
    // não restauraria mais ninguém.
    let rosterCascade = null;
    if (wasActive) {
      rosterCascade = await snapshotAndDeactivateRoster(client, { dojoId, federationId, actorId });
    }

    await client.query('COMMIT');

    const row = (updated && updated.rows[0]) || {};
    return {
      found: true,
      id: dojoId,
      name: row.name || found.rows[0].name || null,
      was_active: wasActive,
      already_inactive: !wasActive,
      is_active: false,
      counts,
      roster_cascade: rosterCascade,
      removal_requested_at: row.removal_requested_at || null,
      retention_days: RETENTION_DAYS,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  RETENTION_DAYS,
  deactivateDojo,
  _resetRemovalStampCache,
};
