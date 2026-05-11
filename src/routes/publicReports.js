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
//
// GET /api/v1/reports/admin/test-weekly?token=...&q=finesse  [TEMPORARIO]
//   -> Endpoint de smoke test para o go-live da segunda 12/05/2026.
//   -> Gerado para validar Finesse (cliente Eryca). REMOVER apos validacao.
// ============================================================

const express = require('express');
const router  = express.Router();

const db = require('../config/database');
const { verifyWeeklyReportToken, signWeeklyReportToken } = require('../utils/reportToken');
const { buildReportData }         = require('../services/reportGenerator');
const { resolvePeriodForReport }  = require('../services/reportDataQueries');

// ─── Rota publica principal (acessada pelo email) ────────────

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

// ─── Smoke-test endpoint TEMPORARIO ──────────────────────────
// Gera URL assinada (JWT 30d) para empresas que casam com ?q=, faz probe
// interno da rota publica e retorna estrutura + KPIs. Gated por token.
//
// REMOVER apos a validacao do go-live de segunda 12/05/2026.
// Idealmente sera removido junto com o fallback hardcoded abaixo.

const _TEST_TOKEN_FALLBACK = 'aura-admin-2026-relatorios';
function _getExpectedTestToken() {
  return process.env.ADMIN_REPORTS_TEST_TOKEN || _TEST_TOKEN_FALLBACK;
}

router.get('/admin/test-weekly', async (req, res) => {
  const provided = req.query.token || req.headers['x-admin-token'];
  if (!provided || provided !== _getExpectedTestToken()) {
    return res.status(401).json({ error: 'Token invalido' });
  }

  const q = String(req.query.q || 'finesse').toLowerCase();
  if (q.length < 2) {
    return res.status(400).json({ error: 'q deve ter pelo menos 2 caracteres' });
  }

  try {
    const { rows: companies } = await db.query(`
      SELECT id, COALESCE(trade_name, legal_name) AS name, plan, email, is_active, created_at
      FROM companies
      WHERE (LOWER(trade_name) LIKE $1 OR LOWER(legal_name) LIKE $1)
      ORDER BY is_active DESC, created_at ASC
      LIMIT 10
    `, [`%${q}%`]);

    if (companies.length === 0) {
      return res.status(404).json({ error: `Nenhuma empresa encontrada para q='${q}'` });
    }

    const period = resolvePeriodForReport('weekly');
    const appUrl = process.env.APP_URL || 'https://app.getaura.com.br';
    const apiBase = `${req.protocol}://${req.get('host')}/api/v1`;

    const results = [];
    for (const co of companies) {
      const tk = signWeeklyReportToken({
        company_id: co.id,
        period_start: period.startDate,
        period_end: period.endDate,
      });
      const webUrl = `${appUrl}/relatorios/semanal/${tk}`;
      const apiUrl = `${apiBase}/reports/weekly/${tk}`;

      let probe = null;
      try {
        const r = await fetch(apiUrl);
        const body = await r.json().catch(() => ({}));
        probe = {
          status: r.status,
          ok: r.ok,
          company: body?.company?.name,
          plan: body?.gating?.plan,
          period: body?.period?.label,
          kpis: body?.kpis ? {
            revenue:      body.kpis.revenue,
            revenue_dir:  body.kpis.revenue_dir,
            sales:        body.kpis.sales,
            active_days:  body.kpis.active_days,
            avg_ticket:   body.kpis.avg_ticket,
            ticket_dir:   body.kpis.ticket_dir,
            health_score: body.kpis.health_score,
          } : null,
          sections: {
            daily_revenue:  Array.isArray(body?.daily_revenue)  ? body.daily_revenue.length  : 0,
            top_products:   Array.isArray(body?.top_products)   ? body.top_products.length   : 0,
            payments:       Array.isArray(body?.payments)       ? body.payments.length       : 0,
            priorities:     Array.isArray(body?.priorities)     ? body.priorities.length     : 0,
            heatmap:        Array.isArray(body?.heatmap)        ? body.heatmap.length        : (body?.heatmap === null ? 'gated' : 0),
            dormant:        body?.dormant?.topDormant ? body.dormant.topDormant.length : (body?.dormant === null ? 'gated' : 0),
            stale_products: Array.isArray(body?.stale_products) ? body.stale_products.length : 0,
            wow_insight:    body?.wow_insight ? 'present' : 'absent',
            narratives:     body?.narratives ? Object.keys(body.narratives).length : 0,
          },
          gating: body?.gating,
        };
      } catch (err) {
        probe = { error: err.message };
      }

      results.push({
        company: { id: co.id, name: co.name, plan: co.plan, email: co.email, is_active: co.is_active },
        urls: { web: webUrl, api: apiUrl },
        probe,
      });
    }

    return res.json({
      period: { start_date: period.startDate, end_date: period.endDate },
      query: q,
      count: results.length,
      results,
    });
  } catch (err) {
    console.error('[publicReports/admin-test] erro:', err.message);
    return res.status(500).json({ error: 'Erro interno', message: err.message });
  }
});

module.exports = router;
