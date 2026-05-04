// ============================================================
// AURA. — Service: Emissao automatica de NFCe a partir de pedido digital
//
// Reusa a logica de routes/nfce.js POST /emit, mas sem auth (chamado de
// dentro do service de confirmacao de pedido). Se nfce_config nao existe
// ou esta inativa, retorna {skipped: true} sem erro — emissao eh opcional
// e nao deve bloquear pedido.
//
// Em ambiente='homologacao', auto-autoriza com protocolo HOMOLOG-NNNNNN.
// Em 'producao', cria com status 'processando' (TODO: integrar SEFAZ).
// ============================================================
'use strict';

async function emitForDigitalOrder({ orderId, dbClient }) {
  // Carrega pedido + items
  const { rows: orders } = await dbClient.query(
    `SELECT * FROM digital_orders WHERE id = $1`, [orderId]
  );
  if (!orders.length) {
    return { skipped: true, reason: 'order_not_found' };
  }
  const order = orders[0];

  // Ja tem NFCe? skip (idempotencia)
  if (order.nfce_id) {
    return { skipped: true, reason: 'already_emitted', nfce_id: order.nfce_id };
  }

  const { rows: items } = await dbClient.query(
    `SELECT * FROM digital_order_items WHERE order_id = $1`, [orderId]
  );
  if (!items.length) {
    return { skipped: true, reason: 'no_items' };
  }

  // Carrega config NFCe da empresa
  const { rows: configs } = await dbClient.query(
    `SELECT * FROM nfce_config WHERE company_id = $1`, [order.company_id]
  );
  if (!configs.length || !configs[0].is_active) {
    console.warn('[nfce] config nao configurada/inativa pra company', order.company_id);
    return { skipped: true, reason: 'nfce_not_configured' };
  }
  const config = configs[0];

  // Monta items no formato esperado pela tabela nfce_emissions
  const nfceItems = items.map(i => ({
    product_id:   i.product_id,
    product_name: i.product_name,
    quantity:     parseFloat(i.quantity),
    unit_price:   parseFloat(i.unit_price),
    discount:     0,
    subtotal:     parseFloat(i.subtotal),
  }));

  let totalProducts = 0;
  for (const it of nfceItems) totalProducts += it.quantity * it.unit_price;
  const totalDiscount = 0;
  const totalNfce = Math.round((totalProducts - totalDiscount) * 100) / 100;

  // Chave de acesso placeholder (real key vem da SEFAZ)
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const chaveAcesso = `${config.uf}${yy}${mm}${'0'.repeat(14)}55${String(config.serie_nfce).padStart(3, '0')}${String(config.next_number).padStart(9, '0')}1${'0'.repeat(8)}1`;

  const customerName = order.customer_name || null;
  const customerCpf  = order.customer_cpf_cnpj || null;
  const initStatus = config.ambiente === 'homologacao' ? 'autorizada' : 'processando';
  const paymentMethod = order.payment_method === 'pix' ? 'pix' :
                        order.payment_method === 'on_delivery' ? 'dinheiro' :
                        order.payment_method || 'dinheiro';

  const { rows: created } = await dbClient.query(
    `INSERT INTO nfce_emissions
       (company_id, sale_id, transaction_id, numero, serie, chave_acesso, status,
        customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
        payment_method, payment_change, emitted_by)
     VALUES ($1, NULL, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12,
             $13, 0, NULL)
     RETURNING id, numero, chave_acesso, status`,
    [order.company_id, order.transaction_id, config.next_number, config.serie_nfce,
     chaveAcesso, initStatus,
     customerCpf, customerName, JSON.stringify(nfceItems),
     totalProducts, totalDiscount, totalNfce,
     paymentMethod]
  );

  // Increment next_number
  await dbClient.query(
    `UPDATE nfce_config SET next_number = next_number + 1, updated_at = NOW()
     WHERE company_id = $1`,
    [order.company_id]
  );

  // Auto-autoriza em homologacao
  if (config.ambiente === 'homologacao') {
    await dbClient.query(
      `UPDATE nfce_emissions
          SET status = 'autorizada',
              protocolo = 'HOMOLOG-' || LPAD(numero::text, 6, '0'),
              authorized_at = NOW()
        WHERE id = $1`,
      [created[0].id]
    );
  }
  // TODO producao: enviar XML pra SEFAZ via NFE.io ou direto, atualizar status

  // Linka no pedido
  await dbClient.query(
    `UPDATE digital_orders SET nfce_id = $1 WHERE id = $2`,
    [created[0].id, orderId]
  );

  return {
    skipped: false,
    nfce_id: created[0].id,
    numero: created[0].numero,
    status: config.ambiente === 'homologacao' ? 'autorizada' : initStatus,
  };
}

module.exports = { emitForDigitalOrder };
