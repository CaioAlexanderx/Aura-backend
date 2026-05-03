// AURA. -- storefront/parts/prelude.js
// Abre o <script>, injeta dados da loja e monta state inicial (vars + PROD_MAP).
'use strict';

module.exports = function prelude(storeData, escapedSlug) {
  return `<script>
var __S = ${storeData};
var SLUG = '${escapedSlug}';
var PRODUCTS = __S.products || [];
var SETTINGS = __S.settings || {};
var CONTACT  = __S.contact  || {};
var SITE     = __S.site     || {};
var PROD_MAP = {};
PRODUCTS.forEach(function(p){ PROD_MAP[p.id] = p; });
`;
};
