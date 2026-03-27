// Nao chama startServer() quando importado por testes (require.main !== module)
const { startServer, app, server } = require('./server');

if (require.main === module) {
  startServer();
}

module.exports = { app, server };
