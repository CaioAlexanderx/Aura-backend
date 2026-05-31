// ============================================================
// AURA. — Rotas de Produtos: Ranking + Curva ABC (BE-03)
//
// 30/05/2026: limit/offset/abc filter expostos pela query string.
// Erro detalhado no log (period/limit/companyId) ajuda investigar
// reincidencias do bug intermitente da Eryca.
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getProductsRanking, getCategories, DEFAULT_LIMIT, MAX_LIMIT } = require('../services/productsRanking');

const VALID_PERIODS = ['today', 'yesterday', 'week', 'month', 'year', 'custom'];
const VALID_ABC = ['A', 'B', 'C'];

/**
 * GET /companies/:id/products/ranking
 * Query params:
 *   period     = today | yesterday | week | month | year | custom (default: month)
 *   category   = filtrar por categoria específica (opcional)
 *   abc        = A | B | C (opcional — filtra só essa classe)
 *   limit      = 1..1000 (default 200)
 *   offset     = >=0 (default 0)
 *   start_date = YYYY-MM-DD (apenas se period=custom)
 *   end_date   = YYYY-MM-DD (apenas se period=custom)
 */
router.get('/ranking', async (req, res) => {
  try {
    const companyId = req.params.id;
    const {
      period = 'month',
      category,
      abc,
      limit,
      offset,
      start_date,
      end_date,
    } = req.query;

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({
        error: `period invalido. Use: ${VALID_PERIODS.join(', ')}`,
      });
    }

    if (period === 'custom' && (!start_date || !end_date)) {
      return res.status(400).json({
        error: 'Para period=custom, informe start_date e end_date (YYYY-MM-DD)',
      });
    }

    if (abc && !VALID_ABC.includes(String(abc).toUpperCase())) {
      return res.status(400).json({ error: `abc invalido. Use: ${VALID_ABC.join(', ')}` });
    }

    if (limit !== undefined) {
      const n = parseInt(limit, 10);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_LIMIT) {
        return res.status(400).json({ error: `limit invalido. Use 1..${MAX_LIMIT} (default ${DEFAULT_LIMIT})` });
      }
    }
    if (offset !== undefined) {
      const n = parseInt(offset, 10);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: 'offset invalido. Use >= 0' });
      }
    }

    const data = await getProductsRanking(companyId, {
      period,
      category,
      abc,
      limit,
      offset,
      start_date,
      end_date,
    });
    res.json(data);

  } catch (err) {
    // 30/05/2026: contexto detalhado pra diagnosticar reincidencias
    // do bug intermitente da Eryca. Antes o log era so a mensagem.
    console.error('[products/ranking]', {
      msg:       err.message,
      code:      err.code,
      companyId: req.params.id,
      period:    req.query.period,
      limit:     req.query.limit,
      abc:       req.query.abc,
    });
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
    console.error('[products/categories]', err.message);
    res.status(500).json({ error: 'Erro ao buscar categorias' });
  }
});

module.exports = router;
