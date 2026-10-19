// ============================================================
// AURA Studio. INSERT unico de pedido (digital_orders) e de item
// (digital_order_items) para as rotas que fabricam pedido no painel:
//   - orcamento aceito/aprovado   (studioQuotes.criarPedidoDoOrcamento)
//   - conversao de evento em lote (studioBulkConvert)
//
// Colunas conferidas no banco de producao em 18/10/2026:
//   - o total do pedido e `total` (+ `subtotal`); nao existe `total_amount`
//     nem `created_by`
//   - `order_number` e NOT NULL sem default: vem de next_digital_order_number
//     (contador atomico por empresa, migration 273), como na vitrine. Chamado
//     varias vezes na mesma transacao devolve numeros distintos e sequenciais.
//   - customer_name e customer_phone sao NOT NULL: sem dado, 'Cliente' e ''
//   - digital_order_items.subtotal e NOT NULL sem default (qtd x preco)
// 'confirmed' (e nao 'pending_payment') de proposito: a lojista ja fechou a
// venda, e o job lojaPixExpiradoJob cancela 'pending_payment' pago em Pix.
//
// Roda dentro da transacao de quem chama (recebe o `client`).
// ============================================================
'use strict';

const arred2 = (n) => Math.round(n * 100) / 100;

/**
 * Cria o pedido do Studio ja confirmado e na etapa 'pending_art' da esteira.
 * @returns {Promise<string>} id do pedido
 */
async function inserirPedidoStudio(client, {
  cid,
  customerName,       // sem valor -> 'Cliente'
  customerPhone,      // sem valor -> '' (coluna NOT NULL)
  total,
  depositRequired = null,
  notes = null,
  bulkEventId = null, // rastreabilidade do evento em lote
}) {
  const valor = parseFloat(total) || 0;
  const r = await client.query(
    `INSERT INTO digital_orders
       (company_id, order_number, vertical, status, studio_production_status,
        customer_name, customer_phone,
        subtotal, total, deposit_required, deposit_paid,
        notes, confirmed_at, studio_bulk_event_id)
     VALUES ($1, next_digital_order_number($1), 'studio', 'confirmed', 'pending_art',
             COALESCE($2, 'Cliente'), COALESCE($3, ''), $4, $4, $5, false, $6, NOW(), $7)
     RETURNING id`,
    [
      cid,
      customerName || null,
      customerPhone || null,
      valor,
      depositRequired != null ? parseFloat(depositRequired) : null,
      notes,
      bulkEventId,
    ]
  );
  return r.rows[0].id;
}

/** Cria uma linha do pedido; subtotal = quantidade x preco. */
async function inserirItemPedidoStudio(client, {
  orderId, productId, productName, quantity, unitPrice, customization,
}) {
  const qtd = parseFloat(quantity);
  const preco = parseFloat(unitPrice);
  await client.query(
    `INSERT INTO digital_order_items
       (order_id, product_id, product_name, quantity, unit_price, subtotal, customization)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      orderId,
      productId || null,
      String(productName),
      qtd,
      preco,
      arred2(qtd * preco),
      customization ? JSON.stringify(customization) : null,
    ]
  );
}

module.exports = { inserirPedidoStudio, inserirItemPedidoStudio };
