// ============================================================
// AURA. — AI Insights
// FIX: contabil query usava 'name' (nao existe) e 'due_day' (nao existe).
//      Corrigido para 'description' e comparacao com due_date.
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
        const { rows: overdue } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
           FROM transactions WHERE company_id=$1 AND type='income' AND status='pending' AND due_date < CURRENT_DATE`, [cid]);
        if (parseInt(overdue[0]?.cnt) > 0) {
          insights.push({ id: 'overdue', severity: 'warning', agent: 'Financeiro',
            title: `${overdue[0].cnt} conta${parseInt(overdue[0].cnt)>1?'s':''} a receber vencida${parseInt(overdue[0].cnt)>1?'s':''}`,
            description: `R$ ${parseFloat(overdue[0].total).toFixed(2).replace('.',',')} em receitas pendentes.`,
            action: { type: 'navigate', target: '/financeiro', label: 'Ver lancamentos' } });
        }
        const { rows: [sales] } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total
           FROM sales WHERE company_id=$1 AND created_at >= CURRENT_DATE`, [cid]);
        if (parseInt(sales?.cnt) > 0) {
          insights.push({ id: 'today-sales', severity: 'info', agent: 'Vendas',
            title: `${sales.cnt} venda${parseInt(sales.cnt)>1?'s':''} hoje`,
            description: `Faturamento: R$ ${parseFloat(sales.total).toFixed(2).replace('.',',')}`,
            action: { type: 'navigate', target: '/pdv', label: 'Ver caixa' } });
        }
        break;
      }
      case 'estoque': {
        const { rows: low } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products
           WHERE company_id=$1 AND stock_qty <= stock_min AND stock_min > 0`, [cid]);
        if (parseInt(low[0]?.cnt) > 0) {
          insights.push({ id: 'low-stock', severity: 'warning', agent: 'Estoque',
            title: `${low[0].cnt} produto${parseInt(low[0].cnt)>1?'s':''} com estoque baixo`,
            description: 'Itens abaixo do estoque minimo precisam de reposicao.',
            action: { type: 'navigate', target: '/estoque', label: 'Ver alertas' } });
        }
        break;
      }
      case 'crm': case 'clientes': {
        const { rows: [inact] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers
           WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL`, [cid]);
        if (parseInt(inact?.cnt) > 0) {
          insights.push({ id: 'inactive', severity: 'warning', agent: 'CRM',
            title: `${inact.cnt} cliente${parseInt(inact.cnt)>1?'s':''} inativo${parseInt(inact.cnt)>1?'s':''}`,
            description: 'Sem compra ha mais de 30 dias.',
            action: { type: 'navigate', target: '/clientes', label: 'Ver clientes' } });
        }
        break;
      }
      case 'contabil': case 'contabilidade': {
        // FIX: coluna correta e 'description' (nao 'name') e comparacao por due_date (nao due_day)
        const { rows: urgent } = await db.query(
          `SELECT code, description, due_date FROM fiscal_obligations
           WHERE company_id=$1 AND status IN ('pending','overdue')
             AND due_date <= CURRENT_DATE + INTERVAL '7 days'
           ORDER BY due_date LIMIT 3`, [cid]);
        for (const ob of urgent) {
          const dueDay = ob.due_date ? new Date(ob.due_date).getDate() : null;
          const isOverdue = ob.due_date && new Date(ob.due_date) <= new Date();
          insights.push({
            id: 'ob-' + ob.code,
            severity: isOverdue ? 'critical' : 'warning',
            agent: 'Contabil',
            title: `${ob.description || ob.code} vence dia ${dueDay}`,
            description: `Obrigacao ${ob.code}.`,
            action: { type: 'navigate', target: '/contabilidade', label: 'Ver guia' },
          });
        }
        break;
      }
      case 'dashboard': case 'geral': {
        const { rows: [ls] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products WHERE company_id=$1 AND stock_qty <= stock_min AND stock_min > 0`, [cid]);
        if (parseInt(ls?.cnt) > 0) {
          insights.push({ id: 'low-stock-d', severity: 'warning', agent: 'Estoque',
            title: `${ls.cnt} produto${parseInt(ls.cnt)>1?'s':''} para repor`,
            description: 'Abaixo do estoque minimo.',
            action: { type: 'navigate', target: '/estoque', label: 'Repor' } });
        }
        const { rows: [td] } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount),0) AS total
           FROM sales WHERE company_id=$1 AND created_at >= CURRENT_DATE`, [cid]);
        if (parseInt(td?.cnt) > 0) {
          insights.push({ id: 'sales-d', severity: 'info', agent: 'Vendas',
            title: `${td.cnt} venda${parseInt(td.cnt)>1?'s':''} hoje - R$ ${parseFloat(td.total).toFixed(2).replace('.',',')}`,
            description: 'Caixa movimentado.',
            action: { type: 'navigate', target: '/pdv', label: 'Ver caixa' } });
        }
        break;
      }
    }
  } catch (err) { console.error(`[aiInsights] ${ctx}:`, err.message); }
  res.json({ context: ctx, insights, count: insights.length });
});

module.exports = router;
