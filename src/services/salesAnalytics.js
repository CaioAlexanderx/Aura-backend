// ============================================================
// AURA. — Servico de Analytics de Vendas (BE-01)
//
// REVISAO 09/05/2026 (Eryca Finesse — fonte unica de vendas):
//   total_revenue agora vem de SALES.total_amount (status != cancelled),
//   no mesmo periodo. Isso ALINHA com o KPI "Vendas hoje" do Painel
//   (/dashboard) e com stats.revenue da tela /vendas (/sales) — que ja
//   usavam sales.
//
//   Eryca Finesse 09/05: Painel mostrava R$ 7651 (sales) e
//   SalesAnalyticsCard "Faturamento (hoje)" mostrava R$ 7247 (transactions
//   confirmed) na mesma tela. Cliente nao podia ter dois numeros
//   divergentes. Decisao: fonte unica = sales.total_amount.
//
//   transactions continua sendo a fonte de:
//     - Painel: revenue (mensal), cashInflow, expenses, net (regime caixa)
//     - Financeiro: lancamentos, DRE, fluxo
//   sales.total_amount e a fonte de:
//     - Painel: KPI "Vendas hoje" (salesToday)
//     - SalesAnalyticsCard: total_revenue (faturamento por periodo)
//     - Tela /vendas: stats.revenue
//     - PDV /summary: gross_revenue
//
// REVISAO 27/04 noite (deprecada acima):
//   total_revenue vinha de TRANSACTIONS — causava divergencia entre
//   o KPI top do Painel e o card Analytics dentro do mesmo Painel.
//
//   Sales table continua sendo a fonte de:
//     - total_sales (contagem operacional)
//     - top_products, top_employees, by_payment (analitico operacional)
//
// FIX: resolvePeriod usa calculo UTC-3 direto (sem ICU) para Railway.
// ============================================================

const db = require('../config/database');

// Calcula data SP sem depender de ICU/locale
// Brazil (SP) = UTC-3 sempre (sem horario de verao desde 2019)
function todaySP() {
  var d = new Date(Date.now() - 3 * 3600000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function addDaysSP(dateStr, n) {
  var parts = dateStr.split('-');
  var y = parseInt(parts[0]), m = parseInt(parts[1]) - 1, day = parseInt(parts[2]);
  var dt = new Date(Date.UTC(y, m, day + n));
  return dt.toISOString().slice(0, 10);
}

async function getSalesAnalytics(companyId, options = {}) {
  const { period = 'month', group_by = 'day', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  const [summary, series, top_products, top_employees, by_payment] = await Promise.all([
    getSummary(companyId, startDate, endDate),
    getTimeSeries(companyId, startDate, endDate, group_by),
    getTopProducts(companyId, startDate, endDate),
    getTopEmployees(companyId, startDate, endDate),
    getByPaymentMethod(companyId, startDate, endDate),
  ]);

  return {
    period: { start: startDate, end: endDate, label: period },
    summary,
    series,
    top_products,
    top_employees,
    by_payment,
  };
}

/**
 * Resumo do periodo.
 * 09/05/2026: total_revenue vem de SALES (mesma fonte do KPI top do Painel).
 * Demais metricas: SALES (operacional do PDV).
 */
async function getSummary(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  // Tudo de sales — fonte unica. Filtra por created_at SP no periodo.
  // status != cancelled para nao contar venda cancelada como faturamento.
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                                                                AS total_sales_all,
      COUNT(*) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int                     AS total_sales,
      COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status,'completed') != 'cancelled'), 0)    AS total_revenue,
      COALESCE(SUM(discount_amount) FILTER (WHERE COALESCE(status,'completed') != 'cancelled'), 0) AS total_discounts,
      COUNT(DISTINCT customer_id) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int  AS unique_customers,
      COUNT(DISTINCT (created_at ${SP})::date) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int AS active_days
    FROM sales
    WHERE company_id = $1
      AND (created_at ${SP}) >= $2::timestamp
      AND (created_at ${SP}) <  $3::timestamp
  `, [companyId, startDate, endDate]);

  const row = rows[0] || {};

  const totalRevenue = parseFloat(row.total_revenue) || 0;
  const totalSales   = parseInt(row.total_sales)     || 0;
  const avgTicket    = totalSales > 0
    ? parseFloat((totalRevenue / totalSales).toFixed(2))
    : 0;

  return {
    total_sales:      totalSales,
    total_revenue:    totalRevenue,
    avg_ticket:       avgTicket,
    total_discounts:  parseFloat(row.total_discounts)  || 0,
    unique_customers: parseInt(row.unique_customers)   || 0,
    active_days:      parseInt(row.active_days)        || 0,
  };
}

/**
 * Serie temporal — TUDO de sales agora.
 * total_sales: contagem por periodo.
 * total_revenue: SOMA de sales.total_amount por periodo.
 */
async function getTimeSeries(companyId, startDate, endDate, groupBy) {
  const SP    = `AT TIME ZONE 'America/Sao_Paulo'`;
  const spCol = `(created_at ${SP})`;

  const formats = {
    day:   `${spCol}::date`,
    week:  `DATE_TRUNC('week',  ${spCol})`,
    month: `DATE_TRUNC('month', ${spCol})`,
  };

  const fmt = formats[groupBy] || formats.day;

  const { rows } = await db.query(`
    SELECT
      ${fmt} AS period,
      COUNT(*)::int                  AS total_sales,
      COALESCE(SUM(total_amount), 0) AS total_revenue
    FROM sales
    WHERE company_id = $1
      AND COALESCE(status, 'completed') != 'cancelled'
      AND ${spCol} >= $2::timestamp
      AND ${spCol} <  $3::timestamp
    GROUP BY 1
    ORDER BY 1
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    period: r.period,
    total_sales: r.total_sales,
    total_revenue: parseFloat(r.total_revenue) || 0,
  }));
}

/**
 * Top 10 produtos mais vendidos — sale_items JOIN sales.
 */
async function getTopProducts(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      p.id,
      p.name,
      p.category,
      SUM(si.quantity)::float              AS total_qty,
      COALESCE(SUM(si.total_price), 0)     AS total_revenue,
      COUNT(DISTINCT s.id)::int            AS appearances
    FROM sale_items si
    JOIN sales    s ON s.id  = si.sale_id
    JOIN products p ON p.id  = si.product_id
    WHERE s.company_id = $1
      AND COALESCE(s.status, 'completed') != 'cancelled'
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) <  $3::timestamp
    GROUP BY p.id, p.name, p.category
    ORDER BY total_revenue DESC
    LIMIT 10
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    id:            r.id,
    name:          r.name,
    category:      r.category,
    total_qty:     parseFloat(r.total_qty),
    total_revenue: parseFloat(r.total_revenue),
    appearances:   r.appearances,
  }));
}

/**
 * Ranking de funcionarios por vendas no periodo — sales.
 */
async function getTopEmployees(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      u.id,
      u.full_name,
      COUNT(s.id)::int                    AS total_sales,
      COALESCE(SUM(s.total_amount), 0)    AS total_revenue,
      COALESCE(AVG(s.total_amount), 0)    AS avg_ticket
    FROM sales s
    JOIN users u ON u.id = s.seller_id
    WHERE s.company_id = $1
      AND COALESCE(s.status, 'completed') != 'cancelled'
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) <  $3::timestamp
      AND s.seller_id IS NOT NULL
    GROUP BY u.id, u.full_name
    ORDER BY total_revenue DESC
    LIMIT 10
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    id:            r.id,
    full_name:     r.full_name,
    total_sales:   r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
    avg_ticket:    parseFloat(parseFloat(r.avg_ticket).toFixed(2)),
  }));
}

/**
 * Vendas por metodo de pagamento — sales.
 */
async function getByPaymentMethod(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      COALESCE(payment_method, 'nao informado') AS method,
      COUNT(*)::int                              AS total_sales,
      COALESCE(SUM(total_amount), 0)             AS total_revenue
    FROM sales
    WHERE company_id = $1
      AND COALESCE(status, 'completed') != 'cancelled'
      AND (created_at ${SP}) >= $2::timestamp
      AND (created_at ${SP}) <  $3::timestamp
    GROUP BY payment_method
    ORDER BY total_revenue DESC
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    method:        r.method,
    total_sales:   r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
  }));
}

/**
 * Resolve periodo para datas de inicio e fim em horario de Brasilia.
 * Usa calculo UTC-3 direto (sem ICU) para Railway.
 */
function resolvePeriod(period, start_date, end_date) {
  var today = todaySP();
  var parts = today.split('-');
  var y = parseInt(parts[0]);
  var m = parseInt(parts[1]);

  var tomorrow     = addDaysSP(today, 1);
  var yesterday    = addDaysSP(today, -1);
  var weekStart    = addDaysSP(today, -6);
  var firstOfMonth = y + '-' + String(m).padStart(2, '0') + '-01';
  var firstOfYear  = y + '-01-01';

  var periods = {
    today:     { startDate: today,        endDate: tomorrow    },
    yesterday: { startDate: yesterday,    endDate: today       },
    week:      { startDate: weekStart,    endDate: tomorrow    },
    month:     { startDate: firstOfMonth, endDate: tomorrow    },
    year:      { startDate: firstOfYear,  endDate: tomorrow    },
    custom: {
      startDate: start_date || firstOfMonth,
      endDate:   end_date   ? addDaysSP(end_date, 1) : tomorrow,
    },
  };

  return periods[period] || periods.month;
}

module.exports = {
  getSalesAnalytics,
  getSummary,
  getTimeSeries,
  getTopProducts,
  getTopEmployees,
  getByPaymentMethod,
  resolvePeriod,
};
