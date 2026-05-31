// ============================================================
// AURA. — Servico de Categorias + Curva ABC (BE-03)
//
// FIX 30/05/2026 (bug Eryca Finesse — Curva ABC):
//   1) WHERE filtros que faltavam (memory armadilha_trocas_inflam_agregados):
//      - COALESCE(s.status, 'completed') != 'cancelled'  (não infla com cancelada)
//      - COALESCE(s.type, 'sale') = 'sale'               (não infla com troca)
//      Alinha com salesAnalytics.getSummary e /dashboard salesToday.
//   2) INNER -> LEFT JOIN em products. Antes, produto vendido e DEPOIS
//      desativado (merge variantes, dental_supply, etc) sumia inteiro
//      do histórico do ranking. Agora preserva como "Produto removido".
//   3) visibilityWhere multi-CNPJ (memory armadilha_visibility_leaks_rotas_produto):
//      shared products do grupo aparecem no ranking de TODAS as filiais.
//   4) Suporte a limit/offset e abc filter — backend agora classifica todos
//      e devolve só a fatia pedida. class_breakdown vai no header.
//
// FIX 19/05/2026: campo por produto renomeado de `curve` -> `abc`.
// FIX 11/05/2026 (analogo trocas): salesAnalytics excluiu type='troca'; o
//   ranking ABC ficou inadvertidamente de fora — esse PR fecha o gap.
// FIX 09/05/2026: queries usam AT TIME ZONE 'America/Sao_Paulo'.
// FIX original: ranking usa INNER JOIN sale_items, period filter no sales.
// ============================================================

const db = require('../config/database');
const { resolvePeriod } = require('./salesAnalytics');

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const VALID_ABC = ['A', 'B', 'C'];

function classifyABC(products, totalRevenue) {
  let accumulated = 0;
  return products.map(product => {
    accumulated += product.total_revenue;
    const pct = totalRevenue > 0 ? (accumulated / totalRevenue) * 100 : 0;
    const abc = pct <= 80 ? 'A' : pct <= 95 ? 'B' : 'C';
    return { ...product, accumulated_pct: parseFloat(pct.toFixed(1)), abc };
  });
}

// Helper de visibilidade de grupo (espelha listVisibilityWhere de products.js).
// Usado no JOIN com products pra incluir is_group_shared do mesmo group_root.
function groupVisibilityClause(cidParamRef) {
  return `(p.company_id = ${cidParamRef} OR (
    p.is_group_shared = true
    AND p.company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParamRef}
      )
    )
  ))`;
}

async function getProductsRanking(companyId, options = {}) {
  const { period = 'month', start_date, end_date, category } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  // limit/offset/abc — sanitiza
  const requestedLimit = parseInt(options.limit, 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;
  const requestedOffset = parseInt(options.offset, 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;
  const abcFilter = typeof options.abc === 'string' && VALID_ABC.includes(options.abc.toUpperCase())
    ? options.abc.toUpperCase()
    : null;

  const params = [companyId, startDate, endDate];
  const categoryFilter = category ? `AND COALESCE(p.category, 'Sem categoria') = $${params.length + 1}` : '';
  if (category) params.push(category);

  // FIX 30/05/2026:
  //   - Filtros de status != cancelled e type != troca no JOIN com sales
  //   - LEFT JOIN em products (preserva histórico) + COALESCE pros campos
  //   - groupVisibilityClause pra multi-CNPJ
  //   - Sem LIMIT na query SQL — limit aplicado depois da classificação,
  //     pra que A/B/C sejam corretos mesmo na pagina N.
  const sql = `
    SELECT
      COALESCE(p.id::text, 'deleted:' || si.product_id::text) AS id,
      COALESCE(p.name, 'Produto removido')                    AS name,
      COALESCE(p.category, 'Sem categoria')                   AS category,
      p.price                                                  AS price,
      p.stock_qty                                              AS stock_qty,
      p.is_active                                              AS is_active,
      SUM(si.quantity)::float                                  AS total_qty,
      COALESCE(SUM(si.total_price), 0)                         AS total_revenue,
      COALESCE(AVG(si.unit_price), 0)                          AS avg_price,
      COUNT(DISTINCT s.id)::int                                AS total_orders
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
      AND s.company_id = $1
      AND COALESCE(s.status, 'completed') != 'cancelled'
      AND COALESCE(s.type,   'sale')      = 'sale'
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) <  $3::timestamp
    LEFT JOIN products p ON p.id = si.product_id
      AND ${groupVisibilityClause('$1')}
      ${categoryFilter}
    WHERE si.product_id IS NOT NULL
    GROUP BY p.id, p.name, p.category, p.price, p.stock_qty, p.is_active, si.product_id
    ORDER BY total_revenue DESC
  `;

  const { rows } = await db.query(sql, params);

  const totalRevenue = rows.reduce((sum, r) => sum + parseFloat(r.total_revenue || 0), 0);
  const totalSold = rows.reduce((sum, r) => sum + (parseFloat(r.total_qty) || 0), 0);

  const allProducts = rows.map(r => ({
    id:            r.id,
    name:          r.name,
    category:      r.category,
    price:         r.price != null ? parseFloat(r.price) : 0,
    stock_qty:     r.stock_qty != null ? parseFloat(r.stock_qty) : 0,
    is_active:     r.is_active === true,
    qty_sold:      parseFloat(r.total_qty) || 0,
    total_qty:     parseFloat(r.total_qty) || 0,
    total_revenue: parseFloat(r.total_revenue) || 0,
    revenue:       parseFloat(r.total_revenue) || 0,
    avg_price:     parseFloat(parseFloat(r.avg_price || 0).toFixed(2)),
    total_orders:  r.total_orders,
    share_pct:     totalRevenue > 0
      ? parseFloat(((parseFloat(r.total_revenue) / totalRevenue) * 100).toFixed(1))
      : 0,
  }));

  // Classifica TODOS antes de filtrar/paginar (senão a curva fica errada).
  const ranked = classifyABC(allProducts, totalRevenue);

  // class_breakdown pra header da UI (cards de resumo "X produtos em A repre-
  // sentando Y% do faturamento").
  const breakdownForGrade = (g) => {
    const items = ranked.filter(p => p.abc === g);
    const rev = items.reduce((s, p) => s + p.total_revenue, 0);
    const qty = items.reduce((s, p) => s + p.qty_sold, 0);
    return {
      grade: g,
      count: items.length,
      total_revenue: parseFloat(rev.toFixed(2)),
      total_qty: qty,
      revenue_pct: totalRevenue > 0 ? parseFloat(((rev / totalRevenue) * 100).toFixed(1)) : 0,
      qty_pct:     totalSold    > 0 ? parseFloat(((qty / totalSold)    * 100).toFixed(1)) : 0,
    };
  };
  const class_breakdown = VALID_ABC.map(breakdownForGrade);

  // Aplica filtros e paginação no resultado já classificado.
  const filtered = abcFilter ? ranked.filter(p => p.abc === abcFilter) : ranked;
  const paged    = filtered.slice(offset, offset + limit);

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
    class_breakdown,
    pagination: {
      limit,
      offset,
      total_items:    ranked.length,
      filtered_items: filtered.length,
      returned:       paged.length,
      abc_filter:     abcFilter,
    },
    products: paged,
  };
}

async function getCategories(companyId, options = {}) {
  const { period = 'month', start_date, end_date } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);
  const SP = `AT TIME ZONE 'America/Sao_Paulo'`;

  // Mesmos filtros e LEFT JOIN aplicados aqui pra consistencia.
  const { rows } = await db.query(`
    SELECT
      COALESCE(p.category, 'Sem categoria')  AS category,
      COUNT(DISTINCT p.id)::int              AS total_products,
      COALESCE(SUM(si.total_price), 0)       AS total_revenue,
      COALESCE(SUM(si.quantity), 0)::float   AS total_qty
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
      AND s.company_id = $1
      AND COALESCE(s.status, 'completed') != 'cancelled'
      AND COALESCE(s.type,   'sale')      = 'sale'
      AND (s.created_at ${SP}) >= $2::timestamp
      AND (s.created_at ${SP}) <  $3::timestamp
    LEFT JOIN products p ON p.id = si.product_id
      AND ${groupVisibilityClause('$1')}
    WHERE si.product_id IS NOT NULL
    GROUP BY p.category
    ORDER BY total_revenue DESC
  `, [companyId, startDate, endDate]);

  const totalRevenue = rows.reduce((sum, r) => sum + parseFloat(r.total_revenue || 0), 0);

  return rows.map(r => ({
    category:       r.category,
    total_products: r.total_products,
    total_revenue:  parseFloat(r.total_revenue) || 0,
    total_qty:      parseFloat(r.total_qty) || 0,
    share_pct:      totalRevenue > 0
      ? parseFloat(((parseFloat(r.total_revenue) / totalRevenue) * 100).toFixed(1))
      : 0,
  }));
}

module.exports = { getProductsRanking, getCategories, classifyABC, DEFAULT_LIMIT, MAX_LIMIT };
