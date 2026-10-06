// ============================================================
// AURA. — A API fora dos resultados de busca (06/10/2026)
//
// O Search Console mostrava api.getaura.com.br/ rastreado. A API nao e
// pagina para ninguem achar no Google: toda resposta dela sai com
// `X-Robots-Tag: noindex, nofollow`, e /robots.txt pede Disallow: /.
//
// ── A REGRA: SO NO HOST DA API, NUNCA NO DA VITRINE ────────────────────
// Este mesmo processo serve a vitrine do lojista — loja.getaura.com.br/
// <slug> e o dominio proprio dele (middleware/customDomain.js). Essa
// pagina TEM que continuar indexavel: e por ela que o cliente da loja
// acha a loja. Entao o header e o robots.txt valem para o host original
// (o que a pessoa digitou, `hostOriginal`) que:
//
//   · e nosso (api.getaura.com.br, *.railway.app, localhost...), e
//   · NAO e loja.getaura.com.br.
//
// Dominio de lojista (qualquer host que nao seja nosso) fica de fora sem
// precisar consultar o banco. Na vitrine, GET /robots.txt segue o fluxo
// de sempre.
//
// A copia da vitrine em api.getaura.com.br/api/v1/storefront/<slug>/page
// recebe o noindex de proposito: o endereco que vale e o da loja.
// ============================================================
'use strict';

const { hostOriginal } = require('./customDomain');

const LOJA_HOST = 'loja.getaura.com.br';

/** Os mesmos sufixos de host proprio de middleware/customDomain.js. */
const HOSTS_PROPRIOS = ['railway.app', 'getaura.com.br', 'localhost', '127.0.0.1'];

const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** O host pede noindex? Nosso e nao e o da vitrine. */
function hostForaDaBusca(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === LOJA_HOST) return false;
  return HOSTS_PROPRIOS.some((s) => h === s || h.endsWith('.' + s));
}

function foraDaBusca(req, res, next) {
  if (!hostForaDaBusca(hostOriginal(req))) return next();

  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/robots.txt') {
    res.type('text/plain; charset=utf-8');
    return res.send(ROBOTS_TXT);
  }
  return next();
}

module.exports = { foraDaBusca, hostForaDaBusca, ROBOTS_TXT };
