'use strict';
// Limpeza das contas pendentes (tq-113; services/limpezaPendentes.js).
// Mesmo padrão dos outros agendadores: setInterval + init/stop.
//
// Uma volta por dia, a partir das 05h de Brasília (antes do painel das 06h,
// para a conta desativada já sair do cálculo do dia). A cada 10 min o job só
// confere: já passou das 05h e ainda não rodou hoje? A guarda "rodou hoje" é
// em memória; a idempotência de verdade está no banco (o UPDATE só pega
// empresa ativa e sem desativada_por) — um reinício no mesmo dia roda de
// novo sem efeito. Volta que falha não marca o dia e é tentada de novo.
//
// Nasce LIGADO: LIMPEZA_PENDENTES_ENABLED=false é o kill switch (lido a
// cada volta, vale na Railway sem deploy). LIMPEZA_PENDENTES_DRY_RUN=true
// só loga quem seria desativado.
const { rodarLimpeza, lerConfig } = require('../services/limpezaPendentes');

const INTERVALO_MS = 10 * 60 * 1000;
const HORA_BRT = 5;

let _interval = null;
let _first = null;
let _running = false;
let _ultimoDiaRodado = null;

function agoraBrt(now = Date.now()) {
  const brt = new Date(now - 3 * 3600000);
  return { dia: brt.toISOString().slice(0, 10), hora: brt.getUTCHours() };
}

/** true quando já passou das 05h BRT e o job ainda não rodou neste dia. */
function devePassarAgora(now = Date.now(), ultimoDia = _ultimoDiaRodado) {
  const { dia, hora } = agoraBrt(now);
  return hora >= HORA_BRT && dia !== ultimoDia;
}

async function runOnce(now = Date.now(), { pool } = {}) {
  if (_running) return null;
  if (!lerConfig().enabled) return null;
  if (!devePassarAgora(now)) return null;
  _running = true;
  try {
    const resumo = await rodarLimpeza({ pool: pool || require('../config/database'), agora: new Date(now) });
    _ultimoDiaRodado = agoraBrt(now).dia;
    console.log('[limpezaPendentes] ' + JSON.stringify(resumo));
    return resumo;
  } catch (e) {
    console.error('[limpezaPendentes] tick crash:', e.message);
    return null;
  } finally {
    _running = false;
  }
}

function initLimpezaPendentesJob() {
  if (_interval) return;
  _interval = setInterval(() => { runOnce(); }, INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  _first = setTimeout(() => { runOnce(); }, 4 * 60 * 1000);
  if (_first.unref) _first.unref();
  const cfg = lerConfig();
  console.log('[limpezaPendentes] iniciado — '
    + (cfg.enabled
      ? `ligado${cfg.dryRun ? ' (dry-run)' : ''}, 1x por dia após 05h BRT`
      : 'desligado (LIMPEZA_PENDENTES_ENABLED=false)'));
}

function stopLimpezaPendentesJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_first) { clearTimeout(_first); _first = null; }
}

// Só para teste: zera a guarda em memória.
function _resetForTests() { _ultimoDiaRodado = null; _running = false; }

module.exports = {
  initLimpezaPendentesJob,
  stopLimpezaPendentesJob,
  runOnce,
  devePassarAgora,
  agoraBrt,
  INTERVALO_MS,
  _resetForTests,
};
