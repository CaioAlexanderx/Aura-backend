// ============================================================
// AURA. — Serviço de Retenção de Clientes (BE-07)
// ============================================================

const db = require('../config/database');
const { resolvePeriod } = require('./salesAnalytics');

/**
 * Dashboard de retenção — novos vs voltando
 * Um cliente é "voltando" se comprou ANTES do período selecionado
 * Um cliente é "novo" se a primeira compra foi DENTRO do período
 */
async function getRetentionDashboard(companyId, options = {}) {
  const { period = 'month', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  const [overview, trend, atRisk, lost] = await Promise.all([
    getRetentionOverview(companyId, startDate, endDate),
    getRetentionTrend(companyId, startDate, endDate),
    getAtRiskCustomers(companyId),
    getLostCustomers(companyId),
  ]);

  return {
    period:   { start: startDate, end: endDate, label: period },
    overview,
    trend,
    at_risk:  atRisk,
    lost,
  };
}

/**
 * Visão geral: novos, voltando, únicos, taxa de retenção
 */
async function getRetentionOverview(companyId, startDate, endDate) {
  const { rows } = await db.query(`
    WITH period_customers AS (
      SELECT DISTINCT
        s.customer_id,
        c.first_purchase_at,
        MIN(s.created_at) AS first_in_period
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.company_id = $1
        AND s.created_at >= $2
        AND s.created_at < $3
        AND s.customer_id IS NOT NULL
      GROUP BY s.customer_id, c.first_purchase_at
    )
    SELECT
      COUNT(*)::int AS total_unique,
      COUNT(CASE WHEN first_purchase_at >= $2 THEN 1 END)::int  AS new_customers,
      COUNT(CASE WHEN first_purchase_at < $2  THEN 1 END)::int  AS returning_customers
    FROM period_customers
  `, [companyId, startDate, endDate]);

  const r = rows[0];
  const total      = r.total_unique;
  const newC       = r.new_customers;
  const returning  = r.returning_customers;

  return {
    total_unique:        total,
    new_customers:       newC,
    returning_customers: returning,
    new_pct:       total > 0 ? parseFloat(((newC      / total) * 100).toFixed(1)) : 0,
    returning_pct: total > 0 ? parseFloat(((returning / total) * 100).toFixed(1)) : 0,
    // Vendas sem identificação de cliente
    anonymous_sales: await getAnonymousSalesCount(companyId, startDate, endDate),
  };
}

async function getAnonymousSalesCount(companyId, startDate, endDate) {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM sales
    WHERE company_id = $1
      AND created_at >= $2
      AND created_at < $3
      AND customer_id IS NULL
  `, [companyId, startDate, endDate]);
  return rows[0].total;
}

/**
 * Tendência mês a mês — últimos 6 meses
 */
async function getRetentionTrend(companyId, startDate, endDate) {
  const { rows } = await db.query(`
    WITH monthly AS (
      SELECT
        DATE_TRUNC('month', s.created_at)                        AS month,
        COUNT(DISTINCT s.customer_id)::int                       AS total_unique,
        COUNT(DISTINCT CASE
          WHEN c.first_purchase_at >= DATE_TRUNC('month', s.created_at)
          THEN s.customer_id END)::int                           AS new_customers,
        COUNT(DISTINCT CASE
          WHEN c.first_purchase_at < DATE_TRUNC('month', s.created_at)
          THEN s.customer_id END)::int                           AS returning_customers
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.company_id = $1
        AND s.created_at >= NOW() - INTERVAL '6 months'
        AND s.customer_id IS NOT NULL
      GROUP BY 1
    )
    SELECT * FROM monthly ORDER BY month ASC
  `, [companyId]);

  return rows.map(r => ({
    month:               r.month,
    total_unique:        r.total_unique,
    new_customers:       r.new_customers,
    returning_customers: r.returning_customers,
    retention_rate:      r.total_unique > 0
      ? parseFloat(((r.returning_customers / r.total_unique) * 100).toFixed(1))
      : 0,
  }));
}

/**
 * Clientes em risco — compraram no passado mas sumiram (30–90 dias sem comprar)
 */
async function getAtRiskCustomers(companyId) {
  const { rows } = await db.query(`
    SELECT
      c.id, c.name, c.phone, c.instagram_handle,
      c.total_purchases, c.total_spent,
      c.last_purchase_at,
      NOW() - c.last_purchase_at AS time_since_last
    FROM customers c
    WHERE c.company_id = $1
      AND c.is_active = true
      AND c.last_purchase_at IS NOT NULL
      AND c.last_purchase_at < NOW() - INTERVAL '30 days'
      AND c.last_purchase_at >= NOW() - INTERVAL '90 days'
    ORDER BY c.total_spent DESC
    LIMIT 20
  `, [companyId]);

  return {
    total: rows.length,
    customers: rows.map(r => ({
      id:               r.id,
      name:             r.name,
      phone:            r.phone,
      instagram_handle: r.instagram_handle,
      total_purchases:  r.total_purchases,
      total_spent:      parseFloat(r.total_spent),
      last_purchase_at: r.last_purchase_at,
      days_since_last:  Math.floor(r.time_since_last.days || 0),
    })),
  };
}

/**
 * Clientes perdidos — sem comprar há mais de 90 dias
 */
async function getLostCustomers(companyId) {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM customers c
    WHERE c.company_id = $1
      AND c.is_active = true
      AND c.last_purchase_at < NOW() - INTERVAL '90 days'
  `, [companyId]);

  return { total: rows[0].total };
}

module.exports = { getRetentionDashboard };
