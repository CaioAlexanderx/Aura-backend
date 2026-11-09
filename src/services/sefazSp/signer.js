// ============================================================
// AURA. — sefazSp/signer: assinatura XMLDSig enveloped do infNFe
// Roadmap NFC-e própria v1 — S1.3.
//
// Padrão de assinatura NF-e/NFC-e (MOC, assinatura ICP-Brasil):
// - Reference URI = "#NFe<chave>" (atributo Id do infNFe)
// - Transforms: enveloped-signature + C14N INCLUSIVO (REC-xml-c14n-20010315)
// - CanonicalizationMethod: C14N inclusivo
// - SignatureMethod: RSA-SHA1 (padrão vigente do leiaute 4.00; SHA-256
//   plugável via opts.sha256 se NT futura exigir)
// - KeyInfo > X509Data > X509Certificate (certificado do titular)
//
// O .pfx é aberto EM MEMÓRIA (pfx.js) — nunca em disco, nunca logado.
// ============================================================
'use strict';

const { SignedXml } = require('xml-crypto');
const { NFE_NS } = require('./xmlBuilder');

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

/**
 * Assina o infNFe e devolve o elemento <Signature> isolado.
 * @param {string} infNfeXml — '<infNFe xmlns=... Id="NFe..." versao="4.00">...</infNFe>'
 * @param {{ keyPem: string, certDerBase64: string, sha256?: boolean }} opts
 * @returns {{ signatureXml: string }}
 */
function signInfNfe(infNfeXml, { keyPem, certDerBase64, sha256 = false }) {
  if (!infNfeXml || !infNfeXml.includes('Id="NFe')) {
    throw new Error('signer: infNfeXml sem atributo Id="NFe<chave>"');
  }
  if (!keyPem) throw new Error('signer: keyPem obrigatória');
  if (!certDerBase64) throw new Error('signer: certDerBase64 obrigatório');

  // Assina dentro de um wrapper <NFe> (estrutura final). O transform
  // enveloped + Reference por Id garantem que o digest cobre só o infNFe.
  const wrapper = `<NFe xmlns="${NFE_NS}">${infNfeXml}</NFe>`;

  const sig = new SignedXml({
    privateKey: keyPem,
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: sha256 ? RSA_SHA256 : RSA_SHA1,
    // KeyInfo do padrão NF-e: só X509Certificate
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certDerBase64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: "//*[local-name(.)='infNFe']",
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: sha256 ? SHA256 : SHA1,
  });

  sig.computeSignature(wrapper, {
    location: { reference: "//*[local-name(.)='infNFe']", action: 'after' },
  });

  const signed = sig.getSignedXml();
  const m = signed.match(/<Signature[\s\S]*<\/Signature>/);
  if (!m) throw new Error('signer: assinatura não gerada');
  const signatureXml = m[0];

  if (!signatureXml.includes('URI="#NFe')) {
    throw new Error('signer: Reference URI não aponta pro Id do infNFe');
  }
  return { signatureXml };
}

/**
 * Verificação independente (testes/auditoria): valida a assinatura de um
 * <NFe> assinado usando o certificado embutido no KeyInfo.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function verifyNfeSignature(nfeXml) {
  const certMatch = nfeXml.match(/<X509Certificate>([\s\S]*?)<\/X509Certificate>/);
  if (!certMatch) return { valid: false, errors: ['X509Certificate ausente no KeyInfo'] };
  const certPem = '-----BEGIN CERTIFICATE-----\n'
    + certMatch[1].replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim()
    + '\n-----END CERTIFICATE-----\n';

  const sigMatch = nfeXml.match(/<Signature[\s\S]*<\/Signature>/);
  if (!sigMatch) return { valid: false, errors: ['Signature ausente'] };

  try {
    const sig = new SignedXml({ publicCert: certPem });
    sig.loadSignature(sigMatch[0]);
    const valid = sig.checkSignature(nfeXml);
    return { valid, errors: valid ? [] : ['assinatura inválida'] };
  } catch (e) {
    return { valid: false, errors: [e.message] };
  }
}

/**
 * 09/11/2026 (NFS-e Nacional): assinatura enveloped GENÉRICA de um elemento
 * com atributo Id, para documentos que não são NF-e (DPS e pedido de evento
 * do Sistema Nacional NFS-e). signInfNfe acima fica intocada — a NFC-e/NF-e
 * continua byte a byte igual.
 *
 * Mesmo padrão do signInfNfe (enveloped + C14N inclusivo + KeyInfo só com
 * X509Certificate). A <Signature> entra como ÚLTIMO filho da raiz, que é o
 * lugar que os XSD do padrão nacional pedem (TCDPS: infDPS, ds:Signature).
 *
 * @param {string} xml — documento completo, sem declaração <?xml?>
 * @param {{ elementName: string, keyPem: string, certDerBase64: string, sha256?: boolean }} opts
 * @returns {string} documento assinado
 */
function signElementById(xml, { elementName, keyPem, certDerBase64, sha256 = true } = {}) {
  if (!elementName) throw new Error('signer: elementName obrigatório');
  const idMatch = String(xml || '').match(new RegExp(`<${elementName}\\b[^>]*\\bId="([^"]+)"`));
  if (!idMatch) throw new Error(`signer: <${elementName}> sem atributo Id`);
  if (!keyPem) throw new Error('signer: keyPem obrigatória');
  if (!certDerBase64) throw new Error('signer: certDerBase64 obrigatório');

  const root = String(xml).match(/^\s*<([A-Za-z_][\w.-]*)/);
  if (!root) throw new Error('signer: documento sem elemento raiz');

  const sig = new SignedXml({
    privateKey: keyPem,
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: sha256 ? RSA_SHA256 : RSA_SHA1,
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certDerBase64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: `//*[local-name(.)='${elementName}']`,
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: sha256 ? SHA256 : SHA1,
  });
  sig.computeSignature(xml, {
    location: { reference: `/*[local-name(.)='${root[1]}']`, action: 'append' },
  });
  const signed = sig.getSignedXml();
  if (!signed.includes(`URI="#${idMatch[1]}"`)) {
    throw new Error(`signer: Reference URI não aponta pro Id do <${elementName}>`);
  }
  return signed;
}

module.exports = {
  signInfNfe, verifyNfeSignature, signElementById,
  C14N, ENVELOPED, RSA_SHA1, SHA1, RSA_SHA256, SHA256,
};
