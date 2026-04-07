require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const { Sentry, initSentry } = require('./config/sentry');
const { sentryContext, sentryError } = require('./middleware/sentryContext');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();
const app = express();

// ── Sentry ────────────────────────────────────────────────────────
initSentry();
app.use(Sentry.Handlers.requestHandler());

// ── BE-REV-14: Security headers (Helmet + CSP) ─────────────
const allowedOrigins = env.ALLOWED_ORIGINS === '*'
  ? ['*']
  : env.ALLOWED_ORIGINS.split(',').map(o => o.trim());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
      connectSrc: ["'self'", ...allowedOrigins.filter(o => o !== '*')],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
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

// ── CORS ──────────────────────────────────────────────────────────
app.use(cors({
  origin: env.ALLOWED_ORIGINS === '*' ? '*' : allowedOrigins,
  credentials: true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge:         600,
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sentryContext);

// ── Rate limiting ────────────────────────────────────────────────

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
  message:   { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

app.use('/api/v1', globalLimiter);

// ── Health checks ────────────────────────────────────────────────
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

app.get('/', function(req, res) {
  res.json({ name: 'Aura. API', version: env.GIT_SHA || '1.0.0', status: 'online' });
});

// ── Rotas da API ─────────────────────────────────────────────────
const apiRouter = require('./routes/index');
apiRouter.use('/auth/login',           authLimiter);
apiRouter.use('/auth/register',        authLimiter);
apiRouter.use('/auth/forgot-password', authLimiter); // S1: rate limit password reset
apiRouter.use('/onboarding/cnpj-lookup', cnpjLimiter);
app.use('/api/v1', apiRouter);

// ── Error handlers ───────────────────────────────────────────────
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
