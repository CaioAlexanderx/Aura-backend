require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { Sentry, initSentry } = require('./config/sentry');
const { sentryContext, sentryError } = require('./middleware/sentryContext');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();
const app = express();

// ── Sentry: requestHandler apenas (tracingHandler removido — causa unhandled rejection em prod)
initSentry();
app.use(Sentry.Handlers.requestHandler());

// ── Seguranca + parsing ─────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(sentryContext);

// ── Health checks (sem dependencias externas) ───────────────
app.get('/health', function(req, res) {
  res.json({
    status:    'ok',
    version:   env.GIT_SHA || '1.0.0',
    env:       env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/db', async function(req, res) {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', message: err.message });
  }
});

app.get('/health/sentry', function(req, res) {
  var secret = env.HEALTH_SECRET;
  if (!secret) {
    if (env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Configure HEALTH_SECRET no Railway para usar este endpoint em producao' });
    }
  } else {
    if (req.query.token !== secret) {
      return res.status(401).json({ error: 'Token invalido' });
    }
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

// ── Rotas da API ────────────────────────────────────────────
const apiRouter = require('./routes/index');
app.use('/api/v1', apiRouter);

// ── Error handlers ──────────────────────────────────────────
app.use(sentryError);
app.use(Sentry.Handlers.errorHandler());

app.use(function(req, res) {
  res.status(404).json({ error: 'Rota nao encontrada' });
});

app.use(function(err, req, res, next) {
  var status = err.statusCode || err.status || 500;
  if (status >= 500) console.error('[ERROR]', err.message);
  res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor' : err.message });
});

module.exports = app;
