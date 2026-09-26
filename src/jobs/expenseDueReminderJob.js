'use strict';
// Lembrete de contas a pagar no sininho, 2 dias antes do vencimento
// (services/lembreteContasAPagar.js). Mesmo padrão dos outros agendadores:
// setInterval + guarda de data (backend sem cron real).
//
// Diferença de propósito em relação ao karateBillingDueScheduler: ele só
// dispara entre 9h00 e 9h05; este dispara na PRIMEIRA volta a partir das 8h.
// Um deploy às 10h não perde o lembrete do dia — a dedupe_key impede que o
// aviso se repita se o processo reiniciar de novo no mesmo dia.
const { runLembretes } = require('../services/lembreteContasAPagar');

const HORA_INICIO_BRT = 8;

function nowBRT() { return new Date(Date.now() - 3 * 3600000); }

async function trigger() {
  const start = Date.now();
  try {
    const r = await runLembretes();
    console.log(`[lembreteContas] ${r.contas} contas, ${r.avisos} avisos, ${r.criados} novos em ${Date.now() - start}ms`);
    return r;
  } catch (e) {
    console.error('[lembreteContas] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;
function tick() {
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() >= HORA_INICIO_BRT && _lastDate !== dateStr) {
    _lastDate = dateStr;
    trigger().catch((e) => console.error('[lembreteContas] crash:', e.message));
  }
}

let _interval = null;
function initExpenseDueReminderJob() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[lembreteContas] agendador iniciado — diário a partir das 8h BRT (vencimento em 2 dias)');
}
function stopExpenseDueReminderJob() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { initExpenseDueReminderJob, stopExpenseDueReminderJob, trigger, _tick: tick, _reset: () => { _lastDate = null; } };
