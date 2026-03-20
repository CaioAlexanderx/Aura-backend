// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router  = express.Router();
const { reviewsRouter, publicReviewsRouter } = require('./reviews');

// BE-01 — Analytics de vendas
router.use('/companies/:id/sales/analytics',    require('./salesAnalytics'));

// BE-02 — Ranking de funcionários / funcionário do mês
router.use('/companies/:id/employees/ranking',  require('./employeesRanking'));

// BE-03 — Categorias + curva ABC
router.use('/companies/:id/products',           require('./productsRanking'));

// BE-04 — Histórico financeiro comparativo anual
router.use('/companies/:id/financial/history',  require('./financialHistory'));

// BE-05 — CRM expandido
router.use('/companies/:id/customers',          require('./crm'));

// BE-06 — Avaliações (autenticado)
router.use('/companies/:id/reviews',            reviewsRouter);

// BE-06 — Avaliações (público — link do cliente)
router.use('/reviews',                          publicReviewsRouter);

module.exports = router;
