// ============================================================
// AURA. — Servico de Categorias + Curva ABC (BE-03)
// FIX: ranking now uses INNER JOIN so only products with
//      sales IN the period appear (was LEFT JOIN = all-time data)
// FIX 2: queries usam AT TIME ZONE 'America/Sao_Paulo' para
//      consistencia com salesAnalytics.js (era created_at direto = UTC)
// FIX 3 (19/05/2026): campo por produto renomeado de `curve` -> `abc`
//      para casar com a leitura do frontend (AbcCurveCard lia p.abc e
//      caia sempre no fallback 'C'). curve_summary preservado no topo
//      da resposta por compatibilidade.
// ============================================================

const db = require('../config/database');
const { resolvePeriod } = require('./salesAnalytics');

function classifyABC(products, totalRevenue) {
  let accumulated = 0;
  return products.map(product => {
    accumulated += product.total_revenue;
    const pct = totalRevenue > 0 ? (accumulated / totalRevenue) * 100 : 0;
    const abc = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
    return { ...product, accumulated_pct: parseFloat(pct.toFixed(1)), abc };
  });
}

async function getProductsRanking(companyId, options = {}) {
  const { period = 'month', start_date, end_date, category } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const params = [companyId, startDate, endDate];
  const categoryFilter = category ? 'AND p.category = $4' : '';
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
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
      AND s.company_id = $1
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) < $3::timestamp
    JOIN products p ON p.id = si.product_id
      AND p.company_id = $1
      AND p.is_active = true
      ${categoryFilter}
    GROUP BY p.id, p.name, p.category, p.price, p.stock_qty
    ORDER BY total_revenue DESC
  `, params);

  const totalRevenue = rows.reduce((sum, r) => sum + parseFloat(r.total_revenue), 0);
  const totalSold = rows.reduce((sum, r) => sum + (parseFloat(r.total_qty) || 0), 0);

  const products = rows.map(r => ({
    id:            r.id,
    name:          r.name,
    category:      r.category,
    price:         parseFloat(r.price),
    stock_qty:     parseFloat(r.stock_qty),
    qty_sold:      parseFloat(r.total_qty) || 0,
    total_qty:     parseFloat(r.total_qty) || 0,
    total_revenue: parseFloat(r.total_revenue),
    revenue:       parseFloat(r.total_revenue),
    avg_price:     parseFloat(parseFloat(r.avg_price).toFixed(2)),
    total_orders:  r.total_orders,
    share_pct:     totalRevenue > 0
      ? parseFloat(((parseFloat(r.total_revenue) / totalRevenue) * 100).toFixed(1))
      : 0,
  }));

  const ranked = classifyABC(products, totalRevenue);

  return {
    period:         { start: startDate, end: endDate, label: period },
    total_revenue:  parseFloat(totalRevenue.toFixed(2)),
    total_products: ranked.length,
    summary: {
      total_products: ranked.length,
      total_sold:     totalSold,
      total_revenue:  parseFloat(totalRevenue.toFixed(2)),
    },
    curve_summary: {
      A: ranked.filter(p => p.abc === 'A').length,
      B: ranked.filter(p => p.abc === 'B').length,
      C: ranked.filter(p => p.abc === 'C').length,
    },
    products: ranked,
  };
}

async function getCategories(companyId, options = {}) {
  const { period = 'month', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  const { rows } = await db.query(`
    SELECT
      COALESCE(p.category, 'Sem categoria')  AS category,
      COUNT(DISTINCT p.id)::int              AS total_products,
      COALESCE(SUM(si.total_price), 0)       AS total_revenue,
      COALESCE(SUM(si.quantity), 0)::float   AS total_qty
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
      AND s.company_id = $1
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) < $3::timestamp
    JOIN products p ON p.id = si.product_id
      AND p.company_id = $1
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
