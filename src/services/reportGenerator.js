// ============================================================
// AURA. — Report Generator (Orquestrador)
// Coordena: dados → narrativas → HTML → snapshot → log.
// Chamado pelo scheduler (cron) ou pela rota admin de disparo.
// ============================================================

const db = require('../config/database');
const { getSalesAnalytics } = require('./salesAnalytics');
const { resolvePeriodForReport, fetchStaleProducts, fetchDormantCustomers, fetchHealthHistory, saveHealthSnapshot } = require('./reportDataQueries');
const { generateWeeklyNarratives, selectPriorities } = require('./narrativeGenerator');
const { buildWeeklyReportHtml } = require('../templates/weeklyReport');

// ------------------------------------------------------------
// Helpers de data
// ------------------------------------------------------------

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function getPrevPeriod(period, type) {
  if (type === 'weekly') {
    return {
      startDate: addDays(period.startDate, -7),
      endDate:   addDays(period.endDate,   -7),
    };
  }
  // monthly
  const [y, m] = period.startDate.split('-').map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const prevStart = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  return { startDate: prevStart, endDate: period.startDate };
}

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];

function formatPeriodLabel(period) {
  const [sy, sm, sd] = period.startDate.split('-').map(Number);
  const [ey, em, ed] = period.endDate.split('-').map(Number);
  // endDate e exclusive, subtrair 1 dia para exibicao
  const endDisplay = new Date(Date.UTC(ey, em - 1, ed - 1));
  const edDay = endDisplay.getUTCDate();
  const edMonth = MONTHS_SHORT[endDisplay.getUTCMonth()];
  const edYear = endDisplay.getUTCFullYear();
  return `${sd} ${MONTHS_SHORT[sm - 1]} — ${edDay} ${edMonth} · ${edYear}`;
}

function formatSentAt() {
  const now = new Date(Date.now() - 3 * 3600000); // BRT
  const dow = WEEKDAYS[now.getUTCDay()];
  const d = now.getUTCDate();
  const m = MONTHS_SHORT[now.getUTCMonth()];
  return `${dow}, ${d} ${m} · ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

// ------------------------------------------------------------
// Helper: atualizar registro de entrega
// ------------------------------------------------------------

async function updateDelivery(id, status, errorMsg = null) {
  await db.query(
    `UPDATE report_deliveries SET status=$2, last_error=$3, sent_at=CASE WHEN $2='sent' THEN NOW() ELSE NULL END, attempts=attempts+1 WHERE id=$1`,
    [id, status, errorMsg]
  ).catch(e => console.error('[reportGenerator] updateDelivery error:', e.message));
}

// ------------------------------------------------------------
// Funcao principal
// ------------------------------------------------------------

async function generateReport(companyId, type, periodOverride = null) {
  // 1. Resolver periodo
  const period = periodOverride || resolvePeriodForReport(type);
  // period = { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }

  // 2. Verificar idempotencia
  const { rows: existing } = await db.query(
    `SELECT id FROM report_deliveries WHERE company_id=$1 AND report_type=$2 AND period_start=$3 AND status='sent' LIMIT 1`,
    [companyId, type, period.startDate]
  );
  if (existing.length > 0) {
    console.log(`[reportGenerator] ja enviado: company=${companyId} type=${type} period=${period.startDate}`);
    return { skipped: true, reason: 'already_sent' };
  }

  // 3. Inserir delivery como 'pending'
  const { rows: [delivery] } = await db.query(
    `INSERT INTO report_deliveries (company_id, report_type, period_start, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [companyId, type, period.startDate]
  );
  const deliveryId = delivery.id;

  // 4. Buscar dados da empresa
  // companies nao tem coluna "name" — usa trade_name / legal_name
  const { rows: [company] } = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS name, email, plan, logo_url
     FROM companies WHERE id = $1 AND is_active = true`,
    [companyId]
  );
  if (!company || !company.email) {
    await updateDelivery(deliveryId, 'failed', 'empresa sem email');
    return { skipped: true, reason: 'no_email' };
  }

  // 5. Calcular periodo anterior e buscar dados em paralelo
  const prevPeriod = getPrevPeriod(period, type);

  const [salesCurrent, salesPrev, staleProducts, dormantCustomers, healthHistory] = await Promise.all([
    getSalesAnalytics(companyId, { period: 'custom', start_date: period.startDate, end_date: period.endDate }),
    getSalesAnalytics(companyId, { period: 'custom', start_date: prevPeriod.startDate, end_date: prevPeriod.endDate }),
    fetchStaleProducts(companyId, 14),
    company.plan !== 'essencial' ? fetchDormantCustomers(companyId) : Promise.resolve(null),
    fetchHealthHistory(companyId),
  ]);

  // 6. Montar KPIs
  const curr = salesCurrent.summary;
  const prev = salesPrev.summary;

  function pctChange(curr, prev) {
    if (!prev || prev === 0) return 0;
    return parseFloat(((curr - prev) / prev * 100).toFixed(1));
  }

  const kpis = {
    revenue:         curr.total_revenue,
    revenue_delta:   pctChange(curr.total_revenue, prev.total_revenue),
    revenue_dir:     curr.total_revenue >= prev.total_revenue ? 'up' : 'down',
    sales:           curr.total_sales,
    active_days:     curr.active_days,
    avg_ticket:      curr.avg_ticket,
    ticket_delta:    pctChange(curr.avg_ticket, prev.avg_ticket),
    ticket_dir:      curr.avg_ticket >= prev.avg_ticket ? 'up' : 'down',
    new_customers:   curr.unique_customers,
    customers_delta: curr.unique_customers - (prev.unique_customers || 0),
    customers_dir:   curr.unique_customers >= prev.unique_customers ? 'up' : 'down',
  };

  // 7. Montar dailyRevenue (serie diaria, garantir 7 dias)
  const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

  const expectedDates = [];
  let cursor = period.startDate;
  while (cursor < period.endDate) {
    expectedDates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const seriesMap = {};
  (salesCurrent.series || []).forEach(s => {
    const dateKey = s.period.slice(0, 10);
    seriesMap[dateKey] = s.total_revenue;
  });

  const dailyRevenue = expectedDates.map(dateStr => {
    const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
    return {
      day: DAYS[dow],
      value: seriesMap[dateStr] || 0,
      is_best: false,
    };
  });

  if (dailyRevenue.length) {
    const maxIdx = dailyRevenue.reduce((mi, d, i, arr) => d.value > arr[mi].value ? i : mi, 0);
    dailyRevenue[maxIdx].is_best = true;
  }

  // 8. Montar topProducts (top 5)
  const topProducts = (salesCurrent.top_products || []).slice(0, 5).map((p, i) => ({
    rank: i + 1,
    name: p.name,
    category: p.category || 'Geral',
    revenue: p.total_revenue,
    qty: Math.round(p.total_qty),
  }));

  // 9. Montar payments
  const totalRev = salesCurrent.summary.total_revenue || 1;
  const PAYMENT_LABELS = {
    pix:       'Pix',
    credit:    'Cartao de Credito',
    debit:     'Cartao de Debito',
    cash:      'Dinheiro',
    crediario: 'Crediario',
  };
  const payments = (salesCurrent.by_payment || []).slice(0, 6).map(p => ({
    name: PAYMENT_LABELS[p.method] || p.method,
    pct: parseFloat(((p.total_revenue / totalRev) * 100).toFixed(1)),
  }));

  // 10. Selecionar prioridades e gerar narrativas
  const reportData = {
    health: { score: 71 },
    kpis,
    dailyRevenue,
    topProducts,
    payments,
    staleProducts,
    dormantCustomers,
  };
  const priorities = selectPriorities(reportData);

  // Narrativas Haiku (com fallback interno em generateWeeklyNarratives)
  const narratives = await generateWeeklyNarratives(reportData);

  // 11. Montar WOW insight
  // Nota: dormantCustomers.topDormant retorna coluna "name" (nao full_name)
  let wowInsight = null;
  if (staleProducts && staleProducts.length > 0) {
    const p = staleProducts[0];
    wowInsight = {
      icon_type: 'box',
      text: `<b>${p.name}</b> esta parado ha <span class="num">${p.days_idle || '14+'} dias</span> sem venda. Verifique o ponto de pedido.`,
    };
  } else if (dormantCustomers && dormantCustomers.topDormant && dormantCustomers.topDormant.length > 0) {
    const c = dormantCustomers.topDormant[0];
    wowInsight = {
      icon_type: 'user',
      text: `<b>${c.name}</b> nao aparece ha <span class="num">${c.days_dormant} dias</span>. Considere uma mensagem de retorno.`,
    };
  }

  // 12. Construir HTML
  const periodLabel = formatPeriodLabel(period);
  const html = buildWeeklyReportHtml({
    company: { name: company.name, logo_url: company.logo_url },
    period:  { label: periodLabel, edition: null, sent_at: formatSentAt() },
    health:  { score: 71, label: 'Atencao', delta: 0, delta_dir: 'neutral' },
    kpis,
    dailyRevenue,
    topProducts,
    payments,
    priorities: priorities.map((p, i) => ({ num: i + 1, ...p })),
    wowInsight,
    plan: company.plan || 'essencial',
  });

  // 13. Salvar snapshot de health (periodo mensal)
  const snapshotPeriod = period.startDate.slice(0, 8) + '01';
  await saveHealthSnapshot(companyId, 71, 'Atencao', snapshotPeriod, {}).catch(e => {
    console.warn('[reportGenerator] saveHealthSnapshot falhou:', e.message);
  });

  // 14. Retornar resultado para o caller (scheduler ou rota admin)
  return {
    skipped: false,
    deliveryId,
    company,
    period,
    kpis,
    html,
  };
}

module.exports = { generateReport, updateDelivery };
