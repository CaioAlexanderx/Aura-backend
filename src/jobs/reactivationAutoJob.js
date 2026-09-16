// ============================================================
// AURA — FASE 7: scheduler da reativação pelo WhatsApp oficial
//
// SEMANAL, terça 10h BRT. Não é diário de propósito: reativação é
// MARKETING, e marketing em volume derruba a qualidade do número (que é
// o mesmo número da cobrança). Terça de manhã porque segunda a loja está
// apagando incêndio e fim de semana promoção vira spam.
//
// O teto de 30 por rodada é pequeno pelo mesmo motivo. Quem quiser
// mandar mais faz pela tela, um disparo por vez, vendo a prévia.
//
// Kill switch REACTIVATION_WA_AUTO_ENABLED (default ligado) para parar
// TODAS as lojas sem deploy. O portão de verdade continua sendo por
// loja: companies.wa_reactivation_auto + consentimento declarado.
//
// Com a 331 pendente, listCompaniesWithAuto devolve lista vazia e o tick
// não loga nada — job que grita todo dia sobre migration que ainda não
// subiu treina todo mundo a ignorar o log.
// ============================================================
'use strict';

const reactivationAuto = require('../services/marketing/reactivationAuto');

// Teto por rodada (ver acima). Não é env: é uma decisão de produto sobre
// a saúde do número, não um parâmetro de operação.
const LIMITE_POR_RODADA = 30;
const SEGMENTO = 'at_risk';

function habilitado() {
  return String(process.env.REACTIVATION_WA_AUTO_ENABLED || 'true').toLowerCase() !== 'false';
}

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

async function triggerReactivationAuto(today = null) {
  const start = Date.now();
  try {
    const r = await reactivationAuto.runAll(today, { segment: SEGMENTO, limit: LIMITE_POR_RODADA });
    if (r.companies > 0) {
      console.log(`[reactivationAuto] concluído em ${Date.now() - start}ms — lojas=${r.companies} enfileiradas=${r.enqueued} falhas=${r.failed}`);
    }
    return r;
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return null; // 331 pendente
    console.error('[reactivationAuto] fatal:', e.message);
    return null;
  }
}

let _lastDate = null;

function tick() {
  if (!habilitado()) return;
  const now = nowBRT();
  const dateStr = now.toISOString().slice(0, 10);
  // Terça (getUTCDay 2 sobre o relógio já deslocado para BRT), janela
  // 10h00–10h04. A trava por data garante 1x mesmo com o tick de 60s
  // caindo várias vezes dentro da janela.
  if (now.getUTCDay() === 2 && now.getUTCHours() === 10 && now.getUTCMinutes() < 5 && _lastDate !== dateStr) {
    _lastDate = dateStr;
    triggerReactivationAuto().catch((e) => console.error('[reactivationAuto] crash:', e.message));
  }
}

let _interval = null;

function initReactivationAutoJob() {
  if (_interval) return;
  if (!habilitado()) {
    console.log('[reactivationAuto] desligado por REACTIVATION_WA_AUTO_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, 60 * 1000);
  console.log('[reactivationAuto] scheduler iniciado — semanal, terça 10h BRT (reativação pelo WhatsApp)');
}

function stopReactivationAutoJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initReactivationAutoJob,
  stopReactivationAutoJob,
  triggerReactivationAuto,
  LIMITE_POR_RODADA,
};
