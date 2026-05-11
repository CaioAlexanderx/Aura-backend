// ============================================================
// AURA. — Public Reports Routes
// Rotas publicas (sem auth) para acessar relatorios via token
// JWT enviado por email. CORS aberto (similar ao /storefront).
//
// GET /api/v1/reports/weekly/:token
//   -> 200 { company, period, kpis, daily_revenue, top_products, ... }
//   -> 401 { error, code: 'invalid' }
//   -> 410 { error, code: 'expired' }
//   -> 404 { error, code: 'company_not_found' }
// ============================================================

const express = require('express');
const router  = express.Router();

const { verifyWeeklyReportToken } = require('../utils/reportToken');
const { buildReportData }         = require('../services/reportGenerator');

router.get('/weekly/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token === 'undefined' || token === 'null') {
    return res.status(400).json({ error: 'Token ausente', code: 'missing_token' });
  }

  const v = verifyWeeklyReportToken(token);
  if (!v.valid) {
    return res.status(v.error === 'expired' ? 410 : 401).json({
      error: v.error === 'expired' ? 'Link expirado' : 'Link invalido',
      code:  v.error,
    });
  }

  try {
    const period = { startDate: v.period_start, endDate: v.period_end };
    const data = await buildReportData(v.company_id, 'weekly', period);

    // Gating por plano (espelha o template do email).
    // Essencial   -> sem heatmap, sem clientes dormentes, sem AI insights
    // Negocio+    -> heatmap + dormentes
    // Expansao+   -> tudo + AI insights
    const plan = data.company.plan || 'essencial';
    const showHeatmap          = plan !== 'essencial';
    const showDormantCustomers = plan !== 'essencial';
    const showAiInsights       = plan === 'expansao' || plan === 'personalizado';

    return res.json({
      company: {
        name:     data.company.name,
        plan,
        logo_url: data.company.logo_url || null,
      },
      period: {
        start_date: period.startDate,
        end_date:   period.endDate,
        label:      data.periodLabel,
        edition:    data.edition,
        sent_at:    data.sentAt,
      },
      health:         data.health,
      kpis:           data.kpis,
      daily_revenue:  data.dailyRevenue,
      top_products:   data.topProducts,
      payments:       data.payments,
      priorities:     data.priorities,
      wow_insight:    data.wowInsight,
      narratives:     data.narratives,
      heatmap:        showHeatmap          ? data.heatmapData      : null,
      dormant:        showDormantCustomers ? data.dormantCustomers : null,
      stale_products: data.staleProducts,
      gating: {
        plan,
        show_heatmap: showHeatmap,
        show_dormant: showDormantCustomers,
        show_ai:      showAiInsights,
      },
    });
  } catch (err) {
    console.error('[publicReports/weekly] erro:', err.message);
    if (err.message && err.message.includes('Empresa nao encontrada')) {
      return res.status(404).json({ error: 'Empresa nao encontrada', code: 'company_not_found' });
    }
    return res.status(500).json({ error: 'Erro ao montar relatorio', code: 'internal' });
  }
});

module.exports = router;
