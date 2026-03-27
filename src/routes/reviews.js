// ============================================================
// AURA. — Rotas de Avaliações (BE-06)
// ============================================================

const express = require('express');
const router = express.Router({ mergeParams: true });

const { createReviewRequest, submitReview, getReviews } = require('../services/reviews');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

/**
 * POST /companies/:id/reviews/request
 * Trigger manual no PDV — gera links de avaliação
 * body: { sale_id, customer_id }
 */
router.post('/request', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { sale_id, customer_id } = req.body;

  if (!sale_id) {
    throw new AppError('sale_id é obrigatório', 400);
  }

  const data = await createReviewRequest(companyId, sale_id, customer_id);
  res.status(201).json(data);
}));

/**
 * GET /companies/:id/reviews
 * Lista avaliações — visibilidade controlada por permissão
 */
router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { rating, limit = 50, offset = 0 } = req.query;

  const data = await getReviews(companyId, {
    rating: rating ? parseInt(rating, 10) : null,
    limit: parseInt(limit, 10),
    offset: parseInt(offset, 10),
  });

  res.json(data);
}));

// ── Rotas públicas (sem auth — acessadas via link pelo cliente) ──

const publicRouter = express.Router();

/**
 * POST /reviews/:token
 * Cliente responde avaliação via link
 * body: { rating, comment }
 */
publicRouter.post('/:token', asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { rating, comment } = req.body;

  try {
    const result = await submitReview(token, { rating, comment });
    res.json(result);
  } catch (err) {
    const status = err.message.includes('inválido') ? 404
      : err.message.includes('expirado') ? 410
      : err.message.includes('respondida') ? 409
      : err.message.includes('Nota deve ser entre 1 e 5') ? 400
      : 400;

    throw new AppError(err.message, status);
  }
}));

module.exports = {
  reviewsRouter: router,
  publicReviewsRouter: publicRouter,
};
