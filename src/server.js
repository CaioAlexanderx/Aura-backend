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
    // O endereco que a vitrine usa pra chamar a API. Se estiver errado,
    // as lojas abrem e nao vendem — e o log e onde isso aparece.
    const { enderecoDaApi, avisarSeNaoConfigurado } = require('./config/enderecoDaApi');
    console.log('   API:     ' + enderecoDaApi());
    avisarSeNaoConfigurado(console.warn);
    console.log('   Release: ' + (env.GIT_SHA || 'local'));
    console.log('   Health:  http://localhost:' + env.PORT + '/health\n');

    // Iniciar scheduler de relatórios
    const { initReportScheduler } = require('./jobs/reportScheduler');
    initReportScheduler();
    // Jobs de uma vez so (src/utils/jobRunner.js, arquivos em jobs/):
    // rodam em segundo plano e ficam registrados em jobs_run. Hoje: as
    // miniaturas do acervo de fotos (job 001).
    const { agendarJobs } = require('./utils/jobRunner');
    agendarJobs({ pool: require('./config/database') });
    // Aura Notas: refresh de status + retransmissão de contingência (S2.4/S3.1)
    const { initNfceRefreshJob } = require('./jobs/nfceRefreshJob');
    initNfceRefreshJob();
    const { initNfceContingencyJob } = require('./jobs/nfceContingencyJob');
    initNfceContingencyJob();

    // Track I: régua de lembrete de anuidade karatê (diário 9h BRT)
    const { initAnnuityReminderScheduler } = require('./jobs/annuityReminderScheduler');
    initAnnuityReminderScheduler();

    // Aviso interno de vencimento (T-2) da mensalidade da federação karatê → contato@getaura.com.br
    const { initKarateBillingDueScheduler } = require('./jobs/karateBillingDueScheduler');
    initKarateBillingDueScheduler();

    // F3c: régua de cobrança do dojô (dojô→aluno) — diário ~9h10 BRT
    const { initDojoReminderScheduler } = require('./jobs/dojoReminderScheduler');
    initDojoReminderScheduler();

    // ONDA 5b: dispatcher da fila WhatsApp (wa_outbox) — tick 30s,
    // kill switch WA_DISPATCH_ENABLED=false.
    const { initWaDispatcher } = require('./jobs/waDispatcherJob');
    initWaDispatcher();

    // AURINHA (312): dispatcher da fila Instagram (ig_outbox) — tick 15s,
    // kill switch IG_DISPATCH_ENABLED=false.
    const { initIgDispatcher } = require('./jobs/igDispatcherJob');
    initIgDispatcher();

    // Loja online (315): Pix vencido sem pagamento — tick 10min. É o único
    // evento do sino sem gancho de fluxo: ninguém "faz" um Pix expirar.
    const { initPixExpiradoJob } = require('./jobs/lojaPixExpiradoJob');
    initPixExpiradoJob();
  });
}

module.exports = { app, server, startServer };
