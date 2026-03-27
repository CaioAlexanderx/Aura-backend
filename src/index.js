require('dotenv').config();

const http    = require('http');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { WebSocketServer } = require('ws');
const { Sentry, initSentry } = require('./config/sentry');
const { sentryContext, sentryError } = require('./middleware/sentryContext');
const { setupDentalWebSocket } = require('./services/dentalWs');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// -- Sentry: deve ser o primeiro middleware ------------------
initSentry();
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

// -- Seguranca + parsing ------------------------------------
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Idempotency-Key'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// -- Contexto Sentry por request ----------------------------
app.use(sentryContext);

// -- Health checks ------------------------------------------
app.get('/health', function(req, res) {
  res.json({
    status:    'ok',
    version:   process.env.GIT_SHA || '1.0.0',
    env:       process.env.NODE_ENV || 'development',
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

// health/sentry: dispara evento de teste (bloqueado em producao)
app.get('/health/sentry', function(req, res) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Indisponivel em producao' });
  }
  Sentry.captureMessage('Aura Sentry health check OK', 'info');
  res.json({ status: 'ok', message: 'Evento de teste enviado ao Sentry' });
});

// -- Rota raiz ----------------------------------------------
app.get('/', function(req, res) {
  res.json({
    name:    'Aura. API',
    version: process.env.GIT_SHA || '1.0.0',
    status:  'online',
    docs:    'https://getaura.com.br/docs',
  });
});

// -- Rotas da API -------------------------------------------
const apiRouter = require('./routes/index');
app.use('/api/v1', apiRouter);

// -- Error handlers (ordem importa) -------------------------
app.use(sentryError);                    // captura 5xx com contexto
app.use(Sentry.Handlers.errorHandler()); // handler nativo do Sentry

// 404
app.use(function(req, res) {
  res.status(404).json({ error: 'Rota nao encontrada' });
});

// Handler global de erros
app.use(function(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const msg    = status >= 500 ? 'Erro interno do servidor' : err.message;
  if (status >= 500) console.error('[ERROR]', err.message);
  res.status(status).json({ error: msg });
});

// -- WebSocket: Assinatura dental (BE-25-10) ----------------
const wss = new WebSocketServer({
  server,
  path: '/ws/sign',
  verifyClient: function(info) { return info.req.url.startsWith('/ws/sign/'); },
});
setupDentalWebSocket(wss);
console.log('[WS] Configurado em /ws/sign/:token');

// -- Start --------------------------------------------------
server.listen(PORT, '0.0.0.0', function() {
  console.log('\n Aura. API — porta ' + PORT);
  console.log('   Env:     ' + (process.env.NODE_ENV || 'development'));
  console.log('   Release: ' + (process.env.GIT_SHA || 'local'));
  console.log('   Health:  http://localhost:' + PORT + '/health\n');
});

module.exports = { app, server };
