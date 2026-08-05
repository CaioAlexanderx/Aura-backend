// ============================================================
// Regressão 05/08/2026 — a 1ª devolução real da engine própria (NF-e 55,
// troca a5842443-836e-4302-87f2-c55b8768132a, Davi Villa Branca, 04/08
// 21:35 UTC) foi rejeitada pela SEFAZ-SP com "225 - Rejeição: Falha no
// Schema XML do lote de NFe": buildIde55Xml colocava <NFref> logo após
// <cMunFG> (comentário antigo dizia "posição B12a"), mas o grupo NFref é
// o ÚLTIMO elemento da sequência de <ide> (depois de verProc) no
// leiauteNFe_v4.00.xsd.
//
// xsdValidation.test.js já valida XML real contra o XSD oficial (PL_010c)
// só que exclusivamente pra xmlBuilder.buildInfNfe (modelo 65 — NFC-e); a
// 55 de devolução (nfe55.buildInfNfe55Devolucao) nunca teve esse mesmo
// crivo, e foi exatamente por isso que o bug só apareceu na SEFAZ real.
// Este arquivo fecha essa lacuna espelhando o mesmo mecanismo (xmllint).
// Pula com aviso se schemas/ ou xmllint não estiverem disponíveis.
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const forge = require('node-forge');

const SCHEMAS_DIR = path.join(__dirname, '../../schemas/PL_010c_NT2022_002v1.30');
const NFE_XSD = path.join(SCHEMAS_DIR, 'nfe_v4.00.xsd');

function hasXmllint() {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const available = fs.existsSync(NFE_XSD) && hasXmllint();
const d = available ? describe : describe.skip;
if (!available) {
  console.warn('[xsdValidationNfe55] PULADO — schemas/PL_010c ou xmllint ausentes');
}

d('Validação XSD oficial — NF-e 55 de devolução (engine própria)', () => {
  const { buildInfNfe55Devolucao } = require('../../src/services/sefazSp/nfe55');
  const { composeNfe } = require('../../src/services/sefazSp/xmlBuilder');
  const { signInfNfe } = require('../../src/services/sefazSp/signer');
  const { companyDavi } = require('../fixtures/nfceDavi');

  let cert;
  beforeAll(() => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const c = forge.pki.createCertificate();
    c.publicKey = keys.publicKey; c.serialNumber = '06';
    c.validity.notBefore = new Date(Date.now() - 864e5);
    c.validity.notAfter = new Date(Date.now() + 365 * 864e5);
    const attrs = [{ name: 'commonName', value: 'TESTE' }];
    c.setSubject(attrs); c.setIssuer(attrs);
    c.sign(keys.privateKey, forge.md.sha256.create());
    cert = {
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
      certDerBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()),
    };
  });

  function validate(nfeXml) {
    const tmp = path.join(os.tmpdir(), `nfe55-xsd-${crypto.randomBytes(6).toString('hex')}.xml`);
    fs.writeFileSync(tmp, '<?xml version="1.0" encoding="UTF-8"?>' + nfeXml);
    try {
      execFileSync('xmllint', ['--noout', '--schema', NFE_XSD, tmp], { stdio: 'pipe' });
      return { valid: true, errors: '' };
    } catch (e) {
      return { valid: false, errors: String(e.stderr || e.message) };
    } finally {
      fs.unlinkSync(tmp);
    }
  }

  function buildDevolucao55(data, opts = {}) {
    const built = buildInfNfe55Devolucao(companyDavi, data, { tpAmb: 2, ...opts });
    const { signatureXml } = signInfNfe(built.infNfeXml, cert);
    return composeNfe({ signedInfNfeXml: built.infNfeXml, infNfeSuplXml: '', signatureXml });
  }

  test('devolução de troca (1 item, refNFe de 44 dígitos da NFC-e original): valida', () => {
    const r = validate(buildDevolucao55({
      items: [{
        code: 'a1', name: 'Azaleia Rasteirinha Amarelo', ncm: '64022000',
        quantity: 1, price: 89.99, barcode: '7891234567895',
      }],
      refNFe: '35260747123119000204650300000000281951475443',
      serie: 1,
      numero: 1,
      natureza_operacao: 'devolucao de mercadoria adquirida por nao contribuinte',
      infAdFisco: 'Devolucao de mercadoria referente a NFC-e chave 35260747123119000204650300000000281951475443.',
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });

  test('devolução multi-item com desconto (crt=1 + tpAmb=2 força grupo IBSCBS): valida', () => {
    const r = validate(buildDevolucao55({
      items: [
        { code: 'b2', name: 'Activita Tenis Gaspea Preto - 40', ncm: '64041100', quantity: 2, price: 159.99, discount: 10 },
        { code: 'c3', name: 'Bolsa Arezzo Croco', ncm: '42029220', quantity: 1, price: 149.99 },
      ],
      refNFe: '35260747123119000204650300000000281951475443',
      serie: 1,
      numero: 2,
      infAdFisco: 'Devolucao de mercadoria.',
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });
});
