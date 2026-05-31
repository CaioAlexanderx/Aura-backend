// ============================================================
// AURA. -- Financial Receivables (F2-2D)
// GET /financial/receivables
// Agrega 'Crediario - A Receber' pendentes com aging por cliente.
// Gating: Negocio+ (definido em private.js).
//
// Montado em private.js:
//   router.use('/financial', requirePlan('negocio','expansao'), require('./financialReceivables'));
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

const SP_DATE = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

// GET /companies/:id/financial/receivables
router.get('/receivables', async (req, res) => {
  const companyId = req.params.id;
  try {
    const [receivablesRes, receivedRes] = await Promise.all([
      // A Receber pendentes, agrupados por cliente com aging
      db.query(
        `SELECT
           c.id AS customer_id,
           COALESCE(c.name, c.phone) AS customer_name,
           c.phone,
           COUNT(*) AS pending_count,
           COALESCE(SUM(t.amount), 0) AS total_open,
           MIN(t.due_date) AS oldest_due_date,
           COUNT(*) FILTER (WHERE t.due_date < ${SP_DATE}) AS overdue_count,
           COALESCE(SUM(t.amount) FILTER (WHERE t.due_date < ${SP_DATE}), 0) AS overdue_amount,
           MAX(t.created_at) AS last_sale_at
         FROM transactions t
         LEFT JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
         LEFT JOIN customers c ON c.id = s.customer_id
         WHERE t.company_id = $1
           AND t.category ILIKE 'Crediario%A Receber%'
           AND t.status = 'pending'
         GROUP BY c.id, c.name, c.phone
         ORDER BY total_open DESC
         LIMIT 200`,
        [companyId]
      ),
      // Recebido no mes corrente
      db.query(
        `SELECT COALESCE(SUM(t.amount), 0) AS received_this_month
         FROM transactions t
         WHERE t.company_id = $1
           AND t.category ILIKE 'Crediario%Recebido%'
           AND t.status = 'confirmed'
           AND DATE_TRUNC('month', t.paid_at AT TIME ZONE 'America/Sao_Paulo')
             = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Sao_Paulo')`,
        [companyId]
      ),
    ]);

    const receivables = receivablesRes.rows;
    const totalOpen    = receivables.reduce((s, r) => s + parseFloat(r.total_open), 0);
    const totalOverdue = receivables.reduce((s, r) => s + parseFloat(r.overdue_amount), 0);

    res.json({
      receivables: receivables.map(r => ({
        customer_id:     r.customer_id,
        customer_name:   r.customer_name,
        phone:           r.phone,
        pending_count:   parseInt(r.pending_count),
        total_open:      parseFloat(r.total_open),
        oldest_due_date: r.oldest_due_date,
        overdue_count:   parseInt(r.overdue_count),
        overdue_amount:  parseFloat(r.overdue_amount),
        last_sale_at:    r.last_sale_at,
      })),
      kpis: {
        total_open:     parseFloat(totalOpen.toFixed(2)),
        total_overdue:  parseFloat(totalOverdue.toFixed(2)),
        customers_open: receivables.length,
        received_month: parseFloat(
          parseFloat(receivedRes.rows[0]?.received_this_month || 0).toFixed(2)
        ),
      },
    });
  } catch (err) {
    console.error('[financialReceivables] error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar recebiveis crediario.' });
  }
});

module.exports = router;
