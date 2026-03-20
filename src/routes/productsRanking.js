// ============================================================
// AURA. — Rotas de Produtos: Ranking + Curva ABC (BE-03)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getProductsRanking, getCategories } = require('../services/productsRanking');

const VALID_PERIODS = ['today', 'yesterday', 'week', 'month', 'year', 'custom'];

/**
 * GET /companies/:id/products/ranking
 * Query params:
 *   period     = week | month | year | custom  (padrão: month)
 *   category   = filtrar por categoria específica (opcional)
 *   start_date = YYYY-MM-DD (apenas se period=custom)
 *   end_date   = YYYY-MM-DD (apenas se period=custom)
 */
router.get('/ranking', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', category, start_date, end_date } = req.query;

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({
        error: `period inválido. Use: ${VALID_PERIODS.join(', ')}`,
      });
    }

    if (period === 'custom' && (!start_date || !end_date)) {
      return res.status(400).json({
        error: 'Para period=custom, informe start_date e end_date (YYYY-MM-DD)',
      });
    }

    const data = await getProductsRanking(companyId, { period, category, start_date, end_date });
    res.json(data);

  } catch (err) {
    console.error('Erro em GET /products/ranking:', err.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de produtos' });
  }
});

/**
 * GET /companies/:id/products/categories
 * Lista categorias com métricas de vendas
 */
router.get('/categories', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', start_date, end_date } = req.query;

    const data = await getCategories(companyId, { period, start_date, end_date });
    res.json({ period, categories: data });

  } catch (err) {
    console.error('Erro em GET /products/categories:', err.message);
    res.status(500).json({ error: 'Erro ao buscar categorias' });
  }
});

module.exports = router;
