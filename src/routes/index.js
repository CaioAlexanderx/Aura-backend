// ============================================================
// AURA. — Roteador Principal
// ============================================================

const express = require('express');
const router  = express.Router();

// Analytics de vendas (BE-01)
const salesAnalyticsRouter = require('./salesAnalytics');
router.use('/companies/:id/sales/analytics', salesAnalyticsRouter);

module.exports = router;
