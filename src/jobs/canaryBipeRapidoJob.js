'use strict';
// BIPE RÁPIDO (t1-08) — a cada 30 s, só o passo do bipe do canário, com
// alerta em 3 falhas seguidas. A lógica e o porquê estão em
// services/canaryBipeRapido.js; aqui só o timer.
//
// Sobe junto com o bipe de 5 min (initCanaryJob chama initCanaryBipeRapidoJob)
// e fica dormente sem CANARY_COMPANY_ID / CANARY_USER_ID / CANARY_BARCODE.
// Kill switch sem deploy: CANARY_BIPE_RAPIDO_ENABLED=false (só este laço) ou
// CANARY_ENABLED=false (os dois).
const servico = require('../services/canaryBipeRapido');

let _interval = null;
let _running = false;

async function tick(deps = {}) {
  const cfg = deps.cfg !== undefined ? deps.cfg : servico.configuracaoRapida(deps.env || process.env);
  if (!cfg) return null; // dormente ou desligado
  if (_running) return null; // nunca sobrepor (a requisição tem tempo-limite < 30 s)
  _running = true;
  try {
    return await servico.rodarUmaVez(cfg, deps);
  } catch (e) {
    console.error('[canary-bipe] tick error:', e.message);
    return null;
  } finally {
    _running = false;
  }
}

function initCanaryBipeRapidoJob(env = process.env) {
  if (_interval) return;
  if (String(env.CANARY_BIPE_RAPIDO_ENABLED || 'true').trim().toLowerCase() === 'false') {
    console.log('[canary-bipe] desabilitado por CANARY_BIPE_RAPIDO_ENABLED=false');
    return;
  }
  if (!servico.configuracaoRapida(env)) {
    console.log('[canary-bipe] dormente — sem as envs do canário');
    return;
  }
  _interval = setInterval(tick, servico.TICK_MS);
  if (_interval.unref) _interval.unref();
  console.log(`[canary-bipe] iniciado — só o bipe a cada ${servico.TICK_MS / 1000} s, alerta em ${servico.FALHAS_PARA_ALERTAR} falhas seguidas`);
}

function stopCanaryBipeRapidoJob() { if (_interval) { clearInterval(_interval); _interval = null; } }

// Só para testes.
function _resetForTests() { _running = false; stopCanaryBipeRapidoJob(); servico._resetForTests(); }
function _ativo() { return !!_interval; }

module.exports = { initCanaryBipeRapidoJob, stopCanaryBipeRapidoJob, tick, _resetForTests, _ativo };
