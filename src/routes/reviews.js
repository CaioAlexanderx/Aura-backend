// ============================================================
// AURA. — Rotas de Avaliações (BE-06)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { createReviewRequest, submitReview, getReviews } = require('../services/reviews');

/**
 * POST /companies/:id/reviews/request
 * Trigger manual no PDV — gera links de avaliação
 * body: { sale_id, customer_id }
 */
router.post('/request', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { sale_id, customer_id } = req.body;

    if (!sale_id) {
      return res.status(400).json({ error: 'sale_id é obrigatório' });
    }

    const data = await createReviewRequest(companyId, sale_id, customer_id);
    res.status(201).json(data);

  } catch (err) {
    console.error('Erro em POST /reviews/request:', err.message);
    res.status(500).json({ error: 'Erro ao criar solicitação de avaliação' });
  }
});

/**
 * GET /companies/:id/reviews
 * Lista avaliações — visibilidade controlada por permissão
 * Query params:
 *   rating  = 1|2|3|4|5  (filtro opcional)
 *   limit   = número de resultados (padrão: 50)
 *   offset  = paginação (padrão: 0)
 */
router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { rating, limit = 50, offset = 0 } = req.query;

    const data = await getReviews(companyId, {
      rating: rating ? parseInt(rating) : null,
      limit:  parseInt(limit),
      offset: parseInt(offset),
    });

    res.json(data);

  } catch (err) {
    console.error('Erro em GET /reviews:', err.message);
    res.status(500).json({ error: 'Erro ao buscar avaliações' });
  }
});

// ── Rotas públicas (sem auth — acessadas via link pelo cliente) ──

const publicRouter = express.Router();

/**
 * POST /reviews/:token
 * Cliente responde avaliação via link
 * body: { rating, comment }
 */
publicRouter.post('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { rating, comment } = req.body;

    const result = await submitReview(token, { rating, comment });
    res.json(result);

  } catch (err) {
    const status = err.message.includes('inválido') ? 404
      : err.message.includes('expirado') ? 410
      : err.message.includes('respondida') ? 409
      : 400;

    res.status(status).json({ error: err.message });
  }
});

module.exports = { reviewsRouter: router, publicReviewsRouter: publicRouter };
