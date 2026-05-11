// ============================================================
// AURA. — Public Reports Routes
// Rotas publicas (sem auth) para acessar relatorios via token JWT.
//
// GET /api/v1/reports/weekly/:token
//   -> 200 single ou consolidado (multi-CNPJ via claim 'cids')
//   -> 401 invalid | 410 expired | 404 not found
//
// GET /api/v1/reports/admin/test-weekly?token=...&q=...  [TEMPORARIO]
//   Agrupa resultados por owner_id; cada grupo gera 1 link consolidado.
// ============================================================

const express = require('express');
const router  = express.Router();

const db = require('../config/database');
const { verifyWeeklyReportToken, signWeeklyReportToken } = require('../utils/reportToken');
const { buildReportData, buildConsolidatedReportData }   = require('../services/reportGenerator');
const { resolvePeriodForReport }                         = require('../services/reportDataQueries');

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

    const data = v.consolidated
      ? await buildConsolidatedReportData(v.company_ids, 'weekly', period)
      : await buildReportData(v.company_id, 'weekly', period);

    const plan = data.company.plan || 'essencial';
    const showHeatmap          = plan !== 'essencial';
    const showDormantCustomers = plan !== 'essencial';
    const showAiInsights       = plan === 'expansao' || plan === 'personalizado';

    return res.json({
      company: {
        name:           data.company.name,
        plan,
        logo_url:       data.company.logo_url || null,
        consolidated:   !!data.company.consolidated,
        unit_count:     data.company.unit_count || (v.consolidated ? v.company_ids.length : 1),
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
      breakdown:      data.breakdown || null,
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

// ─── Admin smoke-test endpoint (TEMPORARIO) ──────────────────

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
    const { rows: matches } = await db.query(`
      SELECT id, owner_id, is_primary, created_at,
             COALESCE(trade_name, legal_name) AS name,
             plan, email,
             COALESCE(report_email_override, email) AS recipient,
             is_active
      FROM companies
      WHERE (LOWER(trade_name) LIKE $1 OR LOWER(legal_name) LIKE $1)
      ORDER BY is_active DESC, created_at ASC
      LIMIT 20
    `, [`%${q}%`]);

    if (matches.length === 0) {
      return res.status(404).json({ error: `Nenhuma empresa encontrada para q='${q}'` });
    }

    const ownerIds = [...new Set(matches.filter(m => m.owner_id).map(m => m.owner_id))];
    let allByOwner = new Map();
    if (ownerIds.length > 0) {
      const { rows: siblings } = await db.query(`
        SELECT id, owner_id, is_primary, created_at,
               COALESCE(trade_name, legal_name) AS name,
               plan, email,
               COALESCE(report_email_override, email) AS recipient,
               is_active
        FROM companies
        WHERE owner_id = ANY($1) AND is_active = true
        ORDER BY owner_id, is_primary DESC NULLS LAST, created_at ASC
      `, [ownerIds]);
      siblings.forEach(s => {
        if (!allByOwner.has(s.owner_id)) allByOwner.set(s.owner_id, []);
        allByOwner.get(s.owner_id).push(s);
      });
    }

    const seenOwner = new Set();
    const groups = [];
    for (const m of matches) {
      if (m.owner_id && allByOwner.has(m.owner_id)) {
        if (seenOwner.has(m.owner_id)) continue;
        seenOwner.add(m.owner_id);
        const members = allByOwner.get(m.owner_id);
        groups.push({ owner_id: m.owner_id, primary: members.find(x => x.is_primary) || members[0], all: members });
      } else {
        groups.push({ owner_id: null, primary: m, all: [m] });
      }
    }

    const period = resolvePeriodForReport('weekly');
    const appUrl = process.env.APP_URL || 'https://app.getaura.com.br';
    const apiBase = `${req.protocol}://${req.get('host')}/api/v1`;

    const results = [];
    for (const g of groups) {
      const ids = g.all.map(c => c.id);
      const consolidated = ids.length > 1;
      let tk;
      try {
        tk = signWeeklyReportToken({
          company_id:   g.primary.id,
          company_ids:  consolidated ? ids : null,
          period_start: period.startDate,
          period_end:   period.endDate,
        });
      } catch (err) {
        results.push({ error: err.message, group_primary: g.primary.name });
        continue;
      }
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
          consolidated: body?.company?.consolidated,
          unit_count: body?.company?.unit_count,
          plan: body?.gating?.plan,
          period: body?.period?.label,
          kpis: body?.kpis ? {
            revenue: body.kpis.revenue,
            revenue_dir: body.kpis.revenue_dir,
            sales: body.kpis.sales,
            avg_ticket: body.kpis.avg_ticket,
            health_score: body.kpis.health_score,
          } : null,
          breakdown: body?.breakdown || null,
          sections: {
            daily_revenue: Array.isArray(body?.daily_revenue) ? body.daily_revenue.length : 0,
            top_products:  Array.isArray(body?.top_products)  ? body.top_products.length  : 0,
            payments:      Array.isArray(body?.payments)      ? body.payments.length      : 0,
            priorities:    Array.isArray(body?.priorities)    ? body.priorities.length    : 0,
          },
        };
      } catch (err) {
        probe = { error: err.message };
      }

      results.push({
        owner_id: g.owner_id,
        consolidated,
        unit_count: ids.length,
        primary: { id: g.primary.id, name: g.primary.name, plan: g.primary.plan, recipient: g.primary.recipient },
        all: g.all.map(c => ({ id: c.id, name: c.name, is_primary: c.is_primary, recipient: c.recipient })),
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
