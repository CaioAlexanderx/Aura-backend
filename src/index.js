require('dotenv').config();

const http    = require('http');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { WebSocketServer } = require('ws');
const { Sentry, initSentry } = require('./config/sentry');
const { setupDentalWebSocket } = require('./services/dentalWs');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

initSentry();
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health checks ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
});

app.get('/health/db', async (req, res) => {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', message: err.message });
  }
});

// ── Rota raiz ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ name: 'Aura. API', version: '1.0.0', status: 'online' });
});

// ── Rotas da API ────────────────────────────────────────────
const apiRouter = require('./routes/index');
app.use('/api/v1', apiRouter);

// ── Sentry error handler ────────────────────────────────────
app.use(Sentry.Handlers.errorHandler());

// ── 404 ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ── Error handler global ──────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erro interno:', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ── WebSocket Server — Assinatura dental (BE-25-10) ───────────
const wss = new WebSocketServer({
  server,
  path: '/ws/sign',
  verifyClient: ({ req }) => req.url.startsWith('/ws/sign/'),
});

setupDentalWebSocket(wss);
console.log('WebSocket configurado em /ws/sign/:token');

// ── Start ───────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Aura. API rodando na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log(`   WS:       ws://localhost:${PORT}/ws/sign/:token\n`);
});

module.exports = { app, server };
