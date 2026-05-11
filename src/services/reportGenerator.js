// ============================================================
// AURA. — Report Generator (Orquestrador)
// Coordena: dados -> narrativas -> HTML -> snapshot -> log.
// Chamado pelo scheduler (cron) ou pela rota admin de disparo.
//
// Convencao de periodo (depois de 11/05/2026):
//   period.startDate = segunda (inclusivo)
//   period.endDate   = sabado (inclusivo)
//   getSalesAnalytics recebe end_date = endDate e adiciona +1 internamente
//   loop de dias: cursor <= period.endDate
//
// EXPORTACOES:
//   buildReportData(companyId, type, periodOverride?)
//     -> JSON puro com kpis, dailyRevenue, topProducts, payments,
//        priorities, narratives, wowInsight, heatmapData, etc.
//     Usado pela rota publica /reports/weekly/:token (sem delivery,
//     sem snapshot, sem HTML).
//   generateReport(companyId, type, periodOverride?)
//     -> orquestra buildReportData + delivery + token + HTML + snapshot.
//     Usado pelo scheduler (cron) e rota admin de disparo.
//   updateDelivery(id, status, errorMsg?)
//     -> atualiza report_deliveries.
// ============================================================

const db = require('../config/database');
const { getSalesAnalytics } = require('./salesAnalytics');
const {
  resolvePeriodForReport,
  fetchStaleProducts,
  fetchDormantCustomers,
  fetchHealthHistory,
  fetchSalesHeatmap,
  saveHealthSnapshot,
} = require('./reportDataQueries');
const { generateWeeklyNarratives, selectPriorities } = require('./narrativeGenerator');
const { buildWeeklyReportHtml } = require('../templates/weeklyReport');
const { signWeeklyReportToken } = require('../utils/reportToken');

// ------------------------------------------------------------
// Helpers de data
// ------------------------------------------------------------

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// toDateKey: normaliza qualquer valor pg (Date obj ou string) para 'YYYY-MM-DD'
function toDateKey(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

function getPrevPeriod(period, type) {
  if (type === 'weekly') {
    return {
      startDate: addDays(period.startDate, -7),
      endDate:   addDays(period.endDate,   -7),
    };
  }
  const [y, m] = period.startDate.split('-').map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  const daysInPrevMonth = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const prevStart = `${prevY}-${String(prevM).padStart(2, '0')}-01`;
  const prevEnd   = `${prevY}-${String(prevM).padStart(2, '0')}-${String(daysInPrevMonth).padStart(2, '0')}`;
  return { startDate: prevStart, endDate: prevEnd };
}

const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS     = ['Domingo', 'Segunda', 'Terca', 'Quarta', 'Quinta', 'Sexta', 'Sabado'];

// endDate INCLUSIVO
function formatPeriodLabel(period) {
  const [, sm, sd]  = period.startDate.split('-').map(Number);
  const [ey, em, ed] = period.endDate.split('-').map(Number);
  return `${sd} ${MONTHS_SHORT[sm - 1]} — ${ed} ${MONTHS_SHORT[em - 1]} · ${ey}`;
}

function formatSentAt() {
  const now = new Date(Date.now() - 3 * 3600000); // BRT
  const dow = WEEKDAYS[now.getUTCDay()];
  const d   = now.getUTCDate();
  const m   = MONTHS_SHORT[now.getUTCMonth()];
  return `${dow}, ${d} ${m} · ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

// Numero sequencial da edicao: semanas desde 2025-01-06 (1a seg)
function calcEdition(startDate) {
  const ref   = new Date('2025-01-06T00:00:00Z');
  const start = new Date(startDate + 'T00:00:00Z');
  const week  = Math.floor((start - ref) / (7 * 24 * 3600 * 1000)) + 1;
  return week > 0 ? week : 1;
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
// buildReportData
// Extrai os dados puros do relatorio (sem delivery, snapshot, HTML).
// Reutilizada pela rota publica /reports/weekly/:token.
// ------------------------------------------------------------

async function buildReportData(companyId, type, periodOverride = null) {
  // 1. Resolver periodo
  const period = periodOverride || resolvePeriodForReport(type);

  // 2. Buscar dados da empresa
  const { rows: [company] } = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS name, email, plan, logo_url
     FROM companies WHERE id = $1 AND is_active = true`,
    [companyId]
  );
  if (!company) throw new Error('Empresa nao encontrada ou inativa');

  // 3. Buscar dados em paralelo
  const prevPeriod = getPrevPeriod(period, type);
  const [salesCurrent, salesPrev, staleProducts, dormantCustomers, healthHistory, heatmapData] = await Promise.all([
    getSalesAnalytics(companyId, { period: 'custom', start_date: period.startDate,    end_date: period.endDate }),
    getSalesAnalytics(companyId, { period: 'custom', start_date: prevPeriod.startDate, end_date: prevPeriod.endDate }),
    fetchStaleProducts(companyId, 14),
    company.plan !== 'essencial' ? fetchDormantCustomers(companyId) : Promise.resolve(null),
    fetchHealthHistory(companyId),
    fetchSalesHeatmap(companyId, period.startDate, period.endDate),
  ]);

  // 4. Montar KPIs
  const curr = salesCurrent.summary;
  const prev = salesPrev.summary;

  function pctChange(a, b) {
    if (!b || b === 0) return 0;
    return parseFloat(((a - b) / b * 100).toFixed(1));
  }

  // Health score fixo em 71 por enquanto (sera calculado dinamicamente na fase 2)
  const HEALTH_SCORE = 71;

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
    health_score:    HEALTH_SCORE,
  };

  // 5. Montar dailyRevenue (seg-sab = 6 dias, cursor <= endDate)
  const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
  const expectedDates = [];
  let cursor = period.startDate;
  while (cursor <= period.endDate) {
    expectedDates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const seriesMap = {};
  (salesCurrent.series || []).forEach(s => {
    seriesMap[toDateKey(s.period)] = s.total_revenue;
  });

  const dailyRevenue = expectedDates.map(dateStr => {
    const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
    return {
      day:     DAYS[dow],
      date:    dateStr,
      value:   seriesMap[dateStr] || 0,
      is_best: false,
    };
  });

  if (dailyRevenue.length) {
    const maxIdx = dailyRevenue.reduce((mi, d, i, arr) => d.value > arr[mi].value ? i : mi, 0);
    dailyRevenue[maxIdx].is_best = true;
  }

  // 6. Top produtos (top 5)
  const topProducts = (salesCurrent.top_products || []).slice(0, 5).map((p, i) => ({
    rank:     i + 1,
    name:     p.name,
    category: p.category || 'Geral',
    revenue:  p.total_revenue,
    qty:      Math.round(p.total_qty),
  }));

  // 7. Pagamentos
  const totalRev = salesCurrent.summary.total_revenue || 1;
  const PAYMENT_LABELS = {
    pix:       'Pix',
    credit:    'Cartao Cred.',
    debit:     'Cartao Deb.',
    cash:      'Dinheiro',
    crediario: 'Crediario',
  };
  const payments = (salesCurrent.by_payment || []).slice(0, 6).map(p => ({
    name: PAYMENT_LABELS[p.method] || p.method,
    pct:  parseFloat(((p.total_revenue / totalRev) * 100).toFixed(1)),
  }));

  // 8. Prioridades
  const reportDataForPriorities = {
    health: { score: HEALTH_SCORE },
    kpis,
    dailyRevenue,
    topProducts,
    payments,
    staleProducts,
    dormantCustomers,
  };
  const priorities = selectPriorities(reportDataForPriorities);

  // 9. Narrativas Haiku (com fallback automatico em generateWeeklyNarratives)
  const narratives = await generateWeeklyNarratives(reportDataForPriorities).catch(() => ({
    revenue:  'Monitore a evolucao diaria do faturamento para identificar padroes.',
    products: 'Priorize os produtos com maior giro para garantir disponibilidade.',
    payments: 'Diversifique os metodos de pagamento para reduzir dependencia.',
  }));

  // 10. WOW insight
  let wowInsight = null;
  if (staleProducts && staleProducts.length > 0) {
    const p = staleProducts[0];
    wowInsight = {
      icon_type: 'box',
      text: `<b>${p.name}</b> esta parado ha <span class="num">${p.days_idle != null ? p.days_idle : '14+'} dias</span> sem venda. Crie uma promocao ou reposicione no PDV.`,
    };
  } else if (dormantCustomers && dormantCustomers.topDormant && dormantCustomers.topDormant.length > 0) {
    const c = dormantCustomers.topDormant[0];
    wowInsight = {
      icon_type: 'user',
      text: `<b>${c.name}</b> nao aparece ha <span class="num">${c.days_dormant} dias</span>. Gastou R$${Math.round(c.total_spent || 0).toLocaleString('pt-BR')} no historico — vale uma mensagem de retorno.`,
    };
  }

  return {
    company,
    period,
    periodLabel: formatPeriodLabel(period),
    edition:     calcEdition(period.startDate),
    sentAt:      formatSentAt(),
    health:      { score: HEALTH_SCORE, label: 'Atencao', delta: 0, delta_dir: 'neutral' },
    kpis,
    dailyRevenue,
    topProducts,
    payments,
    priorities:  priorities.map((p, i) => ({ num: i + 1, ...p })),
    wowInsight,
    narratives,
    heatmapData,
    healthHistory,
    staleProducts,
    dormantCustomers,
  };
}

// ------------------------------------------------------------
// generateReport
// Orquestrador completo: idempotency + delivery + dados + token + HTML + snapshot.
// Chamado pelo cron e rota admin de disparo manual.
// ------------------------------------------------------------

async function generateReport(companyId, type, periodOverride = null) {
  // 1. Resolver periodo (idempotency key)
  const period = periodOverride || resolvePeriodForReport(type);

  // 2. Verificar idempotencia
  const { rows: existing } = await db.query(
    `SELECT id FROM report_deliveries WHERE company_id=$1 AND report_type=$2 AND period_start=$3 AND status='sent' LIMIT 1`,
    [companyId, type, period.startDate]
  );
  if (existing.length > 0) {
    console.log(`[reportGenerator] ja enviado: company=${companyId} type=${type} period=${period.startDate}`);
    return { skipped: true, reason: 'already_sent' };
  }

  // 3. Verificar existencia + email antes de inserir delivery
  const { rows: [coCheck] } = await db.query(
    `SELECT email FROM companies WHERE id = $1 AND is_active = true`,
    [companyId]
  );
  if (!coCheck || !coCheck.email) {
    return { skipped: true, reason: 'no_email' };
  }

  // 4. Inserir delivery como 'pending'
  const { rows: [delivery] } = await db.query(
    `INSERT INTO report_deliveries (company_id, report_type, period_start, status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [companyId, type, period.startDate]
  );
  const deliveryId = delivery.id;

  // 5. Montar dados completos (queries + narrativas)
  const data = await buildReportData(companyId, type, period);

  // 6. Gerar token assinado (30d) e URL do relatorio web
  let reportUrl = null;
  try {
    const token = signWeeklyReportToken({
      company_id:   companyId,
      period_start: period.startDate,
      period_end:   period.endDate,
    });
    const appUrl = process.env.APP_URL || 'https://app.getaura.com.br';
    reportUrl = `${appUrl}/relatorios/semanal/${token}`;
  } catch (err) {
    // Falha em assinar token nao deve quebrar o envio do email — fallback para painel generico
    console.warn('[reportGenerator] signWeeklyReportToken falhou:', err.message);
    reportUrl = process.env.APP_URL || 'https://app.getaura.com.br';
  }

  // 7. Construir HTML (rich body — mantido para futuro PDF/anexo;
  //    o email atual usa template simples em mailer.sendWeeklyReport)
  const html = buildWeeklyReportHtml({
    company:      { name: data.company.name, logo_url: data.company.logo_url },
    period:       { label: data.periodLabel, edition: data.edition, sent_at: data.sentAt },
    health:       data.health,
    kpis:         data.kpis,
    dailyRevenue: data.dailyRevenue,
    topProducts:  data.topProducts,
    payments:     data.payments,
    priorities:   data.priorities,
    wowInsight:   data.wowInsight,
    narratives:   data.narratives,
    heatmapData:  data.heatmapData,
    plan:         data.company.plan || 'essencial',
    reportUrl,
  });

  // 8. Salvar snapshot de health
  const snapshotPeriod = period.startDate.slice(0, 8) + '01';
  await saveHealthSnapshot(companyId, data.health.score, data.health.label, snapshotPeriod, {}).catch(e => {
    console.warn('[reportGenerator] saveHealthSnapshot falhou:', e.message);
  });

  // 9. Retornar resultado
  return {
    skipped:    false,
    deliveryId,
    company:    data.company,
    period,
    kpis:       data.kpis,
    html,
    reportUrl,
  };
}

module.exports = { generateReport, buildReportData, updateDelivery };
