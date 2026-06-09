// ============================================================
// AURA KARATÊ — Webhook de Sincronização (Track F / Fase 5)
// Montado em /webhooks/karate-sync (PÚBLICO, sem auth de empresa).
// O dojô (Via 1) chama POST /:connId apresentando o federation_sync_token
// no header X-Sync-Token. Autenticamos por hash (timing-safe).
//
// FUNDAÇÃO: por ora só REGISTRA o evento (status 'pending') e marca a
// conexão como 'syncing'. A aplicação real do payload (criar praticante,
// frequência, etc.) chega com o motor de sync. HMAC-sobre-corpo
// (verifyHmac) será ligado quando houver segredo recuperável dedicado.
// ============================================================
'use strict';

const router = require('express').Router();
const db = require('../config/database');
const { verifyToken } = require('../services/karateSyncService');

const INBOUND_EVENTS = ['practitioner_added', 'attendance', 'exam_enrollment', 'annuity_paid'];

router.post('/:connId', async (req, res) => {
  const { connId } = req.params;
  const token = req.header('X-Sync-Token') || req.header('x-sync-token');
  const { event_type } = req.body || {};

  try {
    const r = await db.query(
      `SELECT id, federation_id, dojo_id, sync_token_hash, status, via
       FROM karate_dojo_connections WHERE id = $1 LIMIT 1`,
      [connId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Conexão não encontrada' });
    const conn = r.rows[0];

    if (conn.status !== 'connected') {
      return res.status(403).json({ error: 'Conexão inativa', code: 'CONNECTION_INACTIVE' });
    }
    if (!verifyToken(token, conn.sync_token_hash)) {
      return res.status(401).json({ error: 'Token de sync inválido', code: 'UNAUTHORIZED' });
    }
    if (!event_type || !INBOUND_EVENTS.includes(event_type)) {
      return res.status(422).json({ error: `event_type deve ser: ${INBOUND_EVENTS.join(', ')}`, code: 'VALIDATION_ERROR' });
    }

    const ins = await db.query(
      `INSERT INTO karate_sync_events
         (connection_id, federation_id, dojo_id, direction, event_type, status, payload, created_at)
       VALUES ($1, $2, $3, 'dojo_to_fed', $4, 'pending', $5, NOW())
       RETURNING id`,
      [conn.id, conn.federation_id, conn.dojo_id, event_type, req.body?.payload || null]
    );
    await db.query(
      `UPDATE karate_dojo_connections SET last_sync_at = NOW(), last_sync_status = 'syncing', updated_at = NOW()
       WHERE id = $1`,
      [conn.id]
    );

    res.status(202).json({
      ok: true,
      event_id: ins.rows[0].id,
      _note: 'Evento registrado (pending). Aplicação do payload chega com o motor de sync.',
    });
  } catch (err) {
    console.error('[karateSyncWebhook] error:', err.message);
    res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

module.exports = router;
