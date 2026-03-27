// ============================================================
// AURA. — PDV-01: Caixa de Vendas Touch
// Venda atômica: sale + items + baixa de estoque + métricas cliente
// Suporte a desconto, variantes, Pix, múltiplos pagamentos
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth];

const fmt = (v) => parseFloat(v || 0).toFixed(2);

// ============================================================
// POST /companies/:id/pdv/sale
// ============================================================
router.post('/sale', guard, async (req, res) => {
  const {
    items, customer_id, payment_method,
    discount_amount, discount_pct,
    notes, seller_id, payments,
  } = req.body;

  if (!items?.length)
    return res.status(400).json({ error: 'items obrigatório' });

  // fix: db já é o Pool — usar db.connect() direto, não db.pool.connect()
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let subtotal = 0;
    const enrichedItems = [];

    for (const item of items) {
      const qty       = parseFloat(item.quantity);
      const unitPrice = parseFloat(item.unit_price);
      const lineTotal = parseFloat((qty * unitPrice).toFixed(2));
      subtotal += lineTotal;

      let productName = item.product_name_snapshot || '';
      let costPrice   = 0;
      if (item.product_id) {
        const { rows: p } = await client.query(
          `SELECT name, cost_price, stock_qty FROM products WHERE id=$1 AND company_id=$2`,
          [item.product_id, req.params.id]
        );
        if (p.length) {
          productName = productName || p[0].name;
          costPrice   = parseFloat(p[0].cost_price || 0);
          if (parseFloat(p[0].stock_qty) < qty) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: `Estoque insuficiente para "${p[0].name}". Disponível: ${p[0].stock_qty}`,
              product_id: item.product_id,
            });
          }
        }
      }
      enrichedItems.push({ ...item, product_name_snapshot: productName, cost_price: costPrice, line_total: lineTotal });
    }

    let discountAmt = 0;
    if (discount_amount && parseFloat(discount_amount) > 0) {
      discountAmt = parseFloat(discount_amount);
    } else if (discount_pct && parseFloat(discount_pct) > 0) {
      discountAmt = parseFloat((subtotal * parseFloat(discount_pct) / 100).toFixed(2));
    }
    const totalAmount = parseFloat((subtotal - discountAmt).toFixed(2));

    const { rows: sales } = await client.query(
      `INSERT INTO sales
         (company_id, customer_id, seller_id, total_amount, discount_amount,
          payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        req.params.id, customer_id || null,
        seller_id || req.user?.id || null,
        totalAmount, discountAmt,
        payment_method || (payments?.[0]?.method) || 'dinheiro',
        notes || null,
      ]
    );
    const sale = sales[0];

    for (const item of enrichedItems) {
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, variant_id, quantity, unit_price,
            unit_cost, discount, total_price, product_name_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          sale.id, item.product_id || null, item.variant_id || null,
          item.quantity, item.unit_price, item.cost_price,
          item.item_discount || 0, item.line_total, item.product_name_snapshot,
        ]
      );

      if (item.product_id) {
        if (item.variant_id) {
          await client.query(
            `UPDATE product_variants SET stock_qty=GREATEST(0,stock_qty-$1), updated_at=NOW() WHERE id=$2`,
            [item.quantity, item.variant_id]
          );
        } else {
          await client.query(
            `UPDATE products SET stock_qty=GREATEST(0,stock_qty-$1), updated_at=NOW() WHERE id=$2 AND company_id=$3`,
            [item.quantity, item.product_id, req.params.id]
          );
        }
        await client.query(
          `INSERT INTO stock_movements (product_id,company_id,type,quantity,reference_id,reference_type,notes)
           VALUES ($1,$2,'out',$3,$4,'sale','Venda PDV') ON CONFLICT DO NOTHING`,
          [item.product_id, req.params.id, item.quantity, sale.id]
        );
      }
    }

    if (payments?.length > 1) {
      for (const p of payments) {
        await client.query(
          `INSERT INTO sale_payments (sale_id,company_id,method,amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [sale.id, req.params.id, p.method, p.amount]
        );
      }
    }

    if (customer_id) {
      await client.query(
        `UPDATE customers SET total_purchases=total_purchases+1, total_spent=total_spent+$1,
           last_purchase_at=NOW(), first_purchase_at=COALESCE(first_purchase_at,NOW()), updated_at=NOW()
         WHERE id=$2 AND company_id=$3`,
        [totalAmount, customer_id, req.params.id]
      );
    }

    await client.query('COMMIT');

    const { rows: saleItems } = await db.query(
      `SELECT si.*, p.name AS product_name FROM sale_items si
       LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`, [sale.id]
    );

    res.status(201).json({
      sale: { ...sale, items: saleItems },
      receipt_url: `/companies/${req.params.id}/print/receipt/${sale.id}`,
      receipt_auto_url: `/companies/${req.params.id}/print/receipt/${sale.id}/preview`,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// GET /companies/:id/pdv/sale/:saleId
router.get('/sale/:saleId', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, u.full_name AS seller_name, c.name AS customer_name
       FROM sales s LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       WHERE s.id=$1 AND s.company_id=$2`,
      [req.params.saleId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Venda não encontrada' });
    const { rows: items } = await db.query(
      `SELECT si.*, COALESCE(p.name, si.product_name_snapshot) AS product_name
       FROM sale_items si LEFT JOIN products p ON p.id=si.product_id WHERE si.sale_id=$1`,
      [req.params.saleId]
    );
    res.json({ ...rows[0], items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/pdv/sales
router.get('/sales', guard, async (req, res) => {
  const { date, limit = 50, offset = 0 } = req.query;
  const cond = ['s.company_id=$1'];
  const vals = [req.params.id];
  let i = 2;
  if (date) { cond.push(`s.created_at::date=$${i++}`); vals.push(date); }
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.created_at,
              u.full_name AS seller_name, c.name AS customer_name, COUNT(si.id) AS item_count
       FROM sales s LEFT JOIN users u ON u.id=s.seller_id LEFT JOIN customers c ON c.id=s.customer_id
       LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE ${cond.join(' AND ')} GROUP BY s.id, u.full_name, c.name
       ORDER BY s.created_at DESC LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/pdv/summary
router.get('/summary', guard, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0,10);
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS total_sales, COALESCE(SUM(total_amount),0) AS gross_revenue,
              COALESCE(SUM(discount_amount),0) AS total_discounts,
              ROUND(AVG(total_amount)::NUMERIC,2) AS avg_ticket,
              json_object_agg(payment_method, cnt) AS by_payment_method
       FROM (SELECT s.total_amount, s.discount_amount, s.payment_method,
                    COUNT(*) OVER (PARTITION BY s.payment_method) AS cnt
             FROM sales s WHERE s.company_id=$1 AND s.created_at::date=$2) sub`,
      [req.params.id, date]
    );
    res.json({ date, ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /companies/:id/pdv/sale/:saleId
router.delete('/sale/:saleId', guard, async (req, res) => {
  // fix: usar db.connect() direto
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id FROM sales WHERE id=$1 AND company_id=$2`,
      [req.params.saleId, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Venda não encontrada' }); }
    const { rows: items } = await client.query(
      `SELECT product_id, variant_id, quantity FROM sale_items WHERE sale_id=$1`,
      [req.params.saleId]
    );
    for (const item of items) {
      if (!item.product_id) continue;
      if (item.variant_id) {
        await client.query(`UPDATE product_variants SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2`, [item.quantity, item.variant_id]);
      } else {
        await client.query(`UPDATE products SET stock_qty=stock_qty+$1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [item.quantity, item.product_id, req.params.id]);
      }
    }
    await client.query(`UPDATE sales SET notes=CONCAT(COALESCE(notes,''),' [CANCELADA]'), updated_at=NOW() WHERE id=$1`, [req.params.saleId]);
    await client.query('COMMIT');
    res.json({ ok: true, cancelled: req.params.saleId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
