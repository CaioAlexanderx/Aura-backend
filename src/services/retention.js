// ============================================================
// AURA. — Serviço de Retenção de Clientes (BE-07)
//
// MULTICNPJ Sessao 2 Onda 2.6 (03/05/2026): retention agora e
// owner-scoped — metricas de retencao consideram clientes/vendas
// de TODAS as empresas do mesmo dono. Consistente com a decisao
// da Onda 2.3 (clientes sao do dono, nao da loja).
//
// Vendedora membro so de Loja A em modo per-company ainda ve as
// metricas do owner inteiro porque clientes sao owner-scoped.
// ============================================================

const db = require('../config/database');
const { resolvePeriod } = require('./salesAnalytics');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');

/**
 * Dashboard de retenção — novos vs voltando
 * Um cliente é "voltando" se comprou ANTES do período selecionado
 * Um cliente é "novo" se a primeira compra foi DENTRO do período
 *
 * MULTICNPJ Onda 2.6: expande companyId pra todas as empresas do owner
 * antes de rodar as queries. Mantem assinatura identica.
 */
async function getRetentionDashboard(companyId, options = {}) {
  const { period = 'month', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  // MULTICNPJ Onda 2.6: owner-scope
  const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
  if (ownerCompanyIds.length === 0) {
    return {
      period: { start: startDate, end: endDate, label: period },
      overview: {
        total_unique: 0, new_customers: 0, returning_customers: 0,
        new_pct: 0, returning_pct: 0, anonymous_sales: 0,
      },
      trend: [],
      at_risk: { total: 0, customers: [] },
      lost: { total: 0 },
    };
  }

  const [overview, trend, atRisk, lost] = await Promise.all([
    getRetentionOverview(ownerCompanyIds, startDate, endDate),
    getRetentionTrend(ownerCompanyIds, startDate, endDate),
    getAtRiskCustomers(ownerCompanyIds),
    getLostCustomers(ownerCompanyIds),
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
 * Recebe array de companyIds (owner-scope).
 */
async function getRetentionOverview(companyIds, startDate, endDate) {
  const { rows } = await db.query(`
    WITH period_customers AS (
      SELECT DISTINCT
        s.customer_id,
        c.first_purchase_at,
        MIN(s.created_at) AS first_in_period
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.company_id = ANY($1)
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
  `, [companyIds, startDate, endDate]);

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
    anonymous_sales: await getAnonymousSalesCount(companyIds, startDate, endDate),
  };
}

async function getAnonymousSalesCount(companyIds, startDate, endDate) {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM sales
    WHERE company_id = ANY($1)
      AND created_at >= $2
      AND created_at < $3
      AND customer_id IS NULL
  `, [companyIds, startDate, endDate]);
  return rows[0].total;
}

/**
 * Tendência mês a mês — últimos 6 meses
 */
async function getRetentionTrend(companyIds, startDate, endDate) {
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
      WHERE s.company_id = ANY($1)
        AND s.created_at >= NOW() - INTERVAL '6 months'
        AND s.customer_id IS NOT NULL
      GROUP BY 1
    )
    SELECT * FROM monthly ORDER BY month ASC
  `, [companyIds]);

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
 * Clientes em risco — 30–90 dias sem comprar
 */
async function getAtRiskCustomers(companyIds) {
  const { rows } = await db.query(`
    SELECT
      c.id, c.name, c.phone, c.instagram_handle,
      c.total_purchases, c.total_spent,
      c.last_purchase_at,
      NOW() - c.last_purchase_at AS time_since_last
    FROM customers c
    WHERE c.company_id = ANY($1)
      AND c.is_active = true
      AND c.last_purchase_at IS NOT NULL
      AND c.last_purchase_at < NOW() - INTERVAL '30 days'
      AND c.last_purchase_at >= NOW() - INTERVAL '90 days'
    ORDER BY c.total_spent DESC
    LIMIT 20
  `, [companyIds]);

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
async function getLostCustomers(companyIds) {
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS total
    FROM customers c
    WHERE c.company_id = ANY($1)
      AND c.is_active = true
      AND c.last_purchase_at < NOW() - INTERVAL '90 days'
  `, [companyIds]);

  return { total: rows[0].total };
}

module.exports = { getRetentionDashboard };
