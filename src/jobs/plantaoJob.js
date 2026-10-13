'use strict';
// AURINHA DE PLANTÃO — reavalia a cada minuto as conversas do WhatsApp da
// Aura em que o cliente falou e ainda não houve resposta (hub_conversations
// .aguardando_resposta_desde). De dia, a Aurinha espera 15 min pelo humano:
// é este job que a faz entrar quando o prazo vence. De noite o webhook já
// responde na hora; o job só pega o que sobrou (ex.: o plantão virou 21h
// com a mensagem esperando).
//
// Mesmo padrão dos dispatchers (setInterval; o backend não tem cron real).
// Dormente por padrão: sem AURA_COMPANY_ID o tick não consulta o banco.
// Kill switch sem deploy: PLANTAO_ENABLED=false.
const { processarPendentes } = require('../services/hubWhatsapp');

const TICK_MS = 60 * 1000;

let _interval = null;
let _running = false;

async function tick() {
  if (_running) return; // nunca sobrepor ticks
  _running = true;
  try {
    const r = await processarPendentes({ agora: new Date() });
    if (r.picked > 0) {
      console.log(`[plantao] picked=${r.picked} respondidas=${r.respondidas} aguardando=${r.aguardando} outras=${r.outras} erros=${r.erros}`);
    }
    return r;
  } catch (e) {
    // 42P01/42703 = migration 375 pendente: dormente, sem barulho por tick.
    if (e && e.code !== '42P01' && e.code !== '42703') console.error('[plantao] tick error:', e.message);
  } finally {
    _running = false;
  }
}

function initPlantaoJob() {
  if (_interval) return;
  if (String(process.env.PLANTAO_ENABLED || 'true') === 'false') {
    console.log('[plantao] desabilitado por PLANTAO_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, TICK_MS);
  if (_interval.unref) _interval.unref();
  console.log('[plantao] iniciado — Aurinha de plantão reavalia pendentes a cada 60s');
}
function stopPlantaoJob() { if (_interval) { clearInterval(_interval); _interval = null; } }

module.exports = { initPlantaoJob, stopPlantaoJob, tick, TICK_MS };
