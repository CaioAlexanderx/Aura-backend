// ============================================================
// AURA KARATÊ — Token público e stateless do PIX de cobrança (Fase F4/PIX)
//
// A página pública de pagamento (/karate/pix/:token no front) e o QR do
// e-mail apontam pro MESMO BR Code que já é gerado (sem persistir —
// karateBillingMailer.getDisplayPixCode) a cada envio de e-mail de
// cobrança. Em vez de criar uma tabela nova só para guardar esse
// "link público" (o que exigiria migration + writes extras a cada
// envio/reenvio, inclusive em lote), o token carrega o PRÓPRIO conteúdo
// (valor, competência, BR Code) assinado com HMAC — verificável sem
// tocar o banco.
//
// Decisão de privacidade (ver PR): o payload SÓ tem valor, competência e
// o BR Code. NUNCA nome, CPF, telefone, e-mail, dojo_id ou
// practitioner_id — a página pública não precisa (e não deve) saber QUEM
// está pagando, só QUANTO e o código. Isso também é o que barra qualquer
// vazamento de dado pessoal se o link for encaminhado adiante.
//
// Expiração (90 dias): o BR Code estático em si não expira no provider
// (ver karatePaymentProvider.js — MVP é static_brcode), então isso é
// só higiene do link em si, não uma regra do PIX. Token inválido/expirado
// → verifyPixToken retorna null; o caller trata como 404 genérico (nunca
// vaza o motivo específico, evita oráculo de forjagem de token).
// ============================================================
'use strict';

const crypto = require('crypto');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
// Secret dedicado (opcional) com fallback pro JWT_SECRET global — mesmo
// padrão de OTP_SECRET em karatePortalAuthService.js/karateDojoPortalAuthService.js.
const SECRET = process.env.PIX_PUBLIC_TOKEN_SECRET || env.JWT_SECRET;
const CONTEXT = 'karate-pix-public-v1';
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 dias

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', SECRET).update(`${CONTEXT}:${payloadB64}`).digest());
}

// Gera o token opaco autoverificável. `amount` em reais (número),
// `referencePeriod` texto livre (ex.: "2026"), `pixCode` o BR Code inteiro.
function signPixToken({ amount, referencePeriod, pixCode }) {
  const payload = {
    a: Number(amount) || 0,
    c: String(referencePeriod || ''),
    p: String(pixCode || ''),
    e: Date.now() + TTL_MS,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${payloadB64}.${sign(payloadB64)}`;
}

// Verifica assinatura + expiração. Retorna { amount, referencePeriod,
// pixCode } ou null (token ausente/malformado/adulterado/expirado —
// nunca lança, o caller decide o 404).
function verifyPixToken(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sig] = parts;
    if (!payloadB64 || !sig) return null;

    const expected = sign(payloadB64);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    if (!payload || typeof payload.e !== 'number' || Date.now() > payload.e) return null;
    if (!payload.p) return null;

    return { amount: payload.a, referencePeriod: payload.c, pixCode: payload.p };
  } catch (_) {
    return null;
  }
}

module.exports = { signPixToken, verifyPixToken };
