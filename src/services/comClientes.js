// ============================================================
// AURA. — "Com clientes": pecas fora da loja em condicional (C2/C3, 25/11/2026)
//
// Irmao de reservaDoPedido.js. A peca da condicional saiu da loja com a
// cliente (a do pedido do balcao continua na prateleira, so separada). Por
// isso e um numero SEPARADO do reservado:
//
//   livres = estoque − com clientes − reservado   (nunca negativo)
//
// Calculado na hora, nunca gravado:
//
//   com_clientes(produto, variante) = quantidade de condicional_itens
//     com situacao 'com_cliente', ou 'ficou' ainda sem venda (sale_id NULL),
//     de condicionais com status 'aberta' (migration 467).
//
// Cada linha e uma peca (quantidade sempre 1), entao a soma e COUNT(*).
// Some sozinho quando a peca volta, vira venda ou a condicional e cancelada.
//
// Multi-CNPJ / grupo: igual a reserva. O produto compartilhado
// (is_group_shared) e uma linha de estoque so, na loja dona; a condicional de
// QUALQUER loja do grupo tira dele. As condicionais consideradas sao sempre
// do grupo da loja que pergunta (utils/companyGroup.js): loja de outro dono
// nunca entra na conta.
//
// Trava de lancamento: CONDICIONAL_LIBERADA (services/condicional.js). Com
// ela desligada, GET /products e o bipe nem consultam (resposta identica a de
// antes, sem os campos novos).
// ============================================================
'use strict';

const { companyGroupWhere } = require('../utils/companyGroup');
const { reservadoDoProduto, reservadoDaVariante, reservasPorVariante } = require('./reservaDoPedido');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A peca esta fora da loja (com a cliente ou "ficou" sem cobrar). Alias i. */
const PECA_FORA = `(i.situacao = 'com_cliente' OR (i.situacao = 'ficou' AND i.sale_id IS NULL))`;

/**
 * SQL das pecas com clientes por (produto, variante). Parametros: $1 empresa
 * que pergunta, $2 uuid[] dos produtos, $3 condicional a ignorar (ou NULL).
 */
const SQL_COM_CLIENTES = `
  SELECT i.product_id, i.variant_id, COUNT(*)::numeric AS qtd
    FROM condicional_itens i
    JOIN condicionais c ON c.id = i.condicional_id
   WHERE i.product_id = ANY($2::uuid[])
     AND c.status = 'aberta'
     AND ${PECA_FORA}
     AND ($3::uuid IS NULL OR c.id <> $3::uuid)
     AND ${companyGroupWhere('$1', 'c.')}
   GROUP BY i.product_id, i.variant_id`;

/**
 * Quem segura as pecas: as condicionais abertas do grupo com peca fora da
 * loja destes produtos (para o 409 dizer "esta com cliente na C-0031").
 * Parametros: $1 empresa que pergunta, $2 uuid[] dos produtos.
 */
const SQL_QUEM_SEGURA = `
  SELECT i.product_id, i.variant_id, c.id AS condicional_id, c.company_id, c.numero,
         c.customer_name, c.due_date::text AS due_date
    FROM condicional_itens i
    JOIN condicionais c ON c.id = i.condicional_id
   WHERE i.product_id = ANY($2::uuid[])
     AND c.status = 'aberta'
     AND ${PECA_FORA}
     AND ${companyGroupWhere('$1', 'c.')}
   ORDER BY c.due_date, c.numero`;

function soUuids(productIds) {
  return [...new Set((productIds || []).filter(Boolean).map(String))].filter((id) => UUID_RE.test(id));
}

/**
 * Pecas com clientes dos produtos pedidos. Mesmo formato da reserva:
 * Map produto -> { total, semVariante, porVariante: Map }.
 * `q` e o pool ou o client da transacao. Lanca o erro do banco.
 */
async function lerComClientes(q, companyId, productIds, { ignorarCondicional = null } = {}) {
  const ids = soUuids(productIds);
  const mapa = new Map();
  if (!ids.length) return mapa;
  const { rows } = await q.query(SQL_COM_CLIENTES, [companyId, ids, ignorarCondicional]);
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

/** Igual a lerComClientes, mas nunca lanca: falhou (base sem a 467), todo mundo tem 0. */
async function lerComClientesSemFalhar(q, companyId, productIds, contexto = 'com-clientes') {
  try {
    return await lerComClientes(q, companyId, productIds);
  } catch (e) {
    console.error(`[${contexto}] pecas com clientes indisponivel:`, e && e.message);
    return new Map();
  }
}

/** Condicionais que seguram pecas destes produtos (lista crua, ordenada pelo prazo). */
async function lerQuemSegura(q, companyId, productIds) {
  const ids = soUuids(productIds);
  if (!ids.length) return [];
  const { rows } = await q.query(SQL_QUEM_SEGURA, [companyId, ids]);
  return rows || [];
}

module.exports = {
  PECA_FORA,
  SQL_COM_CLIENTES,
  SQL_QUEM_SEGURA,
  lerComClientes,
  lerComClientesSemFalhar,
  lerQuemSegura,
  // Mesmo formato de mapa da reserva: os leitores sao os mesmos.
  comClientesDoProduto: reservadoDoProduto,
  comClientesDaVariante: reservadoDaVariante,
  comClientesPorVariante: reservasPorVariante,
};
