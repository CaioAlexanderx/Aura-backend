// ============================================================
// AURA. — Pedido da loja online idempotente (migration 416, 27/10/2026)
//
// Medido em producao: cada compra pela loja online gerava de 3 a 5 pedidos
// iguais em digital_orders, criados com 0,1 a 0,7 s de diferenca. Os botoes
// de forma de pagamento chamavam submitOrder() sem trava, e o POST
// /storefront/:slug/order criava um pedido novo a cada toque.
//
// A vitrine (templates/storefront/parts/checkout.js) passa a mandar uma
// chave por tentativa de checkout (`idempotency_key` no body; o cabecalho
// `Idempotency-Key` tambem vale), a MESMA em todo toque repetido e em toda
// nova tentativa depois de erro de rede. O servidor grava a chave no pedido;
// a mesma chave da mesma loja devolve o pedido ja criado (200), sem criar
// outro. Mesmo padrao da venda do Caixa (services/vendaIdempotente.js, 390).
//
// Como a rota usa (routes/storefront.js, POST /:slug/order):
//   1. chaveDoPedido(req): le e valida a chave; null = sem idempotencia
//      (pagina antiga em cache, chave fora do formato ou migration 416
//      ausente) — o pedido segue exatamente como antes.
//   2. antes das conferencias, buscarPedido(): a repeticao que chega depois
//      da primeira ter terminado responde logo, sem cair num "estoque
//      insuficiente" falso.
//   3. logo apos o BEGIN, travarEBuscar(): trava a chave (advisory lock da
//      transacao). O toque simultaneo ESPERA o primeiro gravar e enxerga o
//      pedido.
//   4. o indice UNICO parcial e a garantia final: 23505 (ehColisaoDaChave)
//      tambem vira repeticao.
//   5. antes de responder 201, guardarResposta() grava o corpo (com o Pix e
//      o link do cartao). A repeticao devolve esse corpo; se o primeiro
//      ainda estiver gerando o Pix, espera um pouco; se mesmo assim faltar,
//      remonta o basico a partir do pedido.
//
// Mesma chave com OUTROS itens nao e repeticao: 409 IDEMPOTENCY_KEY_REUSED.
// A vitrine troca a chave e o proximo toque vira pedido novo.
// ============================================================
'use strict';

const db = require('../config/database');

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INDICE = 'uq_digital_orders_company_idempotency_key';

// Quanto a repeticao espera o primeiro pedido guardar a resposta (o Pix e
// a preferencia do cartao saem depois do COMMIT, numa chamada externa).
const ESPERA = { totalMs: 8000, passoMs: 250 };

// Cache da sondagem das colunas: "existe" e permanente no processo; "nao
// existe" e reperguntado a cada 60 s (a 416 pode ter acabado de rodar).
let _colunas = null;
let _checadoEm = 0;

async function colunasDisponiveis() {
  if (_colunas === true) return true;
  if (_colunas === false && (Date.now() - _checadoEm) < 60000) return false;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'digital_orders'
          AND column_name IN ('idempotency_key', 'idempotency_response')`
    );
    _colunas = parseInt(rows?.[0]?.n || 0, 10) === 2;
  } catch (e) {
    _colunas = false;
  }
  _checadoEm = Date.now();
  return _colunas;
}

function _resetCache() { _colunas = null; _checadoEm = 0; }

function lerChave(req) {
  const doCabecalho = req?.headers?.['idempotency-key'];
  const raw = (doCabecalho !== undefined && doCabecalho !== null && doCabecalho !== '')
    ? doCabecalho
    : req?.body?.idempotency_key;
  if (raw === undefined || raw === null) return null;
  const k = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!k) return null;
  if (!KEY_RE.test(k)) {
    // Fora do formato: o pedido NAO cai por isso, so segue sem protecao.
    console.warn('[storefront] chave de idempotencia fora do formato, ignorada');
    return null;
  }
  return k;
}

/** A chave deste pedido, ou null quando o pedido segue sem idempotencia. */
async function chaveDoPedido(req) {
  const k = lerChave(req);
  if (!k) return null;
  return (await colunasDisponiveis()) ? k : null;
}

/** Fora de transacao: o id do pedido que a chave ja gerou, ou null. */
async function buscarPedido(companyId, key) {
  const { rows } = await db.query(
    `SELECT id FROM digital_orders WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, key]
  );
  return rows[0]?.id || null;
}

/** Dentro da transacao do pedido. Devolve o id do pedido ja feito, ou null. */
async function travarEBuscar(client, companyId, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`storefront-order:${companyId}:${key}`]);
  const { rows } = await client.query(
    `SELECT id FROM digital_orders WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, key]
  );
  return rows[0]?.id || null;
}

function ehColisaoDaChave(e) {
  return !!e && e.code === '23505' && String(e.constraint || '') === INDICE;
}

// Os itens identificam o pedido: produto, variante e quantidade. A rota
// zera a variante de produto sem grade; a comparacao faz o mesmo.
function mesmosItens(itensDoPedido, itensGravados) {
  const semGrade = new Set(
    (itensGravados || []).filter((i) => !i.variant_id).map((i) => String(i.product_id))
  );
  const linha = (productId, variantId, quantidade) => [
    String(productId),
    variantId && !semGrade.has(String(productId)) ? String(variantId) : '',
    Number(quantidade || 0).toFixed(3),
  ].join('|');
  const a = (itensDoPedido || []).map((i) => linha(i.product_id, i.variant_id, i.quantity)).sort();
  const b = (itensGravados || []).map((i) => linha(i.product_id, i.variant_id, i.quantity)).sort();
  return a.length === b.length && a.every((x, idx) => x === b[idx]);
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

async function lerPedido(companyId, key) {
  const { rows } = await db.query(
    `SELECT * FROM digital_orders WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, key]
  );
  return rows[0] || null;
}

/**
 * Responde a repeticao com o pedido que a chave ja gerou (200), fora da
 * transacao. `remontarCartao(pedido, itens)` e chamado so quando a resposta
 * do primeiro nao foi guardada e o pedido e de cartao (a preferencia do MP
 * usa a chave pref-<pedido>, entao volta a MESMA). Devolve false quando nao
 * achou o pedido — a rota segue o erro de sempre.
 */
async function responderRepeticao(res, { companyId, key, itens, remontarCartao }) {
  let pedido = await lerPedido(companyId, key);
  if (!pedido) return false;

  const { rows: itensGravados } = await db.query(
    `SELECT product_id, variant_id, quantity, product_name, unit_price
       FROM digital_order_items WHERE order_id = $1`,
    [pedido.id]
  );

  if (!mesmosItens(itens, itensGravados)) {
    res.status(409).json({
      error: `Já recebemos um pedido seu (#${pedido.order_number}) com outros itens. Se este for um pedido novo, toque de novo para enviar.`,
      code: 'IDEMPOTENCY_KEY_REUSED',
      order_id: pedido.id,
      order_number: pedido.order_number ?? null,
    });
    return true;
  }

  // O primeiro ainda pode estar gerando o Pix/cartao: espera a resposta.
  const limite = Date.now() + ESPERA.totalMs;
  while (!(pedido.idempotency_response && typeof pedido.idempotency_response === 'object')
         && Date.now() < limite) {
    await pausa(ESPERA.passoMs);
    pedido = (await lerPedido(companyId, key)) || pedido;
  }

  const { idempotency_response: guardada } = pedido;
  let corpo;
  if (guardada && typeof guardada === 'object') {
    corpo = { ...guardada };
  } else {
    let card = null;
    if (pedido.payment_method === 'card' && typeof remontarCartao === 'function') {
      try { card = await remontarCartao(pedido, itensGravados); } catch (e) {
        console.error('[storefront] repeticao: cartao nao remontado:', e && e.message);
      }
    }
    corpo = {
      order_id:       pedido.id,
      order_number:   pedido.order_number,
      total:          parseFloat(pedido.total),
      delivery_fee:   parseFloat(pedido.delivery_fee || 0),
      subtotal:       parseFloat(pedido.subtotal),
      status:         pedido.status,
      payment_method: pedido.payment_method,
      shipping:       null,
      loja_fechada:   false,
      abre_em:        '',
      pix: pedido.asaas_pix_payload ? {
        qrcode:     pedido.asaas_pix_qrcode || null,
        payload:    pedido.asaas_pix_payload,
        expires_at: pedido.asaas_pix_expires_at || null,
        mode:       null,
      } : null,
      card,
    };
  }
  corpo.idempotent_replay = true;
  res.set('Idempotent-Replayed', 'true');
  res.status(200).json(corpo);
  return true;
}

/** Antes do 201. Nunca derruba o pedido: falhou, so loga. */
async function guardarResposta({ companyId, orderId, corpo }) {
  try {
    await db.query(
      `UPDATE digital_orders SET idempotency_response = $1::jsonb WHERE id = $2 AND company_id = $3`,
      [JSON.stringify(corpo), orderId, companyId]
    );
  } catch (e) {
    console.warn('[storefront] resposta do pedido idempotente nao guardada:', e && e.message);
  }
}

module.exports = {
  chaveDoPedido,
  buscarPedido,
  travarEBuscar,
  ehColisaoDaChave,
  responderRepeticao,
  guardarResposta,
  mesmosItens,
  ESPERA,
  _resetCache,
  INDICE,
};
