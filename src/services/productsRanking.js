// ============================================================
// AURA. — Serviço de Categorias + Curva ABC (BE-03)
// ============================================================

const db = require('../config/database');
const { resolvePeriod } = require('./salesAnalytics');

/**
 * Curva ABC — classifica produtos por participação na receita
 * A = produtos que representam os primeiros 80% da receita
 * B = produtos que representam os próximos 15% (80–95%)
 * C = produtos que representam os últimos 5% (95–100%)
 */
function classifyABC(products, totalRevenue) {
  let accumulated = 0;
  return products.map(product => {
    accumulated += product.total_revenue;
    const pct = totalRevenue > 0 ? (accumulated / totalRevenue) * 100 : 0;
    const curve = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
    return { ...product, accumulated_pct: parseFloat(pct.toFixed(1)), curve };
  });
}

/**
 * Ranking de produtos com curva ABC
 */
async function getProductsRanking(companyId, options = {}) {
  const { period = 'month', start_date, end_date, category } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  const params = [companyId, startDate, endDate];
  const categoryFilter = category ? `AND p.category = $4` : '';
  if (category) params.push(category);

  const { rows } = await db.query(`
    SELECT
      p.id,
      p.name,
      p.category,
      p.price,
      p.stock_qty,
      SUM(si.quantity)::float             AS total_qty,
      COALESCE(SUM(si.total_price), 0)    AS total_revenue,
      COALESCE(AVG(si.unit_price), 0)     AS avg_price,
      COUNT(DISTINCT s.id)::int           AS total_orders
    FROM products p
    LEFT JOIN sale_items si ON si.product_id = p.id
    LEFT JOIN sales s ON s.id = si.sale_id
      AND s.company_id = $1
      AND s.created_at >= $2
      AND s.created_at < $3
    WHERE p.company_id = $1
      AND p.is_active = true
      ${categoryFilter}
    GROUP BY p.id, p.name, p.category, p.price, p.stock_qty
    ORDER BY total_revenue DESC
  `, params);

  const totalRevenue = rows.reduce((sum, r) => sum + parseFloat(r.total_revenue), 0);

  const products = rows.map(r => ({
    id:           r.id,
    name:         r.name,
    category:     r.category,
    price:        parseFloat(r.price),
    stock_qty:    parseFloat(r.stock_qty),
    total_qty:    parseFloat(r.total_qty) || 0,
    total_revenue: parseFloat(r.total_revenue),
    avg_price:    parseFloat(parseFloat(r.avg_price).toFixed(2)),
    total_orders: r.total_orders,
    share_pct:    totalRevenue > 0
      ? parseFloat(((parseFloat(r.total_revenue) / totalRevenue) * 100).toFixed(1))
      : 0,
  }));

  const ranked = classifyABC(products, totalRevenue);

  return {
    period:        { start: startDate, end: endDate, label: period },
    total_revenue: parseFloat(totalRevenue.toFixed(2)),
    total_products: ranked.length,
    curve_summary: {
      A: ranked.filter(p => p.curve === 'A').length,
      B: ranked.filter(p => p.curve === 'B').length,
      C: ranked.filter(p => p.curve === 'C').length,
    },
    products: ranked,
  };
}

/**
 * Lista categorias cadastradas com métricas
 */
async function getCategories(companyId, options = {}) {
  const { period = 'month', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  const { rows } = await db.query(`
    SELECT
      COALESCE(p.category, 'Sem categoria')  AS category,
      COUNT(DISTINCT p.id)::int              AS total_products,
      COALESCE(SUM(si.total_price), 0)       AS total_revenue,
      COALESCE(SUM(si.quantity), 0)::float   AS total_qty
    FROM products p
    LEFT JOIN sale_items si ON si.product_id = p.id
    LEFT JOIN sales s ON s.id = si.sale_id
      AND s.company_id = $1
      AND s.created_at >= $2
      AND s.created_at < $3
    WHERE p.company_id = $1
      AND p.is_active = true
    GROUP BY p.category
    ORDER BY total_revenue DESC
  `, [companyId, startDate, endDate]);

  const totalRevenue = rows.reduce((sum, r) => sum + parseFloat(r.total_revenue), 0);

  return rows.map(r => ({
    category:       r.category,
    total_products: r.total_products,
    total_revenue:  parseFloat(r.total_revenue),
    total_qty:      parseFloat(r.total_qty),
    share_pct:      totalRevenue > 0
      ? parseFloat(((parseFloat(r.total_revenue) / totalRevenue) * 100).toFixed(1))
      : 0,
  }));
}

module.exports = { getProductsRanking, getCategories, classifyABC };
