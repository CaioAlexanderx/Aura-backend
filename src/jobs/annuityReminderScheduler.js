// ============================================================
// AURA KARATÊ — Scheduler da régua de anuidade (Track I)
// Segue o padrão do reportScheduler.js (setInterval + guarda de data), já que
// o backend não tem cron real. Dispara 1x/dia ~9h BRT. A idempotência real
// vem da tabela de log (karate_reminder_log), então múltiplas réplicas não
// reenviam o mesmo lembrete.
// ============================================================
'use strict';

const { runAll } = require('../services/karateReminderRunner');

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function triggerAnnuityReminders() {
  console.log('[karateReminder] iniciando régua de anuidade...');
  const start = Date.now();
  try {
    const r = await runAll();
    console.log(`[karateReminder] concluído em ${Date.now() - start}ms — feds=${r.feds} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
    return r;
  } catch (e) {
    console.error('[karateReminder] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  const now = nowBRT();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);
  if (hour === 9 && min < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerAnnuityReminders().catch((e) => console.error('[karateReminder] crash:', e.message));
  }
}

let _interval = null;

function initAnnuityReminderScheduler() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[karateReminder] scheduler iniciado — diário 9h BRT (régua de anuidade)');
}

function stopAnnuityReminderScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initAnnuityReminderScheduler,
  stopAnnuityReminderScheduler,
  triggerAnnuityReminders,
};