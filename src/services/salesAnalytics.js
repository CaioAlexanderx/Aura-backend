// ============================================================
// AURA. — Serviço de Analytics de Vendas (BE-01)
// ============================================================

const db = require('../config/database');

/**
 * Retorna analytics de vendas por período e agrupamento
 * @param {string} companyId
 * @param {object} options - { period, group_by, start_date, end_date }
 *   period: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'custom'
 *   group_by: 'day' | 'week' | 'month' | 'employee' | 'payment_method' | 'product'
 */
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
 * Resumo do período: total, ticket médio, contagem
 */
async function getSummary(companyId, startDate, endDate) {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                          AS total_sales,
      COALESCE(SUM(total_amount), 0)         AS total_revenue,
      COALESCE(AVG(total_amount), 0)         AS avg_ticket,
      COALESCE(SUM(discount_amount), 0)      AS total_discounts,
      COUNT(DISTINCT customer_id)::int       AS unique_customers,
      COUNT(DISTINCT DATE(created_at))::int  AS active_days
    FROM sales
    WHERE company_id = $1
      AND created_at >= $2
      AND created_at < $3
  `, [companyId, startDate, endDate]);

  const row = rows[0];
  return {
    total_sales:      row.total_sales,
    total_revenue:    parseFloat(row.total_revenue),
    avg_ticket:       parseFloat(parseFloat(row.avg_ticket).toFixed(2)),
    total_discounts:  parseFloat(row.total_discounts),
    unique_customers: row.unique_customers,
    active_days:      row.active_days,
  };
}

/**
 * Série temporal — vendas agrupadas por dia/semana/mês
 */
async function getTimeSeries(companyId, startDate, endDate, groupBy) {
  const formats = {
    day:   `DATE(created_at)`,
    week:  `DATE_TRUNC('week', created_at)`,
    month: `DATE_TRUNC('month', created_at)`,
  };

  const groupExpr = formats[groupBy] || formats.day;

  const { rows } = await db.query(`
    SELECT
      ${groupExpr}                    AS period,
      COUNT(*)::int                   AS total_sales,
      COALESCE(SUM(total_amount), 0)  AS total_revenue
    FROM sales
    WHERE company_id = $1
      AND created_at >= $2
      AND created_at < $3
    GROUP BY 1
    ORDER BY 1
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    period:        r.period,
    total_sales:   r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
  }));
}

/**
 * Top 10 produtos mais vendidos (quantidade e receita)
 */
async function getTopProducts(companyId, startDate, endDate) {
  const { rows } = await db.query(`
    SELECT
      p.id,
      p.name,
      p.category,
      SUM(si.quantity)::float              AS total_qty,
      COALESCE(SUM(si.total_price), 0)     AS total_revenue,
      COUNT(DISTINCT s.id)::int            AS appearances
    FROM sale_items si
    JOIN sales s   ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.company_id = $1
      AND s.created_at >= $2
      AND s.created_at < $3
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
 * Ranking de funcionários por vendas no período
 */
async function getTopEmployees(companyId, startDate, endDate) {
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
      AND s.created_at >= $2
      AND s.created_at < $3
      AND s.seller_id IS NOT NULL
    GROUP BY u.id, u.full_name
    ORDER BY total_revenue DESC
    LIMIT 10
  `, [companyId, startDate, endDate]);

  return rows.map(r => ({
    id:           r.id,
    full_name:    r.full_name,
    total_sales:  r.total_sales,
    total_revenue: parseFloat(r.total_revenue),
    avg_ticket:   parseFloat(parseFloat(r.avg_ticket).toFixed(2)),
  }));
}

/**
 * Vendas por método de pagamento
 */
async function getByPaymentMethod(companyId, startDate, endDate) {
  const { rows } = await db.query(`
    SELECT
      COALESCE(payment_method, 'não informado') AS method,
      COUNT(*)::int                              AS total_sales,
      COALESCE(SUM(total_amount), 0)             AS total_revenue
    FROM sales
    WHERE company_id = $1
      AND created_at >= $2
      AND created_at < $3
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
 * Resolve período para datas de início e fim
 */
function resolvePeriod(period, start_date, end_date) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);

  const periods = {
    today: {
      startDate: today,
      endDate:   tomorrow,
    },
    yesterday: {
      startDate: new Date(today.getTime() - 86400000),
      endDate:   today,
    },
    week: {
      startDate: new Date(today.getTime() - 6 * 86400000),
      endDate:   tomorrow,
    },
    month: {
      startDate: new Date(today.getFullYear(), today.getMonth(), 1),
      endDate:   tomorrow,
    },
    year: {
      startDate: new Date(today.getFullYear(), 0, 1),
      endDate:   tomorrow,
    },
    custom: {
      startDate: start_date ? new Date(start_date) : new Date(today.getFullYear(), today.getMonth(), 1),
      endDate:   end_date   ? new Date(new Date(end_date).getTime() + 86400000) : tomorrow,
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
