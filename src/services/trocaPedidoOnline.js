// ============================================================
// AURA. — Pedidos da loja online na busca da troca do Caixa (27/10/2026)
//
// A troca buscava a venda de origem so em `sales`. Pedido da loja online
// vive em digital_orders/digital_order_items e nunca vira venda — a lojista
// nao achava a peca vendida pela loja para trocar.
//
// Esta busca devolve os pedidos ELEGIVEIS no mesmo formato da venda
// (SaleForTroca do app), marcados com origin_kind = 'digital_order', para os
// endpoints GET /pdv/sales-for-troca e /pdv/sales-by-product-barcode
// juntarem aos resultados de sempre.
//
// Elegivel (mesma regra do trocaV2.lookupOriginDigitalOrders):
//   - mesmo grupo: billing_owner_company_id, criterio identico ao da venda;
//   - status != 'cancelled';
//   - stock_deducted = TRUE: a confirmacao baixou o estoque
//     (digitalOrderConfirmation.onOrderConfirmed), entao ha o que repor.
//   payment_status nao entra: "pagar na entrega" entregue segue 'pending'.
//
// Pedido online nao tem NFC-e: has_nfce = false sempre; busca por chave de
// NFC-e nao traz pedido.
//
// Busca:
//   q            nome, CPF/CNPJ, numero do pedido, produto; com 4+ digitos,
//                tambem o telefone (so digitos, os dois lados)
//   order_number numero do pedido ("#00012", "00012", "12")
//   customer_id  cliente vinculado ao pedido
//   barcodes     codigo de barras do produto/variante (mesmas alternativas
//                EAN-12/13 da venda); com 8+ digitos tambem casa telefone —
//                telefone sem DDD cai no detector de codigo de barras do app
// ============================================================
'use strict';

const GROUP_COND = `(o.company_id=$1 OR EXISTS (
       SELECT 1 FROM companies c2 WHERE c2.id=o.company_id
         AND COALESCE(NULLIF(c2.billing_owner_company_id,c2.id),c2.id)
           =COALESCE(NULLIF((SELECT billing_owner_company_id FROM companies WHERE id=$1),$1),$1)))`;

function onlyDigits(v) {
  return String(v || '').replace(/\D/g, '');
}

function normalizeRow(r) {
  return {
    id: r.id,
    origin_kind: 'digital_order',
    origin_type: 'digital_order',
    is_troca_origin: false,
    order_number: r.order_number,
    digital_status: r.status,
    payment_status: r.payment_status,
    total_amount: parseFloat(r.total) || 0,
    payment_method: r.payment_method,
    status: r.status,
    created_at: r.created_at,
    company_id: r.company_id,
    company_name: r.company_name,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    cpf_cnpj: r.customer_cpf_cnpj || null,
    seller_id: null,
    seller_name: null,
    is_cross_filial: r.is_cross_filial,
    has_nfce: false,
    item_count: parseInt(r.item_count, 10) || 0,
    items: Array.isArray(r.items) ? r.items : [],
  };
}

/**
 * @param {object} db pool/cliente com .query
 * @param {string} companyId empresa do Caixa (req.params.id)
 * @param {object} f filtros: { q, order_number, customer_id, nfce_chave, barcodes[], days, limit }
 * @returns {Promise<object[]>} pedidos no formato SaleForTroca + origin_kind
 */
async function buscarPedidosParaTroca(db, companyId, f = {}) {
  if (f.nfce_chave && String(f.nfce_chave).trim()) return [];
  const winDays = Math.max(1, Math.min(parseInt(f.days, 10) || 90, 365));
  const lim = Math.max(1, Math.min(parseInt(f.limit, 10) || 50, 200));

  const cond = [
    "o.status<>'cancelled'",
    'o.stock_deducted=TRUE',
    `o.created_at>=NOW()-INTERVAL '${winDays} days'`,
    GROUP_COND,
  ];
  const vals = [companyId];
  let i = 2;

  if (f.customer_id) { cond.push(`o.customer_id=$${i++}`); vals.push(f.customer_id); }

  if (f.order_number && String(f.order_number).trim()) {
    const num = String(f.order_number).trim().replace(/^[#vV-]+/, '');
    cond.push(`o.order_number ILIKE $${i++}`); vals.push('%' + num + '%');
  }

  if (f.q && String(f.q).trim()) {
    const raw = String(f.q).trim();
    const like = `%${raw.replace(/^#/, '')}%`;
    const parts = [
      `LOWER(COALESCE(o.customer_name,'')) LIKE LOWER($${i})`,
      `LOWER(COALESCE(o.customer_cpf_cnpj,'')) LIKE LOWER($${i})`,
      `o.order_number ILIKE $${i}`,
      `EXISTS (SELECT 1 FROM digital_order_items d2 WHERE d2.order_id=o.id
         AND LOWER(COALESCE(d2.product_name,'')) LIKE LOWER($${i}))`,
    ];
    vals.push(like); i++;
    const dig = onlyDigits(raw);
    if (dig.length >= 4) {
      parts.push(`regexp_replace(COALESCE(o.customer_phone,''),'\\D','','g') LIKE $${i}`);
      parts.push(`regexp_replace(COALESCE(o.customer_cpf_cnpj,''),'\\D','','g') LIKE $${i}`);
      vals.push('%' + dig + '%'); i++;
    }
    cond.push('(' + parts.join(' OR ') + ')');
  }

  if (Array.isArray(f.barcodes) && f.barcodes.length) {
    const parts = [
      `EXISTS (SELECT 1 FROM digital_order_items d3
         LEFT JOIN products p3 ON p3.id=d3.product_id
         LEFT JOIN product_variants v3 ON v3.id=d3.variant_id
        WHERE d3.order_id=o.id
          AND (v3.barcode=ANY($${i}::text[]) OR p3.barcode=ANY($${i}::text[])))`,
    ];
    vals.push(f.barcodes); i++;
    const dig = onlyDigits(f.barcodes[0]);
    if (dig.length >= 8) {
      parts.push(`regexp_replace(COALESCE(o.customer_phone,''),'\\D','','g') LIKE $${i}`);
      vals.push('%' + dig); i++;
    }
    cond.push('(' + parts.join(' OR ') + ')');
  }

  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method,
            o.total, o.created_at, o.company_id,
            COALESCE(comp.trade_name,comp.legal_name) AS company_name,
            o.customer_id, o.customer_name, o.customer_phone, o.customer_cpf_cnpj,
            (o.company_id!=$1) AS is_cross_filial,
            COUNT(doi.id) AS item_count,
            COALESCE(json_agg(json_build_object(
              'product_id',doi.product_id,'variant_id',doi.variant_id,
              'product_name_snapshot',CASE WHEN COALESCE(doi.variant_label,'')<>''
                THEN doi.product_name||' · '||doi.variant_label ELSE doi.product_name END,
              'quantity',doi.quantity,'unit_price',doi.unit_price,
              'total_price',doi.subtotal,
              'original_digital_order_item_id',doi.id::text
            ) ORDER BY doi.id) FILTER (WHERE doi.id IS NOT NULL),'[]'::json) AS items
       FROM digital_orders o
       LEFT JOIN companies comp ON comp.id=o.company_id
       LEFT JOIN digital_order_items doi ON doi.order_id=o.id
      WHERE ${cond.join(' AND ')}
      GROUP BY o.id,comp.trade_name,comp.legal_name
      ORDER BY o.created_at DESC LIMIT ${lim}`,
    vals
  );
  return rows.map(normalizeRow);
}

/**
 * Junta vendas e pedidos online, mais recentes primeiro, no limite pedido.
 * A busca de pedidos e best-effort: se falhar, a troca de venda do Caixa
 * continua respondendo como antes.
 */
async function juntarComPedidos(salesRows, buscar, limit) {
  let pedidos = [];
  try {
    pedidos = await buscar();
  } catch (e) {
    console.warn('[troca] busca de pedidos da loja online falhou (non-fatal):', e.message);
    return salesRows;
  }
  if (!pedidos.length) return salesRows;
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  return [...salesRows, ...pedidos]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, lim);
}

module.exports = { buscarPedidosParaTroca, juntarComPedidos, _internal: { normalizeRow, onlyDigits } };
