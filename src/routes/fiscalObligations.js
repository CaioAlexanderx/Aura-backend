// ============================================================
// AURA. — Rotas de Obrigações Fiscais (BE-10 + BE-24)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const {
  calculateMEIDAS, calculateSNDAS, checkMEILimit,
  generateMonthlyObligations, getObligations, updateCheckpoint,
} = require('../services/fiscalObligations');
const { getPersonalizedCalendar } = require('../services/obligationsCalendar');
const db = require('../config/database');

/**
 * GET /companies/:id/obligations
 * Lista obrigações com status e alertas
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
 * GET /companies/:id/obligations/calendar
 * Calendário personalizado por regime + CNAE + tem funcionário
 * Query params: filter = all | aura_resolve | voce_faz
 */
router.get('/calendar', async (req, res) => {
  try {
    const { filter = 'all' } = req.query;
    const validFilters = ['all', 'aura_resolve', 'voce_faz', 'contador'];
    if (!validFilters.includes(filter)) {
      return res.status(400).json({ error: `filter inválido. Use: ${validFilters.join(', ')}` });
    }
    const data = await getPersonalizedCalendar(req.params.id);
    if (!data) return res.status(404).json({ error: 'Empresa não encontrada' });
    const calendar = filter === 'all'
      ? data.calendar
      : data.calendar.filter(c => c.filter_label === filter);
    res.json({ ...data, calendar });
  } catch (err) {
    console.error('Erro em GET /obligations/calendar:', err.message);
    res.status(500).json({ error: 'Erro ao montar calendário de obrigações' });
  }
});

/**
 * POST /companies/:id/obligations/generate
 * Gera obrigações do mês
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
 * Atualiza checkpoints gamificados
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
 */
router.get('/das/preview', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { activity_type, current_revenue, revenue_12m } = req.query;

    const { rows } = await db.query(
      'SELECT tax_regime, annual_revenue FROM companies WHERE id = $1',
      [companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });

    const { tax_regime, annual_revenue } = rows[0];

    if (tax_regime === 'mei') {
      const das        = calculateMEIDAS(activity_type || 'services');
      const limitCheck = checkMEILimit(parseFloat(annual_revenue));
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

module.exports = router;
