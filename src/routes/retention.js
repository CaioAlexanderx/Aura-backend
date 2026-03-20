// ============================================================
// AURA. — Rotas de Retenção de Clientes (BE-07)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getRetentionDashboard } = require('../services/retention');

/**
 * GET /companies/:id/customers/retention
 * Query params:
 *   period     = week | month | year | custom (padrão: month)
 *   start_date = YYYY-MM-DD
 *   end_date   = YYYY-MM-DD
 */
router.get('/retention', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', start_date, end_date } = req.query;

    const data = await getRetentionDashboard(companyId, {
      period, start_date, end_date,
    });

    res.json(data);
  } catch (err) {
    console.error('Erro em GET /customers/retention:', err.message);
    res.status(500).json({ error: 'Erro ao buscar dados de retenção' });
  }
});

module.exports = router;
