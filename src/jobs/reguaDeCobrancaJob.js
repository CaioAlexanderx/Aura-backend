'use strict';
// Régua de cobrança da assinatura Aura (services/reguaDeCobranca.js,
// migrations 407 e 408; tq-77, tq-78, tq-84, tq-93).
//
// Tick de 10 min. A volta diária (varredura das pendentes, lembretes e
// atraso) roda uma vez por dia a partir das 9h de Brasília, até as 20h — se
// o processo subir depois das 9h, roda na primeira volta. A trava do dia é
// em memória; quem impede e-mail repetido (reinício, duas instâncias) é o
// email_log. A nova tentativa no cartão (só com
// ASAAS_RETENTATIVA_CARTAO_ENABLED) roda em toda volta, 8h–20h.
//
// Kill switch: EMAILS_COBRANCA_ENABLED=false ou EMAILS_CICLO_ENABLED=false.
const { tickDiarioDaRegua, tickRetentativas } = require('../services/reguaDeCobranca');
const { hojeBrt, horaBrt, emailsDeCobrancaLigados } = require('../services/cobrancaAssinatura');

const INTERVALO_MS = 10 * 60 * 1000;
const HORA_DIARIA_BRT = 9;
const HORA_FIM_BRT = 20;
const HORA_INICIO_RETENTATIVA_BRT = 8;

let _interval = null;
let _running = false;
let _ultimoDia = null;

function deveRodarODiario(now = Date.now(), ultimoDia = _ultimoDia) {
  const hora = horaBrt(now);
  return hora >= HORA_DIARIA_BRT && hora < HORA_FIM_BRT && ultimoDia !== hojeBrt(now);
}

function runOnce(now = Date.now()) {
  if (_running || !emailsDeCobrancaLigados()) return;
  const hora = horaBrt(now);
  if (hora < HORA_INICIO_RETENTATIVA_BRT || hora >= HORA_FIM_BRT) return;
  _running = true;
  const db = require('../config/database');
  const { asaas } = require('../services/asaasClient');
  const notifications = require('../services/appNotifications');
  const diario = deveRodarODiario(now);
  if (diario) _ultimoDia = hojeBrt(now);

  (async () => {
    if (diario) {
      const s = await tickDiarioDaRegua({ db, asaas, notifications });
      console.log('[reguaCobranca] diario ' + JSON.stringify(s));
    }
    const r = await tickRetentativas({ db, asaas });
    if (r.retentativas || r.emails || r.falhas) console.log('[reguaCobranca] cartao ' + JSON.stringify(r));
  })()
    .catch((e) => {
      // 42P01: migrations 407/408 ainda não aplicadas — nada a fazer.
      if (e.code !== '42P01') console.error('[reguaCobranca] tick crash:', e.message);
    })
    .finally(() => { _running = false; });
}

function initReguaDeCobrancaJob() {
  if (_interval) return;
  _interval = setInterval(() => runOnce(), INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  const first = setTimeout(() => runOnce(), 4 * 60 * 1000);
  if (first.unref) first.unref();
  console.log('[reguaCobranca] iniciado — lembretes e atraso às 9h BRT (tick de 10 min)');
}

function stopReguaDeCobrancaJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initReguaDeCobrancaJob, stopReguaDeCobrancaJob, deveRodarODiario, INTERVALO_MS, HORA_DIARIA_BRT };
