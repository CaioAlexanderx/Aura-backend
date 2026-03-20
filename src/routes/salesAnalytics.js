// ============================================================
// AURA. — Rotas de Analytics de Vendas (BE-01)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getSalesAnalytics } = require('../services/salesAnalytics');

const VALID_PERIODS  = ['today', 'yesterday', 'week', 'month', 'year', 'custom'];
const VALID_GROUP_BY = ['day', 'week', 'month', 'employee', 'payment_method', 'product'];

/**
 * GET /companies/:id/sales/analytics
 * Query params:
 *   period     = today | yesterday | week | month | year | custom
 *   group_by   = day | week | month | employee | payment_method
 *   start_date = YYYY-MM-DD (apenas se period=custom)
 *   end_date   = YYYY-MM-DD (apenas se period=custom)
 */
router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', group_by = 'day', start_date, end_date } = req.query;

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({
        error: `period inválido. Use: ${VALID_PERIODS.join(', ')}`,
      });
    }

    if (!VALID_GROUP_BY.includes(group_by)) {
      return res.status(400).json({
        error: `group_by inválido. Use: ${VALID_GROUP_BY.join(', ')}`,
      });
    }

    if (period === 'custom' && (!start_date || !end_date)) {
      return res.status(400).json({
        error: 'Para period=custom, informe start_date e end_date (YYYY-MM-DD)',
      });
    }

    const data = await getSalesAnalytics(companyId, {
      period,
      group_by,
      start_date,
      end_date,
    });

    res.json(data);
  } catch (err) {
    console.error('Erro em GET /sales/analytics:', err.message);
    res.status(500).json({ error: 'Erro ao buscar analytics de vendas' });
  }
});

module.exports = router;
