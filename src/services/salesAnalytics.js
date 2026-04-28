// ============================================================
// AURA. — Servico de Analytics de Vendas (BE-01)
//
// REVISAO 27/04 noite (pos PR #3):
//   total_revenue agora vem de TRANSACTIONS (income confirmed) com filtro
//   COALESCE(due_date, created_at SP) — mesma fonte do Painel/Financeiro/DRE.
//   Garante que todas as telas mostrem o mesmo numero de receita.
//
//   Sales table continua sendo a fonte de:
//     - total_sales (contagem operacional)
//     - top_products, top_employees, by_payment (analitico operacional)
//   Esses sao indicadores de PDV, nao financeiros.
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
 * total_revenue: TRANSACTIONS (income confirmed) — mesma fonte do Painel.
 * Demais metricas: SALES (operacional do PDV).
 */
async function getSummary(companyId, startDate, endDate) {
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  // Operacional: contagem, descontos, clientes, dias ativos — vem de sales
  const salesPromise = db.query(`
    SELECT
      COUNT(*)::int                                                                                AS total_sales,
      COALESCE(SUM(discount_amount) FILTER (WHERE COALESCE(status,'completed') != 'cancelled'), 0) AS total_discounts,
      COUNT(DISTINCT customer_id) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int  AS unique_customers,
      COUNT(DISTINCT (created_at ${SP})::date) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int AS active_days
    FROM sales
    WHERE company_id = $1
      AND (created_at ${SP}) >= $2::timestamp
      AND (created_at ${SP}) <  $3::timestamp
  `, [companyId, startDate, endDate]);

  // Financeiro: receita = transactions confirmed com filtro COALESCE(due_date, created_at SP)
  // Identico ao Painel/Financeiro/DRE.
  const txPromise = db.query(`
    SELECT
      COALESCE(SUM(amount), 0) AS total_revenue
    FROM transactions
    WHERE company_id = $1
      AND type = 'income'
      AND status = 'confirmed'
      AND COALESCE(due_date, (created_at ${SP})::date) >= $2::date
      AND COALESCE(due_date, (created_at ${SP})::date) <  $3::date
  `, [companyId, startDate, endDate]);

  const [salesRes, txRes] = await Promise.all([salesPromise, txPromise]);
  const salesRow = salesRes.rows[0] || {};
  const txRow    = txRes.rows[0]    || {};

  const totalRevenue = parseFloat(txRow.total_revenue) || 0;
  const totalSales   = parseInt(salesRow.total_sales)  || 0;
  const avgTicket    = totalSales > 0
    ? parseFloat((totalRevenue / totalSales).toFixed(2))
    : 0;

  return {
    total_sales:      totalSales,
    total_revenue:    totalRevenue,
    avg_ticket:       avgTicket,
    total_discounts:  parseFloat(salesRow.total_discounts)  || 0,
    unique_customers: parseInt(salesRow.unique_customers)   || 0,
    active_days:      parseInt(salesRow.active_days)        || 0,
  };
}

/**
 * Serie temporal.
 * total_sales: contagem por periodo (sales).
 * total_revenue: SOMA de transactions income confirmed por periodo (mesmo do Painel).
 */
async function getTimeSeries(companyId, startDate, endDate, groupBy) {
  const SP    = `AT TIME ZONE 'America/Sao_Paulo'`;
  const spCol = `(created_at ${SP})`;
  const txDateCol = `COALESCE(due_date, (created_at ${SP})::date)`;

  const formats = {
    day:   { sales: `${spCol}::date`,                             tx: `${txDateCol}` },
    week:  { sales: `DATE_TRUNC('week',  ${spCol})`,              tx: `DATE_TRUNC('week',  ${txDateCol})` },
    month: { sales: `DATE_TRUNC('month', ${spCol})`,              tx: `DATE_TRUNC('month', ${txDateCol})` },
  };

  const fmt = formats[groupBy] || formats.day;

  // Contagem operacional por periodo (sales)
  const salesPromise = db.query(`
    SELECT
      ${fmt.sales} AS period,
      COUNT(*)::int AS total_sales
    FROM sales
    WHERE company_id = $1
      AND COALESCE(status, 'completed') != 'cancelled'
      AND ${spCol} >= $2::timestamp
      AND ${spCol} <  $3::timestamp
    GROUP BY 1
  `, [companyId, startDate, endDate]);

  // Receita por periodo (transactions confirmed, regime caixa+due_date)
  const txPromise = db.query(`
    SELECT
      ${fmt.tx} AS period,
      COALESCE(SUM(amount), 0) AS total_revenue
    FROM transactions
    WHERE company_id = $1
      AND type = 'income'
      AND status = 'confirmed'
      AND ${txDateCol} >= $2::date
      AND ${txDateCol} <  $3::date
    GROUP BY 1
  `, [companyId, startDate, endDate]);

  const [salesRes, txRes] = await Promise.all([salesPromise, txPromise]);

  // Merge as duas series por chave de periodo (datetime ou date)
  const merged = new Map();
  salesRes.rows.forEach(r => {
    const k = r.period instanceof Date ? r.period.toISOString() : String(r.period);
    merged.set(k, { period: r.period, total_sales: r.total_sales, total_revenue: 0 });
  });
  txRes.rows.forEach(r => {
    const k = r.period instanceof Date ? r.period.toISOString() : String(r.period);
    if (merged.has(k)) {
      merged.get(k).total_revenue = parseFloat(r.total_revenue);
    } else {
      merged.set(k, { period: r.period, total_sales: 0, total_revenue: parseFloat(r.total_revenue) });
    }
  });

  return Array.from(merged.values())
    .sort((a, b) => {
      const ka = a.period instanceof Date ? a.period.getTime() : String(a.period);
      const kb = b.period instanceof Date ? b.period.getTime() : String(b.period);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
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
