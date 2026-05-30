// ============================================================
// AURA Studio — Aceite público do orçamento (Camada 1, Fase A)
// Rota pública (sem auth) — espelha studioApprovalPublic.
// Montada em /api/v1/orcamento/:token (via index.js).
// GET  /:token          → PublicQuote (loja + itens + validade + status)
// POST /:token/respond  → {action: accept|reject, note?}
// ============================================================
const express = require('express');
const router  = express.Router();

router.get('/:token',          (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));
router.post('/:token/respond', (_req, res) => res.status(501).json({ error: 'Fase A — em implementação' }));

module.exports = router;
