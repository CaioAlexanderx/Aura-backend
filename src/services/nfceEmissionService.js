// ============================================================
// AURA. — Service: Emissão automática de NFC-e para pedidos digitais
//
// Chamado internamente pelo service de confirmação de pedido (sem auth).
// Se nfce_config não existe ou está inativa, retorna {skipped: true}
// sem erro — emissão é opcional e nunca bloqueia o pedido.
//
// Ambientes:
//   homologacao — autoriza localmente sem transmissão real
//   producao    — transmite à Nuvem Fiscal; falha é registrada em
//                 error_message mas NÃO bloqueia a confirmação do pedido
// ============================================================
'use strict';

const nuvemfiscal = require('./nuvemfiscal');

// Mapeamento forma de pagamento → código Nuvem Fiscal
function paymentCode(method) {
  const map = { pix: '17', credito: '03', debito: '04', dinheiro: '01', outros: '99' };
  return map[method] || '01';
}

async function emitForDigitalOrder({ orderId, dbClient }) {
  // Carrega pedido
  const { rows: orders } = await dbClient.query(
    'SELECT * FROM digital_orders WHERE id = $1', [orderId]
  );
  if (!orders.length) return { skipped: true, reason: 'order_not_found' };
  const order = orders[0];

  // Idempotência: já tem NFC-e vinculada?
  if (order.nfce_id) {
    return { skipped: true, reason: 'already_emitted', nfce_id: order.nfce_id };
  }

  // Carrega itens do pedido
  const { rows: items } = await dbClient.query(
    'SELECT * FROM digital_order_items WHERE order_id = $1', [orderId]
  );
  if (!items.length) return { skipped: true, reason: 'no_items' };

  // Config NFC-e da empresa
  const { rows: configs } = await dbClient.query(
    'SELECT * FROM nfce_config WHERE company_id = $1', [order.company_id]
  );
  if (!configs.length || !configs[0].is_active) {
    console.warn('[nfce] config nao configurada/inativa pra company', order.company_id);
    return { skipped: true, reason: 'nfce_not_configured' };
  }
  const config = configs[0];

  // Monta items
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
  const totalNfce = Math.round(totalProducts * 100) / 100;

  // Chave de acesso placeholder (substituída pelo retorno da Nuvem Fiscal em produção)
  const now = new Date();
  const yy  = String(now.getFullYear()).slice(2);
  const mm  = String(now.getMonth() + 1).padStart(2, '0');
  const chaveAcesso = `${config.uf}${yy}${mm}${'0'.repeat(14)}65${String(config.serie_nfce).padStart(3, '0')}${String(config.next_number).padStart(9, '0')}1${'0'.repeat(8)}1`;

  const customerName  = order.customer_name       || null;
  const customerCpf   = order.customer_cpf_cnpj   || null;
  const paymentMethod = order.payment_method === 'pix'         ? 'pix'
                      : order.payment_method === 'on_delivery' ? 'dinheiro'
                      : order.payment_method || 'dinheiro';

  // Insere registro inicial com status 'processando'
  const { rows: created } = await dbClient.query(
    `INSERT INTO nfce_emissions
       (company_id, sale_id, transaction_id, numero, serie, chave_acesso, status,
        customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
        payment_method, payment_change, emitted_by, tipo)
     VALUES ($1, NULL, $2, $3, $4, $5, 'processando',
             $6, $7, $8, $9, 0, $10, $11, 0, NULL, 'nfce')
     RETURNING id, numero, chave_acesso, status`,
    [order.company_id, order.transaction_id,
     config.next_number, config.serie_nfce, chaveAcesso,
     customerCpf, customerName, JSON.stringify(nfceItems),
     totalProducts, totalNfce, paymentMethod]
  );

  // Incrementa numeração
  await dbClient.query(
    'UPDATE nfce_config SET next_number = next_number + 1, updated_at = NOW() WHERE company_id = $1',
    [order.company_id]
  );

  let finalStatus = 'processando';

  if (config.ambiente === 'homologacao') {
    // ── Homologação: autoriza localmente ───────────────────────
    await dbClient.query(
      `UPDATE nfce_emissions
          SET status       = 'autorizada',
              protocolo    = 'HOMOLOG-' || LPAD(numero::text, 6, '0'),
              authorized_at = NOW()
        WHERE id = $1`,
      [created[0].id]
    );
    finalStatus = 'autorizada';

  } else {
    // ── Produção: transmite à Nuvem Fiscal ─────────────────────
    try {
      const { rows: companies } = await dbClient.query(
        `SELECT cnpj, legal_name, trade_name,
                address_street, address_number, address_neighborhood,
                address_city, address_state, address_zip,
                inscricao_estadual, inscricao_municipal,
                ibge_code, email, phone, tax_regime
         FROM companies WHERE id = $1`,
        [order.company_id]
      );
      const company = companies[0];

      if (company && company.cnpj) {
        const nfItems = nfceItems.map(i => ({
          code:        String(i.product_id || ''),
          name:        i.product_name,
          description: i.product_name,
          cfop:        '5102',
          unit:        'UN',
          quantity:    i.quantity,
          price:       i.unit_price,
          ncm:         '00000000',
        }));

        const provResult = await nuvemfiscal.emitNfce(company, {
          items:          nfItems,
          total_value:    totalNfce,
          payment_method: paymentCode(paymentMethod),
          recipient_cpf:  customerCpf,
          recipient_name: customerName,
        });

        finalStatus = provResult.status === 'autorizado' ? 'autorizada'
                    : provResult.status === 'rejeitado'  ? 'rejeitada'
                    : 'processando';

        await dbClient.query(
          `UPDATE nfce_emissions
              SET status         = $1,
                  nuvemfiscal_id = $2,
                  chave_acesso   = COALESCE($3, chave_acesso),
                  protocolo      = $4,
                  authorized_at  = CASE WHEN $1 = 'autorizada' THEN NOW() ELSE NULL END
            WHERE id = $5`,
          [finalStatus, provResult.id || null, provResult.chave_acesso || null,
           provResult.protocolo || null, created[0].id]
        );
      }
    } catch (apiErr) {
      // Falha na transmissão NÃO bloqueia o pedido — registra para investigação
      console.error('[nfce] Nuvem Fiscal emit error (digital order):', apiErr.message);
      await dbClient.query(
        `UPDATE nfce_emissions SET status = 'erro', error_message = $1 WHERE id = $2`,
        [apiErr.message, created[0].id]
      );
      finalStatus = 'erro';
    }
  }

  // Vincula NFC-e ao pedido
  await dbClient.query(
    'UPDATE digital_orders SET nfce_id = $1 WHERE id = $2',
    [created[0].id, orderId]
  );

  return {
    skipped: false,
    nfce_id: created[0].id,
    numero:  created[0].numero,
    status:  finalStatus,
  };
}

module.exports = { emitForDigitalOrder };
