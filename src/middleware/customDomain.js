// ============================================================
// Custom Domain Middleware
// Mapeia o Host header para o slug da loja correspondente e
// reescreve req.url para /api/v1/storefront/:slug/...
//
// Fluxo:
//   www.davicalcados2.com.br/           → /api/v1/storefront/davi-calcados-villa-branca/page
//   www.davicalcados2.com.br/shipping-quote?cep=... → /api/v1/storefront/.../shipping-quote?cep=...
//   www.davicalcados2.com.br/order      → /api/v1/storefront/.../order
//
// Cache em memória com TTL de 5 minutos para evitar query a cada request.
// ============================================================
'use strict';

const db = require('../config/database');

// Hosts proprietários que nunca passam pelo lookup de custom domain
const OWNED_HOST_SUFFIXES = [
  'railway.app',
  'getaura.com.br',
  'localhost',
  '127.0.0.1',
];

// Cache: hostname → { slug | null, expiresAt }
const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function resolveSlugByDomain(hostname) {
  const hit = _cache.get(hostname);
  if (hit && hit.expiresAt > Date.now()) return hit.slug;

  let slug = null;
  try {
    const { rows } = await db.query(
      `SELECT slug FROM digital_channel_config
       WHERE custom_domain = $1 AND is_published = true AND custom_domain_status = 'active'
       LIMIT 1`,
      [hostname]
    );
    slug = rows.length ? rows[0].slug : null;
  } catch (err) {
    console.error('[customDomain] db lookup error:', err.message);
    // fail open — não bloqueia a requisição
  }

  _cache.set(hostname, { slug, expiresAt: Date.now() + CACHE_TTL_MS });
  return slug;
}

/** Invalida a entrada de cache para um hostname (chamar ao atualizar/remover custom_domain). */
function invalidateCustomDomainCache(hostname) {
  if (hostname) _cache.delete(hostname);
}

async function customDomainMiddleware(req, res, next) {
  try {
    const hostname = req.hostname; // trust proxy já configurado — valor correto

    // Ignora rotas da API, health checks e hosts proprietários
    if (
      !hostname ||
      req.url.startsWith('/api/') ||
      req.url.startsWith('/health') ||
      OWNED_HOST_SUFFIXES.some(s => hostname === s || hostname.endsWith('.' + s))
    ) {
      return next();
    }

    const slug = await resolveSlugByDomain(hostname);
    if (!slug) return next();

    // Reescreve URL preservando query string
    const qIdx  = req.url.indexOf('?');
    const path  = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
    const query = qIdx >= 0 ? req.url.slice(qIdx) : '';
    const cleanPath = path.replace(/\/+$/, '') || ''; // remove trailing slash

    if (cleanPath === '' || cleanPath === '/') {
      // Raiz → página HTML da vitrine
      req.url = `/api/v1/storefront/${slug}/page${query}`;
    } else {
      // Sub-rotas: /shipping-quote, /order, /order/:oid, etc.
      req.url = `/api/v1/storefront/${slug}${cleanPath}${query}`;
    }

    // CORS para requisições vindas do domínio customizado
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.sendStatus(204);

    next();
  } catch (err) {
    console.error('[customDomain] middleware error:', err.message);
    next(); // fail open
  }
}

module.exports = { customDomainMiddleware, invalidateCustomDomainCache };
