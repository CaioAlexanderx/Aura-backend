// ============================================================
// AURA. — Reserva calculada do pedido guardado no Caixa (B2 / p-61b, 17/11/2026)
//
// Regra do Caio (17/11): pedido nao e venda. Ele nao baixa o estoque, so
// RESERVA. A reserva nao e gravada em lugar nenhum: e a soma, calculada na
// hora, das pecas dos pedidos do balcao ainda abertos:
//
//   reservado(produto, variante) = SUM(digital_order_items.quantity)
//     dos pedidos com origem = 'balcao'
//                  e status IN ('confirmed', 'preparing', 'ready')
//                  e stock_deducted IS NOT TRUE
//
// Por ser calculada, ela some sozinha quando o pedido conclui (vira venda e
// a venda baixa o estoque) ou e cancelado. Nao tem prazo: pedido esquecido
// segura a peca ate alguem concluir ou cancelar (o atraso so destaca, B3).
//
// O que NAO reserva:
//   - item sem produto (avulso);
//   - peca personalizavel feita sob encomenda (mesma regra da loja, p-179:
//     is_personalizable e customization_config): ela nao sai da prateleira;
//   - pedido da loja online e de Personalizados (outra origem): esses ja
//     baixaram o estoque ou nao passam por ele.
//
// Multi-CNPJ / grupo: o produto compartilhado (is_group_shared) e UMA linha
// de estoque para o grupo inteiro. A reserva dele soma os pedidos de TODAS as
// lojas do grupo (matriz e filiais), e o produto da propria loja so tem
// pedidos dela. Os pedidos considerados sao sempre do grupo da loja que
// pergunta (utils/companyGroup.js): loja de outro dono nunca entra na conta.
//
// Nunca derruba quem pergunta: GET /products e o bipe seguem com reserva 0
// se a consulta falhar (base sem a migration 459, por exemplo).
// ============================================================
'use strict';

const { companyGroupWhere } = require('../utils/companyGroup');

const STATUS_QUE_RESERVAM = ['confirmed', 'preparing', 'ready'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Peca sob encomenda nao reserva (mesmo fragmento de catalogoPaginado.js).
const SOB_ENCOMENDA = `(p.is_personalizable IS TRUE AND p.customization_config IS NOT NULL)`;

/**
 * SQL das reservas por (produto, variante). Parametros: $1 empresa que
 * pergunta, $2 uuid[] dos produtos, $3 pedido a ignorar (ou NULL).
 */
const SQL_RESERVAS = `
  SELECT i.product_id, i.variant_id, SUM(i.quantity)::numeric AS qtd
    FROM digital_order_items i
    JOIN digital_orders o ON o.id = i.order_id
    JOIN products p       ON p.id = i.product_id
   WHERE i.product_id = ANY($2::uuid[])
     AND o.origem = 'balcao'
     AND o.status::text = ANY(ARRAY['${STATUS_QUE_RESERVAM.join("','")}'])
     AND o.stock_deducted IS NOT TRUE
     AND ($3::uuid IS NULL OR o.id <> $3::uuid)
     AND ${companyGroupWhere('$1', 'o.')}
     AND NOT ${SOB_ENCOMENDA}
   GROUP BY i.product_id, i.variant_id`;

/**
 * Reservas dos produtos pedidos. Devolve Map produto -> { total, porVariante: Map, semVariante }.
 * `q` e o pool ou o client da transacao. Lanca o erro do banco (quem chama decide).
 */
async function lerReservas(q, companyId, productIds, { ignorarPedido = null } = {}) {
  // So uuid: produto de mentira ou chave propria do Caixa nao tem reserva (e
  // nao custa uma ida ao banco).
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))].filter((id) => UUID_RE.test(id));
  const mapa = new Map();
  if (!ids.length) return mapa;
  const { rows } = await q.query(SQL_RESERVAS, [companyId, ids, ignorarPedido]);
  for (const r of rows || []) {
    const pid = String(r.product_id);
    const qtd = Number(r.qtd) || 0;
    if (!mapa.has(pid)) mapa.set(pid, { total: 0, semVariante: 0, porVariante: new Map() });
    const m = mapa.get(pid);
    m.total += qtd;
    if (r.variant_id) m.porVariante.set(String(r.variant_id), (m.porVariante.get(String(r.variant_id)) || 0) + qtd);
    else m.semVariante += qtd;
  }
  return mapa;
}

/** Igual a lerReservas, mas nunca lanca: falhou, todo mundo tem reserva 0. */
async function lerReservasSemFalhar(q, companyId, productIds, contexto = 'reserva') {
  try {
    return await lerReservas(q, companyId, productIds);
  } catch (e) {
    console.error(`[${contexto}] reserva do pedido indisponivel:`, e && e.message);
    return new Map();
  }
}

/** Reserva total do produto (todas as variantes). */
function reservadoDoProduto(mapa, productId) {
  const m = mapa && mapa.get(String(productId));
  return m ? m.total : 0;
}

/** Reserva da variante; sem variante = o que foi pedido sem variante. */
function reservadoDaVariante(mapa, productId, variantId) {
  const m = mapa && mapa.get(String(productId));
  if (!m) return 0;
  return variantId ? (m.porVariante.get(String(variantId)) || 0) : m.semVariante;
}

/** { <variant_id>: qtd } das variantes com reserva; {} quando nenhuma. */
function reservasPorVariante(mapa, productId) {
  const m = mapa && mapa.get(String(productId));
  return m ? Object.fromEntries(m.porVariante) : {};
}

module.exports = {
  STATUS_QUE_RESERVAM,
  SOB_ENCOMENDA,
  SQL_RESERVAS,
  lerReservas,
  lerReservasSemFalhar,
  reservadoDoProduto,
  reservadoDaVariante,
  reservasPorVariante,
};
