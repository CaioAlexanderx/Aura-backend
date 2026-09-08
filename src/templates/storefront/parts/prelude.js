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
// URL propria do produto (08/09/2026): a pagina aberta em /<slug>/p/<id>
// ja traz a peca no payload, mesmo que ela nao esteja na primeira pagina
// da grade. BASE_PATH e o endereco da loja sem o sufixo da peca — e o
// que a URL volta a ser quando a peca fecha.
var PRODUTO_INICIAL = __S.produto_inicial || null;
if (PRODUTO_INICIAL && PRODUTO_INICIAL.id) PROD_MAP[PRODUTO_INICIAL.id] = PRODUTO_INICIAL;
var BASE_PATH = (window.location.pathname || '/').replace(/\\/p\\/[^/]+\\/?$/, '') || '/';
// Quantos produtos a loja TEM (contarProdutosDaLoja) contra quantos couberam
// no payload. Base sem a contagem devolve 0 e a grade so nao mostra o aviso.
var CATALOGO_TOTAL = __S.catalog_total || 0;
// Tamanho da pagina, decidido no servidor (services/catalogoPaginado.js).
// O payload embutido E a pagina 1, entao os dois tem que concordar.
var POR_PAGINA = __S.payload_limit || 24;
var CARREGADOS     = PRODUCTS.length;
// Tira de categorias da home. JA resolvida no servidor (so o primeiro
// nivel, minimo de tres) — ver services/tiraDeCategorias.js. Vazia = a
// loja nao desenha. A regra NAO se repete aqui de proposito.
var TIRA_CATEGORIAS = __S.tira_de_categorias || [];
`;
};
