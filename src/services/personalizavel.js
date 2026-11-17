// ============================================================
// AURA — Produto personalizavel: validacao, cotacao e triagem da arte
//
// p-174 (loja unica 3.4a, 17/11/2026). As tres regras do item
// personalizado moravam na rota da vitrine Studio
// (routes/studioStorefront.js). A loja comum vai precisar das MESMAS
// regras quando aceitar produto personalizavel no pedido (p-184): copiar
// seria a quinta vez que as duas lojas divergem. Este modulo e o ponto
// unico. Nada aqui le banco, req ou res: quem chama traz os produtos
// (ja filtrados pela visibilidade da loja) e as faixas de quantidade.
//
// API
// ---
// validarPersonalizacao(config, customization) -> string | null
//     `config` e o products.customization_config; `customization` e o
//     objeto plano { [field.id]: valor } que o app manda. Devolve null
//     quando aceita, ou a mensagem da recusa (ex.: 'campo "Nome"
//     obrigatorio', 'informe a arte em "Foto" ou "Galeria"',
//     'customization obrigatoria'). Config nulo = produto sem
//     personalizacao: aceita. Alias: validateCustomizationValues.
//
// prepararPersonalizacao(customization, config) -> customization
//     Limpa as chaves laterais de ajuste da arte (<campo>_ajuste, _fonte,
//     _tam, _contorno) malformadas. Nunca recusa. E o que o pedido grava.
//     (services/ajusteDaArte.js, sanitizarAjustesDaArte.)
//
// cotarPersonalizados({ items, produtos, faixas })
//     -> { linhas, subtotal } | { erro, indice }
//     Valida e precifica os itens de um pedido ou de uma cotacao, na
//     ordem: produto existe, ativo, personalizavel, quantidade >= 1,
//     prepararPersonalizacao, validarPersonalizacao, preco da linha.
//     `items` = [{ product_id, quantity, customization }];
//     `produtos` = mapa id -> linha de products (price, is_active,
//     is_personalizable, customization_config, name...);
//     `faixas` = o retorno de carregarFaixas (services/precoDoStudio.js).
//     Cada linha: { indice, produto, quantidade, customization (ja
//     limpo, ou null), preco: { lista, base, opcoes, verso, meio, arte,
//     preco_unitario, total, faixa } }. `preco_unitario` nao inclui a
//     arte (ela e cobrada uma vez por linha); `total` inclui.
//     Recusa no PRIMEIRO item ruim, com a mesma mensagem que a vitrine
//     Studio sempre deu (ex.: 'Personalizacao de "Caneca": campo "Nome"
//     obrigatorio') e o `indice` dele em `items`.
//     Produto de prateleira (is_personalizable falso) e recusado: quem
//     tiver sacola mista separa os itens antes de chamar.
//
// statusInicialDaArte(config, customization) -> 'pendente' | null
//     O art_review_status do item recem-criado: 'pendente' quando a
//     cliente mandou arte propria (campo image/template preenchido), null
//     quando nao ha o que triar ou quando ela contratou a criacao
//     ("designer"). Chamar com o customization JA preparado. A regra e a
//     de services/artReview.js (initialArtStatus), que tambem guarda os
//     status e as transicoes da triagem.
//
// O que NAO esta aqui: a consulta dos produtos e das faixas (SQL de cada
// rota), o frete, o desconto do Pix e o total do pedido
// (services/precoDoStudio.js: totaisDoPedido, prazoDaSacola), e a
// gravacao do pedido.
//
// Quem usa hoje: POST /storefront/:slug/studio/order e
// POST /storefront/:slug/studio/cotacao. Testes de caracterizacao em
// __tests__/personalizavelCaracterizacao.test.js: se um deles quebrar, o
// comportamento da vitrine Studio mudou.
// ============================================================
'use strict';

const { cotarItens } = require('./precoDoStudio');
const { sanitizarAjustesDaArte } = require('./ajusteDaArte');
const { initialArtStatus } = require('./artReview');

// ─────────────────────────────────────────────
// Validacao de customization vs customization_config do produto
//
// 18/08/2026 — S0 (F1_CONTEUDO_STUDIO.md): a regra "todo campo required
// e exigido isoladamente" tornava a compra IMPOSSIVEL em loja publicada.
// A Sheid Mania marcou "Obrigatorio" em Texto, Foto do cliente, Template
// da galeria e Cor ao mesmo tempo. A intencao da lojista e legitima ("o
// cliente precisa me dizer o que estampar"), mas `image` e `template`
// preenchem o MESMO slot de arte — o proprio motor visual le
// `values.image || values.template` (compose3dMug.ts). Exigir os dois
// juntos e uma condicao que nenhum cliente consegue satisfazer.
//
// Duas correcoes, ambas espelhadas em useStorefront.ts (commitConfigure)
// no aura-app. As duas validacoes precisam concordar: divergencia entre
// elas faz o app aceitar o item no carrinho e o backend recusar o pedido
// no fechamento — o pior dos dois mundos pro cliente.
//
//   1. GRUPO DE ORIGEM DA ARTE: campos `image` e `template` do mesmo lado
//      formam um grupo. Se ao menos um for required, basta UM preenchido.
//      Com um unico campo do tipo no lado, o comportamento e identico ao
//      anterior — nao ha relaxamento onde a lojista pediu um campo so.
//      `art_service = 'designer'` ("crie minha arte pra mim") satisfaz o
//      grupo inteiro: quem contratou a criacao nao tem arte pra enviar.
//
//   2. LADO INATIVO: campo `side: 'back'` so e exigido quando o verso
//      esta ativo, replicando effectiveBackSelected do app. Antes, produto
//      com verso opcional e campo obrigatorio no verso era aceito pelo app
//      e recusado aqui.
// ─────────────────────────────────────────────
const ART_SOURCE_TYPES = new Set(['image', 'template']);

function isFilledValue(v) {
  return !(v == null || (typeof v === 'string' && !v.trim()));
}

// Mesma regra de effectiveBackSelected (aura-app): verso sem cobranca
// esta sempre ativo; com cobranca, depende da escolha do cliente.
function backIsActive(config, values) {
  if (!config || config.has_back !== true) return false;
  if (config.back_charge_enabled !== true) return true;
  return !!values && values.has_back_selected === true;
}

// Mesma regra do verso para a faixa central (caneca/copo).
function middleIsActive(config, values) {
  if (!config || config.has_middle !== true) return false;
  if (config.middle_charge_enabled !== true) return true;
  return !!values && values.has_middle_selected === true;
}

function fieldSideOf(f) {
  if (!f) return 'front';
  if (f.side === 'back') return 'back';
  if (f.side === 'middle') return 'middle';
  return 'front';
}

function validateCustomizationValues(config, values) {
  if (!config || typeof config !== 'object') return null; // produto nao personalizavel
  if (!values || typeof values !== 'object') {
    return 'customization obrigatoria';
  }
  if (!Array.isArray(config.fields)) return null;

  const backActive = backIsActive(config, values);
  const middleActive = middleIsActive(config, values);
  const ladoAtivo = (lado) =>
    lado === 'back' ? backActive : lado === 'middle' ? middleActive : true;
  const fields = config.fields.filter((f) => f && ladoAtivo(fieldSideOf(f)));

  // "Crie minha arte pra mim" dispensa o cliente de enviar arte.
  const artServiceHired = fields.some(
    (f) => f.config && f.config.is_art_service === true && values[f.id] === 'designer'
  );

  // Grupo de origem da arte, por lado.
  for (const side of ['front', 'back', 'middle']) {
    const group = fields.filter(
      (f) => ART_SOURCE_TYPES.has(f.type) && fieldSideOf(f) === side
    );
    if (!group.some((f) => f.required)) continue;
    if (artServiceHired) continue;
    if (group.some((f) => isFilledValue(values[f.id]))) continue;
    const labels = group.map((f) => `"${f.label || f.id}"`).join(' ou ');
    return `informe a arte em ${labels}`;
  }

  for (const f of fields) {
    if (ART_SOURCE_TYPES.has(f.type)) continue; // ja coberto pelo grupo
    if (f.required && !isFilledValue(values[f.id])) {
      return `campo "${f.label || f.id}" obrigatorio`;
    }
  }
  return null;
}

/** Ajustes da arte limpos (nunca recusa). Ver ajusteDaArte.js. */
function prepararPersonalizacao(customization, config) {
  return sanitizarAjustesDaArte(customization, config);
}

/**
 * Valida e precifica os itens personalizados. A conta e o laco sao os
 * de precoDoStudio.cotarItens; aqui so se fixa QUAL validacao e QUAL
 * limpeza entram, para nenhuma rota esquecer uma delas.
 */
function cotarPersonalizados({ items, produtos, faixas }) {
  return cotarItens({
    items, produtos, faixas,
    validar: validateCustomizationValues, sanear: prepararPersonalizacao,
  });
}

/** art_review_status inicial do item. Ver artReview.initialArtStatus. */
function statusInicialDaArte(config, customization) {
  return initialArtStatus(config, customization);
}

module.exports = {
  validarPersonalizacao: validateCustomizationValues,
  validateCustomizationValues,
  prepararPersonalizacao,
  cotarPersonalizados,
  statusInicialDaArte,
};
