const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const { setupDentalWebSocket } = require('./services/dentalWs');
const { validateRuntimeEnv } = require('./config/env');

const env = validateRuntimeEnv();

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/ws/sign',
  verifyClient: function(info) {
    return info.req.url.startsWith('/ws/sign/');
  },
});

setupDentalWebSocket(wss);
console.log('[WS] Configurado em /ws/sign/:token');

function startServer() {
  server.listen(env.PORT, '0.0.0.0', function() {
    console.log('\n Aura. API — porta ' + env.PORT);
    console.log('   Env:     ' + env.NODE_ENV);
    console.log('   Release: ' + (env.GIT_SHA || 'local'));
    console.log('   Health:  http://localhost:' + env.PORT + '/health\n');
  });
}

module.exports = { app, server, startServer };
