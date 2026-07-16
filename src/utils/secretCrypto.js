// ============================================================
// AURA. — secretCrypto: AES-256-GCM para segredos fiscais
// (certificado A1 .pfx, senha do .pfx, CSC token)
//
// Chave-mestra: env.CERT_MASTER_KEY — 64 chars hex (32 bytes).
// Gerar com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// REGRAS (item de segurança nº 1 do projeto NFC-e própria):
// - A chave NUNCA vai pro banco, pro log ou pro Sentry.
// - Plaintext (pfx/senha/CSC) NUNCA é logado nem escrito em disco.
// - Erros de decrypt não incluem o payload na mensagem.
//
// Formatos:
// - String: envelope 'v1:<iv b64>:<tag b64>:<cipher b64>'
// - Buffer: { enc: Buffer(cipher||tag), iv: Buffer(12) } — colunas
//   pfx_enc/pfx_iv de company_certificates (tag = 16 bytes finais).
// ============================================================
'use strict';

const crypto = require('crypto');

const IV_LEN = 12;   // recomendado p/ GCM
const TAG_LEN = 16;

function getMasterKey() {
  const hex = process.env.CERT_MASTER_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    // Mensagem sem ecoar o valor recebido.
    throw new Error('CERT_MASTER_KEY ausente ou inválida (esperado: 64 chars hex). Necessária para cifrar/decifrar segredos fiscais.');
  }
  return Buffer.from(hex, 'hex');
}

/** true se CERT_MASTER_KEY está presente e bem-formada */
function hasMasterKey() {
  return /^[0-9a-fA-F]{64}$/.test(process.env.CERT_MASTER_KEY || '');
}

// ---------- Strings (csc_token, senha do pfx) ----------

function encryptString(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('encryptString: plaintext vazio');
  }
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptString(envelope) {
  if (typeof envelope !== 'string' || !envelope.startsWith('v1:')) {
    throw new Error('decryptString: envelope inválido (esperado v1:iv:tag:cipher)');
  }
  const parts = envelope.split(':');
  if (parts.length !== 4) throw new Error('decryptString: envelope malformado');
  const key = getMasterKey();
  const iv  = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const enc = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    // GCM auth falhou: chave errada ou dado corrompido. Não ecoar payload.
    throw new Error('decryptString: falha de autenticação (chave incorreta ou dado corrompido)');
  }
}

/** Detecta se um valor já está no envelope cifrado (p/ backfill idempotente). */
function isEncrypted(value) {
  return typeof value === 'string' && /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(value);
}

// ---------- Buffers (.pfx) ----------

function encryptBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error('encryptBuffer: buffer vazio');
  }
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final(), cipher.getAuthTag()]);
  return { enc, iv }; // enc = cipher || tag(16)
}

function decryptBuffer(enc, iv) {
  if (!Buffer.isBuffer(enc) || enc.length <= TAG_LEN) {
    throw new Error('decryptBuffer: ciphertext inválido');
  }
  const key = getMasterKey();
  const tag = enc.subarray(enc.length - TAG_LEN);
  const body = enc.subarray(0, enc.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (_) {
    throw new Error('decryptBuffer: falha de autenticação (chave incorreta ou dado corrompido)');
  }
}

module.exports = {
  hasMasterKey, encryptString, decryptString, isEncrypted,
  encryptBuffer, decryptBuffer,
};
