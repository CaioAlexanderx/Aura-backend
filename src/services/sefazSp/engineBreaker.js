// ============================================================
// AURA. — sefazSp/engineBreaker: circuit breaker da emissão PRÓPRIA
// Roadmap NFC-e própria v1 — S4.3.
//
// Espelha o padrão de contingency.js, MAS chaveado POR COMPANY: um defeito
// de infra da NOSSA engine (certificado não carrega/decripta, CSC ausente,
// falha de assinatura, bug de montagem do XML) é específico da empresa —
// não faz sentido derrubar a emissão própria de TODAS as empresas por causa
// de uma. Já a indisponibilidade da SEFAZ (contingency.js) é global.
//
// Diferença semântica crucial vs. contingency:
//   • contingency conta FALHA DE TRANSPORTE (SEFAZ fora) → contingência offline.
//   • engineBreaker conta THROW da engine (defeito NOSSO) → fallback pro gateway.
//     Rejeição/autorização da SEFAZ = SUCESSO aqui (a engine funcionou; foi a
//     SEFAZ que respondeu). Contingência NÃO é falha da engine tampouco.
//
// FAILURE_THRESHOLD=2 falhas consecutivas → janela de 15min indo DIRETO pro
// gateway (sem nem tentar a engine, fallback_reason='breaker_open'). Após a
// janela, a próxima emissão "sonda" a engine de novo. Um sucesso zera tudo.
// ============================================================
'use strict';

const FAILURE_THRESHOLD = 2;
const OPEN_WINDOW_MS = 15 * 60 * 1000; // 15min

// estado por companyId
const _state = new Map();

function stateFor(companyId) {
  const k = String(companyId);
  if (!_state.has(k)) _state.set(k, { consecutiveFailures: 0, openUntil: 0, lastFailureAt: 0 });
  return _state.get(k);
}

/**
 * THROW da engine (defeito NOSSO de infra). 2 consecutivas abrem a janela.
 * NÃO chamar em rejeição/contingência — só quando emitNfce lançou.
 */
function recordFailure(companyId, now = Date.now()) {
  const s = stateFor(companyId);
  s.consecutiveFailures++;
  s.lastFailureAt = now;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
    s.openUntil = now + OPEN_WINDOW_MS;
  }
}

/**
 * A engine falou com a SEFAZ e recebeu resposta (autorizada OU rejeitada):
 * a engine está de pé. Fecha o breaker.
 */
function recordSuccess(companyId) {
  const s = stateFor(companyId);
  s.consecutiveFailures = 0;
  s.openUntil = 0;
}

/** true = breaker aberto → pula a engine e vai DIRETO ao gateway. */
function isOpen(companyId, now = Date.now()) {
  return now < stateFor(companyId).openUntil;
}

function snapshot(companyId) {
  const s = stateFor(companyId);
  return { ...s, open: isOpen(companyId) };
}

function reset() { _state.clear(); }

module.exports = {
  recordFailure, recordSuccess, isOpen, snapshot, reset,
  FAILURE_THRESHOLD, OPEN_WINDOW_MS,
};
