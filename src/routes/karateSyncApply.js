// ============================================================
// AURA KARATÊ — Track K: disparo manual da aplicação de sync
// Montado em /federation/:id (igual Tracks B/C/E/F).
//
//   POST /sync/apply   — drena a fila pendente da federação e APLICA os
//                        eventos (idempotente). Guard: adminOnly().
//
// É o lado consumidor do webhook da Track F: o dojô empilha eventos
// (karate_sync_events 'pending') e a federação os aplica aqui. A rota é
// idempotente — re-chamar não duplica (dedupe em karate_sync_applied).
// Complementa POST /connections/sync/run (que, via delegação, também passa
// a aplicar de fato).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { guards } = require('../config/karateRoles');
const { runFederationApply } = require('../services/karateSyncApplyRunner');

// ── POST /federation/:id/sync/apply ─────────────────────────
router.post('/sync/apply', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const max = Math.min(1000, Math.max(1, parseInt(req.body?.max, 10) || 200));
  try {
    const summary = await runFederationApply(federationId, { max });
    res.json({
      ok: true,
      ...summary,
      _note: 'Aplicação idempotente da fila de sync (Track K). Re-chamar não duplica.',
    });
  } catch (err) {
    console.error('[karateSyncApply] apply error:', err.message);
    res.status(500).json({ error: 'Erro ao aplicar a fila de sincronização', detail: err.message });
  }
});

module.exports = router;
