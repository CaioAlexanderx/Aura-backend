// ============================================================
// AURA. — Job diário do assento de temporada (13/10/2026)
//
// Todo dia, a partir da 01h BRT:
//   1. expira os passes vencidos (ends_at < hoje): tira os assentos extras
//      (companies.extra_seats_granted) e refaz o valor da assinatura na Asaas;
//   2. aplica os passes contratados antes do início e que hoje começam
//      (01/11/2026 para quem contratou em outubro);
//   3. refaz o valor das assinaturas cujo ajuste ficou pendente por falha
//      transitória da Asaas.
// Cada ação grava uma linha em audit_log (seat_pass.expired / .applied /
// .resynced ...). A regra está em services/seatPass.js; as datas, em
// services/temporada.js.
//
// Mesmo padrão dos outros agendadores (backend sem cron real): tick por
// minuto + guarda de data. Segurança com mais de uma instância: cada passe é
// "reivindicado" por um UPDATE ... WHERE status='ativo' atômico (ver
// seatPass.js), então duas instâncias rodando juntas não somam nem subtraem
// duas vezes — a segunda simplesmente não encontra o que fazer.
//
// Se a rodada termina com erros (Asaas fora, por exemplo), tenta de novo em
// 30 minutos em vez de dar o dia por feito.
//
// Kill switch: SEAT_PASS_JOB_ENABLED=false.
// ============================================================
'use strict';

const { rodarDiario } = require('../services/seatPass');
const { todayBrt } = require('../services/subscriptionDiscount');

const HORA_BRT = 1;
const RETRY_MS = 30 * 60 * 1000;

let _lastDate = null;
let _naoAntesDe = 0;
let _avisouSemTabela = false;

function nowBRT(ms = Date.now()) {
  return new Date(ms - 3 * 3600000);
}

// Uma rodada. Nunca lança.
async function trigger(deps = {}) {
  const inicio = Date.now();
  try {
    const r = await (deps.rodar || rodarDiario)(deps);
    console.log(`[seatPass] ${r.hoje}: ${r.expirados} expirados, ${r.aplicados} aplicados, ${r.cancelados} cancelados, `
      + `${r.ressincronizados} ressincronizados, ${r.erros.length} erros em ${Date.now() - inicio}ms`);
    if (r.erros.length) console.error('[seatPass] erros:', JSON.stringify(r.erros).slice(0, 1000));
    return r;
  } catch (err) {
    if (err && err.code === '42P01') {
      if (!_avisouSemTabela) {
        _avisouSemTabela = true;
        console.warn('[seatPass] seat_passes ainda não existe (migration 374 pendente).');
      }
      return { semTabela: true, erros: [] };
    }
    console.error('[seatPass] fatal:', err && err.message);
    return { erros: [{ etapa: 'rodada', erro: err && err.message }] };
  }
}

// Decide se este tick dispara. Devolve a Promise da rodada (ou null) para o
// teste poder aguardar.
function tick(deps = {}) {
  if (process.env.SEAT_PASS_JOB_ENABLED === 'false') return null;
  const agoraMs = deps.agoraMs || Date.now();
  const now = nowBRT(agoraMs);
  const dateStr = now.toISOString().slice(0, 10);
  if (now.getUTCHours() < HORA_BRT || _lastDate === dateStr || agoraMs < _naoAntesDe) return null;

  // Marca antes de disparar: o tick do minuto seguinte não dispara de novo
  // enquanto esta rodada ainda está em andamento.
  _lastDate = dateStr;
  return trigger({ ...deps, hoje: deps.hoje || todayBrt(agoraMs) }).then((r) => {
    if (r && (r.semTabela || (r.erros && r.erros.length))) {
      _lastDate = null;
      _naoAntesDe = agoraMs + RETRY_MS;
    }
    return r;
  });
}

let _interval = null;

function initSeatPassScheduler() {
  if (_interval) return;
  _interval = setInterval(() => { tick(); }, 60 * 1000);
  console.log('[seatPass] agendador iniciado — expira/aplica assentos de temporada todo dia a partir da 01h BRT');
}

function stopSeatPassScheduler() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Só para testes.
function _resetForTests() {
  _lastDate = null;
  _naoAntesDe = 0;
  _avisouSemTabela = false;
}

module.exports = {
  initSeatPassScheduler,
  stopSeatPassScheduler,
  trigger,
  tick,
  _resetForTests,
};
