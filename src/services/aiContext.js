// ============================================================
// AURA. — AI Context: real business data per agent context
// Used by aiChat.js to enrich Claude's system prompt
// ============================================================
const db = require('../config/database');

async function getContextData(companyId, context) {
  const data = {};
  try {
    switch (context) {
      case 'financeiro': {
        const { rows: [bal] } = await db.query(
          `SELECT
             COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
             COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expenses
           FROM transactions
           WHERE company_id=$1 AND due_date >= date_trunc('month', CURRENT_DATE)`, [companyId]);
        data.receita_mes = parseFloat(bal?.income || 0);
        data.despesa_mes = parseFloat(bal?.expenses || 0);
        data.saldo = data.receita_mes - data.despesa_mes;

        const { rows: vendas } = await db.query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(total_amount),0) AS valor
           FROM sales WHERE company_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)`, [companyId]);
        data.vendas_mes = parseInt(vendas[0]?.total || 0);
        data.faturamento_vendas = parseFloat(vendas[0]?.valor || 0);

        const { rows: overdue } = await db.query(
          `SELECT description, amount, due_date FROM transactions
           WHERE company_id=$1 AND type='income' AND status='pending' AND due_date < CURRENT_DATE
           ORDER BY amount DESC LIMIT 5`, [companyId]);
        data.cobrancas_atrasadas = overdue.map(r => ({ desc: r.description, valor: parseFloat(r.amount), venc: r.due_date }));
        break;
      }
      case 'estoque': {
        const { rows: low } = await db.query(
          `SELECT name, stock_qty, min_stock_qty, sell_price FROM products
           WHERE company_id=$1 AND stock_qty <= min_stock_qty AND min_stock_qty > 0
           ORDER BY stock_qty ASC LIMIT 10`, [companyId]);
        data.estoque_baixo = low.map(r => ({ nome: r.name, atual: parseInt(r.stock_qty), min: parseInt(r.min_stock_qty), preco: parseFloat(r.sell_price) }));

        const { rows: [stats] } = await db.query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(stock_qty * cost_price),0) AS valor_total
           FROM products WHERE company_id=$1`, [companyId]);
        data.total_produtos = parseInt(stats?.total || 0);
        data.valor_estoque = parseFloat(stats?.valor_total || 0);

        const { rows: top } = await db.query(
          `SELECT p.name, COALESCE(SUM(si.quantity),0) AS vendidos
           FROM sale_items si JOIN products p ON p.id=si.product_id
           JOIN sales s ON s.id=si.sale_id
           WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days'
           GROUP BY p.name ORDER BY vendidos DESC LIMIT 5`, [companyId]);
        data.top_vendidos_30d = top.map(r => ({ nome: r.name, vendidos: parseInt(r.vendidos) }));
        break;
      }
      case 'crm': {
        const { rows: inactive } = await db.query(
          `SELECT name, phone, last_purchase_at, total_spent FROM customers
           WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL
           ORDER BY total_spent DESC LIMIT 10`, [companyId]);
        data.clientes_inativos_30d = inactive.map(r => ({
          nome: r.name, telefone: r.phone, ultima_compra: r.last_purchase_at,
          total_gasto: parseFloat(r.total_spent),
        }));

        const { rows: [cstats] } = await db.query(
          `SELECT COUNT(*) AS total,
                  COUNT(CASE WHEN last_purchase_at >= NOW()-INTERVAL '30 days' THEN 1 END) AS ativos_30d
           FROM customers WHERE company_id=$1`, [companyId]);
        data.total_clientes = parseInt(cstats?.total || 0);
        data.clientes_ativos_30d = parseInt(cstats?.ativos_30d || 0);

        const { rows: bday } = await db.query(
          `SELECT name, phone FROM customers
           WHERE company_id=$1 AND birth_date IS NOT NULL
             AND EXTRACT(MONTH FROM birth_date)=EXTRACT(MONTH FROM CURRENT_DATE)
             AND EXTRACT(DAY FROM birth_date) BETWEEN EXTRACT(DAY FROM CURRENT_DATE) AND EXTRACT(DAY FROM CURRENT_DATE)+7
           LIMIT 5`, [companyId]);
        data.aniversarios_proximos = bday.map(r => ({ nome: r.name, telefone: r.phone }));

        const { rows: [rev] } = await db.query(
          `SELECT COUNT(*) AS total, ROUND(AVG(rating)::NUMERIC,1) AS media
           FROM purchase_reviews WHERE company_id=$1`, [companyId]);
        data.reviews = { total: parseInt(rev?.total || 0), media: parseFloat(rev?.media || 0) };
        break;
      }
      case 'contabil': {
        const { rows: obls } = await db.query(
          `SELECT code, name, due_day, status, category FROM fiscal_obligations
           WHERE company_id=$1 AND status != 'done'
           ORDER BY due_day ASC LIMIT 10`, [companyId]);
        data.obrigacoes_pendentes = obls.map(r => ({
          codigo: r.code, nome: r.name, dia_venc: r.due_day, status: r.status, categoria: r.category,
        }));

        const { rows: [check] } = await db.query(
          `SELECT COUNT(*) AS total,
                  COUNT(CASE WHEN completed THEN 1 END) AS concluidos
           FROM monthly_checklist WHERE company_id=$1
             AND period=to_char(CURRENT_DATE,'YYYY-MM')`, [companyId]);
        data.checklist = { total: parseInt(check?.total || 0), concluidos: parseInt(check?.concluidos || 0) };
        break;
      }
      case 'marketing': {
        const { rows: trend } = await db.query(
          `SELECT DATE(created_at) AS dia, COUNT(*) AS vendas, SUM(total_amount) AS valor
           FROM sales WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '14 days'
           GROUP BY DATE(created_at) ORDER BY dia`, [companyId]);
        data.tendencia_vendas_14d = trend.map(r => ({ dia: r.dia, vendas: parseInt(r.vendas), valor: parseFloat(r.valor) }));

        const { rows: pop } = await db.query(
          `SELECT p.name, COUNT(si.id) AS vendidos FROM sale_items si
           JOIN products p ON p.id=si.product_id JOIN sales s ON s.id=si.sale_id
           WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days'
           GROUP BY p.name ORDER BY vendidos DESC LIMIT 5`, [companyId]);
        data.produtos_populares = pop.map(r => ({ nome: r.name, vendidos: parseInt(r.vendidos) }));

        const { rows: [cs] } = await db.query(
          `SELECT COUNT(*) AS total FROM customers WHERE company_id=$1`, [companyId]);
        data.total_clientes = parseInt(cs?.total || 0);
        break;
      }
    }
  } catch (err) {
    console.error(`[aiContext] Error fetching ${context} data:`, err.message);
  }
  return data;
}

module.exports = { getContextData };
