'use strict';
// ============================================================
// AURA — rede de segurança dos modelos-base do WhatsApp
//
// A conexão do número já manda criar os 15 modelos aura_* na Meta, mas
// pode falhar (Meta fora do ar, token ainda não valendo). Este job, a cada
// 6 h, procura lojas conectadas que ainda não têm todos os modelos padrão
// em wa_templates e tenta de novo.
//
// Idempotente: prepararPadroes só cria o que falta, e uma loja por vez
// por processo. Criar modelo não gasta saldo e não passa pela wa_outbox.
// Kill switch: WA_MODELOS_PREPARO_ENABLED=false.
// ============================================================

const TICK_MS = 6 * 60 * 60 * 1000;
const PRIMEIRA_MS = 3 * 60 * 1000;

let _interval = null;
let _first = null;
let _running = false;

async function tick(store = require('../services/waAutomaticas/modelosStore')) {
  if (_running) return null;
  _running = true;
  try {
    const r = await store.prepararPendentes();
    if (r.lojas > 0) console.log(`[waModelosPreparo] lojas=${r.lojas} ok=${r.ok} falhas=${r.falhas}`);
    return r;
  } catch (e) {
    console.error('[waModelosPreparo] erro:', e && e.message);
    return null;
  } finally {
    _running = false;
  }
}

function initWaModelosPreparoJob() {
  if (_interval) return;
  if (String(process.env.WA_MODELOS_PREPARO_ENABLED || 'true') === 'false') {
    console.log('[waModelosPreparo] desabilitado por WA_MODELOS_PREPARO_ENABLED=false');
    return;
  }
  _first = setTimeout(() => { tick(); }, PRIMEIRA_MS);
  if (_first.unref) _first.unref();
  _interval = setInterval(() => { tick(); }, TICK_MS);
  console.log('[waModelosPreparo] iniciado — confere modelos faltando a cada 6 h');
}
function stopWaModelosPreparoJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
  if (_first) { clearTimeout(_first); _first = null; }
}

module.exports = { initWaModelosPreparoJob, stopWaModelosPreparoJob, tick };
