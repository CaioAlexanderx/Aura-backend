const crypto = require('crypto');
const forge = require('node-forge');

const { openPfx, assertValidity } = require('../../src/services/sefazSp/pfx');
const signer = require('../../src/services/sefazSp/signer');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

const PFX_PASSWORD = 'senha-teste-a1';

/** Gera um A1 de teste (self-signed) em memória, como faria uma AC. */
function makeTestPfx({ expired = false } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 86400e3);
  cert.validity.notAfter = expired
    ? new Date(now.getTime() - 3600e3)
    : new Date(now.getTime() + 365 * 86400e3);
  const attrs = [
    { name: 'commonName', value: 'DAVI CALCADOS LTDA:11222333000181' },
    { name: 'countryName', value: 'BR' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD,
    { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
}

let pfxBuf, certInfo, built;
beforeAll(() => {
  pfxBuf = makeTestPfx();
  certInfo = openPfx(pfxBuf, PFX_PASSWORD);
  built = xb.buildInfNfe(companyDavi, nfceDataVendaTipica,
    { tpAmb: 2, cNF: '12345678', dhEmi: '2026-06-10T10:00:00-03:00' });
});

describe('sefazSp/pfx — abertura do A1 em memória', () => {
  test('extrai chave, certificado, validade e CN', () => {
    expect(certInfo.keyPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(certInfo.certPem).toContain('BEGIN CERTIFICATE');
    expect(certInfo.certDerBase64.length).toBeGreaterThan(100);
    expect(certInfo.subjectCN).toContain('DAVI CALCADOS');
    expect(certInfo.notAfter.getTime()).toBeGreaterThan(Date.now());
  });

  test('senha errada falha sem ecoar a senha', () => {
    expect(() => openPfx(pfxBuf, 'errada')).toThrow(/senha incorreta ou arquivo corrompido/);
    try { openPfx(pfxBuf, 'errada'); } catch (e) {
      expect(e.message).not.toContain('errada');
    }
  });

  test('assertValidity recusa certificado expirado', () => {
    const info = openPfx(makeTestPfx({ expired: true }), PFX_PASSWORD);
    expect(() => assertValidity(info)).toThrow(/expirado/);
  });
});

describe('sefazSp/signer — XMLDSig enveloped do infNFe', () => {
  let signatureXml, nfeXml;
  beforeAll(() => {
    ({ signatureXml } = signer.signInfNfe(built.infNfeXml, {
      keyPem: certInfo.keyPem,
      certDerBase64: certInfo.certDerBase64,
    }));
    nfeXml = xb.composeNfe({ signedInfNfeXml: built.infNfeXml, signatureXml });
  });

  test('estrutura padrão NF-e: C14N inclusivo, RSA-SHA1, enveloped, URI=#NFe+chave', () => {
    expect(signatureXml).toContain(`CanonicalizationMethod Algorithm="${signer.C14N}"`);
    expect(signatureXml).toContain(`SignatureMethod Algorithm="${signer.RSA_SHA1}"`);
    expect(signatureXml).toContain(`Algorithm="${signer.ENVELOPED}"`);
    expect(signatureXml).toContain(`URI="#NFe${built.chave}"`);
    expect(signatureXml).toMatch(/<DigestValue>[A-Za-z0-9+/=]+<\/DigestValue>/);
    expect(signatureXml).toMatch(/<SignatureValue>[\s\S]*?<\/SignatureValue>/);
    expect(signatureXml).toContain('<X509Certificate>');
  });

  test('assinatura verificável por verificador independente (xml-crypto check)', () => {
    const { valid, errors } = signer.verifyNfeSignature(nfeXml);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test('tampering no infNFe invalida a assinatura', () => {
    const tampered = nfeXml.replace('<vNF>549.96</vNF>', '<vNF>1.00</vNF>');
    const { valid } = signer.verifyNfeSignature(tampered);
    expect(valid).toBe(false);
  });

  test('SignatureValue confere com RSA-SHA1 do SignedInfo (verificação fora do xml-crypto)', () => {
    // Extrai SignedInfo, canonicaliza injetando o xmlns do XMLDSig e
    // verifica com o crypto nativo do Node — prova independente.
    const siMatch = signatureXml.match(/<SignedInfo[\s\S]*?<\/SignedInfo>/);
    const sigValB64 = signatureXml.match(/<SignatureValue>([\s\S]*?)<\/SignatureValue>/)[1].replace(/\s+/g, '');
    const signedInfoC14n = siMatch[0]
      .replace('<SignedInfo', '<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"')
      // C14N expande tags self-closed: <X/> → <X></X>
      .replace(/<([A-Za-z][^\s/>]*)([^>]*?)\s*\/>/g, '<$1$2></$1>');
    const verifier = crypto.createVerify('RSA-SHA1');
    verifier.update(signedInfoC14n);
    const certPem = certInfo.certPem;
    expect(verifier.verify(certPem, Buffer.from(sigValB64, 'base64'))).toBe(true);
  });

  test('SHA-256 plugável (NT futura)', () => {
    const { signatureXml: sig256 } = signer.signInfNfe(built.infNfeXml, {
      keyPem: certInfo.keyPem, certDerBase64: certInfo.certDerBase64, sha256: true,
    });
    expect(sig256).toContain(signer.RSA_SHA256);
    const nfe256 = xb.composeNfe({ signedInfNfeXml: built.infNfeXml, signatureXml: sig256 });
    expect(signer.verifyNfeSignature(nfe256).valid).toBe(true);
  });

  test('infNFe sem Id é rejeitado', () => {
    expect(() => signer.signInfNfe('<infNFe versao="4.00"></infNFe>', {
      keyPem: certInfo.keyPem, certDerBase64: certInfo.certDerBase64,
    })).toThrow(/Id="NFe/);
  });
});

describe('sefazSp/certStore — guarda cifrada', () => {
  beforeAll(() => {
    process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  });

  function fakeDb() {
    const store = {};
    return {
      store,
      query: jest.fn(async (sql, params) => {
        if (sql.includes('INSERT INTO company_certificates')) {
          store[params[0]] = {
            pfx_enc: params[1], pfx_iv: params[2], password_enc: params[3],
            not_before: params[4], not_after: params[5], subject_cn: params[6],
          };
          return { rows: [] };
        }
        const row = store[params[0]];
        return { rows: row ? [row] : [] };
      }),
    };
  }

  test('save → load round-trip: pfx e senha idênticos, cifrados no "banco"', async () => {
    const certStore = require('../../src/services/sefazSp/certStore');
    const db = fakeDb();
    const meta = await certStore.saveCertificate(db, 'comp-1', pfxBuf, PFX_PASSWORD);
    expect(meta.subject_cn).toContain('DAVI CALCADOS');

    const stored = db.store['comp-1'];
    expect(stored.pfx_enc.equals(pfxBuf)).toBe(false);          // cifrado
    expect(stored.password_enc).not.toContain(PFX_PASSWORD);    // cifrada

    const loaded = await certStore.loadCertificate(db, 'comp-1');
    expect(loaded.pfx.equals(pfxBuf)).toBe(true);
    expect(loaded.password).toBe(PFX_PASSWORD);
  });

  test('empresa sem certificado: erro orientando upload', async () => {
    const certStore = require('../../src/services/sefazSp/certStore');
    await expect(certStore.loadCertificate(fakeDb(), 'sem-cert'))
      .rejects.toThrow(/não cadastrado/);
  });

  test('senha errada no save não persiste nada', async () => {
    const certStore = require('../../src/services/sefazSp/certStore');
    const db = fakeDb();
    await expect(certStore.saveCertificate(db, 'comp-2', pfxBuf, 'errada'))
      .rejects.toThrow();
    expect(db.store['comp-2']).toBeUndefined();
  });
});
