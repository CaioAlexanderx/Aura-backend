'use strict';
// E-mails de relacionamento (services/relacionamento.js e
// services/assinaturasAsaas.js; tq-79, tq-81, tq-82; migrations 407 e 410).
//
// Tick de 10 min, das 8h às 20h de Brasília:
//   - toda volta: aviso de assinatura cancelada (só com
//     EMAIL_ASSINATURA_CANCELADA_ENABLED; espera 2 h depois do evento);
//   - uma vez por dia, a partir das 10h (até as 18h): ciclo do teste (4.2,
//     4.3, 4.4) e "faz uns dias que você não aparece" (só com
//     EMAIL_SUMIU_ENABLED). Se o processo subir depois das 10h, roda na
//     primeira volta.
// A trava do dia é em memória; quem impede e-mail repetido (reinício, duas
// instâncias) é o email_log.
//
// Kill switches: EMAILS_CICLO_ENABLED=false desliga tudo; EMAILS_TESTE_ENABLED
// =false desliga o ciclo do teste.
const R = require('../services/relacionamento');
const A = require('../services/assinaturasAsaas');

const INTERVALO_MS = 10 * 60 * 1000;
const HORA_INICIO_BRT = 8;
const HORA_FIM_BRT = 20;
const HORA_DIARIA_BRT = 10;
const HORA_FIM_DIARIA_BRT = 18;

let _interval = null;
let _running = false;
let _ultimoDia = null;

function horaBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).getUTCHours();
}

function deveRodarODiario(now = Date.now(), ultimoDia = _ultimoDia) {
  const hora = horaBrt(now);
  return hora >= HORA_DIARIA_BRT && hora < HORA_FIM_DIARIA_BRT && ultimoDia !== R.hojeBrt(now);
}

function algoLigado(env = process.env) {
  return R.emailsDoTesteLigados(env) || R.sumiuLigado(env) || A.avisoDeCanceladaLigado(env);
}

function runOnce(now = Date.now()) {
  if (_running || !algoLigado()) return;
  const hora = horaBrt(now);
  if (hora < HORA_INICIO_BRT || hora >= HORA_FIM_BRT) return;
  _running = true;
  const db = require('../config/database');
  const { asaas } = require('../services/asaasClient');
  const diario = deveRodarODiario(now);
  if (diario) _ultimoDia = R.hojeBrt(now);

  (async () => {
    const c = await A.avisosDeCancelamento({ db, asaas });
    if (!c.desligado && Object.keys(c).length) console.log('[relacionamento] cancelada ' + JSON.stringify(c));
    if (diario) {
      const t = await R.voltaDoTeste({ db });
      console.log('[relacionamento] teste ' + JSON.stringify(t));
      const s = await R.voltaDoSumiu({ db });
      if (!s.desligado) console.log('[relacionamento] sumiu ' + JSON.stringify(s));
    }
  })()
    .catch((e) => console.error('[relacionamento] tick crash:', e.message))
    .finally(() => { _running = false; });
}

function initRelacionamentoJob() {
  if (_interval) return;
  _interval = setInterval(() => runOnce(), INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  const first = setTimeout(() => runOnce(), 6 * 60 * 1000);
  if (first.unref) first.unref();
  console.log('[relacionamento] iniciado — ciclo do teste às 10h BRT, aviso de cancelada a cada 10 min');
}

function stopRelacionamentoJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initRelacionamentoJob, stopRelacionamentoJob, deveRodarODiario, runOnce, INTERVALO_MS, HORA_DIARIA_BRT };
