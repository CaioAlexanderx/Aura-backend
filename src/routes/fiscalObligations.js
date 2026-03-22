// ============================================================
// AURA. — Rotas de Obrigações Fiscais (BE-10)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const {
  calculateMEIDAS, calculateSNDAS, checkMEILimit,
  generateMonthlyObligations, getObligations, updateCheckpoint,
} = require('../services/fiscalObligations');

/**
 * GET /companies/:id/obligations
 * Lista obrigações com status e alertas
 * Query params:
 *   status = pending | completed | overdue
 *   year   = YYYY
 */
router.get('/', async (req, res) => {
  try {
    const { status, year } = req.query;
    const data = await getObligations(req.params.id, { status, year });
    res.json({ total: data.length, obligations: data });
  } catch (err) {
    console.error('Erro em GET /obligations:', err.message);
    res.status(500).json({ error: 'Erro ao buscar obrigações' });
  }
});

/**
 * POST /companies/:id/obligations/generate
 * Gera obrigações do mês (chamado pelo worker mensal)
 * body: { reference_month } ex: "2026-03-01"
 */
router.post('/generate', async (req, res) => {
  try {
    const { reference_month } = req.body;
    if (!reference_month) {
      return res.status(400).json({ error: 'reference_month é obrigatório (YYYY-MM-DD)' });
    }
    const data = await generateMonthlyObligations(req.params.id, reference_month);
    res.status(201).json({ generated: data.length, obligations: data });
  } catch (err) {
    console.error('Erro em POST /obligations/generate:', err.message);
    res.status(500).json({ error: 'Erro ao gerar obrigações' });
  }
});

/**
 * PATCH /companies/:id/obligations/:obligationId/checkpoint
 * Atualiza progresso dos checkpoints gamificados
 * body: { checkpoint_done }
 */
router.patch('/:obligationId/checkpoint', async (req, res) => {
  try {
    const { checkpoint_done } = req.body;
    if (checkpoint_done === undefined) {
      return res.status(400).json({ error: 'checkpoint_done é obrigatório' });
    }
    const data = await updateCheckpoint(
      req.params.id,
      req.params.obligationId,
      parseInt(checkpoint_done)
    );
    res.json(data);
  } catch (err) {
    console.error('Erro em PATCH /obligations/checkpoint:', err.message);
    res.status(err.message.includes('não encontrada') ? 404 : 500)
      .json({ error: err.message });
  }
});

/**
 * GET /companies/:id/obligations/das/preview
 * Estimativa do DAS do mês
 * Query params:
 *   activity_type    = commerce | services | both (MEI)
 *   current_revenue  = receita do mês atual (SN)
 *   revenue_12m      = receita acumulada 12 meses (SN)
 */
router.get('/das/preview', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { activity_type, current_revenue, revenue_12m } = req.query;

    // Buscar regime da empresa
    const { rows } = await db.query(
      'SELECT tax_regime, annual_revenue FROM companies WHERE id = $1',
      [companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });

    const { tax_regime, annual_revenue } = rows[0];

    if (tax_regime === 'mei') {
      const das         = calculateMEIDAS(activity_type || 'services');
      const limitCheck  = checkMEILimit(parseFloat(annual_revenue));
      return res.json({ regime: 'mei', das, limit_check: limitCheck });
    }

    if (tax_regime === 'simples_nacional') {
      if (!current_revenue || !revenue_12m) {
        return res.status(400).json({
          error: 'Informe current_revenue e revenue_12m para estimar o DAS do Simples Nacional',
        });
      }
      const das = calculateSNDAS(parseFloat(revenue_12m), parseFloat(current_revenue));
      return res.json({ regime: 'simples_nacional', das });
    }

    res.status(400).json({ error: `Regime ${tax_regime} não suportado neste endpoint` });
  } catch (err) {
    console.error('Erro em GET /obligations/das/preview:', err.message);
    res.status(500).json({ error: 'Erro ao calcular estimativa DAS' });
  }
});

// Importar db para o endpoint das/preview
const db = require('../config/database');

module.exports = router;
