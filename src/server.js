const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const { setupDentalWebSocket } = require('./services/dentalWs');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();
const server = http.createServer(app);

// ── Handlers globais de erro ────────────────────────────────
// Previnem que o processo morra silenciosamente em producao
// O erro e logado e o Railway/Sentry captura para diagnostico

process.on('unhandledRejection', function(reason, promise) {
  console.error('[UNHANDLED REJECTION] Promise:', promise);
  console.error('[UNHANDLED REJECTION] Reason:', reason);
  // Nao encerra o processo — Railway reiniciaria em loop
  // Se for erro critico, o Sentry captura via requestHandler
});

process.on('uncaughtException', function(err) {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
  // Encerra graciosamente e deixa Railway reiniciar
  // (uncaughtException geralmente deixa o processo em estado invalido)
  process.exit(1);
});

// ── WebSocket ───────────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/ws/sign',
  verifyClient: function(info) {
    return info.req.url.startsWith('/ws/sign/');
  },
});

setupDentalWebSocket(wss);
console.log('[WS] Configurado em /ws/sign/:token');

// ── Start ───────────────────────────────────────────────────
function startServer() {
  server.listen(env.PORT, '0.0.0.0', function() {
    console.log('\n Aura. API — porta ' + env.PORT);
    console.log('   Env:     ' + env.NODE_ENV);
    console.log('   Release: ' + (env.GIT_SHA || 'local'));
    console.log('   Health:  http://localhost:' + env.PORT + '/health\n');
  });
}

module.exports = { app, server, startServer };
