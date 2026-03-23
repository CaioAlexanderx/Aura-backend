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

// BE-09 — Multi-usuário RBAC
router.use('/companies/:id/members',            require('./members'));
router.use('/members',                          require('./members')); // /members/accept/:token

// BE-10 — Obrigações fiscais
router.use('/companies/:id/obligations',        require('./fiscalObligations'));

// BE-13/15 — Código de barras e QR Code
router.use('/companies/:id/products',           require('./barcode'));

// BE-14 — Etiquetas
router.use('/companies/:id/products',           require('./labels'));

// BE-15 — Scanner PDV
router.use('/companies/:id/pdv',                require('./scanner'));

// BE-16 — Variantes de produto
router.use('/companies/:id/products/:pid/variants', require('./variants'));

// BE-19/20 — Comissão de vendas + Metas
router.use('/companies/:id/employees',          require('./commission'));

// BE-17/18 — Gestão Aura
router.use('/admin',                            require('./admin'));

// BE-22 — Salão Parceiro
router.use('/companies/:id/salon-partners',     require('./salonPartner'));

// BE-25 — Módulo Odontologia
router.use('/companies/:id/dental',             require('./dental'));
router.use('/dental',                           require('./dental'));

module.exports = router;
