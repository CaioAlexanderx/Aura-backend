// ============================================================
// AURA. — Serviço de CRM Expandido (BE-05)
//
// MULTICNPJ Sessao 2 Onda 2.6 (03/05/2026): owner-scoped.
// Ranking de clientes, aniversariantes e perfil completo agora
// agregam dados de TODAS as empresas do mesmo dono. Consistente
// com a Onda 2.3 (clientes sao do owner) e Onda 2.6 retention.
// ============================================================

const db = require('../config/database');
const { resolvePeriod } = require('./salesAnalytics');
const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');

/**
 * Ranking de clientes por LTV e frequência (owner-scoped).
 */
async function getCustomersRanking(companyId, options = {}) {
  const { period = 'month', start_date, end_date, limit = 50 } = options;
  const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

  const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
  if (ownerCompanyIds.length === 0) return [];

  const { rows } = await db.query(`
    SELECT
      c.id,
      c.name,
      c.phone,
      c.email,
      c.birth_date,
      c.instagram_handle,
      c.follows_instagram,
      c.total_purchases,
      c.total_spent,
      c.last_purchase_at,
      c.first_purchase_at,
      -- Vendas no período selecionado (de qualquer empresa do owner)
      COUNT(s.id)::int                      AS period_purchases,
      COALESCE(SUM(s.total_amount), 0)      AS period_spent
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id
      AND s.company_id = ANY($1)
      AND s.created_at >= $2
      AND s.created_at < $3
    WHERE c.company_id = ANY($1)
      AND c.is_active = true
    GROUP BY c.id
    ORDER BY c.total_spent DESC
    LIMIT $4
  `, [ownerCompanyIds, startDate, endDate, limit]);

  return rows.map((r, index) => ({
    position:          index + 1,
    id:                r.id,
    name:              r.name,
    phone:             r.phone,
    email:             r.email,
    birth_date:        r.birth_date,
    instagram_handle:  r.instagram_handle,
    follows_instagram: r.follows_instagram,
    total_purchases:   r.total_purchases,
    total_spent:       parseFloat(r.total_spent),
    avg_ticket:        r.total_purchases > 0
      ? parseFloat((r.total_spent / r.total_purchases).toFixed(2))
      : 0,
    last_purchase_at:  r.last_purchase_at,
    first_purchase_at: r.first_purchase_at,
    period_purchases:  r.period_purchases,
    period_spent:      parseFloat(r.period_spent),
  }));
}

/**
 * Clientes com aniversário nos próximos N dias (owner-scoped).
 */
async function getUpcomingBirthdays(companyId, days = 7) {
  const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
  if (ownerCompanyIds.length === 0) return [];

  const { rows } = await db.query(`
    SELECT
      id, name, phone, email, birth_date,
      instagram_handle, follows_instagram,
      total_purchases, total_spent,
      CASE
        WHEN TO_DATE(
          EXTRACT(YEAR FROM NOW())::text || '-' ||
          LPAD(EXTRACT(MONTH FROM birth_date)::text, 2, '0') || '-' ||
          LPAD(EXTRACT(DAY FROM birth_date)::text, 2, '0'),
          'YYYY-MM-DD'
        ) >= CURRENT_DATE
        THEN TO_DATE(
          EXTRACT(YEAR FROM NOW())::text || '-' ||
          LPAD(EXTRACT(MONTH FROM birth_date)::text, 2, '0') || '-' ||
          LPAD(EXTRACT(DAY FROM birth_date)::text, 2, '0'),
          'YYYY-MM-DD'
        ) - CURRENT_DATE
        ELSE TO_DATE(
          (EXTRACT(YEAR FROM NOW()) + 1)::text || '-' ||
          LPAD(EXTRACT(MONTH FROM birth_date)::text, 2, '0') || '-' ||
          LPAD(EXTRACT(DAY FROM birth_date)::text, 2, '0'),
          'YYYY-MM-DD'
        ) - CURRENT_DATE
      END AS days_until
    FROM customers
    WHERE company_id = ANY($1)
      AND birth_date IS NOT NULL
      AND is_active = true
      AND (
        TO_DATE(
          EXTRACT(YEAR FROM NOW())::text || '-' ||
          LPAD(EXTRACT(MONTH FROM birth_date)::text, 2, '0') || '-' ||
          LPAD(EXTRACT(DAY FROM birth_date)::text, 2, '0'),
          'YYYY-MM-DD'
        ) BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2::int)
        OR
        TO_DATE(
          (EXTRACT(YEAR FROM NOW()) + 1)::text || '-' ||
          LPAD(EXTRACT(MONTH FROM birth_date)::text, 2, '0') || '-' ||
          LPAD(EXTRACT(DAY FROM birth_date)::text, 2, '0'),
          'YYYY-MM-DD'
        ) BETWEEN CURRENT_DATE AND CURRENT_DATE + ($2::int)
      )
    ORDER BY days_until ASC
  `, [ownerCompanyIds, days]);

  return rows.map(r => ({
    id:                r.id,
    name:              r.name,
    phone:             r.phone,
    email:             r.email,
    birth_date:        r.birth_date,
    instagram_handle:  r.instagram_handle,
    follows_instagram: r.follows_instagram,
    total_purchases:   r.total_purchases,
    total_spent:       parseFloat(r.total_spent),
    days_until:        parseInt(r.days_until),
    is_today:          parseInt(r.days_until) === 0,
  }));
}

/**
 * Ficha completa do cliente com histórico de compras (owner-scoped).
 * Aceita customer de qualquer empresa do mesmo dono — perfil reflete
 * historico completo do cliente (todas as lojas do owner onde comprou).
 */
async function getCustomerProfile(companyId, customerId) {
  const ownerCompanyIds = await getOwnerScopedCompanyIds(companyId);
  if (ownerCompanyIds.length === 0) return null;

  const { rows: customerRows } = await db.query(`
    SELECT * FROM customers
    WHERE id = $1 AND company_id = ANY($2) AND is_active = true
  `, [customerId, ownerCompanyIds]);

  if (!customerRows.length) return null;
  const customer = customerRows[0];

  // Ultimas 10 compras (de qualquer empresa do owner)
  const { rows: salesRows } = await db.query(`
    SELECT
      s.id, s.total_amount, s.payment_method,
      s.created_at, s.discount_amount,
      s.company_id,
      comp.trade_name AS company_trade,
      comp.legal_name AS company_legal,
      COUNT(si.id)::int AS items_count
    FROM sales s
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN companies comp ON comp.id = s.company_id
    WHERE s.customer_id = $1 AND s.company_id = ANY($2)
    GROUP BY s.id, comp.trade_name, comp.legal_name
    ORDER BY s.created_at DESC
    LIMIT 10
  `, [customerId, ownerCompanyIds]);

  return {
    ...customer,
    total_spent:  parseFloat(customer.total_spent),
    avg_ticket:   customer.total_purchases > 0
      ? parseFloat((customer.total_spent / customer.total_purchases).toFixed(2))
      : 0,
    recent_sales: salesRows.map(s => ({
      id:             s.id,
      total_amount:   parseFloat(s.total_amount),
      payment_method: s.payment_method,
      items_count:    s.items_count,
      discount:       parseFloat(s.discount_amount),
      created_at:     s.created_at,
      // Multi-CNPJ: mostra em qual loja foi a compra
      company_id:     s.company_id,
      company_name:   s.company_trade || s.company_legal || 'Empresa',
    })),
  };
}

module.exports = { getCustomersRanking, getUpcomingBirthdays, getCustomerProfile };
