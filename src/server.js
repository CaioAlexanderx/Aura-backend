const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const { setupDentalWebSocket } = require('./services/dentalWs');
const { setupConsentWebSocket } = require('./services/dentalConsentWs');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();
const server = http.createServer(app);

// ── Handlers globais de erro ────────────────────────────────
// Previnem que o processo morra silenciosamente em producao
// O erro e logado e o Railway/Sentry captura para diagnostico

process.on('unhandledRejection', function(reason, promise) {
  console.error('[UNHANDLED REJECTION] Promise:', promise);
  console.error('[UNHANDLED REJECTION] Reason:', reason);
});

process.on('uncaughtException', function(err) {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
  process.exit(1);
});

// ── WebSocket: roteamento por path ──────────────────────────
// upgrade tem que rotear pra wss diferente conforme o path.
// /ws/sign/:token    -> dentalWs.js     (W1-04, appointment signing)
// /ws/consent/:token -> dentalConsentWs.js (W2-04, TCLE signing)

const wssDental = new WebSocketServer({ noServer: true });
const wssConsent = new WebSocketServer({ noServer: true });

setupDentalWebSocket(wssDental);
setupConsentWebSocket(wssConsent);

server.on('upgrade', function(request, socket, head) {
  const url = request.url || '';
  if (url.startsWith('/ws/sign/')) {
    wssDental.handleUpgrade(request, socket, head, function(ws) {
      wssDental.emit('connection', ws, request);
    });
  } else if (url.startsWith('/ws/consent/')) {
    wssConsent.handleUpgrade(request, socket, head, function(ws) {
      wssConsent.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

console.log('[WS] Configurado em /ws/sign/:token (appointments) e /ws/consent/:token (TCLE)');

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
