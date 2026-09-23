// ============================================================
// AURA. — Matcon M4: compras — pecas compartilhadas (23/09/2026)
//
// Usado por src/routes/matconPurchases.js (sugestao, pedidos e entrada da
// nota) e por src/routes/importData.js (import de NF-e com save=true, o
// unico caminho do repo que grava produto a partir do XML no servidor).
// Contrato: aura-app/docs/CONTRACT_MATCON.md secao "M4 › Compras".
// Schema: migrations/354_matcon_m4_purchases.sql.
//
// Tres pecas:
//   1. serializarPedido: linha de matcon_purchase_orders -> PurchaseOrder
//      do front (services/matconApi.ts), com o numero "C-0042".
//   2. gravarUltimaCompra: products.last_supplier_* / last_purchase_* —
//      "quem me vendeu isso na ultima nota e por quanto".
//   3. casarNotaComPedidos: a nota do fornecedor entrou; os pedidos
//      ENVIADOS para o mesmo CNPJ recebem a quantidade por product_id, do
//      pedido mais antigo para o mais novo, e fecham (received) quando
//      tudo chegou. Parcial continua "sent" com received_qty.
// ============================================================
'use strict';

const { onlyDigits } = require('../utils/cnpj');

function round3(n) { return Math.round((Number(n) || 0) * 1000) / 1000; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

function numOuNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function texto(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/** CNPJ so com digitos (mesma normalizacao de suppliers.cnpj), ou null. */
function cnpjDigitos(v) {
  const d = onlyDigits(v).slice(0, 14);
  return d || null;
}

/** 42 -> "C-0042". Acima de 9999 o numero so cresce ("C-10000"). */
function numeroDoPedido(seq) {
  return 'C-' + String(parseInt(seq, 10) || 0).padStart(4, '0');
}

/** items (jsonb) -> lista limpa, com numeros de verdade. */
function normalizarItens(items) {
  const lista = Array.isArray(items) ? items : [];
  return lista
    .filter((it) => it && it.product_id)
    .map((it) => ({
      product_id: String(it.product_id),
      name: it.name || '',
      unit: it.unit || null,
      quantity: round3(it.quantity),
      unit_cost_est: round4(it.unit_cost_est),
      received_qty: round3(it.received_qty),
    }));
}

function totalDosItens(itens) {
  return round2(itens.reduce((acc, it) => acc + (Number(it.quantity) || 0) * (Number(it.unit_cost_est) || 0), 0));
}

/** Tudo que foi pedido ja chegou? (lista vazia nunca conta como recebida) */
function tudoRecebido(itens) {
  return itens.length > 0 && itens.every((it) => round3(it.received_qty) >= round3(it.quantity));
}

function notasDoPedido(receivedInvoice) {
  return String(receivedInvoice || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function juntarNota(receivedInvoice, nota) {
  const notas = notasDoPedido(receivedInvoice);
  if (nota && !notas.includes(nota)) notas.push(nota);
  return notas.length ? notas.join(', ') : null;
}

function serializarPedido(row) {
  if (!row) return null;
  const itens = normalizarItens(row.items);
  return {
    id: row.id,
    number: numeroDoPedido(row.seq),
    status: row.status,
    supplier_name: row.supplier_name || null,
    supplier_cnpj: row.supplier_cnpj || null,
    supplier_phone: row.supplier_phone || null,
    items: itens,
    total_est: round2(row.total_est),
    sent_at: row.sent_at || null,
    received_at: row.received_at || null,
    received_invoice: row.received_invoice || null,
    created_at: row.created_at,
  };
}

/**
 * Grava a ultima compra no produto. `unitCost` e o valor unitario DA NOTA
 * (unidade de compra); custo zerado/ausente mantem o anterior. Telefone:
 * o que veio agora; senao mantem o que ja havia SE for o mesmo fornecedor
 * (telefone de outro fornecedor nao pode ficar grudado no novo).
 *
 * Parametro repetido na query vai sempre com o MESMO cast (::text): o
 * Postgres recusa "inconsistent types deduced for parameter" quando um uso
 * deduz varchar e outro text.
 */
async function gravarUltimaCompra(client, productId, { supplierName, supplierCnpj, supplierPhone, unitCost }) {
  const custo = numOuNull(unitCost);
  await client.query(
    `UPDATE products
        SET last_supplier_name  = $2::text,
            last_supplier_cnpj  = $3::text,
            last_supplier_phone = CASE
                                    WHEN $4::text IS NOT NULL THEN $4::text
                                    WHEN last_supplier_cnpj IS NOT DISTINCT FROM $3::text THEN last_supplier_phone
                                    ELSE NULL
                                  END,
            last_purchase_unit_cost = COALESCE($5::numeric, last_purchase_unit_cost),
            last_purchase_at    = NOW(),
            updated_at          = NOW()
      WHERE id = $1`,
    [
      productId,
      texto(supplierName, 200),
      cnpjDigitos(supplierCnpj),
      texto(supplierPhone, 30),
      custo !== null && custo > 0 ? round4(custo) : null,
    ]
  );
}

/**
 * Casa a nota do fornecedor com os pedidos ENVIADOS da empresa para o
 * mesmo CNPJ. `items` = [{product_id, quantity}] com quantity na unidade
 * de VENDA (a mesma do pedido). Tem que rodar dentro de transacao: trava
 * os pedidos com FOR UPDATE.
 *
 * - Do pedido mais antigo (sent_at) para o mais novo: se a loja mandou
 *   dois pedidos do mesmo cimento, a nota fecha primeiro o mais antigo.
 * - Chegou mais do que foi pedido: o excedente nao vai para lugar nenhum
 *   (o estoque ja entrou pela nota; o pedido so registra o que era dele).
 * - A mesma nota aplicada duas vezes (conferencia repetida) nao soma de
 *   novo: se o numero ja esta em received_invoice de algum pedido deste
 *   fornecedor, nada e casado.
 *
 * Devolve os pedidos alterados, ja serializados.
 */
async function casarNotaComPedidos(client, companyId, { supplierCnpj, invoiceNumber, items }) {
  const cnpj = cnpjDigitos(supplierCnpj);
  if (!cnpj) return [];

  const chegou = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const q = numOuNull(it && it.quantity);
    if (!it || !it.product_id || q === null || q <= 0) continue;
    const pid = String(it.product_id);
    chegou.set(pid, round3((chegou.get(pid) || 0) + q));
  }
  if (!chegou.size) return [];

  const nota = texto(invoiceNumber, 60);
  if (nota) {
    const { rows: jaAplicada } = await client.query(
      `SELECT 1 FROM matcon_purchase_orders
        WHERE company_id = $1 AND supplier_cnpj = $2
          AND $3 = ANY(string_to_array(replace(COALESCE(received_invoice, ''), ' ', ''), ','))
        LIMIT 1`,
      [companyId, cnpj, nota.replace(/\s/g, '')]
    );
    if (jaAplicada.length) return [];
  }

  const { rows: pedidos } = await client.query(
    `SELECT id, company_id, seq, status, supplier_name, supplier_cnpj, supplier_phone,
            items, total_est, sent_at, received_at, received_invoice, created_at
       FROM matcon_purchase_orders
      WHERE company_id = $1 AND status = 'sent' AND supplier_cnpj = $2
      ORDER BY sent_at ASC NULLS LAST, seq ASC
      FOR UPDATE`,
    [companyId, cnpj]
  );

  const alterados = [];
  for (const pedido of pedidos) {
    const itens = normalizarItens(pedido.items);
    let mudou = false;
    for (const it of itens) {
      const resta = chegou.get(it.product_id) || 0;
      if (resta <= 0) continue;
      const falta = round3(it.quantity - it.received_qty);
      if (falta <= 0) continue;
      const usa = Math.min(resta, falta);
      it.received_qty = round3(it.received_qty + usa);
      chegou.set(it.product_id, round3(resta - usa));
      mudou = true;
    }
    if (!mudou) continue;

    const fechou = tudoRecebido(itens);
    const { rows } = await client.query(
      `UPDATE matcon_purchase_orders
          SET items = $3::jsonb,
              status = $4::text,
              received_at = CASE WHEN $4::text = 'received' THEN NOW() ELSE received_at END,
              received_invoice = $5,
              updated_at = NOW()
        WHERE id = $1 AND company_id = $2
        RETURNING id, seq, status, supplier_name, supplier_cnpj, supplier_phone,
                  items, total_est, sent_at, received_at, received_invoice, created_at`,
      [pedido.id, companyId, JSON.stringify(itens), fechou ? 'received' : 'sent', juntarNota(pedido.received_invoice, nota)]
    );
    if (rows[0]) alterados.push(serializarPedido(rows[0]));
  }
  return alterados;
}

module.exports = {
  round2,
  round3,
  round4,
  texto,
  numOuNull,
  cnpjDigitos,
  numeroDoPedido,
  normalizarItens,
  totalDosItens,
  tudoRecebido,
  serializarPedido,
  gravarUltimaCompra,
  casarNotaComPedidos,
};
