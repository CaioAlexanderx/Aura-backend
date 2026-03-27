require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { Sentry, initSentry } = require('./config/sentry');
const { sentryContext, sentryError } = require('./middleware/sentryContext');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();

const app = express();

initSentry();
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

app.use(helmet());
app.use(cors({
  origin: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(sentryContext);

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    version: env.GIT_SHA || '1.0.0',
    env: env.NODE_ENV,
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
      return res.status(403).json({
        error: 'Configure HEALTH_SECRET no Railway para usar este endpoint em producao',
      });
    }
  } else {
    if (req.query.token !== secret) {
      return res.status(401).json({ error: 'Token invalido' });
    }
  }

  var sentryActive = !!env.SENTRY_DSN;
  Sentry.captureMessage('Aura Sentry health check OK', 'info');

  res.json({
    status: 'ok',
    sentry_dsn: sentryActive ? 'configurado' : 'ausente — eventos nao serao enviados',
    environment: env.NODE_ENV,
    release: env.GIT_SHA || 'local',
    message: sentryActive
      ? 'Evento de teste enviado. Verifique em sentry.io em ~30s.'
      : 'SENTRY_DSN nao configurado. Adicione a variavel no Railway.',
  });
});

app.get('/', function(req, res) {
  res.json({
    name: 'Aura. API',
    version: env.GIT_SHA || '1.0.0',
    status: 'online',
    docs: 'https://getaura.com.br/docs',
  });
});

const apiRouter = require('./routes/index');
app.use('/api/v1', apiRouter);

app.use(sentryError);
app.use(Sentry.Handlers.errorHandler());

app.use(function(req, res) {
  res.status(404).json({ error: 'Rota nao encontrada' });
});

app.use(function(err, req, res, next) {
  const status = err.statusCode || err.status || err.statusCode || 500;
  const isServerError = status >= 500;

  if (isServerError) {
    console.error('[ERROR]', err.message);
  }

  const payload = {
    error: isServerError ? 'Erro interno do servidor' : err.message,
  };

  if (err.details && !isServerError) {
    payload.details = err.details;
  }

  res.status(status).json(payload);
});
