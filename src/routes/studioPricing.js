// ============================================================
// AURA Studio — Motor de Precificação (Camada 1, Fase B)
// Stub — todos os endpoints retornam 501 até a Fase B implementar.
// Contratos em services/studioApi.ts. Montado em private.js.
// GET /studio/pricing/rules              → lista regras (global + por produto)
// PUT /studio/pricing/rules/:productId   → upsert (productId='global' p/ regra global)
// POST /studio/pricing/quote-line        → calcula preço de 1 linha (breakdown visível)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });

router.get('/pricing/rules',             (_req, res) => res.status(501).json({ error: 'Fase B — em implementação' }));
router.put('/pricing/rules/:productId',  (_req, res) => res.status(501).json({ error: 'Fase B — em implementação' }));
router.post('/pricing/quote-line',       (_req, res) => res.status(501).json({ error: 'Fase B — em implementação' }));

module.exports = router;
