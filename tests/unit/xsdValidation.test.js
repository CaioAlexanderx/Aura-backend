// ============================================================
// S1.2/S2 — Validação do XML gerado contra o XSD OFICIAL (PL_010c).
// Regra do roadmap: nota só sai se valida local primeiro.
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
  console.warn('[xsdValidation] PULADO — schemas/PL_010c ou xmllint ausentes');
}

d('Validação XSD oficial (PL_010c, leiaute 4.00)', () => {
  const xb = require('../../src/services/sefazSp/xmlBuilder');
  const { signInfNfe } = require('../../src/services/sefazSp/signer');
  const { buildQrCodeUrl, buildInfNfeSupl } = require('../../src/services/sefazSp/qrcode');
  const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

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
    const tmp = path.join(os.tmpdir(), `nfce-xsd-${crypto.randomBytes(6).toString('hex')}.xml`);
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

  function buildNfe(data, opts = {}) {
    const built = xb.buildInfNfe(companyDavi, data, { tpAmb: 2, ...opts });
    const { signatureXml } = signInfNfe(built.infNfeXml, cert);
    // contingência usa o DigestValue REAL da assinatura (b64 28 chars)
    const digVal = signatureXml.match(/<DigestValue>([^<]+)<\/DigestValue>/)[1];
    const qr = buildQrCodeUrl({
      chave: built.chave, tpAmb: 2, cscId: '1', cscToken: 'tok',
      qrCodeBase: 'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode',
      tpEmis: opts.tpEmis, dhEmi: built.dhEmi, vNF: data.total_value, digVal,
    });
    return xb.composeNfe({
      signedInfNfeXml: built.infNfeXml,
      infNfeSuplXml: buildInfNfeSupl({ qrCodeUrl: qr, urlConsulta: 'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta' }),
      signatureXml,
    });
  }

  test('venda típica do Davi (multi-pagamento, desconto, CPF): valida', () => {
    const r = validate(buildNfe(nfceDataVendaTipica));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });

  test('consumidor não identificado, 1 item, dinheiro: valida', () => {
    const r = validate(buildNfe({
      items: [{ name: 'Item X', ncm: '64022000', quantity: 1, price: 10 }],
      payments: [{ method: '01', value: 10 }],
      total_value: 10, serie: 1, numero: 7,
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });

  test('contingência offline (tpEmis=9, dhCont/xJust): valida', () => {
    const r = validate(buildNfe(nfceDataVendaTipica, {
      tpEmis: 9, dhCont: '2026-06-10T10:05:00-03:00',
      xJust: 'Falha de comunicacao com a SEFAZ-SP detectada pelo monitor',
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });

  test('quantidade fracionada e cartão: valida', () => {
    const r = validate(buildNfe({
      items: [{ name: 'Meia', ncm: '61159500', quantity: 1.5, price: 9.99 }],
      payments: [{ method: '03', value: 14.99 }],
      total_value: 14.99, serie: 1, numero: 8,
    }));
    expect(r.errors).toBe('');
    expect(r.valid).toBe(true);
  });
});
