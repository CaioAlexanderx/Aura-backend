// AURA. -- storefront/parts/prelude.js
// Abre o <script>, injeta dados da loja e monta state inicial (vars + PROD_MAP).
// API_BASE: URL absoluta do backend. Necessario porque a vitrine pode ser servida
// num dominio diferente do backend (ex: loja.getaura.com.br via Cloudflare,
// backend em aura-backend-production-XXXX.up.railway.app). Sem isso, fetch
// relativo bate no proprio dominio da vitrine e da 404.
'use strict';

module.exports = function prelude(storeData, escapedSlug, apiBase) {
  return `<script>
var __S = ${storeData};
var SLUG = '${escapedSlug}';
var API_BASE = '${apiBase || ''}';
var PRODUCTS = __S.products || [];
var SETTINGS = __S.settings || {};
var CONTACT  = __S.contact  || {};
var SITE     = __S.site     || {};
var PROD_MAP = {};
PRODUCTS.forEach(function(p){ PROD_MAP[p.id] = p; });
// Quantos produtos a loja TEM (contarProdutosDaLoja) contra quantos couberam
// no payload. Base sem a contagem devolve 0 e a grade so nao mostra o aviso.
var CATALOGO_TOTAL = __S.catalog_total || 0;
var CARREGADOS     = PRODUCTS.length;
`;
};
