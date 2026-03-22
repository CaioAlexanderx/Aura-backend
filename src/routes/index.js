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

// BE-05 + BE-07 — CRM expandido + Retenção
router.use('/companies/:id/customers',          require('./crm'));
router.use('/companies/:id/customers',          require('./retention'));

// BE-06 — Avaliações (autenticado + público)
router.use('/companies/:id/reviews',            reviewsRouter);
router.use('/reviews',                          publicReviewsRouter);

// BE-10 — Obrigações fiscais
router.use('/companies/:id/obligations',        require('./fiscalObligations'));

// BE-13/15 — Código de barras e QR Code (cadastro + lookup PDV)
router.use('/companies/:id/products',           require('./barcode'));

// BE-14 — Etiquetas (dados para impressão client-side)
router.use('/companies/:id/products',           require('./labels'));

// BE-15 — Scanner PDV (lookup por código escaneado)
router.use('/companies/:id/pdv',                require('./scanner'));

// BE-16 — Variantes de produto
router.use('/companies/:id/products/:pid/variants', require('./variants'));

// BE-19/20 — Comissão de vendas + Metas por funcionário
router.use('/companies/:id/employees',          require('./commission'));

// BE-17/18 — Gestão Aura (dashboard + equipe)
router.use('/admin',                            require('./admin'));

// BE-22 — Modo Salão Parceiro (Lei 13.352/2016)
router.use('/companies/:id/salon-partners',     require('./salonPartner'));

module.exports = router;
