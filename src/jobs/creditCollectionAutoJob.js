// ============================================================
// AURA — FASE 6: scheduler da régua do CREDIÁRIO pelo WhatsApp oficial
//
// Mesmo padrão do dojoReminderScheduler (setInterval + guarda de hora +
// trava de "já rodou hoje"), porque o backend não tem cron de verdade.
// 09:00 BRT: antes disso muita loja ainda está fechada, e cobrança que
// chega de madrugada vira reclamação.
//
// Kill switch CREDIT_WA_AUTO_ENABLED (default ligado): é a alavanca para
// parar TODA a régua automática do crediário sem deploy, se alguma loja
// aparecer disparando o que não devia. Cada loja tem o próprio
// interruptor (credit_collection_rules.whatsapp_auto); este é o geral.
//
// Com a 330 pendente, listEnabledCompanies devolve lista vazia e o tick
// não loga nada — um job que grita todo dia sobre migration que ainda
// não subiu treina todo mundo a ignorar o log.
// ============================================================
'use strict';

const collectionAuto = require('../services/credit/collectionAuto');

function habilitado() {
  return String(process.env.CREDIT_WA_AUTO_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function triggerCreditCollectionAuto(today = null) {
  const start = Date.now();
  try {
    const r = await collectionAuto.runAll(today);
    // Silêncio total quando não há nada ligado: o dia em que aparecer
    // uma linha dessas no log, ela quer dizer que mensagem paga saiu.
    if (r.companies > 0) {
      console.log(`[creditCollectionAuto] concluído em ${Date.now() - start}ms — lojas=${r.companies} enfileiradas=${r.enqueued} falhas=${r.failed}`);
    }
    return r;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return null; // 330 pendente
    console.error('[creditCollectionAuto] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  // Janela 9h00–9h04 BRT. A trava por data é o que garante 1x/dia mesmo
  // com o tick de 60s caindo várias vezes dentro da janela.
  if (now.getUTCHours() === 9 && now.getUTCMinutes() < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerCreditCollectionAuto().catch((e) => console.error('[creditCollectionAuto] crash:', e.message));
  }
}

let _interval = null;

function initCreditCollectionAutoJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[creditCollectionAuto] desligado por CREDIT_WA_AUTO_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  console.log('[creditCollectionAuto] scheduler iniciado — diário 9h BRT (régua do crediário pelo WhatsApp)');
}

function stopCreditCollectionAutoJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initCreditCollectionAutoJob,
  stopCreditCollectionAutoJob,
  triggerCreditCollectionAuto,
};
