// ============================================================
// AURA. — sefazSp/certStore: guarda/recupera certificado A1 cifrado
// (tabela company_certificates, migration 234) — S1.3.
//
// Fluxo: upload (.pfx base64 + senha) → valida abrindo em memória →
// cifra AES-256-GCM (secretCrypto, chave em env.CERT_MASTER_KEY) → upsert.
// Load: decifra e devolve { pfx (Buffer), password } só em memória.
// NUNCA: log de conteúdo/senha, escrita em disco, retorno em rota.
// ============================================================
'use strict';

const { encryptBuffer, decryptBuffer, encryptString, decryptString } = require('../../utils/secretCrypto');
const { openPfx, assertValidity } = require('./pfx');

/**
 * Valida e armazena (upsert) o certificado da empresa.
 * @param db — pool/cliente pg (mesma interface de config/database)
 * @returns metadados públicos (sem segredos) p/ exibição
 */
async function saveCertificate(db, companyId, pfxBuffer, password) {
  const info = openPfx(pfxBuffer, password);   // valida senha + extrai validade
  assertValidity(info);                        // recusa certificado já expirado

  const { enc, iv } = encryptBuffer(pfxBuffer);
  const passwordEnc = encryptString(password);

  await db.query(
    `INSERT INTO company_certificates
       (company_id, pfx_enc, pfx_iv, password_enc, not_before, not_after, subject_cn)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id) DO UPDATE SET
       pfx_enc=$2, pfx_iv=$3, password_enc=$4,
       not_before=$5, not_after=$6, subject_cn=$7, updated_at=NOW()`,
    [companyId, enc, iv, passwordEnc, info.notBefore, info.notAfter, info.subjectCN]
  );

  return {
    subject_cn: info.subjectCN,
    issuer_cn: info.issuerCN,
    not_before: info.notBefore,
    not_after: info.notAfter,
  };
}

/**
 * Recupera e decifra o certificado da empresa (em memória).
 * @returns {{ pfx: Buffer, password: string, notAfter: Date, subjectCN: string }}
 */
async function loadCertificate(db, companyId) {
  const { rows } = await db.query(
    `SELECT pfx_enc, pfx_iv, password_enc, not_after, subject_cn
       FROM company_certificates WHERE company_id=$1`,
    [companyId]
  );
  if (!rows.length) {
    throw new Error('Certificado A1 não cadastrado para esta empresa. Envie o .pfx em Configurações > Nota Fiscal.');
  }
  const row = rows[0];
  const pfx = decryptBuffer(row.pfx_enc, row.pfx_iv);
  const password = decryptString(row.password_enc);
  if (row.not_after && new Date() > new Date(row.not_after)) {
    throw new Error(`Certificado A1 expirado em ${new Date(row.not_after).toISOString().slice(0, 10)}. Renove o certificado.`);
  }
  return { pfx, password, notAfter: row.not_after, subjectCN: row.subject_cn };
}

/** Metadados públicos (sem decifrar) p/ UI/alertas de expiração. */
async function getCertificateInfo(db, companyId) {
  const { rows } = await db.query(
    `SELECT subject_cn, not_before, not_after, updated_at
       FROM company_certificates WHERE company_id=$1`,
    [companyId]
  );
  return rows[0] || null;
}

module.exports = { saveCertificate, loadCertificate, getCertificateInfo };
