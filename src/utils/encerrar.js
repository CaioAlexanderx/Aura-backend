'use strict';
// ENCERRAMENTO GRACIOSO (SIGTERM/SIGINT) — t1-03, 14/10/2026.
//
// Por que existe: na troca de versão a Railway sobe a instância nova e só
// depois derruba a antiga. Enquanto as duas estão de pé, cada uma pode
// segurar até 15 conexões (max do pool em config/database.js, com 10 min de
// ociosidade) contra o pool do Supavisor em modo sessão. 19 de 20 rajadas
// de EMAXCONNSESSION entre 06 e 13/10 começaram numa troca de versão. Até
// aqui o processo antigo não tratava SIGTERM: era morto com as conexões
// abertas, sem devolvê-las ao Supavisor de forma ordenada, e sem esperar as
// requisições que estavam no meio.
//
// O que faz, nesta ordem:
//   1. para de aceitar conexões (server.close) e fecha as keep-alive
//      ociosas; para os timers dos jobs e derruba os WebSockets (que
//      prenderiam o server.close até o limite);
//   2. espera as requisições em andamento terminarem, até `timeoutMs`;
//      esgotado o tempo, corta as conexões que sobraram;
//   3. pool.end() (devolve as vagas do Supavisor), também com limite;
//   4. process.exit.
//
// Os timers dos jobs param logo no passo 1, e não depois da espera, para
// nenhum tick novo começar a usar o pool enquanto ele está sendo drenado.
// O tick que já estava rodando segue até o fim (ou até o pool.end).
//
// ATENÇÃO: a Railway manda SIGKILL "draining seconds" depois do SIGTERM, e
// o padrão é 0. Sem RAILWAY_DEPLOYMENT_DRAINING_SECONDS=20 na Railway (ou
// "Draining time" em Settings > Deploy), este código quase não tem tempo de
// rodar. timeoutMs (10 s) + limite do pool (5 s) cabem nos 20 s. Ver
// docs/deploy.md.
//
// Chamar duas vezes (SIGTERM e depois SIGINT, ou dois SIGTERM) não executa
// duas vezes: a segunda chamada devolve a mesma promessa.
const path = require('path');

const TIMEOUT_PADRAO_MS = 10000;
const TIMEOUT_POOL_PADRAO_MS = 5000;

let _emAndamento = null;

// Resolve com o resultado da promessa ou com `valorNoLimite` quando o tempo
// esgota. O timer é unref para não segurar o processo.
function comLimite(promessa, ms, valorNoLimite) {
  let timer;
  const limite = new Promise((resolve) => {
    timer = setTimeout(() => resolve(valorNoLimite), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([
    Promise.resolve(promessa).then((v) => { clearTimeout(timer); return v; }),
    limite,
  ]);
}

// Cada item de `jobs` pode ser uma função ou um objeto com stop()/close().
// Falha de um não impede os outros.
async function pararJobs(jobs, log) {
  for (const job of jobs || []) {
    try {
      if (typeof job === 'function') await job();
      else if (job && typeof job.stop === 'function') await job.stop();
      else if (job && typeof job.close === 'function') await job.close();
    } catch (e) {
      log.warn('[shutdown] falha ao parar job:', e && e.message);
    }
  }
}

function fecharServidor(server) {
  return new Promise((resolve) => {
    if (!server || typeof server.close !== 'function') return resolve('sem_servidor');
    server.close(() => resolve('fechado'));
    // Node >= 18.2: sem isto as conexões keep-alive ociosas seguram o
    // close até o cliente desistir.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  });
}

/**
 * Encerra o processo de forma graciosa. Ver o cabeçalho do arquivo.
 * @returns {Promise<{ forcado: boolean, pool: string }>}
 */
function encerrar({
  server,
  pool,
  jobs = [],
  timeoutMs = TIMEOUT_PADRAO_MS,
  timeoutPoolMs = TIMEOUT_POOL_PADRAO_MS,
  sinal = 'SIGTERM',
  log = console,
  sair = (codigo) => process.exit(codigo),
} = {}) {
  if (_emAndamento) {
    log.log(`[shutdown] ${sinal} recebido de novo — encerramento já em andamento`);
    return _emAndamento;
  }
  _emAndamento = (async () => {
    const inicio = Date.now();
    log.log(`[shutdown] ${sinal} recebido — parando de aceitar conexões (limite ${timeoutMs}ms)`);

    const fechou = fecharServidor(server);
    await pararJobs(jobs, log);

    const resultado = await comLimite(fechou, timeoutMs, 'limite');
    const forcado = resultado === 'limite';
    if (forcado) {
      log.warn(`[shutdown] requisições ainda abertas após ${timeoutMs}ms — cortando conexões`);
      if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
    } else {
      log.log(`[shutdown] requisições em andamento concluídas em ${Date.now() - inicio}ms`);
    }

    let estadoPool = 'sem_pool';
    if (pool && typeof pool.end === 'function') {
      estadoPool = await comLimite(
        Promise.resolve().then(() => pool.end()).then(() => 'fechado', (e) => {
          log.warn('[shutdown] pool.end falhou:', e && e.message);
          return 'erro';
        }),
        timeoutPoolMs,
        'limite',
      );
      log.log(`[shutdown] pool do banco: ${estadoPool}`);
    }

    log.log(`[shutdown] saindo após ${Date.now() - inicio}ms`);
    sair(0);
    return { forcado, pool: estadoPool };
  })();
  return _emAndamento;
}

// Os jobs de src/jobs/ seguem o padrão init*/stop*. Em vez de repetir aqui a
// lista de 25 jobs do server.js (e esquecer o próximo), chama todo stop*
// exportado pelos módulos de src/jobs/ que já foram carregados.
function stopsDosJobsCarregados(cache = require.cache, dirJobs = path.join(__dirname, '..', 'jobs')) {
  const prefixo = path.normalize(dirJobs) + path.sep;
  const stops = [];
  for (const arquivo of Object.keys(cache)) {
    if (!arquivo.startsWith(prefixo)) continue;
    const exp = cache[arquivo] && cache[arquivo].exports;
    if (!exp || typeof exp !== 'object') continue;
    for (const nome of Object.keys(exp)) {
      if (/^stop[A-Z]/.test(nome) && typeof exp[nome] === 'function') stops.push(exp[nome]);
    }
  }
  return stops;
}

// Só para testes.
function _resetForTests() { _emAndamento = null; }

module.exports = {
  encerrar, stopsDosJobsCarregados, comLimite, _resetForTests,
  TIMEOUT_PADRAO_MS, TIMEOUT_POOL_PADRAO_MS,
};
