'use strict';
// AURINHA — dispatcher da fila ig_outbox. Mesmo padrão do waDispatcherJob
// (setInterval curto; o backend não tem cron real). Tick de 15s: DM de
// atendimento é conversa em tempo real, não régua de cobrança.
// Kill switch sem deploy: IG_DISPATCH_ENABLED=false.
const { processBatch } = require('../services/igOutbox');

const TICK_MS = 15 * 1000;
const BATCH = 20;

let _interval = null;
let _running = false;

async function tick() {
  if (_running) return; // nunca sobrepor batches
  _running = true;
  try {
    const r = await processBatch(BATCH);
    if (r.picked > 0) {
      console.log(`[igDispatcher] picked=${r.picked} sent=${r.sent} retried=${r.retried} skipped=${r.skipped} failed=${r.failed}`);
    }
  } catch (e) {
    // 42P01 = migration 312 pendente: fila dormente, sem barulho por tick.
    if (e && e.code !== '42P01') console.error('[igDispatcher] tick error:', e.message);
  } finally {
    _running = false;
  }
}

function initIgDispatcher() {
  if (_interval) return;
  if (String(process.env.IG_DISPATCH_ENABLED || 'true') === 'false') {
    console.log('[igDispatcher] desabilitado por IG_DISPATCH_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, TICK_MS);
  console.log('[igDispatcher] iniciado — fila ig_outbox a cada 15s');
}
function stopIgDispatcher() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { initIgDispatcher, stopIgDispatcher, tick };
