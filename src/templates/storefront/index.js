// AURA. -- storefront/index.js
// Monta o <script> SPA da vitrine publica concatenando os modulos parts/*.
// Mantem assinatura compativel com o antigo storefrontScript.js:
//   buildScript(storeData, escapedSlug, apiBase) -> string <script>...</script>
// apiBase e opcional (default ''); quando setado, fetches usam URL absoluta.
'use strict';

const prelude       = require('./parts/prelude');
const init          = require('./parts/init');
const stateUtils    = require('./parts/state_utils');
// O cartao de produto: uma funcao pra grade e pra home (fase 3).
const card          = require('./parts/card');
const products      = require('./parts/products');
const categorias    = require('./parts/categorias');
const tiraCategorias = require('./parts/tira_categorias');
// A home que nasce do estoque + cabecalho novo (fase 3 do redesign).
// Depois de categorias e tira: usa CATEGORIAS, filhasDe, irParaCategoria.
const home          = require('./parts/home');
const filtros       = require('./parts/filtros');
const cart          = require('./parts/cart');
const checkout      = require('./parts/checkout');
const pix           = require('./parts/pix');
const productDetail = require('./parts/product_detail');
const toast         = require('./parts/toast');
const bootstrap     = require('./parts/bootstrap');
// Regra da capa sem foto (iniciais + degrau do gradiente) — definida uma
// vez em storefrontCapa.js e serializada para o navegador.
const { fonteClienteIniciais } = require('../storefrontCapa');
// Parcelamento: mesma estrategia — a regra vive no servico e vai
// serializada, em vez de reescrita a mao no cliente.
const { fonteClienteParcelamento } = require('../../services/parcelamento');
// Cor: o mapa e a nomeacao moram no servico e vao serializados, porque o
// SERVIDOR tambem usa (pra agrupar as facetas). Duas copias divergiriam.
const { FONTE: fonteDasCores } = require('../../services/coresDaLoja');
// Faixas do filtro de preco: a regra mora no servico (testavel) e vai
// serializada, como parcelamento e cores.
const { FONTE: fonteDasFaixas } = require('../../services/faixasDePreco');

function buildScript(storeData, escapedSlug, apiBase) {
  return prelude(storeData, escapedSlug, apiBase)
       + init
       + stateUtils
       + fonteClienteIniciais()
       + fonteClienteParcelamento()
       + fonteDasCores
       + fonteDasFaixas
       + card
       + products
       + categorias
       + tiraCategorias
       + home
       + filtros
       + cart
       + checkout
       + pix
       + productDetail
       + toast
       + bootstrap;
}

module.exports = buildScript;
