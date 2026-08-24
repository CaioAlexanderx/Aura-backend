'use strict';
// ONDA 5b — dispatcher da fila wa_outbox. Mesmo padrão dos schedulers
// (setInterval; o backend não tem cron real), mas com tick CURTO (30s):
// fila de mensagem não pode esperar o dia virar. Desligável por env
// WA_DISPATCH_ENABLED=false (kill switch sem deploy).
const { processBatch } = require('../services/waOutbox');

const TICK_MS = 30 * 1000;
const BATCH = 20;

let _interval = null;
let _running = false;

async function tick() {
  if (_running) return; // nunca sobrepor batches
  _running = true;
  try {
    const r = await processBatch(BATCH);
    if (r.picked > 0) {
      console.log(`[waDispatcher] picked=${r.picked} sent=${r.sent} retried=${r.retried} skipped=${r.skipped} failed=${r.failed}`);
    }
  } catch (e) {
    // 42P01 = migration 307 pendente: fila dormente, sem barulho por tick.
    if (e && e.code !== '42P01') console.error('[waDispatcher] tick error:', e.message);
  } finally {
    _running = false;
  }
}

function initWaDispatcher() {
  if (_interval) return;
  if (String(process.env.WA_DISPATCH_ENABLED || 'true') === 'false') {
    console.log('[waDispatcher] desabilitado por WA_DISPATCH_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, TICK_MS);
  console.log('[waDispatcher] iniciado — fila wa_outbox a cada 30s');
}
function stopWaDispatcher() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { initWaDispatcher, stopWaDispatcher, tick };
