// ============================================================
// Custom Domain Middleware
// Dois modos de roteamento por Host header:
//
// 1. loja.getaura.com.br/<slug> (URL padrão Aura — zero config por cliente)
//    loja.getaura.com.br/davi-calcados-villa-branca         → vitrine HTML
//    loja.getaura.com.br/davi-calcados-villa-branca/order   → cria pedido
//    loja.getaura.com.br/davi-calcados-villa-branca/shipping-quote → frete
//
// 2. Domínio próprio do cliente (custom_domain no digital_channel_config)
//    www.davicalcados2.com.br/           → vitrine HTML da loja configurada
//    www.davicalcados2.com.br/order      → cria pedido
//
// Cache em memória com TTL 5 min para o modo custom domain (evita DB por request).
// ============================================================
'use strict';

const db = require('../config/database');

// Host canônico da vitrine pública Aura
const LOJA_HOST = 'loja.getaura.com.br';

// Hosts proprietários que pulam o lookup de custom domain
const OWNED_HOST_SUFFIXES = [
  'railway.app',
  'getaura.com.br', // cobre *.getaura.com.br — LOJA_HOST é tratado antes
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

/**
 * O host que a pessoa digitou, e nao o que chegou na porta do Railway.
 *
 * O Railway roteia pelo cabecalho Host e devolve "Application not found"
 * para host que ele nao conhece — testado em 02/09/2026 com
 * `Host: www.davicalcados2.com.br` contra a origem. Cadastrar cada dominio
 * de cliente la seria um passo manual por loja.
 *
 * O caminho sem isso: a Cloudflare (for SaaS) recebe o dominio do cliente,
 * REESCREVE o Host para loja.getaura.com.br (que o Railway conhece) e guarda
 * o original em X-Aura-Host. Aqui a gente prefere esse cabecalho — mas so
 * quando a requisicao passou mesmo pela Cloudflare (cf-ray presente). Sem
 * ele, quem bate direto na origem com um X-Aura-Host inventado cai no
 * fluxo normal, como sempre foi.
 */
function hostOriginal(req) {
  const viaCloudflare = Boolean(req.headers['cf-ray']);
  const declarado = req.headers['x-aura-host'];
  if (viaCloudflare && typeof declarado === 'string' && declarado.trim()) {
    return declarado.trim().toLowerCase().replace(/:\d+$/, '');
  }
  return req.hostname; // trust proxy ja configurado
}

/** Invalida a entrada de cache para um hostname (chamar ao atualizar/remover custom_domain). */
function invalidateCustomDomainCache(hostname) {
  if (hostname) _cache.delete(hostname);
}

/** Reescreve req.url e seta CORS. Não chama next() — caller faz isso. */
function rewriteToStorefront(req, res, slug, subPath, query) {
  if (!subPath) {
    req.url = `/api/v1/storefront/${slug}/page${query}`;
  } else {
    req.url = `/api/v1/storefront/${slug}/${subPath}${query}`;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
}

async function customDomainMiddleware(req, res, next) {
  try {
    const hostname = hostOriginal(req);

    // Sempre ignora rotas internas da API e health checks
    if (!hostname || req.url.startsWith('/api/') || req.url.startsWith('/health')) {
      return next();
    }

    // ── Modo 1: loja.getaura.com.br/<slug>/... ──────────────────────────
    // Tratado ANTES do bloco owned hosts (que cobriria *.getaura.com.br).
    if (hostname === LOJA_HOST) {
      const qIdx    = req.url.indexOf('?');
      const path    = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
      const query   = qIdx >= 0 ? req.url.slice(qIdx) : '';
      const segments = path.split('/').filter(Boolean); // remove strings vazias

      // Raiz sem slug → deixa cair no handler normal (pode ser landing page futura)
      if (!segments.length) return next();

      const slug    = segments[0];
      const subPath = segments.slice(1).join('/');

      rewriteToStorefront(req, res, slug, subPath, query);
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      return next();
    }

    // ── Hosts proprietários — sem lookup ────────────────────────────────
    if (OWNED_HOST_SUFFIXES.some(s => hostname === s || hostname.endsWith('.' + s))) {
      return next();
    }

    // ── Modo 2: domínio próprio do cliente (lookup no DB) ───────────────
    const slug = await resolveSlugByDomain(hostname);
    if (!slug) return next();

    const qIdx     = req.url.indexOf('?');
    const path     = qIdx >= 0 ? req.url.slice(0, qIdx) : req.url;
    const query    = qIdx >= 0 ? req.url.slice(qIdx) : '';
    const cleanPath = path.replace(/\/+$/, '') || '';
    const subPath  = cleanPath === '' || cleanPath === '/' ? '' : cleanPath.slice(1); // remove leading /

    rewriteToStorefront(req, res, slug, subPath, query);
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();

  } catch (err) {
    console.error('[customDomain] middleware error:', err.message);
    next(); // fail open
  }
}

module.exports = { customDomainMiddleware, invalidateCustomDomainCache, hostOriginal };
