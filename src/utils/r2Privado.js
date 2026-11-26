// ============================================================
// AURA. — Bucket PRIVADO no R2 (dado de saúde: foto da receita da ótica)
//
// 23/11/2026 (p-212). O bucket de r2Storage.js (R2_BUCKET_NAME) é servido
// em público por R2_PUBLIC_URL: é onde moram as fotos de produto, e
// qualquer chave dele abre por link direto. A foto da receita é dado de
// saúde (LGPD, art. 5º, II) e NÃO pode ir para lá.
//
// Aqui fica um bucket separado, sem domínio público, lido SÓ por URL
// assinada de vida curta. Configuração (Railway):
//   R2_PRIVATE_BUCKET_NAME   nome do bucket privado (obrigatório)
// As credenciais são as mesmas do r2Storage (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY); o token precisa ter acesso de leitura e escrita ao
// bucket novo.
//
// Sem R2_PRIVATE_BUCKET_NAME (ou sem credenciais), disponivel() é false: a
// ótica não anuncia capabilities.prescription_photo e as rotas de foto
// respondem 503. Diferente do r2Storage, aqui NÃO há modo mock nem queda
// para URL pública: se assinar falhar, a URL é null.
// ============================================================
'use strict';

function config() {
  return {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKey: process.env.R2_ACCESS_KEY_ID,
    secretKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_PRIVATE_BUCKET_NAME,
  };
}

function disponivel() {
  const c = config();
  // O bucket privado nunca pode ser o mesmo bucket público.
  const publico = process.env.R2_BUCKET_NAME || 'aura-storage';
  return !!(c.accountId && c.accessKey && c.secretKey && c.bucket && c.bucket !== publico);
}

let _client = null;
let _clientKey = null;
function client() {
  if (!disponivel()) return null;
  const c = config();
  const chave = [c.accountId, c.accessKey, c.bucket].join('|');
  if (_client && _clientKey === chave) return _client;
  const { S3Client } = require('@aws-sdk/client-s3');
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${c.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: c.accessKey, secretAccessKey: c.secretKey },
  });
  _clientKey = chave;
  return _client;
}

/** Grava o buffer. { ok: true } | { ok: false } (nunca joga). */
async function enviar(key, buffer, contentType) {
  const s3 = client();
  if (!s3) return { ok: false };
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: config().bucket, Key: key, Body: buffer, ContentType: contentType,
      CacheControl: 'private, no-store',
    }));
    return { ok: true };
  } catch (err) {
    console.error('[r2Privado] envio falhou:', err.message);
    return { ok: false };
  }
}

/** URL assinada de leitura (padrão 15 min) ou null. Nunca URL pública. */
async function urlAssinada(key, segundos = 900, signingDate = undefined) {
  const s3 = client();
  if (!s3 || !key) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: config().bucket, Key: key }), { expiresIn: segundos, ...(signingDate ? { signingDate } : {}) });
  } catch (err) {
    console.error('[r2Privado] assinatura falhou:', err.message);
    return null;
  }
}

/** Apaga a chave. { ok } (nunca joga). */
async function apagar(key) {
  const s3 = client();
  if (!s3 || !key) return { ok: false };
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: config().bucket, Key: key }));
    return { ok: true };
  } catch (err) {
    console.error('[r2Privado] remocao falhou:', err.message);
    return { ok: false };
  }
}

module.exports = { disponivel, enviar, urlAssinada, apagar };
