// ============================================================
// AURA KARATÊ — Track K: Runner de aplicação da fila de sync
//
// Puxa os eventos 'pending' de UMA federação e aplica cada um via
// applyEvent (src/services/karateApplyEvent.js), gravando o status de
// volta em karate_sync_events. Espelha o estilo do motor da Track F
// (uma transação por evento, re-tentativa leve com `attempts`).
//
// Diferença vs. processFederationQueue (Track F, motor LIGHT que só dá
// ack): aqui APLICAMOS o payload de fato. As duas convivem — a Track F
// delega o ack para cá (ver edição mínima em karateSyncEngine.applyEvent),
// e esta rota /sync/apply é o disparo manual dedicado (adminOnly).
//
// DEFENSIVO: se karate_sync_events ainda não existir (deploy parcial),
// devolve um resumo vazio sem estourar. Se a migration 179
// (karate_sync_applied / karate_attendance) não estiver aplicada, cada
// evento volta 'deferred' e PERMANECE pending (não drena) — seguro.
// ============================================================
'use strict';

const db = require('../config/database');
const { applyEvent, isMissingSchema } = require('./karateApplyEvent');

const BATCH = 200;
const MAX_ATTEMPTS = 5;

/**
 * Aplica a fila pendente de uma federação.
 * @returns { applied, duplicate, parked, ignored, invalid, deferred, retried, failed, scanned }
 */
async function runFederationApply(federationId, opts = {}) {
  const max = opts.max || BATCH;
  const summary = {
    scanned: 0, applied: 0, duplicate: 0, parked: 0,
    ignored: 0, invalid: 0, deferred: 0, retried: 0, failed: 0,
  };

  let pend;
  try {
    pend = await db.query(
      `SELECT id, connection_id, federation_id, dojo_id, direction,
              event_type, status, payload, attempts
       FROM karate_sync_events
       WHERE federation_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT $2`,
      [federationId, max]
    );
  } catch (err) {
    if (isMissingSchema(err)) {
      return { ...summary, _note: 'karate_sync_events ausente (migration 171 não aplicada).' };
    }
    throw err;
  }

  for (const ev of pend.rows) {
    summary.scanned++;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let outcome;
      try {
        outcome = await applyEvent(client, ev);
      } catch (e) {
        outcome = { ok: false, recoverable: !!e.recoverable, error: e.message };
      }

      if (outcome.deferred) {
        // Schema da Track K ausente: não drena, mantém pending sem incrementar
        // attempts (não é falha do evento, é falta de migration).
        await client.query('ROLLBACK');
        summary.deferred++;
        continue;
      }

      if (outcome.ok) {
        await client.query(
          `UPDATE karate_sync_events SET status = 'ok', processed_at = NOW(), error = $2 WHERE id = $1`,
          [ev.id, outcome.invalid ? `invalid: ${outcome.detail || ''}` : null]
        );
        await client.query('COMMIT');
        if (outcome.applied) summary.applied++;
        else if (outcome.duplicate) summary.duplicate++;
        else if (outcome.parked) summary.parked++;
        else if (outcome.ignored) summary.ignored++;
        else if (outcome.invalid) summary.invalid++;
        else summary.applied++; // annuity sem cobrança ainda conta como processado
      } else {
        // Falha recuperável: ROLLBACK PRIMEIRO para desfazer a reivindicação
        // (claim) na trilha karate_sync_applied — senão a re-tentativa veria a
        // chave já gravada e trataria como duplicata, nunca aplicando. Depois
        // do ROLLBACK a conexão volta a autocommit; gravamos o status numa
        // statement separada (fora da transação abortada).
        await client.query('ROLLBACK');
        const attempts = (ev.attempts || 0) + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        await client.query(
          `UPDATE karate_sync_events SET attempts = $1, status = $2, error = $3 WHERE id = $4`,
          [attempts, dead ? 'failed' : 'pending', outcome.error || 'falha ao aplicar', ev.id]
        );
        if (dead) summary.failed++; else summary.retried++;
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      // Erro de infra na própria transação de status: conta como retried e segue.
      summary.retried++;
    } finally {
      client.release();
    }
  }

  return summary;
}

module.exports = { runFederationApply, MAX_ATTEMPTS, BATCH };
