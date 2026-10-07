'use strict';
// Lembrete de fatura agendado (services/lembreteDeFatura.js, migration 367).
// Mesmo padrão dos outros agendadores: setInterval + init/stop.
//
// A cada 30 min, entre 8h e 20h de Brasília. Não há guarda de "já rodou
// hoje": o que já foi feito está gravado em invoice_reminders, então uma
// volta sem nada pendente é uma consulta só e não chama o Asaas — e uma
// falha (Asaas ou Resend fora do ar) é tentada de novo na volta seguinte.
const { tickLembretesDeFatura } = require('../services/lembreteDeFatura');

const INTERVALO_MS = 30 * 60 * 1000;
const HORA_INICIO_BRT = 8;
const HORA_FIM_BRT = 20;

let _interval = null;
let _running = false;

function dentroDoHorario(now = Date.now()) {
  const hora = new Date(now - 3 * 3600000).getUTCHours();
  return hora >= HORA_INICIO_BRT && hora < HORA_FIM_BRT;
}

function runOnce() {
  if (_running || !dentroDoHorario()) return;
  _running = true;
  const db = require('../config/database');
  const { asaas } = require('../services/asaasClient');
  const notifications = require('../services/appNotifications');
  const emailer = require('../services/notificationEmail');
  tickLembretesDeFatura({ db, asaas, notifications, emailer })
    .then((s) => {
      if (s.publicados || s.emails || s.pagos || s.alertas || s.falhas) {
        console.log('[lembreteFatura] ' + JSON.stringify(s));
      }
    })
    .catch((e) => {
      // 42P01: migration 367 ainda não aplicada — nada a fazer.
      if (e.code !== '42P01') console.error('[lembreteFatura] tick crash:', e.message);
    })
    .finally(() => { _running = false; });
}

function initLembreteDeFaturaJob() {
  if (_interval) return;
  _interval = setInterval(runOnce, INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  // Primeira volta logo depois do boot, sem esperar 30 min a cada deploy.
  const first = setTimeout(runOnce, 3 * 60 * 1000);
  if (first.unref) first.unref();
  console.log('[lembreteFatura] iniciado — lembretes de fatura agendados (a cada 30 min, 8h–20h BRT)');
}

function stopLembreteDeFaturaJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { initLembreteDeFaturaJob, stopLembreteDeFaturaJob, dentroDoHorario, INTERVALO_MS };
