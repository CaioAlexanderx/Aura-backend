// ============================================================
// AURA Studio · Conversão de bulk-event → digital_orders reais
//
// Item #4 da análise UX/UI: tinha como criar o evento mas nada
// transformava cada item da lista em pedido real no KDS.
//
// Mount em private.js no mesmo prefixo /studio.
// Migration 134 adicionou:
//   studio_bulk_event_items.digital_order_id (FK → digital_orders)
//   studio_bulk_events.converted_at
//
// Estratégia:
//   1 bulk_event_item == 1 digital_orders (1 produto personalizado por pessoa)
//   - studio_production_status='pending_art' (entra no KDS aguardando arte)
//   - vertical='studio'
//   - customer_name = recipient_name (ou nome do contratante se for vazio)
//   - customer_phone do evento ('' se o evento nao tem: coluna NOT NULL)
//   - order_number e subtotal preenchidos (services/studioPedido.js, o mesmo
//     INSERT do orcamento; antes faltavam e a conversao falhava sempre)
//   - studio_bulk_event_id apontando pro evento (rastreabilidade)
//   - total = base_unit_price * (1 - discount_pct/100)
//   - 1 digital_order_items por order com customization JSONB do item
//
// Idempotente: items já convertidos (digital_order_id IS NOT NULL) são pulados.
// Permite re-convert se cancelar a digital_order (FK ON DELETE SET NULL).
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { inserirPedidoStudio, inserirItemPedidoStudio } = require('../services/studioPedido');

// GET /studio/bulk-events/:eid/orders
// Lista todas as digital_orders já geradas pra este evento, com info do item
router.get('/bulk-events/:eid/orders', async function(req, res) {
  try {
    // Confirma evento existe nesta empresa
    const evCheck = await db.query(
      `SELECT id FROM studio_bulk_events WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [req.params.eid, req.params.id]
    );
    if (!evCheck.rows.length) return res.status(404).json({ error: 'Evento não encontrado' });

    const r = await db.query(
      `SELECT
         i.id AS item_id, i.line_number, i.recipient_name, i.customization,
         i.digital_order_id,
         o.studio_production_status, o.total, o.created_at AS order_created_at,
         o.customer_name AS order_customer_name,
         (SELECT MIN(image_url) FROM studio_approval_links a
           WHERE a.order_id = o.id AND a.status = 'pending'
           ORDER BY a.created_at DESC LIMIT 1) AS pending_mockup_url
         FROM studio_bulk_event_items i
         LEFT JOIN digital_orders o ON o.id = i.digital_order_id
        WHERE i.event_id = $1
        ORDER BY i.line_number`,
      [req.params.eid]
    );
    res.json({
      items: r.rows,
      converted: r.rows.filter((x) => x.digital_order_id).length,
      total: r.rows.length,
    });
  } catch (err) {
    console.error('[studio/bulk-events/:eid/orders]', err.message);
    res.status(500).json({ error: 'Erro ao listar items do evento' });
  }
});

// POST /studio/bulk-events/:eid/convert
// Cria 1 digital_orders por bulk_event_item ainda não convertido
router.post('/bulk-events/:eid/convert', async function(req, res) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Lock pessimista: garante que duas calls paralelas não dupliquem
    const eventRes = await client.query(
      `SELECT id, customer_name, customer_phone, product_id, product_name_snapshot,
              base_unit_price, discount_pct, status
         FROM studio_bulk_events
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [req.params.eid, req.params.id]
    );
    if (!eventRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Evento não encontrado' });
    }
    const event = eventRes.rows[0];
    if (event.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Evento cancelado não pode ser convertido' });
    }

    // Pega apenas items ainda não convertidos
    const pendingRes = await client.query(
      `SELECT id, line_number, recipient_name, customization, notes
         FROM studio_bulk_event_items
        WHERE event_id = $1 AND digital_order_id IS NULL
        ORDER BY line_number`,
      [req.params.eid]
    );
    const pending = pendingRes.rows;
    if (pending.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ converted: 0, message: 'Todos os items já estão convertidos' });
    }

    // Calcula preço por unidade (com desconto já aplicado)
    const unitPrice = +(Number(event.base_unit_price) * (1 - Number(event.discount_pct) / 100)).toFixed(2);

    let convertedCount = 0;
    const generatedOrderIds = [];

    for (const item of pending) {
      // Cria digital_orders pra este item
      const customerName = item.recipient_name || event.customer_name || 'Cliente do evento';

      // Mesmo INSERT do orcamento (services/studioPedido.js): schema real,
      // order_number do contador atomico por empresa (um por item, sem
      // colisao dentro do lote), subtotal do item, pedido 'confirmed'.
      // O item do lote nao tem telefone proprio (studio_bulk_event_items so
      // tem recipient_name); vale o telefone do evento e, sem ele, '' (a
      // coluna e NOT NULL), como no orcamento.
      const orderId = await inserirPedidoStudio(client, {
        cid: req.params.id,
        customerName,
        customerPhone: event.customer_phone,
        total: unitPrice,
        bulkEventId: req.params.eid,
      });
      generatedOrderIds.push(orderId);

      // Cria digital_order_items (1 linha = 1 produto = qty 1)
      await inserirItemPedidoStudio(client, {
        orderId,
        productId: event.product_id,
        productName: event.product_name_snapshot || 'Produto personalizado',
        quantity: 1,
        unitPrice,
        customization: item.customization,
      });

      // Liga o item de volta ao order
      await client.query(
        `UPDATE studio_bulk_event_items SET digital_order_id = $1 WHERE id = $2`,
        [orderId, item.id]
      );
      convertedCount++;
    }

    // Marca o evento como in_production (já é o estágio natural após conversão)
    // e timestamp
    await client.query(
      `UPDATE studio_bulk_events
         SET status = CASE WHEN status = 'draft' THEN 'in_production' ELSE status END,
             converted_at = COALESCE(converted_at, NOW()),
             updated_at = NOW()
       WHERE id = $1`,
      [req.params.eid]
    );

    await client.query('COMMIT');

    res.status(201).json({
      converted: convertedCount,
      order_ids: generatedOrderIds,
      message: `${convertedCount} pedido(s) criado(s) no KDS`,
    });
  } catch (err) {
    // Se a conexao ja caiu o ROLLBACK tambem falha: nao pode engolir a resposta.
    try { await client.query('ROLLBACK'); } catch (_) { /* conexao ja caiu */ }
    console.error('[studio/bulk-events/convert]', err.message);
    res.status(500).json({ error: 'Erro ao converter evento em pedidos' });
  } finally {
    client.release();
  }
});

module.exports = router;
