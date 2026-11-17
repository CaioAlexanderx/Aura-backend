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
//
// p-184 (loja unica 3.4b, 17/11/2026): a peca PERSONALIZAVEL (is_personalizable
// com customization_config, services/personalizavel.ehPecaPersonalizada) nao
// passa por conferirItem: nao confere estoque nem variante, e o preco e o da
// cotacao do Studio (cotarPersonalizados: opcoes, verso, meio, arte e faixa
// de quantidade), nunca o da sacola. A peca de prateleira segue aqui como
// sempre.
// ============================================================
'use strict';

const db = require('../config/database');
const { listVisibilityWhere } = require('./storefrontBuilder');
const {
  colunasPromo, colunasPromoNulas, comColunasPromo, precoEfetivoDoProduto, precoEfetivoDaVariante,
} = require('./precoEfetivo');
// 14/11/2026: rotulo da variante com o nome da cor (CP2a da revisao de cores).
const { colunasDoRotulo, aplicarRotulo } = require('./nomeDaCor');
const { ehPecaPersonalizada, cotarPersonalizados, statusInicialDaArte } = require('./personalizavel');

/**
 * As pecas citadas em `items`, da empresa `cid` e visiveis na vitrine:
 * { productMap, variantMap, productHasVariants }. As consultas sao as que o
 * pedido sempre fez (saidas da rota). p-184: a de products traz tambem
 * is_personalizable e customization_config, para separar a peca
 * personalizada da de prateleira sem outra ida ao banco.
 */
async function carregarPecas(cid, items) {
  const productIds = items.map(i => i.product_id);
  // p-85 (08/11/2026, migration 427): o preco do pedido e o PRECO EFETIVO
  // (De/Por), pela regra unica de services/precoEfetivo.js — o mesmo que
  // a vitrine mostra. Base sem a 427: promo nulo, preco normal.
  const { rows: products } = await comColunasPromo((com) => db.query(
    `SELECT id, name, price, stock_qty, image_url, is_active,
            is_personalizable, customization_config,
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
function precosDaSacola(items, pecas, { mostrarPrecos = true, agora = new Date(), faixas = null } = {}) {
  return items.map((item, indice) => {
    if (ehPecaPersonalizada(pecas.productMap[item.product_id])) {
      return precoDoPersonalizado(item, indice, pecas, { mostrarPrecos, faixas });
    }
    const r = conferirItem(item, pecas, agora);
    const base = { indice, product_id: item.product_id, variant_id: item.variant_id || null };
    const preco = mostrarPrecos && r.preco != null ? r.preco : null;
    if (r.erro) return { ...base, preco, disponivel: false, motivo: r.motivo };
    return { ...base, preco, disponivel: true };
  });
}

// ─────────────────────────────────────────────
// p-184: a peca personalizada no pedido e na sacola
// ─────────────────────────────────────────────

/** Os indices, em `items`, dos itens de peca personalizada. */
function indicesPersonalizados(items, { productMap }) {
  const out = [];
  items.forEach((item, i) => {
    if (item && ehPecaPersonalizada(productMap[item.product_id])) out.push(i);
  });
  return out;
}

/**
 * Cota os itens personalizados do pedido (os de `indices`) pela regra do
 * Studio. Devolve { linhas: Map(indice -> linha de cotarPersonalizados),
 * lista: [linhas na ordem] } ou { erro } com a mensagem da vitrine Studio
 * (ex.: 'Personalizacao de "Caneca": campo "Nome" obrigatorio').
 */
function cotarPersonalizadosDoPedido(items, indices, pecas, faixas) {
  const cot = cotarPersonalizados({
    items: indices.map((i) => items[i]), produtos: pecas.productMap, faixas,
  });
  if (cot.erro) return { erro: cot.erro };
  return { linhas: new Map(indices.map((i, k) => [i, cot.linhas[k]])), lista: cot.linhas };
}

/**
 * A linha de cotarPersonalizados no formato do item do pedido da loja
 * comum. `unit_price` sem a arte (cobrada uma vez por linha): unit_price x
 * quantity + arte = subtotal, como na vitrine Studio. Sem variante (o
 * tamanho e a cor do personalizado vem no customization) e sem promocao
 * (o preco e o da cotacao). `_art_delta` nao e gravado: e o que o cartao
 * cobra como item proprio (precoDoStudio.itensParaCobranca).
 */
function itemPersonalizado({ produto: p, quantidade, customization, preco }) {
  return {
    product_id:        p.id,
    product_name:      p.name,
    product_image:     p.image_url,
    unit_price:        preco.preco_unitario,
    quantity:          quantidade,
    subtotal:          preco.total,
    variant_id:        null,
    preco_lista:       null,
    em_promocao:       false,
    personalizado:     true,
    customization:     customization || null,
    art_review_status: statusInicialDaArte(p.customization_config, customization),
    _art_delta:        preco.arte,
  };
}

/**
 * O registro de POST /sacola/precos para a peca personalizada: o preco
 * cotado com o customization do item (`preco` = unitario sem a arte,
 * `subtotal` = a linha inteira, com a arte), `personalizado: true`. Item
 * que nao passa na cotacao vem com disponivel=false e motivo
 * 'personalizacao' (o pedido da a mensagem). Nao confere estoque.
 */
function precoDoPersonalizado(item, indice, pecas, { mostrarPrecos, faixas }) {
  const base = { indice, product_id: item.product_id, variant_id: null, personalizado: true };
  const cot = cotarPersonalizados({ items: [item], produtos: pecas.productMap, faixas: faixas || {} });
  if (cot.erro) {
    const p = pecas.productMap[item.product_id];
    const motivo = p && p.is_active === false ? 'indisponivel' : 'personalizacao';
    return { ...base, preco: null, subtotal: null, disponivel: false, motivo };
  }
  const { preco } = cot.linhas[0];
  return {
    ...base,
    preco: mostrarPrecos ? preco.preco_unitario : null,
    subtotal: mostrarPrecos ? preco.total : null,
    disponivel: true,
  };
}

module.exports = {
  carregarPecas, conferirItem, precosDaSacola,
  indicesPersonalizados, cotarPersonalizadosDoPedido, itemPersonalizado,
};
