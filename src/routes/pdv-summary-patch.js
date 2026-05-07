// ============================================================
// PDV — Patch routes: GET /sales e GET /summary
// Montado ANTES do pdv.js em private.js para sobrescrever apenas
// as duas rotas corrigidas (07/05/2026).
//
// FIX GET /summary: exclui type='troca' do gross_revenue.
//   total_amount da troca = newValue (novos itens), não o netAmount.
//   O efeito financeiro real já vai para transactions (netAmount).
//   Incluir total_amount inflacionava o caixa do dia — ex.: troca de
//   R$100 por R$150 aparecia como R$150 de venda em vez de R$50.
//   Fix é retroativo: trocas já registradas passam a ser excluídas
//   do resumo sem necessidade de cancelar/refazer.
//   Retorna trocas_count + trocas_net_received separados para o frontend.
//
// FIX GET /sales: expõe s.type + s.exchange_of_sale_id para o frontend
//   distinguir trocas de vendas regulares na listagem (badge, ícone etc).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

const SP_DATE_COL = (col) => `(${col} AT TIME ZONE 'America/Sao_Paulo')::date`;

// GET /companies/:id/pdv/sales
// FIX: expõe s.type e s.exchange_of_sale_id — ausentes no pdv.js original.
router.get('/sales', async (req, res) => {
  const { date, limit = 50, offset = 0, include_cancelled } = req.query;
  const cond = ['s.company_id=$1'];
  const vals = [req.params.id];
  let i = 2;
  if (date) { cond.push(`${SP_DATE_COL('s.created_at')}=$${i++}`); vals.push(date); }
  if (!include_cancelled) { cond.push("s.status != 'cancelled'"); }
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.coupon_code, s.status,
              s.type, s.exchange_of_sale_id, s.seller_name, s.created_at,
              u.full_name AS user_seller_name, c.name AS customer_name, e.name AS employee_name,
              COUNT(si.id) AS item_count
       FROM sales s
       LEFT JOIN users u ON u.id=s.seller_id
       LEFT JOIN customers c ON c.id=s.customer_id
       LEFT JOIN employees e ON e.id=s.employee_id
       LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE ${cond.join(' AND ')}
       GROUP BY s.id, s.type, s.exchange_of_sale_id, u.full_name, c.name, e.name
       ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('[PDV patch] Erro ao listar vendas:', e.message);
    res.status(500).json({ error: 'Erro ao listar vendas' });
  }
});

// GET /companies/:id/pdv/summary
// FIX: exclui type='troca' do gross_revenue; retorna trocas separadas.
router.get('/summary', async (req, res) => {
  const date = req.query.date
    || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  try {
    const [{ rows }, { rows: trocaRows }] = await Promise.all([
      // Vendas regulares (type IS NULL ou 'sale') — exclui trocas
      db.query(
        `SELECT COUNT(*) AS total_sales, COALESCE(SUM(total_amount),0) AS gross_revenue,
                COALESCE(SUM(discount_amount),0) AS total_discounts,
                ROUND(AVG(total_amount)::NUMERIC,2) AS avg_ticket,
                json_object_agg(payment_method, cnt) AS by_payment_method
         FROM (SELECT s.total_amount, s.discount_amount, s.payment_method,
                      COUNT(*) OVER (PARTITION BY s.payment_method) AS cnt
               FROM sales s
               WHERE s.company_id=$1 AND ${SP_DATE_COL('s.created_at')}=$2
                 AND s.status != 'cancelled'
                 AND (s.type IS NULL OR s.type = 'sale')) sub`,
        [req.params.id, date]
      ),
      // Trocas do dia: contagem + netAmount recebido (via transactions)
      db.query(
        `SELECT
           COUNT(s.id)::int AS trocas_count,
           COALESCE(SUM(t.amount), 0) AS trocas_net_received
         FROM sales s
         LEFT JOIN transactions t
           ON t.idempotency_key = 'pdv-troca-' || s.id
          AND t.company_id = s.company_id
         WHERE s.company_id=$1
           AND ${SP_DATE_COL('s.created_at')}=$2
           AND s.status != 'cancelled'
           AND s.type = 'troca'`,
        [req.params.id, date]
      ),
    ]);
    res.json({
      date, ...rows[0],
      trocas_count:        parseInt(trocaRows[0]?.trocas_count)        || 0,
      trocas_net_received: parseFloat(trocaRows[0]?.trocas_net_received) || 0,
    });
  } catch (e) {
    console.error('[PDV patch] Erro ao buscar resumo:', e.message);
    res.status(500).json({ error: 'Erro ao buscar resumo do caixa' });
  }
});

module.exports = router;
