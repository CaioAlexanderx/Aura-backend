// ============================================================
// AURA DOJÔ — Scheduler da régua de cobrança do dojô (F3c)
// Espelha annuityReminderScheduler.js (Track I): setInterval + guarda de
// data, já que o backend não tem cron real. Dispara 1x/dia ~9h10 BRT
// (offset de ~10min em relação à régua de anuidade da federação, que roda
// às 9h, para não empilhar os dois lotes no mesmo tick). A idempotência
// real vem do log (karate_dojo_reminder_log), então múltiplas réplicas não
// reenviam o mesmo lembrete.
//
// Só roda dojôs com karate_dojo_reminder_config.enabled = true (opt-in);
// runAll já filtra. Com nenhuma config ligada, é um no-op silencioso.
// ============================================================
'use strict';

const { runAll } = require('../services/karateDojoReminderEngine');

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function triggerDojoReminders() {
  console.log('[karateDojoReminder] iniciando régua de cobrança do dojô...');
  const start = Date.now();
  try {
    const r = await runAll();
    console.log(`[karateDojoReminder] concluído em ${Date.now() - start}ms — dojos=${r.dojos} sent=${r.sent} skipped=${r.skipped} failed=${r.failed}`);
    return r;
  } catch (e) {
    console.error('[karateDojoReminder] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  const now = nowBRT();
  const hour = now.getUTCHours();
  const min = now.getUTCMinutes();
  const dateStr = now.toISOString().slice(0, 10);
  // Janela 9h10–9h14 BRT (a régua de anuidade da federação usa 9h00–9h04).
  if (hour === 9 && min >= 10 && min < 15 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerDojoReminders().catch((e) => console.error('[karateDojoReminder] crash:', e.message));
  }
}

let _interval = null;

function initDojoReminderScheduler() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[karateDojoReminder] scheduler iniciado — diário ~9h10 BRT (régua de cobrança do dojô)');
}

function stopDojoReminderScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initDojoReminderScheduler,
  stopDojoReminderScheduler,
  triggerDojoReminders,
};
