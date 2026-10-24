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

    // E-mails (407, tq-74): todo sendMail grava uma linha em email_log.
    // Nunca derruba o envio nem o boot.
    try { require('./services/emailLog').ligarRegistroNoMailer(); }
    catch (e) { console.error('[emailLog] registro nao ligado:', e.message); }

    // Iniciar scheduler de relatórios
    const { initReportScheduler } = require('./jobs/reportScheduler');
    initReportScheduler();
    // Gestão Aura (370): health score, MRR do mês, blocos do painel e
    // alertas — diário a partir das 06h BRT, com trava por dia em
    // painel_runs. Kill switch PAINEL_DIARIO_ENABLED=false.
    const { initPainelDiarioScheduler } = require('./jobs/painelDiarioScheduler');
    initPainelDiarioScheduler();
    // Assento de temporada (374): expira os passes vencidos, aplica os que
    // começam e refaz o valor da assinatura — diário a partir da 01h BRT.
    // Kill switch SEAT_PASS_JOB_ENABLED=false.
    const { initSeatPassScheduler } = require('./jobs/seatPassScheduler');
    initSeatPassScheduler();
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

    // 25/09/2026: lembrete no sininho das contas a pagar que vencem em 2 dias
    // (todas as empresas) — diário a partir das 8h BRT.
    const { initExpenseDueReminderJob } = require('./jobs/expenseDueReminderJob');
    initExpenseDueReminderJob();

    // 13/10/2026: placar do dia no WhatsApp do dono — 21h BRT para a loja que
    // nao fecha caixa (quem fecha recebe no fechamento). Kill switch
    // PLACAR_DO_DIA_ENABLED=false.
    const { initPlacarDoDiaJob } = require('./jobs/placarDoDiaJob');
    initPlacarDoDiaJob();

    // F3c: régua de cobrança do dojô (dojô→aluno) — diário ~9h10 BRT
    const { initDojoReminderScheduler } = require('./jobs/dojoReminderScheduler');
    initDojoReminderScheduler();

    // ONDA 5b: dispatcher da fila WhatsApp (wa_outbox) — tick 30s,
    // kill switch WA_DISPATCH_ENABLED=false.
    const { initWaDispatcher } = require('./jobs/waDispatcherJob');
    initWaDispatcher();

    // FASE 6: régua do crediário pelo WhatsApp oficial — diário 9h BRT,
    // kill switch CREDIT_WA_AUTO_ENABLED=false. Quem despacha continua
    // sendo o waDispatcher; este job só enfileira.
    const { initCreditCollectionAutoJob } = require('./jobs/creditCollectionAutoJob');
    initCreditCollectionAutoJob();

    // Alarme diário (8h BRT): parcela aberta acima do saldo do crediário.
    // Só leitura e só fala quando acha — services/credit/integrity.js.
    const { initCreditIntegrityJob } = require('./jobs/creditIntegrityJob');
    initCreditIntegrityJob();

    // FASE 8: parabéns de aniversário pelo WhatsApp — diário 9h30 BRT
    // (meia hora DEPOIS da régua do crediário, para cobrança e parabéns
    // do mesmo cliente não saírem no mesmo minuto). Kill switch
    // BIRTHDAY_WA_AUTO_ENABLED=false.
    const { initBirthdayAutoJob } = require('./jobs/birthdayAutoJob');
    initBirthdayAutoJob();

    // FASE 7: reativação de clientes — SEMANAL, terça 10h BRT. Marketing
    // em volume derruba a qualidade do número; por isso semanal e com
    // teto pequeno. Kill switch REACTIVATION_WA_AUTO_ENABLED=false.
    const { initReactivationAutoJob } = require('./jobs/reactivationAutoJob');
    initReactivationAutoJob();

    // AURINHA (312): dispatcher da fila Instagram (ig_outbox) — tick 15s,
    // kill switch IG_DISPATCH_ENABLED=false.
    const { initIgDispatcher } = require('./jobs/igDispatcherJob');
    initIgDispatcher();

    // AURINHA DE PLANTAO (375): reavalia a cada 60s as conversas do WhatsApp
    // da Aura que esperam resposta (de dia, 15 min pelo humano). Dormente
    // sem AURA_COMPANY_ID; kill switch PLANTAO_ENABLED=false.
    const { initPlantaoJob } = require('./jobs/plantaoJob');
    initPlantaoJob();

    // RESUMO DA MADRUGADA (376): às 8h BRT manda por e-mail o que chegou no
    // WhatsApp da Aura entre 21h e 8h. Dormente sem AURA_COMPANY_ID; kill
    // switch RESUMO_MADRUGADA_ENABLED=false.
    const { initResumoDaMadrugadaJob } = require('./jobs/resumoDaMadrugadaJob');
    initResumoDaMadrugadaJob();

    // BIPE SINTETICO (378): a cada 5 min bipa, vende, consulta e cancela na
    // empresa de teste pelo caminho HTTP real e avisa por e-mail quando o
    // Caixa para (o /health fica verde nesses casos). Dormente sem
    // CANARY_COMPANY_ID/CANARY_USER_ID/CANARY_BARCODE; kill switch
    // CANARY_ENABLED=false.
    const { initCanaryJob } = require('./jobs/canaryJob');
    initCanaryJob();

    // Loja online (315): Pix vencido sem pagamento — tick 10min. É o único
    // evento do sino sem gancho de fluxo: ninguém "faz" um Pix expirar.
    const { initPixExpiradoJob } = require('./jobs/lojaPixExpiradoJob');
    initPixExpiradoJob();

    // Assinatura (326): cupom com desconto por varios meses — devolve o valor
    // cheio no Asaas e avisa o cliente antes da 1a mensalidade cheia. Tick 6h.
    const { initSubscriptionDiscountJob } = require('./jobs/subscriptionDiscountJob');
    initSubscriptionDiscountJob();

    // Otica (334): pos-venda de adaptacao (3 dias apos a entrega) e lembrete
    // de revisao da receita (30 dias antes de vencer) — diario 10h BRT,
    // depois do crediario (9h) e do aniversario (9h30). Kill switch
    // OTICA_WA_AUTO_ENABLED=false. Quem despacha e o waDispatcher.
    const { initOticaReminderJob } = require('./jobs/oticaReminderJob');
    initOticaReminderJob();

    // Matcon M1 (352): orcamento open com validade vencida vira expired —
    // diario 00h05 BRT e uma vez logo apos o boot. Sem mensagem. Kill
    // switch MATCON_QUOTE_EXPIRY_ENABLED=false.
    const { initMatconQuoteExpiryJob } = require('./jobs/matconQuoteExpiryJob');
    initMatconQuoteExpiryJob();

    // Studio (361): o vídeo do orçamento em vídeo 3D fica guardado 30 dias
    // (prorrogável). Diário 03h10 BRT e uma vez ~2 min após o boot. Kill
    // switch STUDIO_QUOTE_VIDEO_EXPIRY_ENABLED=false.
    const { initOrcamentoVideoExpiryJob } = require('./jobs/orcamentoVideoExpiryJob');
    initOrcamentoVideoExpiryJob();

    // Assinatura (367): lembrete de fatura agendado — banner com o Pix no
    // sininho do cliente no dia marcado e aviso para a Aura se a fatura
    // vencer sem pagamento. A cada 30 min, 8h–20h BRT.
    const { initLembreteDeFaturaJob } = require('./jobs/lembreteDeFaturaJob');
    initLembreteDeFaturaJob();

    // Régua de cobrança da assinatura (407/408; tq-77, 78, 84, 93):
    // lembrete 2 dias antes e no dia, atraso de 1/3/7/11/14 dias e aviso
    // interno no dia 3 — diário às 9h BRT, tick de 10 min. Kill switch
    // EMAILS_COBRANCA_ENABLED=false (ou EMAILS_CICLO_ENABLED=false).
    const { initReguaDeCobrancaJob } = require('./jobs/reguaDeCobrancaJob');
    initReguaDeCobrancaJob();

    // E-mails de relacionamento (407/410; tq-79, 81, 82): ciclo do teste
    // (4.2, 4.3, 4.4) às 10h BRT, "faz uns dias que você não aparece" e o
    // aviso de assinatura cancelada (estes dois atrás de flags desligadas).
    // Kill switch EMAILS_TESTE_ENABLED=false (ou EMAILS_CICLO_ENABLED=false).
    const { initRelacionamentoJob } = require('./jobs/relacionamentoJob');
    initRelacionamentoJob();

    // Indicação (14/10/2026): 1x por dia após 06h30 BRT cria o banner
    // "Indique um lojista" (ativo) para toda empresa de varejo em teste,
    // um por empresa (dedupe_key). Kill switch
    // BANNER_INDICACAO_TRIAL_ENABLED=false; ..._DRY_RUN=true só loga;
    // ..._PUBLICAR=false cria o banner inativo.
    const { initBannerIndicacaoTrialJob } = require('./jobs/bannerIndicacaoTrialJob');
    initBannerIndicacaoTrialJob();
  });

  instalarEncerramento();
}

// ── Encerramento gracioso (t1-03) ───────────────────────────
// SIGTERM (troca de versão na Railway) e SIGINT (Ctrl+C local): para de
// aceitar conexões, espera as requisições em andamento (até 10 s), para os
// jobs, derruba os WebSockets, devolve as conexões do pool (pool.end) e só
// então sai. Detalhes e o porquê em src/utils/encerrar.js.
// Nunca derruba o boot: se algo aqui falhar, o servidor segue sem o handler.
function instalarEncerramento() {
  try {
    const { encerrar, stopsDosJobsCarregados } = require('./utils/encerrar');
    const fecharWebSockets = function() {
      [wssDental, wssConsent].forEach(function(wss) {
        wss.clients.forEach(function(ws) { try { ws.terminate(); } catch (_) {} });
      });
    };
    ['SIGTERM', 'SIGINT'].forEach(function(sinal) {
      process.on(sinal, function() {
        encerrar({
          server,
          pool: require('./config/database'),
          jobs: stopsDosJobsCarregados().concat([fecharWebSockets]),
          timeoutMs: 10000,
          sinal,
        }).catch(function(e) {
          console.error('[shutdown] falha no encerramento:', e && e.message);
          process.exit(1);
        });
      });
    });
  } catch (e) {
    console.error('[shutdown] handler de encerramento nao instalado:', e.message);
  }
}

module.exports = { app, server, startServer };
