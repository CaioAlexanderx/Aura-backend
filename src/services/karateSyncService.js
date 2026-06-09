// ============================================================
// AURA KARATÊ — Serviço de Sincronização Dojô (Track F / Fase 5)
//
// federation_sync_token: gerado na aprovação/rotação de uma conexão
// (Via 1 native / Via 2 adapter). NUNCA é persistido em claro — guardamos
// apenas o hash sha256 + um prefixo curto para exibição mascarada.
//
// Autenticação do webhook (Via 1 bidirecional): o dojô apresenta o token
// (header) e comparamos o hash com timing-safe. HMAC-sobre-corpo
// (verifyHmac) fica disponível para hardening futuro quando houver um
// segredo recuperável dedicado (decisão de armazenamento pendente).
// ============================================================
'use strict';

const crypto = require('crypto');

const TOKEN_BYTES = 24; // 48 hex chars

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Gera um novo token de sync. Retorna { token (claro, mostrar 1x), hash, prefix }. */
function generateSyncToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}

/** Máscara para exibição (nunca expõe o token inteiro). */
function maskToken(prefix) {
  return prefix ? `${prefix}${'•'.repeat(12)}` : null;
}

/** Compara um token apresentado contra o hash guardado (timing-safe). */
function verifyToken(presentedToken, storedHash) {
  if (!presentedToken || !storedHash) return false;
  try {
    const a = Buffer.from(hashToken(presentedToken), 'hex');
    const b = Buffer.from(String(storedHash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** HMAC-SHA256 sobre o corpo cru (para webhook assinado — uso futuro). */
function verifyHmac(rawBody, signatureHex, secret) {
  if (!signatureHex || !secret) return false;
  try {
    const expected = crypto.createHmac('sha256', String(secret)).update(rawBody || '').digest('hex');
    const a = Buffer.from(String(signatureHex), 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { generateSyncToken, hashToken, maskToken, verifyToken, verifyHmac };
