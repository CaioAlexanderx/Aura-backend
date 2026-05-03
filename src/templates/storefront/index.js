// AURA. -- storefront/index.js
// Monta o <script> SPA da vitrine publica concatenando os modulos parts/*.
// Mantem assinatura compativel com o antigo storefrontScript.js:
//   buildScript(storeData, escapedSlug) -> string <script>...</script>
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

function buildScript(storeData, escapedSlug) {
  return prelude(storeData, escapedSlug)
       + init
       + stateUtils
       + products
       + cart
       + checkout
       + pix
       + productDetail
       + toast
       + bootstrap;
}

module.exports = buildScript;
