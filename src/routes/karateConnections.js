// ============================================================
// AURA KARATÊ — Rotas de Conectividade Dojô (Track F / Fase 5)
// Montado em /federation/:id (igual aos Tracks B/C/E).
//
//   GET   /connections                       — lista (filtros via/status) + counts
//   GET   /connections/requests              — solicitações pendentes (inbox)
//   POST  /connections                       — inicia conexão (staffWrite)
//   POST  /connections/sync/run              — catch-up assíncrono (drena fila) (staffWrite)
//   GET   /connections/:connId               — detalhe + eventos recentes
//   PATCH /connections/:connId               — edita notes/via (staffWrite)
//   POST  /connections/:connId/approve       — aprova handshake (adminOnly)
//                                              native → gera token (1x)
//   POST  /connections/:connId/reject        — recusa/revoga (adminOnly)
//   POST  /connections/:connId/rotate-token  — rotaciona token (adminOnly)
//   GET   /connections/:connId/events        — log de sync (paginado)
//   POST  /connections/:connId/events/:eventId/reprocess — marca reprocessado
//
// SEGURANÇA: o federation_sync_token só aparece em CLARO na resposta de
// approve/rotate (uma vez). Persistimos apenas hash + prefixo.
//
// VIAS (revisado 09/06): native (Via 1, Aura Karatê Dojô) e manual (Via 2,
// sem sistema — gerido pela FPKT). A antiga Via 2 (adaptador Aura Negócio)
// foi removida: o dojô nunca usa outra vertical além do Aura Karatê.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { generateSyncToken, maskToken } = require('../services/karateSyncService');
const { runFederationSync } = require('../services/karateSyncEngine');

const VIAS = ['native', 'manual'];

function shapeConnection(r) {
  return {
    id: r.id,
    federation_id: r.federation_id,
    dojo_id: r.dojo_id,
    dojo_name: r.dojo_name || null,
    fpkt_affiliation_id: r.fpkt_affiliation_id || null,
    via: r.via,
    status: r.status,
    sync_token_masked: maskToken(r.sync_token_prefix),
    token_rotated_at: r.token_rotated_at || null,
    connected_at: r.connected_at || null,
    last_sync_at: r.last_sync_at || null,
    last_sync_status: r.last_sync_status || null,
    notes: r.notes || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const SELECT_CONN = `
  SELECT c.*, COALESCE(dj.trade_name, dj.legal_name) AS dojo_name,
         dj.fpkt_affiliation_id
  FROM karate_dojo_connections c
  LEFT JOIN companies dj ON dj.id = c.dojo_id`;

// ── GET /connections ──────────────────────────────────────
router.get('/connections', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  const { via, status } = req.query;
  try {
    const conditions = ['c.federation_id = $1'];
    const params = [federationId];
    let n = 2;
    if (via) { conditions.push(`c.via = $${n}`); params.push(via); n++; }
    if (status) { conditions.push(`c.status = $${n}`); params.push(status); n++; }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows } = await db.query(
      `${SELECT_CONN} ${where} ORDER BY c.created_at DESC`, params
    );
    const countsRes = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM karate_dojo_connections
       WHERE federation_id = $1 GROUP BY status`,
      [federationId]
    );
    const counts = {};
    for (const row of countsRes.rows) counts[row.status] = row.n;

    res.json({ counts, data: rows.map(shapeConnection) });
  } catch (err) {
    console.error('[karateConnections] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar conexões' });
  }
});

// ── GET /connections/requests — inbox de pendentes ──────────
router.get('/connections/requests', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;
  try {
    const { rows } = await db.query(
      `${SELECT_CONN} WHERE c.federation_id = $1 AND c.status = 'pending'
       ORDER BY c.created_at ASC`,
      [federationId]
    );
    res.json(rows.map(shapeConnection));
  } catch (err) {
    console.error('[karateConnections] requests error:', err.message);
    res.status(500).json({ error: 'Erro ao listar solicitações' });
  }
});

// ── POST /connections — inicia conexão ─────────────────────
router.post('/connections', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const { dojo_id, via, notes } = req.body;

  if (!dojo_id) return res.status(422).json({ error: 'dojo_id é obrigatório', code: 'VALIDATION_ERROR' });
  if (!via || !VIAS.includes(via)) {
    return res.status(422).json({ error: `via deve ser: ${VIAS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }

  try {
    // dojô precisa existir
    const dojo = await db.query(`SELECT id FROM companies WHERE id = $1 LIMIT 1`, [dojo_id]);
    if (!dojo.rows.length) return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });

    // Via 2 (manual) já nasce conectada (a FPKT gere direto). Native fica pendente.
    const status = via === 'manual' ? 'connected' : 'pending';
    const connectedAt = via === 'manual' ? 'NOW()' : 'NULL';

    const ins = await db.query(
      `INSERT INTO karate_dojo_connections
         (federation_id, dojo_id, via, status, requested_by, connected_at, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, ${connectedAt}, $6, NOW(), NOW())
       ON CONFLICT (federation_id, dojo_id) DO UPDATE
         SET via = EXCLUDED.via, notes = EXCLUDED.notes, updated_at = NOW()
       RETURNING id`,
      [federationId, dojo_id, via, status, req.user?.id || null, notes || null]
    );
    const detail = await db.query(`${SELECT_CONN} WHERE c.id = $1`, [ins.rows[0].id]);
    res.status(201).json(shapeConnection(detail.rows[0]));
  } catch (err) {
    console.error('[karateConnections] create error:', err.message);
    res.status(500).json({ error: 'Erro ao iniciar conexão', detail: err.message });
  }
});

// ── POST /connections/sync/run ──────────────────────────
// Catch-up assíncrono: processa a fila de eventos que o dojô empilhou e
// sinaliza dojôs que ficaram quietos. Chamado quando a federação abre o
// sistema (pull). Não exige o dojô online ao mesmo tempo.
router.post('/connections/sync/run', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  try {
    const summary = await runFederationSync(federationId);
    res.json(summary);
  } catch (err) {
    console.error('[karateConnections] sync run error:', err.message);
    res.status(500).json({ error: 'Erro ao processar a fila de sincronização' });
  }
});

async function findConnection(federationId, connId) {
  const r = await db.query(
    `${SELECT_CONN} WHERE c.id = $1 AND c.federation_id = $2 LIMIT 1`,
    [connId, federationId]
  );
  return r.rows[0] || null;
}

// ── GET /connections/:connId ────────────────────────────
router.get('/connections/:connId', ...guards.read(), async (req, res) => {
  const { id: federationId, connId } = req.params;
  try {
    const conn = await findConnection(federationId, connId);
    if (!conn) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    const events = await db.query(
      `SELECT id, direction, event_type, status, error, created_at
       FROM karate_sync_events WHERE connection_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [connId]
    );
    res.json({ ...shapeConnection(conn), recent_events: events.rows });
  } catch (err) {
    console.error('[karateConnections] detail error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar conexão' });
  }
});

// ── PATCH /connections/:connId ─────────────────────────
router.patch('/connections/:connId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, connId } = req.params;
  const ALLOWED = ['notes', 'via'];
  const updates = [];
  const values = [];
  let idx = 1;
  if (req.body.via !== undefined && !VIAS.includes(req.body.via)) {
    return res.status(422).json({ error: `via deve ser: ${VIAS.join(', ')}`, code: 'VALIDATION_ERROR' });
  }
  for (const f of ALLOWED) {
    if (req.body[f] !== undefined) { updates.push(`${f} = $${idx}`); values.push(req.body[f]); idx++; }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push('updated_at = NOW()');
  values.push(connId, federationId);

  try {
    const upd = await db.query(
      `UPDATE karate_dojo_connections SET ${updates.join(', ')}
       WHERE id = $${idx} AND federation_id = $${idx + 1} RETURNING id`,
      values
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    const detail = await findConnection(federationId, connId);
    res.json(shapeConnection(detail));
  } catch (err) {
    console.error('[karateConnections] patch error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar conexão' });
  }
});

// helper: aprova/rotaciona — gera token p/ native, registra handshake
async function issueToken(federationId, conn, isRotation) {
  const needsToken = conn.via === 'native';
  let plaintext = null;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (needsToken) {
      const { token, hash, prefix } = generateSyncToken();
      plaintext = token;
      await client.query(
        `UPDATE karate_dojo_connections
         SET status = 'connected', sync_token_hash = $1, sync_token_prefix = $2,
             token_rotated_at = NOW(),
             connected_at = COALESCE(connected_at, NOW()),
             approved_by = COALESCE(approved_by, $3),
             updated_at = NOW()
         WHERE id = $4`,
        [hash, prefix, conn._approver || null, conn.id]
      );
    } else {
      await client.query(
        `UPDATE karate_dojo_connections
         SET status = 'connected', connected_at = COALESCE(connected_at, NOW()),
             approved_by = COALESCE(approved_by, $1), updated_at = NOW()
         WHERE id = $2`,
        [conn._approver || null, conn.id]
      );
    }
    await client.query(
      `INSERT INTO karate_sync_events
         (connection_id, federation_id, dojo_id, direction, event_type, status, created_at)
       VALUES ($1, $2, $3, 'fed_to_dojo', 'handshake', 'ok', NOW())`,
      [conn.id, federationId, conn.dojo_id]
    );
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
  return plaintext;
}

// ── POST /connections/:connId/approve ─────────────────────
router.post('/connections/:connId/approve', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, connId } = req.params;
  try {
    const conn = await findConnection(federationId, connId);
    if (!conn) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    if (conn.status === 'connected') {
      return res.status(409).json({ error: 'Conexão já está ativa', code: 'CONFLICT' });
    }
    conn._approver = req.user?.id || null;
    const token = await issueToken(federationId, conn, false);
    const detail = await findConnection(federationId, connId);
    res.json({
      ...shapeConnection(detail),
      sync_token: token, // CLARO — exibido uma única vez (null p/ via manual)
      _note: token
        ? 'Guarde o token agora — ele não será exibido novamente.'
        : 'Conexão manual ativada (Via 2 não usa token).',
    });
  } catch (err) {
    console.error('[karateConnections] approve error:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar conexão', detail: err.message });
  }
});

// ── POST /connections/:connId/reject ─────────────────────
router.post('/connections/:connId/reject', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, connId } = req.params;
  try {
    const upd = await db.query(
      `UPDATE karate_dojo_connections
       SET status = 'revoked', sync_token_hash = NULL, sync_token_prefix = NULL, updated_at = NOW()
       WHERE id = $1 AND federation_id = $2 RETURNING id`,
      [connId, federationId]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    res.json({ id: connId, status: 'revoked' });
  } catch (err) {
    console.error('[karateConnections] reject error:', err.message);
    res.status(500).json({ error: 'Erro ao recusar conexão' });
  }
});

// ── POST /connections/:connId/rotate-token ──────────────────
router.post('/connections/:connId/rotate-token', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, connId } = req.params;
  try {
    const conn = await findConnection(federationId, connId);
    if (!conn) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    if (conn.via === 'manual') {
      return res.status(409).json({ error: 'Conexão manual (Via 2) não usa token', code: 'CONFLICT' });
    }
    conn._approver = req.user?.id || null;
    const token = await issueToken(federationId, conn, true);
    res.json({ id: connId, sync_token: token, _note: 'Token rotacionado — o anterior foi invalidado.' });
  } catch (err) {
    console.error('[karateConnections] rotate error:', err.message);
    res.status(500).json({ error: 'Erro ao rotacionar token', detail: err.message });
  }
});

// ── GET /connections/:connId/events ──────────────────────
router.get('/connections/:connId/events', ...guards.read(), async (req, res) => {
  const { id: federationId, connId } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;
  try {
    const conn = await findConnection(federationId, connId);
    if (!conn) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM karate_sync_events WHERE connection_id = $1`, [connId]
    );
    const { rows } = await db.query(
      `SELECT id, direction, event_type, status, error, created_at
       FROM karate_sync_events WHERE connection_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [connId, pageSize, offset]
    );
    res.json({ page, page_size: pageSize, total: countRes.rows[0].total, data: rows });
  } catch (err) {
    console.error('[karateConnections] events error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar eventos de sync' });
  }
});

// ── POST /connections/:connId/events/:eventId/reprocess ─────
router.post('/connections/:connId/events/:eventId/reprocess', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, connId, eventId } = req.params;
  try {
    const conn = await findConnection(federationId, connId);
    if (!conn) return res.status(404).json({ error: 'Conexão não encontrada', code: 'NOT_FOUND' });
    const upd = await db.query(
      `UPDATE karate_sync_events SET status = 'reprocessed'
       WHERE id = $1 AND connection_id = $2 AND status = 'failed'
       RETURNING id, status`,
      [eventId, connId]
    );
    if (!upd.rows.length) {
      return res.status(409).json({ error: 'Evento não encontrado ou não está em falha', code: 'CONFLICT' });
    }
    res.json({ id: eventId, status: 'reprocessed', _note: 'Reprocessamento real do payload chega com o motor de sync.' });
  } catch (err) {
    console.error('[karateConnections] reprocess error:', err.message);
    res.status(500).json({ error: 'Erro ao reprocessar evento' });
  }
});

module.exports = router;
