// ============================================================
// AURA. — Canal Digital: Pedidos (Admin)
// GET    /companies/:id/digital-channel/orders
// GET    /companies/:id/digital-channel/orders/:oid
// PATCH  /companies/:id/digital-channel/orders/:oid/status
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const notify = require('../services/digitalOrderNotifications');

// GET — Lista pedidos com filtro por status e paginação
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const conditions = ['o.company_id = $1'];
    const values = [cid];
    let idx = 2;

    if (status && status !== 'all') {
      conditions.push(`o.status = $${idx}`);
      values.push(status);
      idx++;
    }

    const where = conditions.join(' AND ');

    const { rows: orders } = await db.query(`
      SELECT
        o.id, o.order_number, o.customer_name, o.customer_phone, o.customer_email,
        o.delivery_type, o.subtotal, o.total, o.delivery_fee,
        o.status, o.payment_status, o.notes,
        o.confirmed_at, o.delivered_at, o.cancelled_at, o.created_at,
        COUNT(i.id)::int AS item_count
      FROM digital_orders o
      LEFT JOIN digital_order_items i ON i.order_id = o.id
      WHERE ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...values, parseInt(limit), offset]);

    const { rows: counts } = await db.query(`
      SELECT
        COUNT(*)::int                                               AS total,
        COUNT(*) FILTER (WHERE status = 'pending_payment')::int    AS pending_payment,
        COUNT(*) FILTER (WHERE status = 'confirmed')::int          AS confirmed,
        COUNT(*) FILTER (WHERE status = 'preparing')::int          AS preparing,
        COUNT(*) FILTER (WHERE status = 'ready')::int              AS ready,
        COUNT(*) FILTER (WHERE status = 'delivered')::int          AS delivered,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int          AS cancelled
      FROM digital_orders WHERE company_id = $1
    `, [cid]);

    res.json({
      orders,
      counts: counts[0],
      pagination: {
        page:  parseInt(page),
        limit: parseInt(limit),
        total: counts[0].total,
        pages: Math.ceil(counts[0].total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('digital orders list error:', err);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

// GET /:oid — Detalhe de um pedido com itens
router.get('/:oid', async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { rows: orders } = await db.query(
      `SELECT * FROM digital_orders WHERE id = $1 AND company_id = $2`, [oid, cid]
    );
    if (!orders.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const { rows: items } = await db.query(
      `SELECT id, product_id, product_name, product_image, unit_price, quantity, subtotal
       FROM digital_order_items WHERE order_id = $1 ORDER BY id`, [oid]
    );
    res.json({ ...orders[0], items });
  } catch (err) {
    console.error('digital order detail error:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// PATCH /:oid/status — Avança status do pedido (admin)
router.patch('/:oid/status', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  const { status } = req.body;

  const ALLOWED = ['confirmed', 'preparing', 'ready', 'delivered', 'cancelled'];
  if (!ALLOWED.includes(status)) {
    return res.status(400).json({
      error: `Status inválido. Permitidos: ${ALLOWED.join(', ')}`,
    });
  }

  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_status FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });

    const current = rows[0].status;
    if (current === 'delivered' || current === 'cancelled') {
      return res.status(409).json({ error: `Pedido já finalizado com status "${current}"` });
    }
    const FLOW = ['pending_payment', 'confirmed', 'preparing', 'ready', 'delivered'];
    const curIdx = FLOW.indexOf(current);
    const newIdx = FLOW.indexOf(status);
    if (status !== 'cancelled' && newIdx < curIdx) {
      return res.status(409).json({
        error: `Não é possível voltar de "${current}" para "${status}"`,
      });
    }

    const { rows: updated } = await db.query(`
      UPDATE digital_orders SET
        status       = $1,
        payment_status = CASE
          WHEN $1 = 'confirmed' AND payment_status = 'pending' THEN 'confirmed'
          ELSE payment_status
        END,
        confirmed_at = CASE WHEN $1 = 'confirmed' AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END,
        delivered_at = CASE WHEN $1 = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
        cancelled_at = CASE WHEN $1 = 'cancelled' AND cancelled_at IS NULL THEN NOW() ELSE cancelled_at END,
        updated_at   = NOW()
      WHERE id = $2 AND company_id = $3
      RETURNING *
    `, [status, oid, cid]);

    res.json({ order: updated[0], updated: true });

    // Notificações ao cliente (fire-and-forget)
    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] status change error:', err.message));

  } catch (err) {
    console.error('digital order status update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

module.exports = router;
