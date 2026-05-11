// ============================================================
// AURA. — Smoke test do relatorio semanal
// Gera URL assinada (JWT 30d) para a empresa Finesse (cliente Eryca)
// e exibe + valida que a rota publica retorna 200.
//
// USO (no Railway):
//   railway run node scripts/test-weekly-report-finesse.js
// USO (localmente, com .env preenchido):
//   node scripts/test-weekly-report-finesse.js
//
// Sai com codigo 0 se OK, 1 se erro.
// ============================================================

require('dotenv').config();

const db = require('../src/config/database');
const { signWeeklyReportToken } = require('../src/utils/reportToken');
const { resolvePeriodForReport } = require('../src/services/reportDataQueries');

async function findFinesse() {
  const { rows } = await db.query(`
    SELECT id, COALESCE(trade_name, legal_name) AS name, plan, email, is_active
    FROM companies
    WHERE (
      LOWER(trade_name) LIKE '%finesse%' OR
      LOWER(legal_name) LIKE '%finesse%'
    )
    ORDER BY is_active DESC, created_at ASC
    LIMIT 10
  `);
  return rows;
}

async function probeUrl(url) {
  try {
    const res = await fetch(url);
    const ok = res.ok;
    const status = res.status;
    let body = null;
    try {
      const json = await res.json();
      body = {
        company:    json?.company?.name,
        plan:       json?.gating?.plan,
        period:     json?.period?.label,
        kpis:       json?.kpis ? {
          revenue:      json.kpis.revenue,
          sales:        json.kpis.sales,
          avg_ticket:   json.kpis.avg_ticket,
          health_score: json.kpis.health_score,
        } : null,
        sections: {
          daily_revenue:  Array.isArray(json?.daily_revenue)  ? json.daily_revenue.length  : 0,
          top_products:   Array.isArray(json?.top_products)   ? json.top_products.length   : 0,
          payments:       Array.isArray(json?.payments)       ? json.payments.length       : 0,
          priorities:     Array.isArray(json?.priorities)     ? json.priorities.length     : 0,
          heatmap:        Array.isArray(json?.heatmap)        ? json.heatmap.length        : (json?.heatmap === null ? 'gated' : 0),
          dormant_top:    json?.dormant?.topDormant ? json.dormant.topDormant.length : (json?.dormant === null ? 'gated' : 0),
          stale_products: Array.isArray(json?.stale_products) ? json.stale_products.length : 0,
          wow_insight:    json?.wow_insight ? 'present' : 'absent',
          narratives:     json?.narratives ? Object.keys(json.narratives).length : 0,
        },
        gating: json?.gating,
      };
    } catch (_) {
      body = '<not json>';
    }
    return { ok, status, body };
  } catch (err) {
    return { ok: false, status: 0, body: `<network: ${err.message}>` };
  }
}

async function main() {
  console.log('[finesse-test] buscando empresas Finesse...');
  const companies = await findFinesse();

  if (companies.length === 0) {
    console.error('[finesse-test] nenhuma empresa Finesse encontrada no banco');
    process.exit(1);
  }

  console.log(`[finesse-test] ${companies.length} resultado(s):`);
  companies.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name} | id=${c.id} | plan=${c.plan} | email=${c.email} | active=${c.is_active}`);
  });

  const period = resolvePeriodForReport('weekly');
  console.log(`\n[finesse-test] periodo da semana mais recente: ${period.startDate} -> ${period.endDate}`);

  const apiBase = process.env.API_BASE || 'https://aura-backend-production-f805.up.railway.app/api/v1';
  const appUrl  = process.env.APP_URL  || 'https://app.getaura.com.br';

  let firstFailure = null;

  for (const co of companies) {
    if (!co.is_active) {
      console.log(`\n[skip] ${co.name} esta inativa`);
      continue;
    }
    const token = signWeeklyReportToken({
      company_id:   co.id,
      period_start: period.startDate,
      period_end:   period.endDate,
    });
    const apiUrl = `${apiBase}/reports/weekly/${token}`;
    const webUrl = `${appUrl}/relatorios/semanal/${token}`;

    console.log(`\n=== ${co.name} (plan ${co.plan}) ===`);
    console.log(`  WEB: ${webUrl}`);
    console.log(`  API: ${apiUrl}`);

    const probe = await probeUrl(apiUrl);
    console.log(`  -> HTTP ${probe.status} ${probe.ok ? 'OK' : 'FAIL'}`);
    if (probe.body && typeof probe.body === 'object') {
      console.log(`  -> Empresa retornada: ${probe.body.company} | plan ${probe.body.plan}`);
      console.log(`  -> Periodo: ${probe.body.period}`);
      if (probe.body.kpis) {
        console.log(`  -> KPIs: receita=R$${probe.body.kpis.revenue?.toFixed?.(2) ?? probe.body.kpis.revenue}, vendas=${probe.body.kpis.sales}, ticket=R$${probe.body.kpis.avg_ticket?.toFixed?.(2) ?? probe.body.kpis.avg_ticket}, saude=${probe.body.kpis.health_score}/100`);
      }
      console.log(`  -> Secoes: daily=${probe.body.sections.daily_revenue} | top_prod=${probe.body.sections.top_products} | pagto=${probe.body.sections.payments} | priorid=${probe.body.sections.priorities} | heatmap=${probe.body.sections.heatmap} | dormant=${probe.body.sections.dormant_top} | stale=${probe.body.sections.stale_products} | wow=${probe.body.sections.wow_insight} | narrativas=${probe.body.sections.narratives}`);
      console.log(`  -> Gating: ${JSON.stringify(probe.body.gating)}`);
    } else {
      console.log(`  -> body: ${probe.body}`);
      if (!firstFailure) firstFailure = co.name;
    }
  }

  if (firstFailure) {
    console.log(`\n[finesse-test] FALHA em ${firstFailure}`);
    process.exit(1);
  }
  console.log(`\n[finesse-test] OK — abra o link WEB acima no browser para validar a UI`);
  process.exit(0);
}

main().catch(e => {
  console.error('[finesse-test] crash:', e);
  process.exit(1);
});
