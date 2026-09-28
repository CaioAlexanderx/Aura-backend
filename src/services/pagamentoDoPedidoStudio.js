// ============================================================
// AURA Studio · Pagamento do pedido da vitrine no painel (26/09/2026)
//
// Achado A1 do QA da lojista (P0): o pedido da vitrine Studio mora em
// digital_orders, e quando a cliente paga pela chave Pix ele fica em
// 'pending_payment' ate a lojista confirmar. A unica tela com o botao
// era a fila do Canal Digital, de onde a conta Studio e redirecionada;
// o detalhe do Studio (/studio/pedidos/:id) nao sabia nem a forma nem a
// situacao do pagamento. Resultado: pedido pago por chave Pix era
// cancelado sozinho em 72 h (jobs/lojaPixExpiradoJob), porque a lojista
// nao tinha onde dar baixa.
//
// A view studio_orders nao tem as colunas de pagamento, e ela nao e
// versionada (migration 208: "mantida como esta" em prod) -- entao o
// detalhe e as listas completam o pedido DAQUI, com um SELECT curto em
// digital_orders, sem mexer na view.
//
// A baixa em si reusa a rota do Canal Digital
// (POST /digital-channel/orders/:oid/approve-payment): ela ja muda
// status + payment_status, dispara a confirmacao (estoque, e-mail da
// cliente, aviso "Pagamento confirmado") e passa pelos mesmos gates que
// as rotas /studio (requirePlan negocio/expansao).
//
// payment_proof_url nasceu depois das outras colunas. Base sem ela (42703)
// perde so o comprovante, uma vez por processo (CLAUDE.md, armadilha 1).
// ============================================================
'use strict';

const COLUNAS = [
  'id', 'company_id', 'status', 'payment_method', 'payment_status', 'total',
  'order_number', 'confirmed_at', 'cancelled_at',
  // LJ-34 (QA final 28/09/2026): o cartao da Producao diz por que um Pix
  // vencido nao cancelou — a mesma leitura do job (situacaoDoPixVencido).
  'created_at', 'vertical', 'studio_production_status',
  "(to_jsonb(digital_orders)->>'deposit_paid')::boolean AS deposit_paid",
];
const COLUNAS_DO_COMPROVANTE = ['payment_proof_url', 'payment_proof_uploaded_at'];

let _semComprovante = false;

function _resetParaTeste() { _semComprovante = false; }

/**
 * Pagamento de varios pedidos digitais de uma empresa.
 * @returns {Promise<Map<string, object>>} id (texto) -> linha de pagamento
 */
async function pagamentosDosPedidos(db, companyId, ids) {
  const lista = [...new Set((ids || []).filter(Boolean).map(String))];
  const mapa = new Map();
  if (!companyId || lista.length === 0) return mapa;

  const consulta = (comComprovante) => db.query(
    `SELECT ${COLUNAS.concat(comComprovante ? COLUNAS_DO_COMPROVANTE : []).join(', ')}
       FROM digital_orders
      WHERE company_id = $1
        AND id::text = ANY($2::text[])`,
    [companyId, lista]
  );

  let rows;
  try {
    ({ rows } = await consulta(!_semComprovante));
  } catch (e) {
    if (e.code !== '42703' || _semComprovante) throw e;
    _semComprovante = true;
    ({ rows } = await consulta(false));
  }
  for (const r of rows) mapa.set(String(r.id), r);
  return mapa;
}

/** Campos que o detalhe do pedido Studio recebe (somados, nunca trocados). */
function camposDoDetalhe(linha) {
  if (!linha) return {};
  return {
    status: linha.status,
    payment_method: linha.payment_method ?? null,
    payment_status: linha.payment_status ?? null,
    payment_proof_url: linha.payment_proof_url ?? null,
    payment_proof_uploaded_at: linha.payment_proof_uploaded_at ?? null,
    total: linha.total != null ? Number(linha.total) : null,
    order_number: linha.order_number ?? null,
    confirmed_at: linha.confirmed_at ?? null,
    cancelled_at: linha.cancelled_at ?? null,
  };
}

/**
 * Campos que as LISTAS recebem. Sem a URL do comprovante: a fila so
 * precisa saber se ele existe, para o selo "Pagamento a conferir".
 */
function camposDaLista(linha) {
  if (!linha) return {};
  return {
    order_status: linha.status,
    payment_method: linha.payment_method ?? null,
    payment_status: linha.payment_status ?? null,
    has_payment_proof: !!linha.payment_proof_url,
    pix_cancelamento: linha.created_at ? situacaoDoPixVencido(linha) : null,
  };
}

/**
 * Soma os campos de pagamento as linhas de uma lista. `idDoPedido(linha)`
 * devolve o id do digital_order da linha (ou null quando a linha nao e
 * pedido da vitrine). Falha na consulta nunca derruba a lista: a linha
 * so fica sem selo.
 */
async function comPagamentoNaLista(db, companyId, linhas, idDoPedido) {
  const ids = linhas.map(idDoPedido).filter(Boolean);
  if (ids.length === 0) return linhas;
  let mapa;
  try {
    mapa = await pagamentosDosPedidos(db, companyId, ids);
  } catch (e) {
    console.error('[pagamentoDoPedidoStudio] lista sem pagamento:', e.message);
    return linhas;
  }
  return linhas.map((l) => {
    const id = idDoPedido(l);
    return id && mapa.has(String(id)) ? { ...l, ...camposDaLista(mapa.get(String(id))) } : l;
  });
}

// ── Nota, entrega e Pix vencido no detalhe (QA 28/09/2026) ─────────────
//
// LJ-32 (P0): o detalhe nao mostrava o CPF/CNPJ que a cliente pediu na
// nota nem "Retirada na loja". LJ-34: Pix vencido sem dizer por que nao
// cancelou. Os campos vem do pedido inteiro (SELECT *: coluna que falte
// numa base so fica nula, nao derruba nada) e da loja (endereco de
// retirada, a mesma regra da confirmacao e do acompanhamento).
const { situacaoDoPixVencido } = require('../jobs/lojaPixExpiradoJob');
const { cancelamentoDoPedido } = require('./cancelamentoDoPedido');

const TIPOS_DE_ENTREGA = ['pickup', 'delivery', 'courier'];
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
const texto = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/**
 * Campos de nota, entrega e Pix vencido do detalhe do pedido Studio.
 * Pura: `pedido` e a linha de digital_orders, `loja` a de
 * digital_channel_config (ou null).
 */
function camposDeEntregaENota(pedido, loja, agora = Date.now()) {
  if (!pedido) return {};
  const tipo = TIPOS_DE_ENTREGA.includes(pedido.delivery_type) ? pedido.delivery_type : 'pickup';
  const retira = tipo === 'pickup' || tipo === 'courier';
  const l = loja || {};
  return {
    customer_cpf_cnpj: texto(pedido.customer_cpf_cnpj),
    request_nfce: pedido.nfce_requested === true,
    delivery_type: tipo,
    delivery_address: tipo === 'delivery' ? texto(pedido.delivery_address) : null,
    address_neighborhood: tipo === 'delivery' ? texto(pedido.address_neighborhood) : null,
    address_city: tipo === 'delivery' ? texto(pedido.address_city) : null,
    retirada_endereco: retira ? (texto(l.pickup_address) || texto(l.address)) : null,
    courier_name: texto(pedido.courier_name),
    courier_plate: texto(pedido.courier_plate),
    courier_a_informar: tipo === 'courier' && !texto(pedido.courier_name),
    shipping_fee: num(pedido.delivery_fee),
    pix_discount: num(pedido.discount_amount),
    payment_method: pedido.payment_method ?? null,
    payment_status: pedido.payment_status ?? null,
    pix_cancelamento: situacaoDoPixVencido(pedido, agora),
    // QA final 28/09/2026 (LJ-33): o bloco "Cancelado" do detalhe diz quem
    // cancelou e o motivo que a lojista escreveu (null se nao cancelado).
    cancelamento: cancelamentoDoPedido(pedido),
  };
}

/** Le o pedido e a loja e devolve camposDeEntregaENota. */
async function entregaENotaDoPedido(db, companyId, digitalOrderId) {
  const { rows } = await db.query(
    `SELECT * FROM digital_orders WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [digitalOrderId, companyId]
  );
  if (!rows.length) return {};
  let loja = null;
  try {
    const r = await db.query(
      `SELECT * FROM digital_channel_config WHERE company_id = $1 LIMIT 1`, [companyId]);
    loja = r.rows[0] || null;
  } catch (e) {
    console.error('[pagamentoDoPedidoStudio] loja do pedido:', e.message);
  }
  return camposDeEntregaENota(rows[0], loja);
}

module.exports = {
  camposDeEntregaENota,
  entregaENotaDoPedido,
  pagamentosDosPedidos,
  camposDoDetalhe,
  camposDaLista,
  comPagamentoNaLista,
  _resetParaTeste,
};
