// ============================================================
// AURA. — tests/helpers/certA1Teste: A1 de MENTIRA para testes (autoassinado,
// gerado na hora com node-forge). CN no padrão ICP "RAZAO:CNPJ" para o
// certCnpj achar o CNPJ. Nunca é um certificado real.
// ============================================================
'use strict';

const forge = require('node-forge');

let cache = null;

function gerarA1({ cnpj = '11222333000181', senha = 'senha-teste', dias = 365 } = {}) {
  if (cache && cache.cnpj === cnpj && cache.senha === senha && cache.dias === dias) return cache;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey;
  c.serialNumber = '0a';
  c.validity.notBefore = new Date(Date.now() - 864e5);
  c.validity.notAfter = new Date(Date.now() + dias * 864e5);
  const attrs = [{ name: 'commonName', value: `EMPRESA TESTE LTDA:${cnpj}` }];
  c.setSubject(attrs);
  c.setIssuer(attrs);
  c.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [c], senha, { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
  cache = {
    cnpj, senha, dias, pfx,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(c),
    certDerBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()),
    notAfter: c.validity.notAfter,
  };
  return cache;
}

module.exports = { gerarA1 };
