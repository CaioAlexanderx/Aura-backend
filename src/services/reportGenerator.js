// ============================================================
// AURA. — Report Generator (Orquestrador)
// Coordena: dados -> narrativas -> HTML -> snapshot -> log.
//
// EXPORTACOES:
//   buildReportData(companyId, type, periodOverride?)
//   buildConsolidatedReportData(companyIds, type, periodOverride?)
//   generateReport(companyId, type, periodOverride?, opts?)
//   generateConsolidatedReport(companyIds, primaryId, type, periodOverride?, opts?)
//     opts: { destinatarios?, semEntrega? } (tq-88), { config? } (tq-85)
//   updateDelivery(id, status, { resendId?, error? }) -> true/false
//
// tq-85 (24/10/2026): relatório longo. buildReportData também devolve
// `relatorio`, os blocos da versão completa (services/relatorioBlocos): os
// ligados nas preferências que o plano tem. O consolidado junta os blocos
// das empresas do grupo (consolidarBlocos explica a decisão por bloco). O
// HTML devolvido é a página completa nova (templates/weeklyReport).
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
const P = require('./emailPreferencias');
const RB = require('./relatorioBlocos');
const { apiUrl } = require('./emailLinks');

/**
 * Config do relatório que decide os blocos: a que veio (scheduler, que já
 * leu as preferências da primária) ou a da empresa, lida agora.
 */
async function configDoRelatorio(companyId, config) {
  if (config && typeof config === 'object') return config;
  const prefs = await P.preferenciasDaEmpresa(db, companyId);
  return (prefs && prefs.relatorio && prefs.relatorio.config) || {};
}

/**
 * Link "Ver relatório completo". Padrão: a página do app
 * (/relatorios/semanal/<token>). Com RELATORIO_PAGINA_NO_BACKEND=true, a
 * página completa servida aqui (GET /reports/weekly/<token>/pagina), que já
 * tem todos os blocos — liga sem deploy enquanto o app não mostra os blocos.
 */
function urlDoRelatorio(token, env = process.env) {
  if (/^(1|true|on|sim)$/i.test(String(env.RELATORIO_PAGINA_NO_BACKEND || '').trim())) {
    return `${apiUrl(env)}/reports/weekly/${token}/pagina`;
  }
  const appUrl = env.APP_URL || 'https://app.getaura.com.br';
  return `${appUrl}/relatorios/semanal/${token}`;
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

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

function formatPeriodLabel(period) {
  const [, sm, sd]  = period.startDate.split('-').map(Number);
  const [ey, em, ed] = period.endDate.split('-').map(Number);
  return `${sd} ${MONTHS_SHORT[sm - 1]} — ${ed} ${MONTHS_SHORT[em - 1]} · ${ey}`;
}

function formatSentAt() {
  const now = new Date(Date.now() - 3 * 3600000);
  const dow = WEEKDAYS[now.getUTCDay()];
  const d   = now.getUTCDate();
  const m   = MONTHS_SHORT[now.getUTCMonth()];
  return `${dow}, ${d} ${m} · ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

function calcEdition(startDate) {
  const ref   = new Date('2025-01-06T00:00:00Z');
  const start = new Date(startDate + 'T00:00:00Z');
  const week  = Math.floor((start - ref) / (7 * 24 * 3600 * 1000)) + 1;
  return week > 0 ? week : 1;
}

// Mensagem curta para report_deliveries.last_error: sem e-mail (o Resend
// às vezes repete o endereço na mensagem de erro) e no máximo 200 chars.
function erroCurto(msg) {
  const s = String(msg == null ? '' : msg)
    .replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, '[email]')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 200 ? s.slice(0, 199) + '…' : s;
}

const STATUS_DE_ENTREGA = new Set(['pending', 'sent', 'failed']);

/**
 * Grava o resultado de um envio em report_deliveries.
 *
 *   updateDelivery(id, 'sent',   { resendId })   -> sent_at = NOW(), resend_id
 *   updateDelivery(id, 'failed', { error })      -> last_error (curto, sem e-mail)
 *
 * attempts sobe 1 a cada chamada (cada chamada é uma tentativa de envio).
 * Aceita a forma antiga (id, status, 'mensagem de erro').
 *
 * tq-72 (21/10/2026): o SQL antigo usava $2 duas vezes — em `status=$2`
 * (coluna VARCHAR(20): o Postgres deduz character varying) e em
 * `CASE WHEN $2='sent'` (comparação com literal: deduz text). O node-pg
 * manda os parâmetros sem tipo, e o Postgres recusava a query inteira com
 * 42P08 "inconsistent types deduced for parameter $2". O .catch só fazia
 * console.error, então o envio contava como "sent" e a linha ficava
 * 'pending'. Agora todo parâmetro tem cast explícito, e o status é o mesmo
 * `$1::text` nas duas posições. O id ($4) aparece uma vez só e fica sem
 * cast: o tipo vem da coluna, seja qual for.
 *
 * Nunca lança: devolve true/false. Falha do UPDATE vai para o log com o
 * código do Postgres — quem chama decide o que fazer com o false.
 */
async function updateDelivery(id, status, info = {}) {
  const opts = typeof info === 'string' ? { error: info } : (info || {});
  if (!STATUS_DE_ENTREGA.has(status)) {
    console.error(`[reportGenerator] updateDelivery: status invalido "${status}" (delivery=${id})`);
    return false;
  }
  const resendId = opts.resendId != null && opts.resendId !== '' ? String(opts.resendId).slice(0, 100) : null;
  const error = status === 'failed' ? (erroCurto(opts.error) || 'erro desconhecido') : null;

  try {
    const { rowCount } = await db.query(
      `UPDATE report_deliveries
          SET status     = $1::text,
              resend_id  = COALESCE($2::text, resend_id),
              last_error = $3::text,
              sent_at    = CASE WHEN $1::text = 'sent' THEN NOW() ELSE NULL END,
              attempts   = attempts + 1
        WHERE id = $4`,
      [status, resendId, error, id]
    );
    if (!rowCount) {
      console.error(`[reportGenerator] updateDelivery: delivery=${id} nao encontrada (status=${status})`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[reportGenerator] updateDelivery error: code=${e.code || 'sem_codigo'} delivery=${id} status=${status}: ${e.message}`);
    return false;
  }
}

// opts (tq-85):
//   semBlocos  não calcula os blocos (versão resumo: o e-mail não usa)
//   config     config do relatório (preferências) que decide os blocos; sem
//              ela, lê a da própria empresa
//   semNarrativas  não chama o Claude para as narrativas: o e-mail e a página
//              nova não usam (só o JSON da página do app usa)
async function buildReportData(companyId, type, periodOverride = null, opts = {}) {
  const period = periodOverride || resolvePeriodForReport(type);

  const { rows: [company] } = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS name, email, plan, logo_url, is_primary, owner_id
     FROM companies WHERE id = $1 AND is_active = true`,
    [companyId]
  );
  if (!company) throw new Error('Empresa nao encontrada ou inativa');

  const prevPeriod = getPrevPeriod(period, type);
  const [salesCurrent, salesPrev, staleProducts, dormantCustomers, healthHistory, heatmapData] = await Promise.all([
    getSalesAnalytics(companyId, { period: 'custom', start_date: period.startDate,    end_date: period.endDate }),
    getSalesAnalytics(companyId, { period: 'custom', start_date: prevPeriod.startDate, end_date: prevPeriod.endDate }),
    fetchStaleProducts(companyId, 14),
    company.plan !== 'essencial' ? fetchDormantCustomers(companyId) : Promise.resolve(null),
    fetchHealthHistory(companyId),
    fetchSalesHeatmap(companyId, period.startDate, period.endDate),
  ]);

  const curr = salesCurrent.summary;
  const prev = salesPrev.summary;

  function pctChange(a, b) {
    if (!b || b === 0) return 0;
    return parseFloat(((a - b) / b * 100).toFixed(1));
  }

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

  kpis._prev_revenue   = prev.total_revenue || 0;
  kpis._prev_sales     = prev.total_sales || 0;
  kpis._prev_customers = prev.unique_customers || 0;

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

  const topProducts = (salesCurrent.top_products || []).slice(0, 5).map((p, i) => ({
    rank:     i + 1,
    name:     p.name,
    category: p.category || 'Geral',
    revenue:  p.total_revenue,
    qty:      Math.round(p.total_qty),
  }));

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
    _revenue: p.total_revenue,
  }));

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

  const narrativasPadrao = {
    revenue:  'Monitore a evolucao diaria do faturamento para identificar padroes.',
    products: 'Priorize os produtos com maior giro para garantir disponibilidade.',
    payments: 'Diversifique os metodos de pagamento para reduzir dependencia.',
  };
  const narratives = opts.semNarrativas
    ? narrativasPadrao
    : await generateWeeklyNarratives(reportDataForPriorities).catch(() => narrativasPadrao);

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

  let relatorio = null;
  if (!opts.semBlocos && type === 'weekly') {
    const config = await configDoRelatorio(companyId, opts.config);
    relatorio = await RB.dadosDosBlocos(companyId, {
      blocos: RB.blocosEfetivos(config, company.plan),
      plano: company.plan,
      period,
      kpis,
      dailyRevenue,
      prevRevenue: prev.total_revenue || 0,
      byPayment: salesCurrent.by_payment || [],
      dormant: dormantCustomers,
    });
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
    relatorio,
  };
}

// opts (tq-85): { semBlocos?, config?, decisorId? }. Os blocos do grupo são
// os da config da primária (decisorId, ou a primeira empresa), filtrados pelo
// plano de cada empresa.
async function buildConsolidatedReportData(companyIds, type, periodOverride = null, opts = {}) {
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    throw new Error('buildConsolidatedReportData: companyIds vazio');
  }
  if (companyIds.length === 1) {
    return buildReportData(companyIds[0], type, periodOverride, opts);
  }

  const period = periodOverride || resolvePeriodForReport(type);
  const config = opts.semBlocos ? null : await configDoRelatorio(opts.decisorId || companyIds[0], opts.config);
  const perCompany = await Promise.all(
    companyIds.map(id => buildReportData(id, type, period, { semBlocos: !!opts.semBlocos, config, semNarrativas: !!opts.semNarrativas }))
  );

  const primary = perCompany.find(r => r.company.is_primary) || perCompany[0];
  const N = perCompany.length;

  const totalRev          = perCompany.reduce((s, r) => s + (r.kpis.revenue || 0), 0);
  const totalSales        = perCompany.reduce((s, r) => s + (r.kpis.sales || 0), 0);
  const totalNewCustomers = perCompany.reduce((s, r) => s + (r.kpis.new_customers || 0), 0);
  const totalPrevRev      = perCompany.reduce((s, r) => s + (r.kpis._prev_revenue || 0), 0);
  const totalPrevSales    = perCompany.reduce((s, r) => s + (r.kpis._prev_sales || 0), 0);
  const totalPrevCusts    = perCompany.reduce((s, r) => s + (r.kpis._prev_customers || 0), 0);
  const activeDays        = Math.max(...perCompany.map(r => r.kpis.active_days || 0));
  const avgTicket         = totalSales > 0 ? totalRev / totalSales : 0;
  const avgTicketPrev     = totalPrevSales > 0 ? totalPrevRev / totalPrevSales : 0;

  function pct(a, b) {
    if (!b || b === 0) return 0;
    return parseFloat(((a - b) / b * 100).toFixed(1));
  }

  const HEALTH_SCORE = 71;
  const kpis = {
    revenue:         totalRev,
    revenue_delta:   pct(totalRev, totalPrevRev),
    revenue_dir:     totalRev >= totalPrevRev ? 'up' : 'down',
    sales:           totalSales,
    active_days:     activeDays,
    avg_ticket:      parseFloat(avgTicket.toFixed(2)),
    ticket_delta:    pct(avgTicket, avgTicketPrev),
    ticket_dir:      avgTicket >= avgTicketPrev ? 'up' : 'down',
    new_customers:   totalNewCustomers,
    customers_delta: totalNewCustomers - totalPrevCusts,
    customers_dir:   totalNewCustomers >= totalPrevCusts ? 'up' : 'down',
    health_score:    HEALTH_SCORE,
  };

  const dailyRevenue = primary.dailyRevenue.map((d, i) => ({
    day:     d.day,
    date:    d.date,
    value:   perCompany.reduce((s, r) => s + (r.dailyRevenue[i]?.value || 0), 0),
    is_best: false,
  }));
  if (dailyRevenue.length) {
    const maxIdx = dailyRevenue.reduce((mi, d, i, arr) => d.value > arr[mi].value ? i : mi, 0);
    dailyRevenue[maxIdx].is_best = true;
  }

  const prodMap = new Map();
  perCompany.forEach(r => {
    (r.topProducts || []).forEach(p => {
      const key = `${p.name}|${p.category || ''}`;
      const ex = prodMap.get(key) || { name: p.name, category: p.category || 'Geral', revenue: 0, qty: 0 };
      ex.revenue += p.revenue || 0;
      ex.qty     += p.qty || 0;
      prodMap.set(key, ex);
    });
  });
  const topProducts = Array.from(prodMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((p, i) => ({ ...p, rank: i + 1 }));

  const payMap = new Map();
  perCompany.forEach(r => {
    (r.payments || []).forEach(p => {
      const rev = p._revenue != null ? p._revenue : ((p.pct / 100) * (r.kpis.revenue || 0));
      const ex = payMap.get(p.name) || { name: p.name, revenue: 0 };
      ex.revenue += rev;
      payMap.set(p.name, ex);
    });
  });
  const payments = Array.from(payMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 6)
    .map(p => ({
      name: p.name,
      pct:  totalRev > 0 ? parseFloat(((p.revenue / totalRev) * 100).toFixed(1)) : 0,
    }));

  const heatMap = new Map();
  perCompany.forEach(r => {
    (r.heatmapData || []).forEach(c => {
      const key = `${c.dow}-${c.hour}`;
      const ex = heatMap.get(key) || { dow: c.dow, hour: c.hour, sale_count: 0, revenue: 0 };
      ex.sale_count += parseInt(c.sale_count) || 0;
      ex.revenue    += parseFloat(c.revenue)   || 0;
      heatMap.set(key, ex);
    });
  });
  const heatmapData = Array.from(heatMap.values()).sort((a, b) => a.dow - b.dow || a.hour - b.hour);

  const staleAll = perCompany.flatMap(r => (r.staleProducts || []).map(p => ({
    ...p,
    _from_company: r.company.name,
  })));
  staleAll.sort((a, b) => (b.days_idle || 0) - (a.days_idle || 0));
  const staleProducts = staleAll.slice(0, 3);

  const anyDormant = perCompany.some(r => r.dormantCustomers != null);
  const dormantCustomers = anyDormant ? {
    count: perCompany.reduce((s, r) => s + (r.dormantCustomers?.count || 0), 0),
    topDormant: perCompany
      .flatMap(r => r.dormantCustomers?.topDormant || [])
      .sort((a, b) => (b.total_spent || 0) - (a.total_spent || 0))
      .slice(0, 3),
  } : null;

  const reportDataAgg = {
    health: { score: HEALTH_SCORE },
    kpis,
    dailyRevenue,
    topProducts,
    payments,
    staleProducts,
    dormantCustomers,
  };
  const priorities = selectPriorities(reportDataAgg);
  const narrativasPadraoGrupo = {
    revenue:  'Monitore a evolucao diaria do faturamento consolidado para identificar padroes.',
    products: 'Priorize os produtos com maior giro nas duas unidades.',
    payments: 'Compare a distribuicao de pagamentos entre as unidades.',
  };
  const narratives = opts.semNarrativas
    ? narrativasPadraoGrupo
    : await generateWeeklyNarratives(reportDataAgg).catch(() => narrativasPadraoGrupo);

  let wowInsight = null;
  if (staleProducts && staleProducts.length > 0) {
    const p = staleProducts[0];
    wowInsight = {
      icon_type: 'box',
      text: `<b>${p.name}</b> esta parado ha <span class="num">${p.days_idle != null ? p.days_idle : '14+'} dias</span> em <b>${p._from_company || 'uma das unidades'}</b>. Crie uma promocao ou reposicione.`,
    };
  } else if (dormantCustomers && dormantCustomers.topDormant && dormantCustomers.topDormant.length > 0) {
    const c = dormantCustomers.topDormant[0];
    wowInsight = {
      icon_type: 'user',
      text: `<b>${c.name}</b> nao aparece ha <span class="num">${c.days_dormant} dias</span>. Gastou R$${Math.round(c.total_spent || 0).toLocaleString('pt-BR')} no historico — vale uma mensagem de retorno.`,
    };
  }

  const relatorio = opts.semBlocos || type !== 'weekly' ? null : RB.consolidarBlocos(
    perCompany.map(r => ({ companyId: r.company.id, nome: r.company.name, dados: r.relatorio })),
    { kpis, dailyRevenue, prevRevenue: totalPrevRev }
  );

  delete kpis._prev_revenue;
  delete kpis._prev_sales;
  delete kpis._prev_customers;

  const companyName = primary.company.name;
  const consolidatedName = `${companyName} (${N} unidades)`;

  return {
    company: {
      ...primary.company,
      name: consolidatedName,
      consolidated: true,
      unit_count: N,
    },
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
    staleProducts,
    dormantCustomers,
    breakdown: perCompany.map(r => ({
      company_id:   r.company.id,
      company_name: r.company.name,
      revenue:      r.kpis.revenue,
      sales:        r.kpis.sales,
      avg_ticket:   r.kpis.avg_ticket,
    })),
    relatorio,
  };
}

// opts (tq-88, 24/10/2026):
//   destinatarios  lista de e-mails já resolvida pelas preferências
//                  (services/emailPreferencias): pula a checagem de
//                  report_email_override/email, que deixou de ser a fonte
//   semEntrega     "Me enviar um agora": não olha nem grava
//                  report_deliveries (não pode consumir o envio agendado
//                  da semana) e não grava o snapshot de saúde
/**
 * Primeiro destinatário do relatório: o da lista já resolvida pelas
 * preferências (tq-88) ou, sem lista (rotas de admin), o de sempre:
 * COALESCE(report_email_override, email) da empresa ativa. null = sem e-mail.
 */
async function destinatarioDoRelatorio(companyId, destinatarios) {
  if (destinatarios) return destinatarios[0] || null;
  const { rows: [coCheck] } = await db.query(
    `SELECT COALESCE(report_email_override, email) AS recipient FROM companies WHERE id = $1 AND is_active = true`,
    [companyId]
  );
  return (coCheck && coCheck.recipient) || null;
}

async function generateReport(companyId, type, periodOverride = null, opts = {}) {
  const period = periodOverride || resolvePeriodForReport(type);
  const destinatarios = Array.isArray(opts.destinatarios) ? opts.destinatarios.filter(Boolean) : null;

  if (!opts.semEntrega) {
    const { rows: existing } = await db.query(
      `SELECT id FROM report_deliveries WHERE company_id=$1 AND report_type=$2 AND period_start=$3 AND status='sent' LIMIT 1`,
      [companyId, type, period.startDate]
    );
    if (existing.length > 0) {
      console.log(`[reportGenerator] ja enviado: company=${companyId} type=${type} period=${period.startDate}`);
      return { skipped: true, reason: 'already_sent' };
    }
  }

  const recipient = await destinatarioDoRelatorio(companyId, destinatarios);
  if (!recipient) return { skipped: true, reason: 'no_email' };

  let deliveryId = null;
  if (!opts.semEntrega) {
    const { rows: [delivery] } = await db.query(
      `INSERT INTO report_deliveries (company_id, report_type, period_start, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [companyId, type, period.startDate]
    );
    deliveryId = delivery.id;
  }

  // tq-85: a versão (completa/resumo) sai da config do relatório. Na
  // versão resumo os blocos não são calculados (o e-mail não usa).
  const config = await configDoRelatorio(companyId, opts.config);
  const versao = RB.versaoDoRelatorio(config);
  const data = await buildReportData(companyId, type, period, { config, semBlocos: versao === 'resumo', semNarrativas: true });

  let reportUrl = null;
  try {
    const token = signWeeklyReportToken({
      company_id:   companyId,
      period_start: period.startDate,
      period_end:   period.endDate,
    });
    reportUrl = urlDoRelatorio(token);
  } catch (err) {
    console.warn('[reportGenerator] signWeeklyReportToken falhou:', err.message);
    reportUrl = process.env.APP_URL || 'https://app.getaura.com.br';
  }

  const html = buildWeeklyReportHtml({
    company:   { name: data.company.name, logo_url: data.company.logo_url },
    companyId,
    periodo:   { inicio: period.startDate, fim: period.endDate },
    relatorio: data.relatorio,
  });

  if (!opts.semEntrega) {
    const snapshotPeriod = period.startDate.slice(0, 8) + '01';
    await saveHealthSnapshot(companyId, data.health.score, data.health.label, snapshotPeriod, {}).catch(e => {
      console.warn('[reportGenerator] saveHealthSnapshot falhou:', e.message);
    });
  }

  return {
    skipped:    false,
    deliveryId,
    company:    { ...data.company, recipient_email: recipient },
    period,
    kpis:       data.kpis,
    relatorio:  RB.semInternos(data.relatorio),
    versao,
    html,
    reportUrl,
  };
}

async function generateConsolidatedReport(companyIds, primaryId, type, periodOverride = null, opts = {}) {
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    throw new Error('generateConsolidatedReport: companyIds vazio');
  }
  if (companyIds.length === 1) {
    return generateReport(companyIds[0], type, periodOverride, opts);
  }

  const period = periodOverride || resolvePeriodForReport(type);
  const sub = primaryId || companyIds[0];
  const destinatarios = Array.isArray(opts.destinatarios) ? opts.destinatarios.filter(Boolean) : null;

  if (!opts.semEntrega) {
    const { rows: existing } = await db.query(
      `SELECT id FROM report_deliveries WHERE company_id=$1 AND report_type=$2 AND period_start=$3 AND status='sent' LIMIT 1`,
      [sub, type, period.startDate]
    );
    if (existing.length > 0) {
      console.log(`[reportGenerator] (consolidado) ja enviado: primary=${sub} period=${period.startDate}`);
      return { skipped: true, reason: 'already_sent' };
    }
  }

  const recipient = await destinatarioDoRelatorio(sub, destinatarios);
  if (!recipient) return { skipped: true, reason: 'no_email' };

  let deliveryId = null;
  if (!opts.semEntrega) {
    const { rows: [delivery] } = await db.query(
      `INSERT INTO report_deliveries (company_id, report_type, period_start, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [sub, type, period.startDate]
    );
    deliveryId = delivery.id;
  }

  const config = await configDoRelatorio(sub, opts.config);
  const versao = RB.versaoDoRelatorio(config);
  const data = await buildConsolidatedReportData(companyIds, type, period, {
    config, decisorId: sub, semBlocos: versao === 'resumo', semNarrativas: true,
  });

  let reportUrl = null;
  try {
    const token = signWeeklyReportToken({
      company_id:   sub,
      company_ids:  companyIds,
      period_start: period.startDate,
      period_end:   period.endDate,
    });
    reportUrl = urlDoRelatorio(token);
  } catch (err) {
    console.warn('[reportGenerator] signWeeklyReportToken (consolidado) falhou:', err.message);
    reportUrl = process.env.APP_URL || 'https://app.getaura.com.br';
  }

  const html = buildWeeklyReportHtml({
    company:   { name: data.company.name, logo_url: data.company.logo_url },
    companyId: sub,
    periodo:   { inicio: period.startDate, fim: period.endDate },
    relatorio: data.relatorio,
    breakdown: data.breakdown,
  });

  if (!opts.semEntrega) {
    const snapshotPeriod = period.startDate.slice(0, 8) + '01';
    await saveHealthSnapshot(sub, data.health.score, data.health.label, snapshotPeriod, {}).catch(e => {
      console.warn('[reportGenerator] saveHealthSnapshot (consolidado) falhou:', e.message);
    });
  }

  return {
    skipped:    false,
    deliveryId,
    company:    { ...data.company, recipient_email: recipient },
    period,
    kpis:       data.kpis,
    relatorio:  RB.semInternos(data.relatorio),
    versao,
    html,
    reportUrl,
  };
}

module.exports = {
  generateReport,
  generateConsolidatedReport,
  buildReportData,
  buildConsolidatedReportData,
  updateDelivery,
  configDoRelatorio,
  urlDoRelatorio,
};
