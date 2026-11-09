// ============================================================
// AURA. — Vendidos na promocao (p-92, 08/11/2026, migration 428)
//
// O item vendido passa a guardar se saiu na promocao De/Por:
//   sale_items.preco_lista  o "De" (preco normal) na hora da venda
//   sale_items.em_promocao  a promocao valia na hora da venda
//
// Regra (a mesma do preco efetivo, services/precoEfetivo.js, relogio do
// servidor): para cada item com produto, le price/price_override e os
// promo_* do produto (e da variante) e roda camposDoProduto /
// camposDaVariante com `agora`.
//   - promocao valendo: preco_lista = preco base (variante: price_override
//     ?? price do produto), em_promocao = true;
//   - produto conferido e sem promocao valendo: preco_lista NULL,
//     em_promocao = false;
//   - nao deu para conferir (item avulso sem produto, produto fora do
//     grupo, variante que nao e do produto, venda com data retroativa,
//     venda anterior a 428): os dois NULL. NULL = "nao sabemos".
//
// So GRAVA. Nunca muda unit_price, desconto nem total: o Caixa manda o
// preco (pdv.js confia no unit_price do app, contrato De/Por).
//
// Base sem as colunas (428 ainda nao aplicada, ou 427): a venda grava
// exatamente como antes. Quem decide e uma leitura de information_schema
// (nunca falha, nao aborta a transacao da venda), guardada no processo:
// presente = para sempre; ausente = confere de novo em 5 minutos (a
// migration roda com o processo antigo no ar).
// ============================================================
'use strict';

const { camposDoProduto, camposDaVariante } = require('./precoEfetivo');
const { productVisibilityWhere } = require('../utils/companyGroup');

const NOVA_TENTATIVA_MS = 5 * 60 * 1000;
let presentes = false;
let ausenteAte = 0;

// As 4 colunas que a gravacao usa: as 2 da 428 e o promo_price da 427.
const SQL_COLUNAS = `
  SELECT COUNT(*)::int AS n
    FROM information_schema.columns
   WHERE table_schema = ANY (current_schemas(false))
     AND ((table_name = 'sale_items' AND column_name IN ('preco_lista', 'em_promocao'))
       OR (table_name IN ('products', 'product_variants') AND column_name = 'promo_price'))`;

/** As colunas existem? `q(sql, params)` = client.query da transacao. */
async function colunasPresentes(q) {
  if (presentes) return true;
  if (Date.now() < ausenteAte) return false;
  let n = 0;
  try {
    const r = await q(SQL_COLUNAS, []);
    n = Number(r && r.rows && r.rows[0] && r.rows[0].n) || 0;
  } catch (_) {
    n = 0;
  }
  if (n >= 4) {
    presentes = true;
    return true;
  }
  ausenteAte = Date.now() + NOVA_TENTATIVA_MS;
  return false;
}

const NULO = Object.freeze({ preco_lista: null, em_promocao: null });

const numero = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Conta pura: o que gravar para um item, com as linhas ja lidas. */
function marcacaoDoItem(produto, variante, agora = new Date()) {
  if (!produto) return NULO;
  if (variante) {
    const c = camposDaVariante(variante, produto, agora);
    if (!c.em_promocao) return { preco_lista: null, em_promocao: false };
    const override = numero(variante.price_override);
    const base = override !== null ? override : numero(produto.price);
    return { preco_lista: base, em_promocao: true };
  }
  const c = camposDoProduto(produto, agora);
  if (!c.em_promocao) return { preco_lista: null, em_promocao: false };
  return { preco_lista: numero(produto.price), em_promocao: true };
}

/**
 * Marcacao de cada item da venda, na ordem de `itens`, ou null quando a
 * base nao tem as colunas (o INSERT segue o de sempre).
 *
 * itens: [{ product_id, variant_id }]. Quem pode ganhar marcacao: os
 * product_id de `visiveis` (Set que a venda ja validou para a empresa) ou,
 * com `companyId`, os produtos visiveis para ela (da loja ou compartilhados
 * no grupo, utils/companyGroup.js). Os outros ficam NULL. Duas leituras no
 * maximo (produtos e variantes da venda), na mesma transacao.
 */
async function marcarItens(q, itens, { visiveis, companyId, agora = new Date() } = {}) {
  if (!(await colunasPresentes(q))) return null;
  const lista = Array.isArray(itens) ? itens : [];
  const pids = [...new Set(lista
    .filter((i) => i && i.product_id && (!visiveis || visiveis.has(i.product_id)))
    .map((i) => String(i.product_id)))];
  if (!pids.length) return lista.map(() => NULO);

  const { rows: produtos } = await q(
    companyId
      ? `SELECT p.id, p.price, p.promo_price, p.promo_starts_at, p.promo_ends_at
           FROM products p WHERE p.id = ANY($1::uuid[]) AND ${productVisibilityWhere('$2', 'p.')}`
      : `SELECT id, price, promo_price, promo_starts_at, promo_ends_at
           FROM products WHERE id = ANY($1::uuid[])`,
    companyId ? [pids, companyId] : [pids]
  );
  const porProduto = new Map(produtos.map((p) => [String(p.id), p]));

  const vids = [...new Set(lista
    .filter((i) => i && i.variant_id && porProduto.has(String(i.product_id)))
    .map((i) => String(i.variant_id)))];
  const porVariante = new Map();
  if (vids.length) {
    const { rows: variantes } = await q(
      `SELECT id, product_id, price_override, promo_price, promo_starts_at, promo_ends_at
         FROM product_variants WHERE id = ANY($1::uuid[])`,
      [vids]
    );
    for (const v of variantes) porVariante.set(String(v.id), v);
  }

  return lista.map((i) => {
    if (!i || !i.product_id) return NULO;
    const produto = porProduto.get(String(i.product_id));
    if (!produto) return NULO;
    if (i.variant_id) {
      const v = porVariante.get(String(i.variant_id));
      // Variante que nao e deste produto: nao da para dizer.
      if (!v || String(v.product_id) !== String(i.product_id)) return NULO;
      return marcacaoDoItem(produto, v, agora);
    }
    return marcacaoDoItem(produto, null, agora);
  });
}

// ─── Resumo: GET /products/promotions/vendidos ─────────────────────
//
// So os itens com em_promocao = true. Venda cancelada fora; devolucao
// (type 'devolucao') fora; venda e troca contam (na troca, sale_items so
// tem os itens NOVOS, que sairam da loja).
//   itens_vendidos = soma da quantidade
//   faturamento    = soma do total da linha (sale_items.total_price: ja com
//                    o desconto do lapis do item; sem o cupom/desconto da
//                    venda inteira, que nao e por item)
//   desconto_dado  = soma de (preco_lista - unit_price) x quantidade, nunca
//                    negativo por linha (Caixa que mandou o preco normal na
//                    promocao conta o item, com desconto 0)
//   vendas         = vendas distintas com algum item na promocao
// Nenhum dado de cliente.

const FILTRO = `
       s.company_id = ANY($1::uuid[])
   AND s.created_at >= $2::timestamptz AND s.created_at <= $3::timestamptz
   AND COALESCE(s.status, 'completed') <> 'cancelled'
   AND COALESCE(s.type, 'sale') IN ('sale', 'troca')
   AND si.em_promocao = true
   AND ($4::uuid IS NULL OR si.product_id = $4::uuid)`;

const SOMAS = `
       COALESCE(SUM(si.quantity), 0) AS itens_vendidos,
       COALESCE(SUM(si.total_price), 0) AS faturamento,
       COALESCE(SUM(GREATEST(COALESCE(si.preco_lista, si.unit_price) - si.unit_price, 0) * si.quantity), 0) AS desconto_dado,
       COUNT(DISTINCT s.id)::int AS vendas`;

const MAX_ITENS = 500;

const dinheiro = (v) => Math.round((Number(v) || 0) * 100) / 100;
const qtd = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

function somas(r) {
  return {
    itens_vendidos: qtd(r && r.itens_vendidos),
    faturamento: dinheiro(r && r.faturamento),
    desconto_dado: dinheiro(r && r.desconto_dado),
    vendas: (r && Number(r.vendas)) || 0,
  };
}

function resumoVazio() {
  return { itens_vendidos: 0, faturamento: 0, desconto_dado: 0, vendas: 0 };
}

/**
 * q(sql, params). companyIds: lojas somadas (1 = a loja; varias = o
 * consolidado). desde/ate: Date. productId: opcional.
 * Devolve { resumo, items, por_loja }.
 */
async function resumoDosVendidos(q, { companyIds, desde, ate, productId = null }) {
  const params = [companyIds, desde.toISOString(), ate.toISOString(), productId];
  const { rows: tot } = await q(
    `SELECT ${SOMAS}
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE ${FILTRO}`,
    params
  );
  const resumo = somas(tot[0]);
  if (!resumo.vendas) return { resumo, items: [], por_loja: [] };

  const { rows: porItem } = await q(
    `SELECT si.product_id, si.variant_id,
            COALESCE(MAX(p.name), MAX(si.product_name_snapshot)) AS nome,
            (SELECT COALESCE(
                      (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
                         FROM product_variant_values pvv WHERE pvv.variant_id = pv.id),
                      pv.sku_suffix)
               FROM product_variants pv WHERE pv.id = si.variant_id) AS variant_label,
            ${SOMAS}
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
      WHERE ${FILTRO}
      GROUP BY si.product_id, si.variant_id
      ORDER BY faturamento DESC, nome, si.product_id, si.variant_id NULLS FIRST
      LIMIT ${MAX_ITENS}`,
    params
  );
  const items = porItem.map((r) => ({
    product_id: r.product_id,
    variant_id: r.variant_id || null,
    nome: r.nome || null,
    variant_label: r.variant_label || null,
    ...somas(r),
  }));

  let por_loja = [];
  if (companyIds.length > 1) {
    const { rows: lojas } = await q(
      `SELECT s.company_id, MAX(COALESCE(c.trade_name, c.legal_name)) AS nome, ${SOMAS}
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN companies c ON c.id = s.company_id
        WHERE ${FILTRO}
        GROUP BY s.company_id
        ORDER BY faturamento DESC, s.company_id`,
      params
    );
    por_loja = lojas.map((r) => ({ company_id: r.company_id, nome: r.nome || null, ...somas(r) }));
  }
  return { resumo, items, por_loja };
}

function _resetarParaTeste() { presentes = false; ausenteAte = 0; }

module.exports = {
  colunasPresentes, marcacaoDoItem, marcarItens, NULO,
  resumoDosVendidos, resumoVazio, MAX_ITENS,
  _resetarParaTeste,
};
