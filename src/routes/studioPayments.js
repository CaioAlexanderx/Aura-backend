// ============================================================
// AURA Studio — Pagamentos / Sinal (Camada 1, Fase C)
// Stub — todos os endpoints retornam 501 até a Fase C implementar.
// Contratos em services/studioApi.ts. Montado em private.js.
// GET  /studio/orders/:oid/payments     → lista marcos do pedido
// POST /studio/orders/:oid/payments     → cria marco {kind, amount, due_at, method}
// POST /studio/payments/:pid/mark-paid  → Pix manual recebido (DA-D)
// POST /studio/payments/:pid/charge-link→ gera cobrança via modalidade existente (DA-D)
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });

router.get('/orders/:oid/payments',       (_req, res) => res.status(501).json({ error: 'Fase C — em implementação' }));
router.post('/orders/:oid/payments',      (_req, res) => res.status(501).json({ error: 'Fase C — em implementação' }));
router.post('/payments/:pid/mark-paid',   (_req, res) => res.status(501).json({ error: 'Fase C — em implementação' }));
router.post('/payments/:pid/charge-link', (_req, res) => res.status(501).json({ error: 'Fase C — em implementação' }));

module.exports = router;
