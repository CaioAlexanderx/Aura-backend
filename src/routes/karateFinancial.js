// ============================================================
// AURA KARATÊ — Rota Financeira (Track B)
// GET /federation/:id/financial/overview
//     DRE por competência + fluxo de caixa + projeção de recebíveis
//
// Guard: adminOnly() — financeiro é sensível (RBAC §7.3).
// federation_staff não acessa este módulo.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { guards } = require('../config/karateRoles');
const { calcDre, calcCashflow, calcProjectedReceivables } = require('../services/karateFinanceService');

// GET /federation/:id/financial/overview
router.get('/overview', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;
  const { from, to } = req.query;

  // Defaults: ano corrente
  const defaultFrom = `${new Date().getFullYear()}-01-01`;
  const defaultTo   = `${new Date().getFullYear()}-12-31`;
  const periodFrom  = from || defaultFrom;
  const periodTo    = to   || defaultTo;

  try {
    const [dre, cashflow, projected] = await Promise.all([
      calcDre(federationId, periodFrom, periodTo),
      calcCashflow(federationId, periodFrom, periodTo),
      calcProjectedReceivables(federationId),
    ]);

    res.json({
      period: { from: periodFrom, to: periodTo },
      dre,
      cashflow,
      projected_receivables: projected,
    });
  } catch (err) {
    console.error('[karateFinancial] overview error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular overview financeiro' });
  }
});

module.exports = router;
