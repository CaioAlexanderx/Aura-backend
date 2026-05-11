// ============================================================
// AURA. — Listagem e detalhes de vendas (Item 3 Eryca)
//
// GET    /companies/:id/sales              -> lista paginada + stats agregados
// GET    /companies/:id/sales/:sale_id     -> detalhes completos + items
// PATCH  /companies/:id/sales/:sale_id     -> atualiza seller da venda
// POST   /companies/:id/sales/:sale_id/cancel  -> cancela venda inteira
//
// Vinculo com transactions: cada sale tem uma tx no financeiro com
// idempotency_key = 'pdv-sale-{sale_uuid}'. O endpoint de listagem
// retorna transaction_id pra UI poder abrir o TransactionModal direto.
//
// 11/05/2026 — Fix bug auditoria caixa: cancel agora deleta também
// os sale_payments da venda. Antes, payments residuais inflavam o
// total do fechamento de caixa (caso Davi Villa Branca 10/05: 2 vendas
// canceladas mantinham R$299,98 em payments).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

// Constroi clausula WHERE dinamica baseada nos filtros recebidos.
// Retorna { conds, vals } pra concatenar nas queries de count/list/stats.
function buildWhere(companyId, filters) {
  const conds = ['s.company_id = $1'];
  const vals = [companyId];
  let i = 2;

  if (filters.date_from) {
    conds.push('s.created_at >= $' + (i++) + '::timestamptz');
    vals.push(filters.date_from);
  }
  if (filters.date_to) {
    conds.push('s.created_at <= $' + (i++) + '::timestamptz');
    vals.push(filters.date_to);
  }
  if (filters.status === 'active') {
    conds.push("COALESCE(s.status, 'completed') != 'cancelled'");
  } else if (filters.status === 'cancelled') {
    conds.push("s.status = 'cancelled'");
  } // 'all' ou undefined = sem filtro

  if (filters.seller_id) {
    conds.push('(s.seller_id = $' + i + ' OR s.employee_id = $' + i + ')');
    vals.push(filters.seller_id);
    i++;
  }
  if (filters.customer_id) {
    conds.push('s.customer_id = $' + (i++));
    vals.push(filters.customer_id);
  }
  if (filters.q) {
    conds.push('(c.name ILIKE $' + i + ' OR COALESCE(s.seller_name, e.name) ILIKE $' + i + ')');
    vals.push('%' + filters.q + '%');
    i++;
  }

  return { conds: conds.join(' AND '), vals: vals };
}

// GET /companies/:id/sales
router.get('/', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { date_from, date_to, status, seller_id, customer_id, q, limit, offset } = req.query;

  const filters = { date_from, date_to, status, seller_id, customer_id, q };
  const { conds, vals } = buildWhere(companyId, filters);

  const limitNum = Math.min(parseInt(limit) || 50, 200);
  const offsetNum = parseInt(offset) || 0;

  // Count total (pra paginacao)
  const countQuery =
    'SELECT COUNT(*)::int AS total FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE ' + conds;
  const { rows: countRows } = await pool.query(countQuery, vals);
  const total = countRows[0].total;

  // Listagem com customer/seller denormalized + items_count + transaction_id
  const listQuery =
    'SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.status, ' +
    '       s.cancelled_at, s.created_at, ' +
    '       s.customer_id, c.name AS customer_name, ' +
    '       s.seller_id, COALESCE(s.seller_name, e.name) AS seller_name, s.employee_id, ' +
    '       (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS items_count, ' +
    "       (SELECT t.id FROM transactions t WHERE t.idempotency_key = 'pdv-sale-' || s.id AND t.company_id = s.company_id LIMIT 1) AS transaction_id " +
    'FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE ' + conds + ' ' +
    'ORDER BY s.created_at DESC ' +
    'LIMIT $' + (vals.length + 1) + ' OFFSET $' + (vals.length + 2);
  const { rows } = await pool.query(listQuery, [...vals, limitNum, offsetNum]);

  // Stats agregados pro periodo (sem paginacao, mesmo filtro)
  const statsQuery =
    'SELECT ' +
    '  COUNT(*)::int AS total_sales, ' +
    "  COUNT(*) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled')::int AS active_sales, " +
    "  COUNT(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled_sales, " +
    "  COALESCE(SUM(s.total_amount) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS revenue, " +
    "  COALESCE(AVG(s.total_amount) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS avg_ticket " +
    'FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE ' + conds;
  const { rows: statsRows } = await pool.query(statsQuery, vals);
  const stats = statsRows[0];

  res.json({
    total: total,
    limit: limitNum,
    offset: offsetNum,
    sales: rows.map(function(r) {
      return {
        id: r.id,
        total_amount: parseFloat(r.total_amount),
        discount_amount: parseFloat(r.discount_amount || 0),
        payment_method: r.payment_method,
        status: r.status || 'completed',
        cancelled_at: r.cancelled_at,
        created_at: r.created_at,
        customer: r.customer_id ? { id: r.customer_id, name: r.customer_name } : null,
        seller: { id: r.seller_id || r.employee_id || null, name: r.seller_name || null },
        items_count: r.items_count,
        transaction_id: r.transaction_id,
      };
    }),
    stats: {
      total_sales: stats.total_sales,
      active_sales: stats.active_sales,
      cancelled_sales: stats.cancelled_sales,
      revenue: parseFloat(stats.revenue),
      avg_ticket: parseFloat(stats.avg_ticket),
    },
  });
}));

// GET /companies/:id/sales/:sale_id
router.get('/:sale_id', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.sale_id;

  const saleRes = await pool.query(
    'SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, ' +
    '       COALESCE(s.seller_name, e.name) AS seller_name_eff, ' +
    "       (SELECT t.id FROM transactions t WHERE t.idempotency_key = 'pdv-sale-' || s.id AND t.company_id = s.company_id LIMIT 1) AS transaction_id " +
    'FROM sales s ' +
    'LEFT JOIN customers c ON c.id = s.customer_id ' +
    'LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id ' +
    'WHERE s.id = $1 AND s.company_id = $2',
    [saleId, companyId]
  );
  if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);
  const sale = saleRes.rows[0];

  const itemsRes = await pool.query(
    'SELECT si.id, si.product_id, si.variant_id, si.quantity, si.unit_price, ' +
    '       si.discount, si.total_price, si.product_name_snapshot, ' +
    '       p.name AS product_name, p.image_url ' +
    'FROM sale_items si ' +
    'LEFT JOIN products p ON p.id = si.product_id ' +
    'WHERE si.sale_id = $1 ' +
    'ORDER BY si.id',
    [saleId]
  );

  res.json({
    sale: {
      id: sale.id,
      total_amount: parseFloat(sale.total_amount),
      discount_amount: parseFloat(sale.discount_amount || 0),
      payment_method: sale.payment_method,
      status: sale.status || 'completed',
      cancelled_at: sale.cancelled_at,
      created_at: sale.created_at,
      notes: sale.notes,
      cash_tendered: sale.cash_tendered ? parseFloat(sale.cash_tendered) : null,
      coupon_code: sale.coupon_code,
      transaction_id: sale.transaction_id,
    },
    customer: sale.customer_id ? {
      id: sale.customer_id,
      name: sale.customer_name,
      phone: sale.customer_phone,
      email: sale.customer_email,
    } : null,
    seller: {
      id: sale.seller_id || sale.employee_id,
      name: sale.seller_name_eff,
    },
    items: itemsRes.rows.map(function(r) {
      return {
        id: r.id,
        product_id: r.product_id,
        variant_id: r.variant_id,
        quantity: parseFloat(r.quantity),
        unit_price: parseFloat(r.unit_price),
        discount: parseFloat(r.discount || 0),
        total_price: parseFloat(r.total_price),
        product_name: r.product_name || r.product_name_snapshot || 'Item',
        image_url: r.image_url,
      };
    }),
  });
}));

// PATCH /companies/:id/sales/:sale_id
// Atualiza o vendedor da venda. Aceita seller_id (UUID do employee) ou
// null pra limpar. Persiste seller_name denormalizado pra garantir que
// o nome apareca mesmo se o employee for deletado depois (fix "nao puxa
// vendedor em algumas vendas").
router.patch('/:sale_id', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.sale_id;
  const { seller_id } = req.body || {};

  // Verifica existencia da venda
  const saleRes = await pool.query(
    'SELECT id, status FROM sales WHERE id = $1 AND company_id = $2',
    [saleId, companyId]
  );
  if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);

  // Resolve nome do vendedor a partir do employee
  let sellerName = null;
  const resolvedSellerId = seller_id || null;

  if (seller_id) {
    const empRes = await pool.query(
      'SELECT id, name FROM employees WHERE id = $1 AND company_id = $2',
      [seller_id, companyId]
    );
    if (!empRes.rows.length) throw new AppError('Vendedor nao encontrado nesta empresa', 404);
    sellerName = empRes.rows[0].name;
  }

  // Atualiza seller_id, employee_id e seller_name em sincronia.
  // seller_name denormalizado garante exibicao correta mesmo se o
  // employee for removido no futuro.
  await pool.query(
    'UPDATE sales SET seller_id = $1, employee_id = $1, seller_name = $2, updated_at = NOW() WHERE id = $3 AND company_id = $4',
    [resolvedSellerId, sellerName, saleId, companyId]
  );

  res.json({ ok: true, sale_id: saleId, seller_id: resolvedSellerId, seller_name: sellerName });
}));

// POST /companies/:id/sales/:sale_id/cancel
// Fluxo esperado:
//   1. Marca venda como cancelled (status='cancelled', cancelled_at, cancelled_by, notes).
//   2. Devolve estoque de todos os items (variant tem prioridade sobre product).
//   3. Remove a transaction de receita (DELETE) — assim o valor sai do
//      financeiro e dos relatorios. Sales-based dashboards ja filtram por
//      status='cancelled', mas o transactions ainda alimenta o financeiro,
//      por isso precisa sair tambem.
//   4. Remove sale_payments — sem isso o fechamento de caixa inflava o
//      total. Fix do bug Davi Villa Branca 10/05/2026.
//
// NAO criamos espelho expense/devolucao: o codigo antigo fazia
// UPDATE amount=0 + INSERT expense, o que (a) violava CHECK (amount > 0)
// derrubando o cancelamento e (b) duplicava a baixa contabil.
//
// Auditoria preservada em sales.cancelled_at + cancelled_by + notes.
router.post('/:sale_id/cancel', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const saleId = req.params.sale_id;
  const reason = ((req.body && req.body.reason) || '').toString().trim().slice(0, 200);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Carrega venda com lock
    const saleRes = await client.query(
      'SELECT id, total_amount, status FROM sales WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [saleId, companyId]
    );
    if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);
    if (saleRes.rows[0].status === 'cancelled') {
      throw new AppError('Venda ja esta cancelada', 400);
    }

    // 2. Carrega items pra devolver estoque
    const itemsRes = await client.query(
      'SELECT si.product_id, si.variant_id, si.quantity FROM sale_items si WHERE si.sale_id = $1',
      [saleId]
    );

    // 3. Devolve estoque de cada item (variant tem prioridade)
    for (let idx = 0; idx < itemsRes.rows.length; idx++) {
      const item = itemsRes.rows[idx];
      const qty = parseFloat(item.quantity);
      if (item.variant_id) {
        await client.query(
          'UPDATE product_variants SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW() WHERE id = $2',
          [qty, item.variant_id]
        );
      } else if (item.product_id) {
        await client.query(
          'UPDATE products SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW() WHERE id = $2 AND company_id = $3',
          [qty, item.product_id, companyId]
        );
      }
    }

    // 4. Marca venda como cancelada (preserva historico nas notes)
    await client.query(
      "UPDATE sales SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $1, updated_at = NOW(), " +
      "                notes = COALESCE(notes, '') || CASE WHEN $2::text != '' THEN E'\\nCancelada: ' || $2::text ELSE '' END " +
      'WHERE id = $3',
      [req.user && req.user.id ? req.user.id : null, reason, saleId]
    );

    // 5. Remove a transaction de receita vinculada (se existir).
    //    Vendas orfas (pre-sync ou ja deletadas) nao tem nada pra remover.
    const txRes = await client.query(
      'SELECT id, amount FROM transactions WHERE idempotency_key = $1 AND company_id = $2',
      ['pdv-sale-' + saleId, companyId]
    );

    let refundedAmount = 0;
    let txRemoved = false;

    if (txRes.rows.length) {
      refundedAmount = parseFloat(txRes.rows[0].amount);
      await client.query(
        'DELETE FROM transactions WHERE id = $1',
        [txRes.rows[0].id]
      );
      txRemoved = true;
    }

    // 6. Remove sale_payments (FIX 11/05/2026)
    //    Sem isso, o card "Fechamentos de Caixa" e o snapshot do fechamento
    //    de caixa atual inflam o total — payments de vendas canceladas
    //    continuavam sendo somados. Detectado na auditoria SQL Davi Villa
    //    Branca 10/05 (2 vendas canceladas, R$299,98 residuais).
    const paymentsDel = await client.query(
      'DELETE FROM sale_payments WHERE sale_id = $1 RETURNING id, amount',
      [saleId]
    );
    const paymentsRemoved = paymentsDel.rows.length;
    const paymentsAmount = paymentsDel.rows.reduce(function(acc, r) {
      return acc + parseFloat(r.amount || 0);
    }, 0);

    await client.query('COMMIT');
    res.json({
      ok: true,
      sale_id: saleId,
      refunded_amount: refundedAmount,
      // mirror_created mantido pra compat com o frontend; sempre false agora
      // (não criamos mais espelho expense/devolucao no cancelamento).
      mirror_created: false,
      tx_removed: txRemoved,
      items_returned: itemsRes.rows.length,
      payments_removed: paymentsRemoved,
      payments_amount: paymentsAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
