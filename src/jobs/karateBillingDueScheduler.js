'use strict';
// Scheduler do aviso de vencimento (T-2) — mesmo padrão do annuityReminder:
// setInterval + guarda de data (backend sem cron real). Dispara 1x/dia ~9h BRT.
const { runDueAlerts } = require('../services/karateBillingAlertRunner');

function nowBRT() { return new Date(Date.now() - 3 * 3600000); }

async function trigger() {
  console.log('[karateBillingAlert] verificando vencimentos T-2...');
  const start = Date.now();
  try {
    const r = await runDueAlerts();
    console.log(`[karateBillingAlert] concluído em ${Date.now() - start}ms — feds=${r.feds} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
    return r;
  } catch (e) {
    console.error('[karateBillingAlert] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;
function tick() {
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 9 && now.getUTCMinutes() < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    trigger().catch((e) => console.error('[karateBillingAlert] crash:', e.message));
  }
}

let _interval = null;
function initKarateBillingDueScheduler() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[karateBillingAlert] scheduler iniciado — diário 9h BRT (vencimento T-2)');
}
function stopKarateBillingDueScheduler() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { initKarateBillingDueScheduler, stopKarateBillingDueScheduler, trigger };
