// ============================================================
// AURA. — Canal Digital: Pedidos (Admin)
// GET    /companies/:id/digital-channel/orders
// GET    /companies/:id/digital-channel/orders/:oid
// PATCH  /companies/:id/digital-channel/orders/:oid/status
// POST   /companies/:id/digital-channel/orders/:oid/approve-payment
// POST   /companies/:id/digital-channel/orders/:oid/reject-payment
// DELETE /companies/:id/digital-channel/orders/:oid    (21/05/2026)
//
// fix (22/05/2026): approve-payment chama notifyPaymentConfirmed para
// enviar e-mail de confirmação ao cliente após aprovação manual do Pix.
//
// 01/09/2026: os mesmos três pontos passam a gravar EVENTO DURÁVEL no sino
// (services/lojaEvents.js). notify.* fala com o CLIENTE (e-mail/push); os
// lojaEvents.emit falam com a LOJISTA e ficam no app até serem lidos —
// antes disso, o que acontecia depois do pedido não aparecia em lugar nenhum.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const notify = require('../services/digitalOrderNotifications');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
const lojaEvents = require('../services/lojaEvents');

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
        o.status, o.payment_status, o.payment_method, o.notes,
        o.payment_proof_url, o.payment_proof_uploaded_at,
        o.confirmed_at, o.delivered_at, o.cancelled_at, o.created_at,
        o.customer_id, o.transaction_id, o.stock_deducted, o.nfce_id,
        -- migration 288: esta lista e explicita, entao coluna nova nao
        -- aparece sozinha aqui. Sem as duas o lojista ve delivery_type
        -- 'courier' na listagem sem saber quem vai buscar o pedido.
        o.courier_name, o.courier_plate,
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
        COUNT(*)::int                                                 AS total,
        COUNT(*) FILTER (WHERE status = 'pending_payment')::int      AS pending_payment,
        COUNT(*) FILTER (WHERE status = 'awaiting_approval')::int    AS awaiting_approval,
        COUNT(*) FILTER (WHERE status = 'confirmed')::int            AS confirmed,
        COUNT(*) FILTER (WHERE status = 'preparing')::int            AS preparing,
        COUNT(*) FILTER (WHERE status = 'ready')::int                AS ready,
        COUNT(*) FILTER (WHERE status = 'delivered')::int            AS delivered,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int            AS cancelled
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
      `SELECT id, product_id, variant_id, product_name, product_image, unit_price, quantity, subtotal
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
    const FLOW = ['pending_payment', 'awaiting_approval', 'confirmed', 'preparing', 'ready', 'delivered'];
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

    if (status === 'confirmed' && current !== 'confirmed') {
      onOrderConfirmed(oid)
        .catch(err => console.error('[orders] onOrderConfirmed error (status patch):', err.message));
    }

    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] status change error:', err.message));

    // Evento durável no sino. Um por transição — a dedupe_key é por pedido,
    // então reenviar o mesmo status não vira segundo aviso.
    if (status === 'delivered') lojaEvents.emit('loja_pedido_entregue', updated[0]);
    if (status === 'cancelled') lojaEvents.emit('loja_pedido_cancelado', updated[0]);
    if (status === 'confirmed' && current !== 'confirmed') {
      lojaEvents.emit('loja_pedido_pago', updated[0]);
    }

  } catch (err) {
    console.error('digital order status update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// ============================================================
// POST /:oid/approve-payment — Lojista aprova pedido aguardando aprovacao
// ============================================================
router.post('/:oid/approve-payment', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT id, status, payment_method, order_number, customer_name, customer_email, company_id
       FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];
    if (order.status !== 'awaiting_approval' && order.status !== 'pending_payment') {
      return res.status(409).json({
        error: `Pedido nao esta aguardando aprovacao (status atual: ${order.status})`,
      });
    }

    const { rows: updated } = await db.query(`
      UPDATE digital_orders SET
        status = 'confirmed',
        payment_status = 'confirmed',
        confirmed_at = COALESCE(confirmed_at, NOW()),
        updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING *
    `, [oid, cid]);

    res.json({ order: updated[0], approved: true });

    onOrderConfirmed(oid)
      .catch(err => console.error('[orders] onOrderConfirmed error (approve-payment):', err.message));

    // Notifica cliente por e-mail que o pagamento foi aprovado pelo lojista
    notify.notifyPaymentConfirmed({ order })
      .catch(err => console.error('[notify] approve-payment confirmed email error:', err.message));

    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] approve-payment error:', err.message));

    lojaEvents.emit('loja_pedido_pago', updated[0]);

  } catch (err) {
    console.error('[orders] approve-payment error:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar pagamento' });
  }
});

// ============================================================
// POST /:oid/reject-payment — Lojista rejeita pedido (cancelled)
// ============================================================
router.post('/:oid/reject-payment', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  const { reason } = req.body || {};
  try {
    const { rows } = await db.query(
      `SELECT id, status FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];
    if (order.status === 'delivered' || order.status === 'cancelled') {
      return res.status(409).json({
        error: `Pedido ja finalizado com status "${order.status}"`,
      });
    }

    const noteSuffix = reason
      ? '\n[REJEITADO em ' + new Date().toISOString() + ']: ' + String(reason).substring(0, 200)
      : '\n[REJEITADO em ' + new Date().toISOString() + ']';

    const { rows: updated } = await db.query(`
      UPDATE digital_orders SET
        status = 'cancelled',
        payment_status = 'cancelled',
        cancelled_at = NOW(),
        notes = COALESCE(notes, '') || $1,
        updated_at = NOW()
      WHERE id = $2 AND company_id = $3
      RETURNING *
    `, [noteSuffix, oid, cid]);

    res.json({ order: updated[0], rejected: true });

    notify.notifyStatusChange(updated[0])
      .catch(err => console.error('[notify] reject-payment error:', err.message));

    lojaEvents.emit('loja_pedido_cancelado', updated[0]);

  } catch (err) {
    console.error('[orders] reject-payment error:', err.message);
    res.status(500).json({ error: 'Erro ao rejeitar pagamento' });
  }
});

// ============================================================
// DELETE /:oid — Exclui pedido permanentemente (apagar pedidos teste/órfãos).
//
// Davi reclamou (21/05/2026) que não conseguia apagar pedidos teste — backend
// só tinha cancel (muda status mas mantém na lista). Esta rota apaga DE FATO.
//
// Proteções (qualquer falha → 409 com mensagem específica):
//   1. Status deve ser cancelled OU pending_payment (jamais confirmados+).
//   2. transaction_id IS NULL — sem lançamento financeiro vinculado.
//   3. stock_deducted = false — sem baixa de estoque.
//   4. confirmed_at IS NULL — nunca foi confirmado (mesmo que tenha voltado a cancelled).
//   5. nfce_id IS NULL — sem nota fiscal emitida.
//
// digital_order_items é limpo automaticamente via ON DELETE CASCADE
// (digital_order_items_order_id_fkey).
//
// Permissão: client OR admin (analyst NÃO pode — ação destrutiva).
// ============================================================
router.delete('/:oid', requireRole('client', 'admin'), async (req, res) => {
  const { id: cid, oid } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT id, status, transaction_id, stock_deducted, confirmed_at, nfce_id, order_number
       FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const order = rows[0];

    if (!['cancelled', 'pending_payment'].includes(order.status)) {
      return res.status(409).json({
        error: `Pedido não pode ser excluído (status atual: ${order.status}). Cancele o pedido primeiro.`,
      });
    }
    if (order.transaction_id) {
      return res.status(409).json({
        error: 'Pedido tem lançamento financeiro vinculado. Exclua o lançamento no Financeiro antes.',
      });
    }
    if (order.stock_deducted) {
      return res.status(409).json({
        error: 'Pedido já deu baixa no estoque. Use cancelamento (que devolve o estoque) em vez de excluir.',
      });
    }
    if (order.confirmed_at) {
      return res.status(409).json({
        error: 'Pedido foi confirmado em algum momento. Não pode ser excluído — mantenha como cancelado pro histórico.',
      });
    }
    if (order.nfce_id) {
      return res.status(409).json({
        error: 'Pedido tem NFC-e emitida. Cancele a nota antes de excluir.',
      });
    }

    const { rowCount } = await db.query(
      `DELETE FROM digital_orders WHERE id = $1 AND company_id = $2`,
      [oid, cid]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Pedido nao encontrado' });

    console.log(`[orders] deleted #${order.order_number} (${oid}) for company ${cid}`);
    res.json({ deleted: true, order_number: order.order_number });
  } catch (err) {
    console.error('[orders] delete error:', err.message);
    res.status(500).json({ error: 'Erro ao excluir pedido' });
  }
});

module.exports = router;
