// ============================================================
// AURA. — Product Margin Analysis
// Ranking de rentabilidade por produto + margem geral
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// GET /margin — ranking de produtos por margem
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { months = 6, limit = 50 } = req.query;
  const numMonths = Math.min(Math.max(parseInt(months) || 6, 1), 24);
  try {
    // 1. Product margin from sale_items (real sales data)
    const { rows: fromSales } = await db.query(
      `SELECT p.id, p.name, p.price, p.cost_price, p.category, p.stock_qty,
         COUNT(si.id)::int AS vendas,
         SUM(si.quantity)::int AS unidades,
         SUM(si.total_price) AS faturamento,
         SUM(si.unit_cost * si.quantity) AS custo_total,
         SUM(si.total_price) - SUM(si.unit_cost * si.quantity) AS lucro,
         CASE WHEN SUM(si.total_price) > 0
           THEN ROUND(((SUM(si.total_price) - SUM(si.unit_cost * si.quantity)) / SUM(si.total_price) * 100)::numeric, 1)
           ELSE 0 END AS margem_pct,
         ROUND(AVG(si.unit_price)::numeric, 2) AS preco_medio,
         ROUND(AVG(si.unit_cost)::numeric, 2) AS custo_medio
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       WHERE s.company_id = $1
         AND s.created_at >= date_trunc('month', NOW()) - (($2::int || ' months')::interval)
       GROUP BY p.id, p.name, p.price, p.cost_price, p.category, p.stock_qty
       ORDER BY lucro DESC
       LIMIT $3`, [cid, numMonths, parseInt(limit) || 50]);

    // 2. Products without sales but with cost_price (catalog margin)
    const { rows: catalogOnly } = await db.query(
      `SELECT id, name, price, cost_price, category, stock_qty,
         CASE WHEN price > 0 AND cost_price > 0
           THEN ROUND(((price - cost_price) / price * 100)::numeric, 1)
           ELSE NULL END AS margem_catalogo
       FROM products
       WHERE company_id = $1 AND cost_price IS NOT NULL AND cost_price > 0
         AND id NOT IN (SELECT DISTINCT si.product_id FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.company_id = $1 AND s.created_at >= date_trunc('month', NOW()) - (($2::int || ' months')::interval))
       ORDER BY margem_catalogo ASC NULLS LAST
       LIMIT 20`, [cid, numMonths]);

    // 3. Overall margin stats
    const totalFat = fromSales.reduce((s, p) => s + parseFloat(p.faturamento || 0), 0);
    const totalCusto = fromSales.reduce((s, p) => s + parseFloat(p.custo_total || 0), 0);
    const totalLucro = totalFat - totalCusto;
    const margemGeral = totalFat > 0 ? Math.round((totalLucro / totalFat) * 100 * 10) / 10 : 0;

    // 4. Margin distribution (how many products in each bracket)
    const brackets = [
      { label: 'Negativa (<0%)', min: -999, max: 0, count: 0, revenue: 0 },
      { label: 'Baixa (0-20%)', min: 0, max: 20, count: 0, revenue: 0 },
      { label: 'Saudavel (20-40%)', min: 20, max: 40, count: 0, revenue: 0 },
      { label: 'Boa (40-60%)', min: 40, max: 60, count: 0, revenue: 0 },
      { label: 'Excelente (60%+)', min: 60, max: 999, count: 0, revenue: 0 },
    ];
    fromSales.forEach(p => {
      const m = parseFloat(p.margem_pct) || 0;
      const b = brackets.find(br => m >= br.min && m < br.max);
      if (b) { b.count++; b.revenue += parseFloat(p.faturamento || 0); }
    });

    // 5. Alerts: products with margin < 10% but selling a lot
    const alerts = fromSales
      .filter(p => parseFloat(p.margem_pct) < 10 && parseInt(p.vendas) >= 5)
      .map(p => ({
        id: p.id, name: p.name,
        margem_pct: parseFloat(p.margem_pct),
        vendas: parseInt(p.vendas),
        message: `${p.name} tem margem de ${p.margem_pct}% com ${p.vendas} vendas. Revisar precificacao.`
      }));

    // 6. Top 5 most profitable + bottom 5
    const top5 = fromSales.slice(0, 5).map(p => ({
      name: p.name, lucro: parseFloat(p.lucro), margem_pct: parseFloat(p.margem_pct), vendas: parseInt(p.vendas)
    }));
    const bottom5 = [...fromSales].sort((a, b) => parseFloat(a.margem_pct) - parseFloat(b.margem_pct)).slice(0, 5).map(p => ({
      name: p.name, lucro: parseFloat(p.lucro), margem_pct: parseFloat(p.margem_pct), vendas: parseInt(p.vendas)
    }));

    res.json({
      summary: {
        total_faturamento: totalFat,
        total_custo: totalCusto,
        total_lucro: totalLucro,
        margem_geral_pct: margemGeral,
        produtos_analisados: fromSales.length,
        periodo_meses: numMonths,
      },
      products: fromSales.map(p => ({
        id: p.id, name: p.name, price: parseFloat(p.price), cost_price: parseFloat(p.cost_price || 0),
        category: p.category, stock_qty: parseInt(p.stock_qty || 0),
        vendas: parseInt(p.vendas), unidades: parseInt(p.unidades),
        faturamento: parseFloat(p.faturamento), custo_total: parseFloat(p.custo_total),
        lucro: parseFloat(p.lucro), margem_pct: parseFloat(p.margem_pct),
        preco_medio: parseFloat(p.preco_medio), custo_medio: parseFloat(p.custo_medio),
      })),
      catalog_without_sales: catalogOnly.map(p => ({
        id: p.id, name: p.name, price: parseFloat(p.price), cost_price: parseFloat(p.cost_price),
        margem_catalogo: p.margem_catalogo ? parseFloat(p.margem_catalogo) : null,
      })),
      distribution: brackets.map(b => ({ label: b.label, count: b.count, revenue: Math.round(b.revenue) })),
      top5_lucro: top5,
      bottom5_margem: bottom5,
      alerts,
    });
  } catch (err) { console.error('product margin error:', err); res.status(500).json({ error: 'Erro ao calcular margem' }); }
});

module.exports = router;
