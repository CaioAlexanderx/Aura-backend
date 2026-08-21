// AURA. -- storefront/index.js
// Monta o <script> SPA da vitrine publica concatenando os modulos parts/*.
// Mantem assinatura compativel com o antigo storefrontScript.js:
//   buildScript(storeData, escapedSlug, apiBase) -> string <script>...</script>
// apiBase e opcional (default ''); quando setado, fetches usam URL absoluta.
'use strict';

const prelude       = require('./parts/prelude');
const init          = require('./parts/init');
const stateUtils    = require('./parts/state_utils');
const products      = require('./parts/products');
const cart          = require('./parts/cart');
const checkout      = require('./parts/checkout');
const pix           = require('./parts/pix');
const productDetail = require('./parts/product_detail');
const toast         = require('./parts/toast');
const bootstrap     = require('./parts/bootstrap');
// Regra das iniciais da capa sem foto — definida uma vez em
// storefrontIniciais.js e serializada para o navegador.
const { fonteClienteIniciais } = require('../storefrontIniciais');

function buildScript(storeData, escapedSlug, apiBase) {
  return prelude(storeData, escapedSlug, apiBase)
       + init
       + stateUtils
       + fonteClienteIniciais()
       + products
       + cart
       + checkout
       + pix
       + productDetail
       + toast
       + bootstrap;
}

module.exports = buildScript;
