// ============================================================
// AURA Studio — Orçamentos (Camada 1, Fase A)
// Stub — todos os endpoints retornam 501 até a Fase A implementar.
// Contratos em services/studioApi.ts. Montado em private.js.
// GET/POST  /studio/quotes
// GET/PATCH/DELETE /studio/quotes/:qid
// POST /studio/quotes/:qid/send     → gera token + expires_at, status=sent
// POST /studio/quotes/:qid/convert  → cria digital_order (vertical=studio), status=converted
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });

router.get('/quotes',              (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.post('/quotes',             (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.get('/quotes/:qid',         (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.patch('/quotes/:qid',       (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.delete('/quotes/:qid',      (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.post('/quotes/:qid/send',   (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.post('/quotes/:qid/convert',(_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));

module.exports = router;
