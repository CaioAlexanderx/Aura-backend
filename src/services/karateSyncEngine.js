// ============================================================
// AURA KARATÊ — Motor de Sincronização LIGHT (Track F / Fase 5)
//
// MODELO ASSÍNCRONO POR FILA (decisão Caio 09/06): federação e dojô
// raramente estão online ao mesmo tempo, então não há sync em tempo real.
//   - O dojô EMPILHA eventos pelo webhook (karate_sync_events status 'pending'),
//     quando estiver online.
//   - A federação PROCESSA quando abre o sistema (catch-up por "pull":
//     POST /federation/:id/connections/sync/run), e um varredor leve marca
//     dojôs que ficaram quietos demais (vira o aviso proativo da UI).
//
// Track K (14/06): a aplicação real de cada tipo de evento saiu do stub e
// passou a delegar para o motor consumidor idempotente
// (src/services/karateApplyEvent.js). applyEvent abaixo é só o adaptador
// que traduz o resultado do consumidor para o contrato {ok, ack} que este
// motor LIGHT já esperava — sem mudar a lógica de fila/re-tentativa/saúde.
// ============================================================
'use strict';

const db = require('../config/database');

const STALE_HOURS = 24;   // dojô sem enviar nada há mais que isso → "conexão caiu"
const MAX_ATTEMPTS = 5;   // re-tentativas antes de marcar 'failed'
const BATCH = 200;

/** Puro/testável: passou do tempo desde a última sincronização? */
function isStale(lastSyncAtISO, hours, now) {
  if (!lastSyncAtISO) return false; // nunca sincronizou = "recém-ligada", não é queda
  const last = new Date(lastSyncAtISO).getTime();
  if (isNaN(last)) return false;
  const ref = (now ? new Date(now) : new Date()).getTime();
  return ref - last > hours * 3600 * 1000;
}

/**
 * Aplica um evento da fila. Track K: delega ao consumidor idempotente.
 * Traduz o resultado rico do consumidor para o contrato {ok, ack} deste
 * motor:
 *   - consumidor.ok=true            → { ok:true, ack:true }   (drena)
 *   - consumidor.deferred (schema   → { ok:false, deferred:true } (NÃO drena:
 *       da Track K ausente)             mantém pending, sem queimar attempts;
 *                                       o re-processo aplica quando a migration
 *                                       179 vier — ver fix B2 abaixo)
 *   - consumidor.ok=false           → { ok:false, error }     (re-tenta)
 *
 * IMPORTANTE (fix B2): deferred NÃO pode virar ack/ok. Antes mapeávamos
 * deferred → { ok:true, ack:true }, e processFederationQueue marcava o
 * evento status='ok' + COMMIT — drenando um pending que nunca foi aplicado,
 * sem dedupe-row para recuperar depois da migration. Agora deferred é um
 * resultado NÃO-drenante, espelhando o runner dedicado (karateSyncApplyRunner).
 *
 * Mantido lazy o require para não acoplar o boot da Track F à Track K.
 */
async function applyEvent(client, ev) {
  let consumer;
  try {
    consumer = require('./karateApplyEvent');
  } catch (_) {
    return { ok: true, ack: true }; // consumidor ausente: comportamento LIGHT antigo
  }
  const out = await consumer.applyEvent(client, ev);
  if (out.deferred) return { ok: false, deferred: true };
  if (out.ok) return { ok: true, ack: true, applied: !!out.applied, kind: out.kind };
  return { ok: false, error: out.error || 'falha ao aplicar' };
}

/** Processa a fila de UMA federação (chamado no "pull" quando ela abre). */
async function processFederationQueue(federationId, opts = {}) {
  const max = opts.max || BATCH;
  const res = { applied: 0, failed: 0, retried: 0, deferred: 0 };

  const pend = await db.query(
    `SELECT * FROM karate_sync_events
     WHERE federation_id = $1 AND status = 'pending'
     ORDER BY created_at ASC LIMIT $2`,
    [federationId, max]
  );

  for (const ev of pend.rows) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      let outcome;
      try { outcome = await applyEvent(client, ev); }
      catch (e) { outcome = { ok: false, error: e.message }; }

      if (outcome.deferred) {
        // Schema da Track K ausente (migration 179 não aplicada): NÃO drena.
        // ROLLBACK, mantém status='pending', sem processed_at e sem incrementar
        // attempts — não é falha do evento, é "ainda não pronto" (espelha o
        // runner dedicado). Quando a migration vier, o re-processo aplica.
        await client.query('ROLLBACK');
        res.deferred++;
      } else if (outcome.ok) {
        await client.query(
          `UPDATE karate_sync_events SET status='ok', processed_at=NOW(), error=NULL WHERE id=$1`,
          [ev.id]
        );
        await client.query('COMMIT');
        res.applied++;
      } else {
        const attempts = (ev.attempts || 0) + 1;
        const fail = attempts >= MAX_ATTEMPTS;
        await client.query(
          `UPDATE karate_sync_events SET attempts=$1, status=$2, error=$3 WHERE id=$4`,
          [attempts, fail ? 'failed' : 'pending', outcome.error || 'falha ao aplicar', ev.id]
        );
        await client.query('COMMIT');
        if (fail) res.failed++; else res.retried++;
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    } finally {
      client.release();
    }
  }

  // Atualiza a saúde de cada conexão que recebeu eventos: última atualização
  // = evento mais recente; volta a "connected/ok" (recupera de uma queda).
  await db.query(
    `UPDATE karate_dojo_connections c
     SET last_sync_at = sub.maxc, last_sync_status='ok', status='connected', updated_at=NOW()
     FROM (
       SELECT connection_id, MAX(created_at) AS maxc
       FROM karate_sync_events WHERE federation_id = $1
       GROUP BY connection_id
     ) sub
     WHERE c.id = sub.connection_id AND c.federation_id = $1
       AND c.via='native' AND c.status IN ('connected','error')
       AND (c.last_sync_at IS NULL OR sub.maxc > c.last_sync_at)`,
    [federationId]
  );

  return res;
}

/** Marca como "caiu" (error) conexões native sem eventos há > horas. */
async function flagStaleConnections(federationId, hours = STALE_HOURS) {
  const r = await db.query(
    `UPDATE karate_dojo_connections
     SET last_sync_status='error', status='error', updated_at=NOW()
     WHERE federation_id = $1 AND via='native' AND status='connected'
       AND last_sync_at IS NOT NULL
       AND last_sync_at < NOW() - ($2 || ' hours')::interval
     RETURNING id`,
    [federationId, String(hours)]
  );
  return (r.rowCount != null ? r.rowCount : (r.rows ? r.rows.length : 0));
}

/** Pull completo de uma federação: drena a fila + sinaliza quedas. */
async function runFederationSync(federationId, opts = {}) {
  const queue = await processFederationQueue(federationId, opts);
  const stale = await flagStaleConnections(federationId, opts.staleHours || STALE_HOURS);
  return {
    ...queue,
    stale,
    _note: 'Troca assíncrona: o dojô empilha eventos; a federação processa ao abrir.',
  };
}

module.exports = {
  isStale, applyEvent, processFederationQueue, flagStaleConnections, runFederationSync,
  STALE_HOURS, MAX_ATTEMPTS,
};
