// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router  = express.Router();

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

module.exports = router;
