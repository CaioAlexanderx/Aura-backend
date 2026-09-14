// ============================================================
// AURA — FASE 8: scheduler do aniversário pelo WhatsApp oficial
//
// DIÁRIO, 9h30 BRT — meia hora depois da régua do crediário, de
// propósito: se as duas rodassem juntas, a cobrança e o parabéns do
// MESMO cliente sairiam no mesmo minuto pelo mesmo número.
//
// Idempotente por ano em três camadas (índice único do wa_marketing_log,
// dedupeKey da fila e checagem do birthday_messages_sent): rodar duas
// vezes no mesmo dia não manda duas mensagens.
//
// Kill switch BIRTHDAY_WA_AUTO_ENABLED (default ligado). O portão de
// verdade é por loja: companies.wa_birthday_auto + consentimento.
// ============================================================
'use strict';

const birthdayAuto = require('../services/marketing/birthdayAuto');

function habilitado() {
  return String(process.env.BIRTHDAY_WA_AUTO_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function triggerBirthdayAuto(today = null) {
  const start = Date.now();
  try {
    const r = await birthdayAuto.runAll(today);
    // Silêncio quando não há nada ligado: o dia em que aparecer uma linha
    // dessas no log, ela quer dizer que mensagem paga saiu.
    if (r.companies > 0) {
      console.log(`[birthdayAuto] concluído em ${Date.now() - start}ms — lojas=${r.companies} enfileiradas=${r.enqueued} falhas=${r.failed}`);
    }
    return r;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return null; // 331 pendente
    console.error('[birthdayAuto] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  // Janela 9h30–9h34 BRT; trava por data garante 1x/dia.
  if (now.getUTCHours() === 9 && now.getUTCMinutes() >= 30 && now.getUTCMinutes() < 35 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerBirthdayAuto().catch((e) => console.error('[birthdayAuto] crash:', e.message));
  }
}

let _interval = null;

function initBirthdayAutoJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[birthdayAuto] desligado por BIRTHDAY_WA_AUTO_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  console.log('[birthdayAuto] scheduler iniciado — diário 9h30 BRT (aniversário pelo WhatsApp)');
}

function stopBirthdayAutoJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initBirthdayAutoJob,
  stopBirthdayAutoJob,
  triggerBirthdayAuto,
};
