require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { Sentry, initSentry } = require('./config/sentry');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Sentry (deve ser o primeiro middleware) ──────────────────
initSentry();
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

// ── Segurança e parsing ──────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check simples (Railway) ───────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── Health check com banco ───────────────────────────────────
app.get('/health/db', async (req, res) => {
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', message: err.message });
  }
});

// ── Rota raiz ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Aura. API',
    version: '1.0.0',
    status: 'online',
    docs: 'https://github.com/CaioAlexanderx/aura-backend',
  });
});

// ── Sentry error handler (antes do error handler global) ─────
app.use(Sentry.Handlers.errorHandler());

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Rota não encontrada' });
});

// ── Error handler global ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erro interno:', err.message);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// ── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Aura. API rodando na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health:   http://localhost:${PORT}/health\n`);
});

module.exports = app;
