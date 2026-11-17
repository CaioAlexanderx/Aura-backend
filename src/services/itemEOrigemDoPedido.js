// ============================================================
// AURA. — Nome do item e origem do pedido na lista da Fila (p-177)
//
// GET /companies/:id/studio/orders ganha quatro campos por pedido, só
// somados (nada sai, nada muda de nome):
//
//   item_name      nome do item que o cartão mostra ("Caneca com nome").
//                  No Caixa, a peça personalizável vem primeiro; depois, o
//                  menor id. null quando o pedido não tem item legível.
//   item_quantity  quantidade desse item (número), ou null.
//   origin         'orcamento' | 'caixa' | 'loja_online' | 'lote' |
//                  'marketplace' | null
//   origin_label   'Orçamento' | 'Caixa' | 'Loja online' | 'Pedido em lote' |
//                  'Mercado Livre' | 'Shopee' | 'Marketplace' | null
//
// Origem:
//   source 'pdv'          -> Caixa
//   source 'digital'      -> Orçamento quando um studio_quotes aponta para o
//                            pedido (order_id); Pedido em lote quando veio de
//                            evento (studio_bulk_event_id); senão Loja online
//   source 'marketplace'  -> a plataforma
//
// Por que consultas à parte, e não subselects na query RICA da lista: a
// query rica cai inteira no fallback slim com qualquer erro (perdendo
// imagem, prazo e saldo do quadro do Studio). Aqui cada consulta tem o seu
// try/catch: se uma falhar, só os campos dela ficam null.
// Escopo por empresa em todas as consultas. Ids comparados como uuid (o
// tipo de sales.id, digital_orders.id e studio_quotes.order_id), para usar
// os indices; um id malformado so derruba a consulta dele (try/catch).
// ============================================================
'use strict';

const NULL_ITEM_E_ORIGEM = Object.freeze({
  item_name: null,
  item_quantity: null,
  origin: null,
  origin_label: null,
});

const ROTULOS = {
  orcamento: 'Orçamento',
  caixa: 'Caixa',
  loja_online: 'Loja online',
  lote: 'Pedido em lote',
};

const PLATAFORMAS = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
};

function quantidade(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Origem a partir da linha e do que as consultas acharam. Pura. */
function origemDoPedido(o, { doOrcamento = false, doLote = false } = {}) {
  if (!o) return { origin: null, origin_label: null };
  if (o.source === 'pdv') return { origin: 'caixa', origin_label: ROTULOS.caixa };
  if (o.source === 'digital') {
    const origin = doOrcamento ? 'orcamento' : (doLote ? 'lote' : 'loja_online');
    return { origin, origin_label: ROTULOS[origin] };
  }
  if (o.source === 'marketplace') {
    return { origin: 'marketplace', origin_label: PLATAFORMAS[o.marketplace_platform] || 'Marketplace' };
  }
  return { origin: null, origin_label: null };
}

async function tentar(rotulo, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[studio/orders][item-e-origem][${rotulo}]`, err.message);
    return [];
  }
}

/**
 * Soma item_name, item_quantity, origin e origin_label a cada pedido da
 * lista. Nunca lança: falha vira campo null.
 */
async function comItemEOrigem(db, companyId, orders) {
  if (!Array.isArray(orders) || !orders.length) return orders;

  const vendas = [...new Set(orders.filter((o) => o.source === 'pdv' && o.pdv_sale_id).map((o) => String(o.pdv_sale_id)))];
  const digitais = [...new Set(orders.filter((o) => o.source === 'digital' && o.digital_order_id).map((o) => String(o.digital_order_id)))];

  const [linhasVenda, linhasDigital, linhasOrcamento] = await Promise.all([
    vendas.length ? tentar('caixa', async () => (await db.query(
      `SELECT DISTINCT ON (si.sale_id)
              si.sale_id::text AS pedido,
              COALESCE(NULLIF(TRIM(si.product_name_snapshot), ''), p.name) AS item_name,
              si.quantity AS item_quantity
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         LEFT JOIN products p ON p.id = si.product_id
        WHERE s.company_id = $1
          AND s.id = ANY($2::uuid[])
        ORDER BY si.sale_id, (p.is_personalizable IS TRUE) DESC, si.id`,
      [companyId, vendas]
    )).rows) : [],
    digitais.length ? tentar('loja', async () => (await db.query(
      `SELECT d.id::text AS pedido,
              (d.studio_bulk_event_id IS NOT NULL) AS do_lote,
              it.item_name, it.item_quantity
         FROM digital_orders d
         LEFT JOIN LATERAL (
           SELECT COALESCE(NULLIF(TRIM(doi.product_name), ''), p.name) AS item_name,
                  doi.quantity AS item_quantity
             FROM digital_order_items doi
             LEFT JOIN products p ON p.id = doi.product_id
            WHERE doi.order_id = d.id
            ORDER BY doi.id
            LIMIT 1
         ) it ON TRUE
        WHERE d.company_id = $1
          AND d.id = ANY($2::uuid[])`,
      [companyId, digitais]
    )).rows) : [],
    digitais.length ? tentar('orcamento', async () => (await db.query(
      `SELECT DISTINCT q.order_id::text AS pedido
         FROM studio_quotes q
        WHERE q.company_id = $1
          AND q.order_id IS NOT NULL
          AND q.order_id = ANY($2::uuid[])`,
      [companyId, digitais]
    )).rows) : [],
  ]);

  const itemDaVenda = new Map(linhasVenda.map((r) => [String(r.pedido), r]));
  const itemDigital = new Map(linhasDigital.map((r) => [String(r.pedido), r]));
  const orcamentos = new Set(linhasOrcamento.map((r) => String(r.pedido)));

  return orders.map((o) => {
    let item = null;
    let doLote = false;
    let doOrcamento = false;
    if (o.source === 'pdv' && o.pdv_sale_id) {
      item = itemDaVenda.get(String(o.pdv_sale_id)) || null;
    } else if (o.source === 'digital' && o.digital_order_id) {
      const chave = String(o.digital_order_id);
      item = itemDigital.get(chave) || null;
      doLote = !!(item && item.do_lote === true);
      doOrcamento = orcamentos.has(chave);
    }
    return {
      ...o,
      item_name: item && item.item_name ? item.item_name : null,
      item_quantity: item ? quantidade(item.item_quantity) : null,
      ...origemDoPedido(o, { doOrcamento, doLote }),
    };
  });
}

module.exports = { comItemEOrigem, origemDoPedido, NULL_ITEM_E_ORIGEM };
