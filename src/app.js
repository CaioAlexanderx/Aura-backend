require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { Sentry, initSentry } = require('./config/sentry');
const { sentryContext, sentryError } = require('./middleware/sentryContext');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();
const app = express();

// ── Sentry ──────────────────────────────────────────────────
initSentry();
app.use(Sentry.Handlers.requestHandler());

// ── Segurança + parsing ─────────────────────────────────────
app.use(helmet());

// A-02: CORS — fallback '*' só em dev/test, nunca em produção
app.use(cors({
  origin: env.ALLOWED_ORIGINS === '*'
    ? '*'
    : env.ALLOWED_ORIGINS.split(',').map(o => o.trim()),
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key'],
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sentryContext);

// ── Rate limiting ────────────────────────────────────────────
// A-01: proteção contra brute force em auth e onboarding público

// Auth: 10 tentativas por IP a cada 15 minutos
const authLimiter = rateLimit({
  windowMs:  15 * 60 * 1000,
  max:       10,
  message:   { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

// CNPJ lookup público: 10 por hora por IP (já tem rate limit interno via Redis,
// mas esse garante proteção mesmo sem Redis)
const cnpjLimiter = rateLimit({
  windowMs:  60 * 60 * 1000,
  max:       20,
  message:   { error: 'Limite de consultas CNPJ atingido. Tente novamente em 1 hora.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

// API geral: 300 req/min por IP (proteção contra flood)
const globalLimiter = rateLimit({
  windowMs:  60 * 1000,
  max:       300,
  message:   { error: 'Muitas requisições. Tente novamente em 1 minuto.' },
  standardHeaders: true,
  legacyHeaders:   false,
  skip: (req) => env.NODE_ENV === 'test',
});

app.use('/api/v1', globalLimiter);

// ── Health checks ────────────────────────────────────────────
app.get('/health', function(req, res) {
  res.json({
    status:    'ok',
    version:   env.GIT_SHA || '1.0.0',
    env:       env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// A-04: /health/db não expõe mensagem de erro interna
app.get('/health/db', async function(req, res) {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    // Erro real vai para Sentry/logs — cliente recebe mensagem genérica
    console.error('[health/db]', err.message);
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
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

// ── Rotas da API ─────────────────────────────────────────────
const apiRouter = require('./routes/index');

// Rate limits específicos aplicados antes do roteador
apiRouter.use('/auth/login',    authLimiter);
apiRouter.use('/auth/register', authLimiter);
apiRouter.use('/onboarding/cnpj-lookup', cnpjLimiter);

app.use('/api/v1', apiRouter);

// ── Error handlers ───────────────────────────────────────────
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
