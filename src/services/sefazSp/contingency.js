// ============================================================
// AURA. — sefazSp/contingency: detector de indisponibilidade SEFAZ-SP
// Roadmap NFC-e própria v1 — S3.1.
//
// Estado GLOBAL por ambiente (SP tem um autorizador só): falhas
// consecutivas de transporte derrubam pro modo contingência por uma
// janela; sucesso real fecha. Decisão de design: o PDV NUNCA espera —
// se o detector diz offline, a emissão nem tenta a SEFAZ (entra direto
// em tpEmis=9); senão tenta 1x e, falhando transporte, cai pra
// contingência na mesma requisição.
//
// FAILURE_THRESHOLD=2 · janela offline 60s (renovada a cada falha) —
// após a janela, a próxima emissão "sonda" a SEFAZ de novo.
// ============================================================
'use strict';

const FAILURE_THRESHOLD = 2;
const OFFLINE_WINDOW_MS = 60 * 1000;

// estado por tpAmb (1=produção, 2=homolog) — autorizador é o mesmo p/ SP
const _state = new Map();

function stateFor(tpAmb) {
  const k = String(tpAmb);
  if (!_state.has(k)) _state.set(k, { consecutiveFailures: 0, offlineUntil: 0, lastFailureAt: 0 });
  return _state.get(k);
}

/** Falha de TRANSPORTE (timeout/rede/HTTP≠200). Rejeição NÃO é falha. */
function recordFailure(tpAmb, now = Date.now()) {
  const s = stateFor(tpAmb);
  s.consecutiveFailures++;
  s.lastFailureAt = now;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
    s.offlineUntil = now + OFFLINE_WINDOW_MS;
  }
}

/** Resposta real da SEFAZ (autorizada OU rejeitada): serviço está de pé. */
function recordSuccess(tpAmb) {
  const s = stateFor(tpAmb);
  s.consecutiveFailures = 0;
  s.offlineUntil = 0;
}

/** true = pula a SEFAZ e emite direto em contingência. */
function isLikelyOffline(tpAmb, now = Date.now()) {
  return now < stateFor(tpAmb).offlineUntil;
}

function snapshot(tpAmb) {
  const s = stateFor(tpAmb);
  return { ...s, offline: isLikelyOffline(tpAmb) };
}

function reset() { _state.clear(); }

const XJUST_DEFAULT = 'Falha de comunicacao com o autorizador SEFAZ-SP detectada pelo emissor';

module.exports = {
  recordFailure, recordSuccess, isLikelyOffline, snapshot, reset,
  FAILURE_THRESHOLD, OFFLINE_WINDOW_MS, XJUST_DEFAULT,
};
