// ============================================================
// AURA. — AI Insights: proactive agent banners
// GET /companies/:id/ai/insights/:context
// Only flags items explicitly marked as 'pending' (contas a receber)
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

router.get('/:context', async (req, res) => {
  const cid = req.params.id;
  const ctx = req.params.context || 'geral';
  const insights = [];

  try {
    switch (ctx) {
      case 'financeiro': {
        // Contas a receber vencidas (so items EXPLICITAMENTE pending, nao confirmados)
        const { rows: overdue } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
           FROM transactions WHERE company_id=$1 AND type='income' AND status='pending' AND due_date < CURRENT_DATE`, [cid]);
        if (parseInt(overdue[0]?.cnt) > 0) {
          insights.push({
            id: 'overdue', severity: 'warning', agent: 'Financeiro',
            title: `${overdue[0].cnt} conta${parseInt(overdue[0].cnt)>1?'s':''} a receber vencida${parseInt(overdue[0].cnt)>1?'s':''}`,
            description: `R$ ${parseFloat(overdue[0].total).toFixed(2).replace('.',',')} em receitas pendentes com vencimento passado.`,
            action: { type: 'navigate', target: '/financeiro', label: 'Ver lancamentos' },
          });
        }
        // Saldo do mes
        const { rows: [bal] } = await db.query(
          `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS saldo
           FROM transactions WHERE company_id=$1 AND status='confirmed' AND due_date >= date_trunc('month', CURRENT_DATE)`, [cid]);
        if (parseFloat(bal?.saldo) < 0) {
          insights.push({
            id: 'negative-balance', severity: 'critical', agent: 'Financeiro',
            title: 'Despesas maiores que receitas no mes',
            description: `Diferenca de R$ ${Math.abs(parseFloat(bal.saldo)).toFixed(2).replace('.',',')} entre despesas e receitas confirmadas.`,
            action: { type: 'navigate', target: '/financeiro', label: 'Analisar' },
          });
        }
        // Vendas recentes
        const { rows: [sales] } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total
           FROM sales WHERE company_id=$1 AND created_at >= CURRENT_DATE`, [cid]);
        if (parseInt(sales?.cnt) > 0) {
          insights.push({
            id: 'today-sales', severity: 'info', agent: 'Financeiro',
            title: `${sales.cnt} venda${parseInt(sales.cnt)>1?'s':''} hoje`,
            description: `Faturamento do dia: R$ ${parseFloat(sales.total).toFixed(2).replace('.',',')}`,
            action: { type: 'navigate', target: '/pdv', label: 'Ver caixa' },
          });
        }
        break;
      }
      case 'estoque': {
        const { rows: low } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products
           WHERE company_id=$1 AND stock_qty <= min_stock_qty AND min_stock_qty > 0`, [cid]);
        if (parseInt(low[0]?.cnt) > 0) {
          insights.push({
            id: 'low-stock', severity: 'warning', agent: 'Estoque',
            title: `${low[0].cnt} produto${parseInt(low[0].cnt)>1?'s':''} com estoque baixo`,
            description: 'Itens abaixo do estoque minimo precisam de reposicao.',
            action: { type: 'navigate', target: '/estoque', label: 'Ver alertas' },
          });
        }
        const { rows: [dead] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products p
           WHERE p.company_id=$1 AND p.stock_qty > 0
             AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id
                             WHERE si.product_id=p.id AND s.created_at >= NOW()-INTERVAL '30 days')`, [cid]);
        if (parseInt(dead?.cnt) > 5) {
          insights.push({
            id: 'dead-stock', severity: 'info', agent: 'Estoque',
            title: `${dead.cnt} produtos sem venda em 30 dias`,
            description: 'Considere criar promocoes para girar o estoque parado.',
            action: { type: 'navigate', target: '/estoque', label: 'Ver produtos' },
          });
        }
        break;
      }
      case 'crm': case 'clientes': {
        const { rows: [inact] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers
           WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL`, [cid]);
        if (parseInt(inact?.cnt) > 0) {
          insights.push({
            id: 'inactive-customers', severity: 'warning', agent: 'CRM',
            title: `${inact.cnt} cliente${parseInt(inact.cnt)>1?'s':''} inativo${parseInt(inact.cnt)>1?'s':''}`,
            description: 'Sem compra ha mais de 30 dias. Envie uma oferta para reativa-los.',
            action: { type: 'navigate', target: '/clientes', label: 'Ver clientes' },
          });
        }
        const { rows: bday } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers
           WHERE company_id=$1 AND birth_date IS NOT NULL
             AND EXTRACT(MONTH FROM birth_date)=EXTRACT(MONTH FROM CURRENT_DATE)
             AND EXTRACT(DAY FROM birth_date) BETWEEN EXTRACT(DAY FROM CURRENT_DATE) AND EXTRACT(DAY FROM CURRENT_DATE)+7`, [cid]);
        if (parseInt(bday[0]?.cnt) > 0) {
          insights.push({
            id: 'birthdays', severity: 'info', agent: 'CRM',
            title: `${bday[0].cnt} aniversario${parseInt(bday[0].cnt)>1?'s':''} esta semana`,
            description: 'Envie parabens e uma oferta especial.',
            action: { type: 'navigate', target: '/clientes', label: 'Ver clientes' },
          });
        }
        break;
      }
      case 'contabil': case 'contabilidade': {
        const { rows: urgent } = await db.query(
          `SELECT code, name, due_day FROM fiscal_obligations
           WHERE company_id=$1 AND status IN ('pending','overdue')
             AND due_day <= EXTRACT(DAY FROM CURRENT_DATE) + 7
           ORDER BY due_day LIMIT 3`, [cid]);
        for (const ob of urgent) {
          insights.push({
            id: 'obligation-' + ob.code, severity: ob.due_day <= new Date().getDate() ? 'critical' : 'warning',
            agent: 'Contabil', title: `${ob.name} vence dia ${ob.due_day}`,
            description: `Obrigacao ${ob.code} precisa de atencao.`,
            action: { type: 'navigate', target: '/contabilidade', label: 'Ver guia' },
          });
        }
        break;
      }
      case 'dashboard': case 'geral': {
        const { rows: [ls] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products WHERE company_id=$1 AND stock_qty <= min_stock_qty AND min_stock_qty > 0`, [cid]);
        if (parseInt(ls?.cnt) > 0) {
          insights.push({ id: 'low-stock-dash', severity: 'warning', agent: 'Estoque',
            title: `${ls.cnt} produto${parseInt(ls.cnt)>1?'s':''} para repor`,
            description: 'Itens abaixo do estoque minimo.',
            action: { type: 'navigate', target: '/estoque', label: 'Repor' } });
        }
        const { rows: [ic] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL`, [cid]);
        if (parseInt(ic?.cnt) > 0) {
          insights.push({ id: 'inactive-dash', severity: 'info', agent: 'CRM',
            title: `${ic.cnt} cliente${parseInt(ic.cnt)>1?'s':''} para reativar`,
            description: 'Sem compra ha 30+ dias.',
            action: { type: 'navigate', target: '/clientes', label: 'Reativar' } });
        }
        const { rows: [td] } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total
           FROM sales WHERE company_id=$1 AND created_at >= CURRENT_DATE`, [cid]);
        if (parseInt(td?.cnt) > 0) {
          insights.push({ id: 'today-sales-dash', severity: 'info', agent: 'Vendas',
            title: `${td.cnt} venda${parseInt(td.cnt)>1?'s':''} hoje - R$ ${parseFloat(td.total).toFixed(2).replace('.',',')}`,
            description: 'Caixa movimentado.',
            action: { type: 'navigate', target: '/pdv', label: 'Ver caixa' } });
        }
        break;
      }
    }
  } catch (err) { console.error(`[aiInsights] Error for ${ctx}:`, err.message); }
  res.json({ context: ctx, insights, count: insights.length });
});

module.exports = router;
