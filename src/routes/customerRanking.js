// ============================================================
// AURA. — BE-REV-03: Customer Ranking by LTV or Visits
// GET /companies/:id/customers/ranking-ltv?by=ltv|visits&limit=20
//
// MULTICNPJ Sessao 2 Onda 2.6 (03/05/2026): owner-scoped.
// Vendedora ou owner ve o ranking unificado de TODAS as empresas
// do mesmo dono. Consistente com a decisao de lista unica de
// clientes (Onda 2.3). Aggregam-se vendas de todas as empresas
// do owner pra calcular total_spent/visit_count por cliente.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');

router.get('/', async (req, res) => {
  const cid = req.params.id;
  const by = req.query.by === 'visits' ? 'visits' : 'ltv';
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  try {
    const orderCol = by === 'visits' ? 'visit_count' : 'total_spent';

    // MULTICNPJ Onda 2.6: expande pra todas as empresas do owner
    const ownerCompanyIds = await getOwnerScopedCompanyIds(cid);
    if (ownerCompanyIds.length === 0) {
      return res.json({ by, limit, total: 0, ranking: [] });
    }

    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.email, c.phone, c.instagram_handle,
        c.birth_date,
        COALESCE(stats.total_spent, 0) AS total_spent,
        COALESCE(stats.visit_count, 0) AS visit_count,
        COALESCE(stats.avg_ticket, 0) AS avg_ticket,
        stats.last_purchase,
        c.created_at AS first_visit
      FROM customers c
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(s.total_amount), 0) AS total_spent,
          COUNT(s.id) AS visit_count,
          CASE WHEN COUNT(s.id) > 0
            THEN ROUND(SUM(s.total_amount) / COUNT(s.id), 2)
            ELSE 0
          END AS avg_ticket,
          MAX(s.created_at) AS last_purchase
        FROM sales s
        WHERE s.company_id = ANY($1) AND s.customer_id = c.id
      ) stats ON true
      WHERE c.company_id = ANY($1)
      ORDER BY ${orderCol} DESC NULLS LAST
      LIMIT $2
    `, [ownerCompanyIds, limit]);

    const ranking = rows.map((r, i) => ({
      position: i + 1,
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      instagram: r.instagram_handle,
      birthday: r.birth_date,
      total_spent: parseFloat(r.total_spent) || 0,
      visit_count: parseInt(r.visit_count) || 0,
      avg_ticket: parseFloat(r.avg_ticket) || 0,
      last_purchase: r.last_purchase,
      first_visit: r.first_visit,
      status: getCustomerStatus(r),
    }));

    res.json({
      by,
      limit,
      total: ranking.length,
      ranking,
    });
  } catch (err) {
    console.error('customer ranking error:', err);
    res.status(500).json({ error: 'Erro ao gerar ranking de clientes' });
  }
});

function getCustomerStatus(c) {
  const tags = [];
  if (parseFloat(c.total_spent) >= 2000) tags.push('VIP');
  if (parseInt(c.visit_count) >= 10) tags.push('Frequente');
  if (parseInt(c.visit_count) <= 3) tags.push('Novo');
  if (c.last_purchase) {
    const daysSince = (Date.now() - new Date(c.last_purchase).getTime()) / 86400000;
    if (daysSince > 30) tags.push('Inativo');
  }
  return tags;
}

module.exports = router;
