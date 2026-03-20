// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router  = express.Router();

// BE-01 — Analytics de vendas
const salesAnalyticsRouter = require('./salesAnalytics');
router.use('/companies/:id/sales/analytics', salesAnalyticsRouter);

// BE-02 — Ranking de funcionários / funcionário do mês
const employeesRankingRouter = require('./employeesRanking');
router.use('/companies/:id/employees/ranking', employeesRankingRouter);

module.exports = router;
