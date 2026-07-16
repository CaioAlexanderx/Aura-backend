require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const { Sentry, initSentry } = require('./config/sentry');
const { sentryContext, sentryError } = require('./middleware/sentryContext');
const { validateRuntimeEnv } = require('./config/env');
const { customDomainMiddleware } = require('./middleware/customDomain');

const env = validateRuntimeEnv();
const app = express();

// Railway/Cloudflare run behind a reverse proxy
app.set('trust proxy', 1);

// ── Sentry ─────────────────────────────────────────
initSentry();
app.use(Sentry.Handlers.requestHandler());

// ── Custom domain → storefront rewrite (antes do CORS e rotas) ─────────
// Mapeia Host headers de domínios customizados (ex: www.davicalcados2.com.br)
// para a rota interna /api/v1/storefront/:slug/page antes do roteamento normal.
app.use(customDomainMiddleware);

// ── BE-REV-14: Security headers (Helmet + CSP) ─────────
const allowedOrigins = env.ALLOWED_ORIGINS === '*'
  ? ['*']
  : env.ALLOWED_ORIGINS.split(',').map(o => o.trim());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", 'https://static.cloudflareinsights.com'],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'blob:', 'https://cdn.jsdelivr.net', 'https://r2.getaura.com.br', 'https://*.r2.dev'],
      connectSrc: ["'self'", 'https://cloudflareinsights.com', ...allowedOrigins.filter(o => o !== '*')],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
      mediaSrc:   ["'self'", 'blob:'],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  noSniff: true,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: false,
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  dnsPrefetchControl: { allow: false },
  ieNoOpen: true,
}));

app.disable('x-powered-by');

// ── CORS aberto pra storefront publico ─────────────────────
app.use('/api/v1/storefront', function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
  // Sem Allow-Credentials (incompativel com origin '*' e nao precisamos)
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── CORS aberto pra rotas publicas de relatorios (acessadas via token JWT) ──
// Mesmo padrao do storefront: link no email pode ser aberto em qualquer
// dominio/cliente, e nao precisamos de cookies (autenticacao por token na URL).
app.use('/api/v1/reports', function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── CORS aberto pra portal publico de karate (microsites {slug}.getaura.com.br) ──
// O portal publico roda em subdominios de federacao (ex.: fpkt.getaura.com.br) e
// so acessa rotas /public/karate (sem cookies; auth por Bearer quando ha). Mesmo
// padrao aberto do storefront/reports — libera qualquer origem nessas rotas.
app.use('/api/v1/public/karate', function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── CORS global (rotas autenticadas) ──────────────────────
app.use(cors({
  origin: env.ALLOWED_ORIGINS === '*' ? '*' : allowedOrigins,
  credentials: true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key', 'Idempotency-Key'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge:         600,
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sentryContext);

// ── Rate limiting ───────────────────────────────────

const authLimiter = rateLimit({
  windowMs:  15 * 60 * 1000,
  max:       10,
  message:   { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

const cnpjLimiter = rateLimit({
  windowMs:  60 * 60 * 1000,
  max:       20,
  message:   { error: 'Limite de consultas CNPJ atingido. Tente novamente em 1 hora.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

const globalLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       300,
  message:   { error: 'Muitas requisicoes. Tente novamente em 1 minuto.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

app.use('/api/v1', globalLimiter);

// ── Health checks ───────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status:    'ok',
    version:   env.GIT_SHA || '1.0.0',
    env:       env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()) + 's',
  });
});

app.get('/health/db', async function(req, res) {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    console.error('[health/db]', err.message);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.get('/health/full', async function(req, res) {
  const checks = { database: 'unknown', redis: 'unknown' };
  let healthy = true;

  try {
    const db = require('./config/database');
    const start = Date.now();
    await db.query('SELECT 1');
    checks.database = 'connected';
    checks.db_latency_ms = Date.now() - start;
  } catch (err) {
    checks.database = 'unavailable';
    checks.db_error = err.message;
    healthy = false;
  }

  try {
    const redis = require('./config/redis');
    const client = redis.default || redis;
    if (client && typeof client.ping === 'function') {
      const start = Date.now();
      await client.ping();
      checks.redis = 'connected';
      checks.redis_latency_ms = Date.now() - start;
    } else {
      checks.redis = 'not_configured';
    }
  } catch (err) {
    checks.redis = 'unavailable';
    checks.redis_error = err.message;
  }

  const status = healthy ? 200 : 503;
  res.status(status).json({
    status: healthy ? 'ok' : 'degraded',
    version: env.GIT_SHA || '1.0.0',
    env: env.NODE_ENV,
    uptime: Math.floor(process.uptime()) + 's',
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/sentry', function(req, res) {
  const secret = env.HEALTH_SECRET;
  if (!secret) {
    if (env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Configure HEALTH_SECRET no Railway' });
    }
  } else if (req.query.token !== secret) {
    return res.status(401).json({ error: 'Token invalido' });
  }
  try { Sentry.captureMessage('Aura Sentry health check OK', 'info'); } catch (_) {}
  res.json({
    status:      'ok',
    sentry_dsn:  env.SENTRY_DSN ? 'configurado' : 'ausente',
    environment: env.NODE_ENV,
    release:     env.GIT_SHA || 'local',
  });
});

app.get('/health/r2', async function(req, res) {
  const checks = {
    env_account_id: !!process.env.R2_ACCOUNT_ID,
    env_access_key: !!process.env.R2_ACCESS_KEY_ID,
    env_secret_key: !!process.env.R2_SECRET_ACCESS_KEY,
    env_bucket: process.env.R2_BUCKET_NAME || 'aura-storage (default)',
    env_public_url: process.env.R2_PUBLIC_URL || '(not set — using default)',
  };

  if (process.env.R2_ACCOUNT_ID) {
    const aid = process.env.R2_ACCOUNT_ID;
    checks.account_id_suffix = '...' + aid.slice(-6);
  }
  if (process.env.R2_ACCESS_KEY_ID) {
    const akid = process.env.R2_ACCESS_KEY_ID;
    checks.access_key_suffix = '...' + akid.slice(-4);
  }

  if (!checks.env_account_id || !checks.env_access_key || !checks.env_secret_key) {
    return res.status(503).json({
      status: 'not_configured',
      message: 'Faltam env vars R2_ACCOUNT_ID, R2_ACCESS_KEY_ID ou R2_SECRET_ACCESS_KEY',
      checks,
    });
    }

  const r2 = require('./utils/r2Storage');
  const testKey = '_healthcheck/' + Date.now() + '.txt';
  const testContent = Buffer.from('aura-r2-healthcheck-' + new Date().toISOString());

  try {
    const up = await r2.uploadToR2(testKey, testContent, 'text/plain');
    if (!up.success) {
      return res.status(503).json({
        status: 'upload_failed',
        message: 'S3 client conectou mas upload falhou',
        error: up.error,
        checks,
      });
    }
    checks.test_upload = 'ok';
    checks.test_key = up.key;
    checks.test_public_url = up.url;
  } catch (err) {
    return res.status(503).json({
      status: 'upload_exception',
      message: 'Excecao no upload — verifique credenciais e bucket',
      error: err.message,
      checks,
    });
  }

  try {
    const signed = await r2.getSignedUrl(testKey, 60);
    checks.test_signed_url = signed.startsWith('https://') ? 'ok' : 'fallback_to_public';
  } catch (err) {
    checks.test_signed_url = 'error: ' + err.message;
  }

  try {
    const del = await r2.deleteFromR2(testKey);
    checks.test_delete = del.success ? 'ok' : ('error: ' + del.error);
  } catch (err) {
    checks.test_delete = 'exception: ' + err.message;
  }

  res.json({
    status: 'ok',
    message: 'R2 configurado e funcional (upload + delete testados)',
    bucket: checks.env_bucket,
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', function(req, res) {
  res.json({ name: 'Aura. API', version: env.GIT_SHA || '1.0.0', status: 'online' });
});

// ── Rotas da API ────────────────────────────────────
const apiRouter = require('./routes/index');
apiRouter.use('/auth/login',           authLimiter);
apiRouter.use('/auth/register',        authLimiter);
apiRouter.use('/auth/forgot-password', authLimiter);
apiRouter.use('/onboarding/cnpj-lookup', cnpjLimiter);
app.use('/api/v1', apiRouter);

// ── Error handlers ──────────────────────────────────
app.use(sentryError);
app.use(Sentry.Handlers.errorHandler());

app.use(function(req, res) {
  res.status(404).json({ error: 'Rota nao encontrada' });
});

app.use(function(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) console.error('[ERROR]', err.message);
  res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor' : err.message });
});

module.exports = app;
