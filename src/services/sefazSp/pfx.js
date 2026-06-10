// ============================================================
// AURA. — sefazSp/pfx: abre certificado A1 (.pfx/PKCS#12) EM MEMÓRIA
// Roadmap NFC-e própria v1 — S1.3.
//
// REGRAS: o buffer do .pfx e a senha nunca tocam disco nem log.
// Mensagens de erro não ecoam senha/conteúdo.
// ============================================================
'use strict';

const forge = require('node-forge');

/**
 * Abre um .pfx e extrai chave privada + certificado em PEM.
 * @param {Buffer} pfxBuffer
 * @param {string} password
 * @returns {{ keyPem, certPem, certDerBase64, notBefore, notAfter, subjectCN, issuerCN }}
 */
function openPfx(pfxBuffer, password) {
  if (!Buffer.isBuffer(pfxBuffer) || pfxBuffer.length === 0) {
    throw new Error('openPfx: buffer do certificado vazio');
  }
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (_) {
    throw new Error('openPfx: não foi possível abrir o .pfx (senha incorreta ou arquivo corrompido)');
  }

  let keyObj = null;
  const certs = [];
  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
        if (safeBag.key) keyObj = safeBag.key;
      } else if (safeBag.type === forge.pki.oids.certBag && safeBag.cert) {
        certs.push(safeBag.cert);
      }
    }
  }
  if (!keyObj) throw new Error('openPfx: chave privada não encontrada no .pfx');
  if (!certs.length) throw new Error('openPfx: certificado não encontrado no .pfx');

  // Certificado do titular = o que NÃO é CA; fallback: primeiro.
  const leaf = certs.find((c) => {
    const bc = c.getExtension('basicConstraints');
    return !bc || !bc.cA;
  }) || certs[0];

  const cnAttr = leaf.subject.getField('CN');
  const issuerAttr = leaf.issuer.getField('CN');

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes();

  return {
    keyPem: forge.pki.privateKeyToPem(keyObj),
    certPem: forge.pki.certificateToPem(leaf),
    // DER base64 "puro" (sem header PEM) — vai no <X509Certificate>
    certDerBase64: forge.util.encode64(certDer),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter,
    subjectCN: cnAttr ? cnAttr.value : null,
    issuerCN: issuerAttr ? issuerAttr.value : null,
  };
}

/** Valida vigência: lança se expirado/ainda não válido (tolerância 0). */
function assertValidity(info, now = new Date()) {
  if (info.notBefore && now < info.notBefore) {
    throw new Error('Certificado A1 ainda não é válido (notBefore no futuro)');
  }
  if (info.notAfter && now > info.notAfter) {
    throw new Error(`Certificado A1 expirado em ${info.notAfter.toISOString().slice(0, 10)}`);
  }
}

module.exports = { openPfx, assertValidity };
