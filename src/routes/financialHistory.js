// ============================================================
// AURA. — Rotas de Histórico Financeiro (BE-04)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getFinancialHistory } = require('../services/financialHistory');

/**
 * GET /companies/:id/financial/history
 * Query params:
 *   year        = YYYY  (padrão: ano atual)
 *   granularity = month | quarter  (padrão: month)
 */
router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { year, granularity = 'month' } = req.query;

    if (!['month', 'quarter'].includes(granularity)) {
      return res.status(400).json({
        error: 'granularity inválido. Use: month, quarter',
      });
    }

    if (year && (isNaN(year) || year < 2020 || year > 2100)) {
      return res.status(400).json({
        error: 'year inválido. Use um ano entre 2020 e 2100',
      });
    }

    const data = await getFinancialHistory(companyId, { year, granularity });
    res.json(data);

  } catch (err) {
    console.error('Erro em GET /financial/history:', err.message);
    res.status(500).json({ error: 'Erro ao buscar histórico financeiro' });
  }
});

module.exports = router;
