// ============================================================
// AURA. — Os itens do pedido da loja online: as pecas e o preco de agora
// (p-124, 15/11/2026)
//
// Uma regra so para duas perguntas:
//   POST /storefront/:slug/order          — quanto o pedido COBRA;
//   POST /storefront/:slug/sacola/precos  — quanto a sacola deve MOSTRAR.
//
// A sacola guarda no navegador o preco da hora em que o item entrou (ate 7
// dias, parts/sacola.js). Promocao que encerrou ou preco que a lojista
// mudou no meio do caminho fazia o resumo do checkout mostrar um total e o
// Pix cobrar outro (QA da Black Friday). O servidor sempre esteve certo; a
// vitrine agora pergunta a ele, e ele responde com este modulo — o MESMO
// que o pedido usa. Nada de copia da regra de preco: o preco efetivo
// (De/Por, promocao da variante, price_override) e o de
// services/precoEfetivo.js, e as conferencias de produto, variante e
// estoque sao estas, com as mensagens de sempre.
// ============================================================
'use strict';

const db = require('../config/database');
const { listVisibilityWhere } = require('./storefrontBuilder');
const {
  colunasPromo, colunasPromoNulas, comColunasPromo, precoEfetivoDoProduto, precoEfetivoDaVariante,
} = require('./precoEfetivo');
// 14/11/2026: rotulo da variante com o nome da cor (CP2a da revisao de cores).
const { colunasDoRotulo, aplicarRotulo } = require('./nomeDaCor');

/**
 * As pecas citadas em `items`, da empresa `cid` e visiveis na vitrine:
 * { productMap, variantMap, productHasVariants }. As consultas sao as que o
 * pedido sempre fez (saidas da rota, sem mudar uma linha do SQL).
 */
async function carregarPecas(cid, items) {
  const productIds = items.map(i => i.product_id);
  // p-85 (08/11/2026, migration 427): o preco do pedido e o PRECO EFETIVO
  // (De/Por), pela regra unica de services/precoEfetivo.js — o mesmo que
  // a vitrine mostra. Base sem a 427: promo nulo, preco normal.
  const { rows: products } = await comColunasPromo((com) => db.query(
    `SELECT id, name, price, stock_qty, image_url, is_active,
            ${com ? colunasPromo() : colunasPromoNulas()}
     FROM products
     WHERE id::text = ANY($1) AND ${listVisibilityWhere('$2')}`,
    [productIds.map(String), cid]
  ));
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));

  const variantIds = items.map(i => i.variant_id).filter(Boolean);
  let variantMap = {};
  if (variantIds.length > 0) {
    const { rows: varRows } = await comColunasPromo((com) => db.query(`
      SELECT pv.id, pv.product_id, pv.price_override, pv.stock_qty, pv.is_active,
             ${com ? colunasPromo('pv') : colunasPromoNulas()},
             ''::text AS label, ${colunasDoRotulo('pv.id')}
      FROM product_variants pv
      WHERE pv.id = ANY($1::uuid[])
    `, [variantIds]));
    // 14/11/2026 (CP2a da revisao de cores): o item do pedido sai com o nome
    // da cor, o mesmo do Caixa e do cupom ("Vestido (Off White · M)"), e
    // nao com "Cor: #FAF9F6 / Tamanho: M". Variante sem atributo: sem rotulo.
    for (const v of varRows) {
      const temAtributo = Array.isArray(v._rotulo_attrs) && v._rotulo_attrs.length > 0;
      aplicarRotulo(v, 'label', ' · ');
      if (!temAtributo) v.label = '';
    }
    variantMap = Object.fromEntries(varRows.map(v => [v.id, v]));
  }

  const { rows: variantCountRows } = await db.query(`
    SELECT product_id, COUNT(*) AS cnt
    FROM product_variants
    WHERE product_id = ANY($1::uuid[]) AND is_active = true
    GROUP BY product_id
  `, [productIds]);
  const productHasVariants = Object.fromEntries(
    variantCountRows.map(r => [r.product_id, parseInt(r.cnt) > 0])
  );

  return { productMap, variantMap, productHasVariants };
}

/**
 * Um item da sacola contra as pecas de `carregarPecas`. Devolve
 *   { produto, variante|null, variantId|null, preco }            — vale;
 *   { erro, motivo, preco? }                                     — nao vale.
 * `erro` e a mensagem que o pedido sempre deu. `preco` vem tambem no erro de
 * estoque: a peca existe e tem preco, so falta quantidade (a sacola mostra o
 * preco certo e o pedido explica o estoque).
 */
function conferirItem(item, { productMap, variantMap, productHasVariants }, agora = new Date()) {
  const p = productMap[item.product_id];
  if (!p) return { erro: `Produto ${item.product_id} nao encontrado`, motivo: 'nao_encontrado' };
  if (p.is_active === false) return { erro: `Produto "${p.name}" nao esta disponivel`, motivo: 'indisponivel' };

  if (productHasVariants[p.id]) {
    const variantId = item.variant_id || null;
    if (!variantId) {
      return { erro: `Selecione uma variante para "${p.name}"`, motivo: 'variante' };
    }
    const variant = variantMap[variantId];
    if (!variant || variant.product_id !== p.id) {
      return { erro: `Variante invalida para "${p.name}"`, motivo: 'variante' };
    }
    if (variant.is_active === false) {
      return { erro: `Variante de "${p.name}" nao esta disponivel`, motivo: 'indisponivel' };
    }
    // Preco proprio da variante, a promocao dela, ou o efetivo do
    // produto (variante sem preco proprio segue o produto).
    const preco = precoEfetivoDaVariante(variant, p, agora);
    if (variant.stock_qty < item.quantity) {
      return {
        erro: `Estoque insuficiente para "${p.name}" (${variant.label}). Disponivel: ${variant.stock_qty}`,
        motivo: 'estoque', preco,
      };
    }
    return { produto: p, variante: variant, variantId, preco };
  }

  const preco = precoEfetivoDoProduto(p, agora);
  if (p.stock_qty < item.quantity) {
    return {
      erro: `Estoque insuficiente para "${p.name}". Disponivel: ${p.stock_qty}`,
      motivo: 'estoque', preco,
    };
  }
  return { produto: p, variante: null, variantId: null, preco };
}

/**
 * A resposta de POST /sacola/precos: um registro por item, na ordem do
 * pedido, com `indice`. `preco` nulo quando nao ha o que mostrar (peca que
 * saiu da loja, variante invalida, loja que esconde os precos).
 */
function precosDaSacola(items, pecas, { mostrarPrecos = true, agora = new Date() } = {}) {
  return items.map((item, indice) => {
    const r = conferirItem(item, pecas, agora);
    const base = { indice, product_id: item.product_id, variant_id: item.variant_id || null };
    const preco = mostrarPrecos && r.preco != null ? r.preco : null;
    if (r.erro) return { ...base, preco, disponivel: false, motivo: r.motivo };
    return { ...base, preco, disponivel: true };
  });
}

module.exports = { carregarPecas, conferirItem, precosDaSacola };
