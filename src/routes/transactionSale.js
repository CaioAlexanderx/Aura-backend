// ============================================================
// AURA. — Vinculo Transacao <-> Venda (mercadorias + vendedora)
//
// Quando uma transaction veio do PDV, sua idempotency_key tem
// formato "pdv-sale-{sale_uuid}". Esse arquivo expõe acoes
// extras pra editar a venda relacionada SEM quebrar o snapshot
// da transacao financeira.
//
// Rotas:
//   GET    /transactions/:tx_id/sale-details
//   DELETE /transactions/:tx_id/sale-items/:item_id  (devolucao parcial)
//   PATCH  /transactions/:tx_id/seller               (mudar vendedora)
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

// Extrai sale_id da idempotency_key. Retorna null se nao for venda do PDV.
function extractSaleId(idempotencyKey) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null;
  const m = idempotencyKey.match(/^pdv-sale-([0-9a-f-]+)$/i);
  return m ? m[1] : null;
}

// GET /transactions/:tx_id/sale-details
// Retorna { has_sale, sale, items, customer, seller, available_employees }
// Se transaction nao for de venda, has_sale=false.
router.get('/transactions/:tx_id/sale-details', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;

  const txRes = await pool.query(
    `SELECT id, idempotency_key, employee_id, employee_name, amount, description
     FROM transactions WHERE id = $1 AND company_id = $2`,
    [txId, companyId]
  );
  if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);
  const tx = txRes.rows[0];
  const saleId = extractSaleId(tx.idempotency_key);

  // Lista de funcionarios pra dropdown (ativos)
  const empRes = await pool.query(
    `SELECT id, name FROM employees WHERE company_id = $1 AND COALESCE(is_active, true) = true
     ORDER BY name`,
    [companyId]
  );
  const availableEmployees = empRes.rows;

  if (!saleId) {
    // Transacao nao vinculada a venda — so retorna info de funcionario
    return res.json({
      has_sale: false,
      transaction: {
        id: tx.id,
        amount: parseFloat(tx.amount),
        description: tx.description,
        employee_id: tx.employee_id,
        employee_name: tx.employee_name,
      },
      available_employees: availableEmployees,
    });
  }

  // Busca venda + itens + customer + seller
  const saleRes = await pool.query(
    `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.status,
            s.cancelled_at, s.created_at,
            s.customer_id, c.name AS customer_name, c.phone AS customer_phone,
            s.seller_id, s.seller_name, s.employee_id
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [saleId, companyId]
  );
  if (!saleRes.rows.length) {
    // Venda foi deletada mas transacao continua — comporta como sem venda
    return res.json({
      has_sale: false,
      transaction: {
        id: tx.id,
        amount: parseFloat(tx.amount),
        description: tx.description,
        employee_id: tx.employee_id,
        employee_name: tx.employee_name,
      },
      available_employees: availableEmployees,
    });
  }
  const sale = saleRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT si.id, si.product_id, si.variant_id, si.quantity,
            si.unit_price, si.discount, si.total_price,
            si.product_name_snapshot,
            p.name AS product_name, p.image_url
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = $1
     ORDER BY si.id`,
    [saleId]
  );

  res.json({
    has_sale: true,
    transaction: {
      id: tx.id,
      amount: parseFloat(tx.amount),
      description: tx.description,
      employee_id: tx.employee_id,
      employee_name: tx.employee_name,
    },
    sale: {
      id: sale.id,
      total_amount: parseFloat(sale.total_amount),
      discount_amount: parseFloat(sale.discount_amount || 0),
      payment_method: sale.payment_method,
      status: sale.status,
      cancelled_at: sale.cancelled_at,
      created_at: sale.created_at,
    },
    customer: sale.customer_id ? {
      id: sale.customer_id,
      name: sale.customer_name,
      phone: sale.customer_phone,
    } : null,
    seller: {
      id: sale.seller_id || sale.employee_id,
      name: sale.seller_name,
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
    available_employees: availableEmployees,
  });
}));

// DELETE /transactions/:tx_id/sale-items/:item_id
// Devolucao parcial:
//   1. Devolve quantidade ao stock (product ou variant)
//   2. Reduz sales.total_amount
//   3. Reduz transactions.amount
//   4. Cria nova transaction tipo 'expense' categoria 'devolucao'
//      como contrapartida (auditoria)
// Tudo numa unica transacao SQL pra atomicidade.
router.delete('/transactions/:tx_id/sale-items/:item_id', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;
  const itemId = req.params.item_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Carrega transaction + valida vinculo com venda
    const txRes = await client.query(
      `SELECT id, idempotency_key, amount, description
       FROM transactions WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [txId, companyId]
    );
    if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);
    const tx = txRes.rows[0];
    const saleId = extractSaleId(tx.idempotency_key);
    if (!saleId) throw new AppError('Lancamento nao esta vinculado a uma venda', 400);

    // 2. Carrega item da venda + valida pertence a essa venda + empresa
    const itemRes = await client.query(
      `SELECT si.id, si.sale_id, si.product_id, si.variant_id,
              si.quantity, si.total_price, si.product_name_snapshot,
              p.name AS product_name
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id
       WHERE si.id = $1 AND s.id = $2 AND s.company_id = $3 FOR UPDATE`,
      [itemId, saleId, companyId]
    );
    if (!itemRes.rows.length) throw new AppError('Item nao encontrado nessa venda', 404);
    const item = itemRes.rows[0];
    const itemTotal = parseFloat(item.total_price);
    const itemQty = parseFloat(item.quantity);
    const itemName = item.product_name || item.product_name_snapshot || 'Item';

    // 3. Devolve estoque (variant tem prioridade)
    if (item.variant_id) {
      await client.query(
        `UPDATE product_variants SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW()
         WHERE id = $2`,
        [itemQty, item.variant_id]
      );
    } else if (item.product_id) {
      await client.query(
        `UPDATE products SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3`,
        [itemQty, item.product_id, companyId]
      );
    }

    // 4. Remove o item da venda
    await client.query('DELETE FROM sale_items WHERE id = $1', [itemId]);

    // 5. Verifica quantos items restaram
    const remainingRes = await client.query(
      'SELECT COUNT(*)::int AS n, COALESCE(SUM(total_price), 0) AS new_total FROM sale_items WHERE sale_id = $1',
      [saleId]
    );
    const remaining = remainingRes.rows[0];
    const newTotal = parseFloat(remaining.new_total);

    if (remaining.n === 0) {
      // Sem itens restantes: cancela a venda inteira
      await client.query(
        `UPDATE sales SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [saleId]
      );
    } else {
      // Atualiza total da venda
      await client.query(
        'UPDATE sales SET total_amount = $1, updated_at = NOW() WHERE id = $2',
        [newTotal, saleId]
      );
    }

    // 6. Reduz transaction.amount (transacao original)
    const newTxAmount = parseFloat(tx.amount) - itemTotal;
    await client.query(
      'UPDATE transactions SET amount = $1, updated_at = NOW() WHERE id = $2',
      [Math.max(0, newTxAmount), txId]
    );

    // 7. Cria transacao espelho de "devolucao" (categoria devolucao)
    //    Tipo expense (saida de dinheiro pra cliente).
    //    due_date = data atual em America/Sao_Paulo.
    const refundDesc = 'Devolucao: ' + itemName + ' (qty ' + itemQty + ')';
    await client.query(
      `INSERT INTO transactions (
         company_id, type, status, amount, description, category, due_date,
         paid_at, idempotency_key, created_at, updated_at, created_by
       ) VALUES (
         $1, 'expense', 'confirmed', $2, $3, 'devolucao',
         (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
         NOW(), $4, NOW(), NOW(), $5
       )`,
      [
        companyId,
        itemTotal,
        refundDesc,
        'refund-' + saleId + '-' + itemId,
        req.user?.id || null,
      ]
    );

    await client.query('COMMIT');
    res.json({
      ok: true,
      removed_item: { id: itemId, name: itemName, quantity: itemQty, refund_amount: itemTotal },
      new_sale_total: newTotal,
      new_tx_amount: Math.max(0, newTxAmount),
      sale_cancelled: remaining.n === 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// PATCH /transactions/:tx_id/seller
// Body: { employee_id: string | null, employee_name?: string }
// Atualiza vendedora na transaction E na sale vinculada (se houver).
router.patch('/transactions/:tx_id/seller', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;
  const { employee_id, employee_name } = req.body || {};

  // Valida funcionario (se nao for null)
  let resolvedName = employee_name || null;
  if (employee_id) {
    const empRes = await pool.query(
      'SELECT id, name FROM employees WHERE id = $1 AND company_id = $2',
      [employee_id, companyId]
    );
    if (!empRes.rows.length) throw new AppError('Funcionario nao encontrado', 404);
    resolvedName = empRes.rows[0].name;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `UPDATE transactions
       SET employee_id = $1, employee_name = $2, updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING id, idempotency_key, employee_id, employee_name`,
      [employee_id || null, resolvedName, txId, companyId]
    );
    if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);

    // Sincroniza com a venda se vinculada
    const saleId = extractSaleId(txRes.rows[0].idempotency_key);
    if (saleId) {
      await client.query(
        `UPDATE sales
         SET seller_id = $1, employee_id = $1, seller_name = $2, updated_at = NOW()
         WHERE id = $3 AND company_id = $4`,
        [employee_id || null, resolvedName, saleId, companyId]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      transaction: txRes.rows[0],
      synced_to_sale: !!saleId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
