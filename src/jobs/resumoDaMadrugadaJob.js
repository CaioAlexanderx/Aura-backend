'use strict';
// RESUMO DA MADRUGADA — às 8h (BRT) manda por e-mail o que chegou no
// WhatsApp da Aura entre 21h e 8h (services/resumoDaMadrugada.js).
//
// Mesmo padrão do plantaoJob: setInterval por minuto (o backend não tem cron
// real). 8h é o piso, não a janela: se o processo subir depois das 8h (deploy,
// queda) e o dia ainda não tiver resumo, sai no primeiro tick — até 12h; depois
// disso o resumo da manhã já não serve e o alerta de contato sem resposta
// cobre o que ficou. A idempotência mora no banco (um evento por dia), então
// mais de uma instância não manda duas vezes.
//
// Dormente por padrão: sem AURA_COMPANY_ID o tick não consulta o banco.
// Kill switch sem deploy: RESUMO_MADRUGADA_ENABLED=false.
const { auraCompanyId } = require('../services/hubWhatsapp');
const { gerarEEnviar } = require('../services/resumoDaMadrugada');

const TICK_MS = 60 * 1000;
const HORA_INICIO_BRT = 8;
const HORA_FIM_BRT = 12;
const RETENTATIVA_MS = 10 * 60 * 1000;

let _interval = null;
let _running = false;
let _feitoDia = null;
let _naoAntesDe = 0;

async function tick(deps = {}) {
  if (String(process.env.RESUMO_MADRUGADA_ENABLED || 'true') === 'false') return null;
  if (_running) return null; // nunca sobrepor ticks
  const agora = deps.agora || new Date();
  const brt = new Date(agora.getTime() - 3 * 3600000);
  const hora = brt.getUTCHours();
  const dia = brt.toISOString().slice(0, 10);
  if (hora < HORA_INICIO_BRT || hora >= HORA_FIM_BRT) return null;
  if (_feitoDia === dia || agora.getTime() < _naoAntesDe) return null;
  if (!auraCompanyId()) return null;

  _running = true;
  try {
    const r = await (deps.gerar || gerarEEnviar)({ hoje: dia });
    if (r.ok) {
      _feitoDia = dia;
      if (r.enviado) console.log(`[resumoMadrugada] ${dia}: ${r.total} contatos enviados para ${r.para}`);
    } else if (r.motivo !== 'DORMENTE') {
      _naoAntesDe = agora.getTime() + RETENTATIVA_MS;
      console.error(`[resumoMadrugada] ${dia}: ${r.motivo}${r.erro ? ` — ${r.erro}` : ''}; nova tentativa em 10 min`);
    }
    return r;
  } catch (e) {
    _naoAntesDe = agora.getTime() + RETENTATIVA_MS;
    if (e && e.code !== '42P01' && e.code !== '42703') console.error('[resumoMadrugada] tick error:', e.message);
    return null;
  } finally {
    _running = false;
  }
}

function initResumoDaMadrugadaJob() {
  if (_interval) return;
  if (String(process.env.RESUMO_MADRUGADA_ENABLED || 'true') === 'false') {
    console.log('[resumoMadrugada] desabilitado por RESUMO_MADRUGADA_ENABLED=false');
    return;
  }
  _interval = setInterval(tick, TICK_MS);
  if (_interval.unref) _interval.unref();
  console.log('[resumoMadrugada] iniciado — resumo do WhatsApp da Aura às 8h BRT');
}
function stopResumoDaMadrugadaJob() { if (_interval) { clearInterval(_interval); _interval = null; } }

// Só para testes.
function _resetForTests() { _running = false; _feitoDia = null; _naoAntesDe = 0; }

module.exports = {
  initResumoDaMadrugadaJob, stopResumoDaMadrugadaJob, tick, _resetForTests,
  TICK_MS, HORA_INICIO_BRT, HORA_FIM_BRT,
};
