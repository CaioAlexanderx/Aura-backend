// ============================================================
// AURA DOJÔ — F3b: cifra da apiKey da subconta Asaas (BaaS)
//
// A criação da subconta (POST /v3/accounts) devolve a apiKey UMA única vez.
// Precisamos guardá-la pra criar cobranças PIX na subconta do dojô depois —
// então ela é cifrada com AES-256-GCM (mesma família da CERT_MASTER_KEY das
// notas). NUNCA é gravada nem logada em texto puro.
//
// Chave: env DOJO_BAAS_ENC_KEY (32 bytes — 64 hex OU base64). A validação da
// chave é LAZY (só quando encrypt/decrypt são chamados de fato, no fluxo
// BaaS), pra não derrubar o boot do app inteiro quando a flag DOJO_BAAS_
// ENABLED está desligada e ninguém usa BaaS. Sem a env, o fluxo BaaS falha
// com erro claro — o resto do billing (pix_manual) continua intacto.
//
// Formato do ciphertext: 'v1:<iv b64>:<tag b64>:<data b64>'.
// ============================================================
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
let _key = null; // cache module-level da chave já validada

function getKey() {
  if (_key) return _key;
  const raw = process.env.DOJO_BAAS_ENC_KEY;
  if (!raw || !String(raw).trim()) {
    throw new Error(
      'DOJO_BAAS_ENC_KEY ausente — obrigatória para cifrar a apiKey da subconta Asaas do dojô (BaaS). ' +
      'Gere: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const s = String(raw).trim();
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    buf = Buffer.from(s, 'hex');
  } else {
    buf = Buffer.from(s, 'base64');
  }
  if (buf.length !== 32) {
    throw new Error('DOJO_BAAS_ENC_KEY inválida: esperado 32 bytes (64 caracteres hex ou base64 de 32 bytes).');
  }
  _key = buf;
  return buf;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decrypt(payload) {
  const key = getKey();
  const parts = String(payload || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('payload cifrado inválido (formato inesperado)');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const data = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
