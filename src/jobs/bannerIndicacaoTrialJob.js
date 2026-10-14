'use strict';
// Banner de indicação para trials (services/bannerIndicacaoTrial.js).
// Mesmo padrão dos outros agendadores: setInterval + init/stop.
//
// Uma avaliação por dia, a partir das 06h30 de Brasília (a Cassie lê às
// 07h30). A cada 5 min o job só confere duas coisas: já passou das 06h30 e
// ainda não rodou hoje? A guarda "rodou hoje" é em memória; a idempotência de
// verdade vem do dedupe_key do banner — um reinício no mesmo dia roda de novo
// e não cria nada em duplicidade. Volta que falha (banco fora do ar) não
// marca o dia e é tentada de novo 5 min depois.
//
// Nasce desligado: só roda com BANNER_INDICACAO_TRIAL_ENABLED=true (lido a
// cada volta, então ligar/desligar na Railway vale no próximo ciclo).
const { tickBannerIndicacaoTrial, lerConfig } = require('../services/bannerIndicacaoTrial');

const INTERVALO_MS = 5 * 60 * 1000;
const HORA_BRT = 6;
const MINUTO_BRT = 30;

let _interval = null;
let _first = null;
let _running = false;
let _ultimoDiaRodado = null;

// Dia civil, hora e minuto de São Paulo (UTC-3, sem horário de verão).
function agoraBrt(now = Date.now()) {
  const brt = new Date(now - 3 * 3600000);
  return { dia: brt.toISOString().slice(0, 10), hora: brt.getUTCHours(), minuto: brt.getUTCMinutes() };
}

function passouDoHorario(now = Date.now()) {
  const { hora, minuto } = agoraBrt(now);
  return hora > HORA_BRT || (hora === HORA_BRT && minuto >= MINUTO_BRT);
}

/** true quando já passou das 06h30 BRT e o job ainda não rodou neste dia. */
function devePassarAgora(now = Date.now(), ultimoDia = _ultimoDiaRodado) {
  return passouDoHorario(now) && agoraBrt(now).dia !== ultimoDia;
}

async function runOnce(now = Date.now()) {
  if (_running) return null;
  if (!lerConfig().enabled) return null;
  if (!devePassarAgora(now)) return null;
  _running = true;
  try {
    const db = require('../config/database');
    const notifications = require('../services/appNotifications');
    const resumo = await tickBannerIndicacaoTrial({ db, notifications, now });
    _ultimoDiaRodado = agoraBrt(now).dia;
    console.log('[bannerIndicacaoTrial] ' + JSON.stringify(resumo));
    return resumo;
  } catch (e) {
    console.error('[bannerIndicacaoTrial] tick crash:', e.message);
    return null;
  } finally {
    _running = false;
  }
}

function initBannerIndicacaoTrialJob() {
  if (_interval) return;
  _interval = setInterval(() => { runOnce(); }, INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  // Primeira volta ~3 min depois do boot: só age se já passou das 06h30 e
  // ainda não rodou hoje (a checagem está dentro do runOnce).
  _first = setTimeout(() => { runOnce(); }, 3 * 60 * 1000);
  if (_first.unref) _first.unref();
  const cfg = lerConfig();
  console.log('[bannerIndicacaoTrial] iniciado — '
    + (cfg.enabled
      ? `ligado${cfg.dryRun ? ' (dry-run)' : ''}, banner nasce ${cfg.publicar ? 'ATIVO' : 'inativo'}, 1x por dia após 06h30 BRT`
      : 'desligado (BANNER_INDICACAO_TRIAL_ENABLED != true)'));
}

function stopBannerIndicacaoTrialJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_first) { clearTimeout(_first); _first = null; }
}

// Só para teste: zera a guarda em memória.
function _resetForTests() { _ultimoDiaRodado = null; _running = false; }

module.exports = {
  initBannerIndicacaoTrialJob,
  stopBannerIndicacaoTrialJob,
  runOnce,
  passouDoHorario,
  devePassarAgora,
  agoraBrt,
  INTERVALO_MS,
  _resetForTests,
};
