const crypto = require('crypto');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const sefazSp = require('../../src/services/sefazSp');
const { signInfNfe, verifyNfeSignature } = require('../../src/services/sefazSp/signer');
const { encryptBuffer, encryptString } = require('../../src/utils/secretCrypto');
const { SefazTransportError } = require('../../src/services/sefazSp/soapClient');
const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

const PFX_PASSWORD = 'senha-a1';

function makeTestPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'DAVI CALCADOS LTDA:11222333000181' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD, { algorithm: '3des' })
  ).getBytes(), 'binary');
}

const pfxBuf = makeTestPfx();
const { enc, iv } = encryptBuffer(pfxBuf);

function fakeDb() {
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM company_certificates')) {
        return { rows: [{ pfx_enc: enc, pfx_iv: iv, password_enc: encryptString(PFX_PASSWORD), not_after: new Date(Date.now() + 365 * 86400e3), subject_cn: 'DAVI' }] };
      }
      return { rows: [] };
    }),
  };
}

const CONFIG = {
  company_id: companyDavi.id, uf: 'SP', ambiente: 'homologacao',
  serie_nfce: 1, csc_id: '000001',
  csc_token_enc: encryptString('TOKEN-CSC-HOMOLOG'),
  provider: 'sefaz_sp',
};

function soapOk(chave) {
  return {
    status: 200,
    body: '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
      + '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><tpAmb>2</tpAmb><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
      + `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><nProt>135260000000099</nProt><dhRecbto>2026-06-10T10:00:05-03:00</dhRecbto><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`
      + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>',
  };
}

describe('sefazSp.emitNfce — fim-a-fim (SOAP mockado)', () => {
  test('caminho feliz: monta, assina, QR, transmite, normaliza pro shape do gateway', async () => {
    const sent = [];
    const transport = async (url, envelope) => {
      sent.push({ url, envelope });
      const chave = envelope.match(/Id="NFe(\d{44})"/)[1];
      return soapOk(chave);
    };

    const r = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db: fakeDb(), config: CONFIG, transport });

    // shape de gateway (extractProvFields)
    expect(r.status).toBe('autorizado');
    expect(r.codigo_status).toBe('100');
    expect(r.protocolo).toBe('135260000000099');
    expect(r.chave_acesso).toMatch(/^\d{44}$/);
    expect(r.qr_code).toContain('homologacao.nfce.fazenda.sp.gov.br/qrcode?p=');
    expect(r.qr_code).not.toContain('TOKEN-CSC-HOMOLOG');
    expect(r.tp_emis).toBe(1);

    // XML transmitido: NFe completo c/ infNFeSupl entre infNFe e Signature,
    // assinatura verificável
    const envelope = sent[0].envelope;
    expect(sent[0].url).toContain('homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4');
    expect(envelope).toContain('<indSinc>1</indSinc>');
    const nfeXml = r.xml_signed;
    expect(nfeXml.indexOf('<infNFe')).toBeLessThan(nfeXml.indexOf('<infNFeSupl>'));
    expect(nfeXml.indexOf('<infNFeSupl>')).toBeLessThan(nfeXml.indexOf('<Signature'));
    expect(verifyNfeSignature(nfeXml).valid).toBe(true);
    expect(envelope).toContain(nfeXml);
  });

  test('timeout ambíguo + consulta diz autorizada → sucesso sem reemitir', async () => {
    let call = 0;
    const transport = async (url, envelope) => {
      call++;
      if (call === 1) throw new Error('timeout após 30000ms'); // autorização
      // consulta por chave
      const chave = envelope.match(/<chNFe>(\d{44})<\/chNFe>/)[1];
      return {
        status: 200,
        body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
          + '<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>100</cStat><xMotivo>Autorizado</xMotivo>'
          + `<protNFe><infProt><chNFe>${chave}</chNFe><nProt>135260000000777</nProt><cStat>100</cStat></infProt></protNFe>`
          + '</retConsSitNFe></nfeResultMsg></soap:Body></soap:Envelope>',
      };
    };
    const r = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db: fakeDb(), config: CONFIG, transport });
    expect(r.status).toBe('autorizado');
    expect(r.protocolo).toBe('135260000000777');
  });

  test('timeout ambíguo + consulta 217 (não consta) → erro ambíguo preservado, mesmo número reutilizável', async () => {
    let call = 0;
    const transport = async () => {
      call++;
      if (call === 1) throw new Error('ECONNRESET');
      return {
        status: 200,
        body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
          + '<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>217</cStat><xMotivo>Nao consta</xMotivo></retConsSitNFe>'
          + '</nfeResultMsg></soap:Body></soap:Envelope>',
      };
    };
    await expect(sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db: fakeDb(), config: CONFIG, transport }))
      .rejects.toMatchObject({ name: 'SefazTransportError', ambiguous: true });
  });

  test('rejeição da SEFAZ: status=rejeitado com cStat/motivo', async () => {
    const transport = async (url, envelope) => {
      const chave = envelope.match(/Id="NFe(\d{44})"/)[1];
      return {
        status: 200,
        body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
          + '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
          + `<protNFe><infProt><chNFe>${chave}</chNFe><cStat>778</cStat><xMotivo>Informado NCM inexistente</xMotivo></infProt></protNFe>`
          + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>',
      };
    };
    const r = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db: fakeDb(), config: CONFIG, transport });
    expect(r.status).toBe('rejeitado');
    expect(r.codigo_status).toBe('778');
    expect(r.motivo_status).toContain('NCM');
  });

  test('CSC legado em claro ainda funciona (até o backfill)', async () => {
    const cfg = { ...CONFIG, csc_token_enc: null, csc_token: 'TOKEN-CLARO' };
    const transport = async (url, envelope) => soapOk(envelope.match(/Id="NFe(\d{44})"/)[1]);
    const r = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db: fakeDb(), config: cfg, transport });
    expect(r.status).toBe('autorizado');
  });

  test('sem certificado salvo: erro orientando configuração', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(sefazSp.emitNfce(companyDavi, nfceDataVendaTipica,
      { db, config: CONFIG, transport: async () => { throw new Error('não deveria chamar'); } }))
      .rejects.toThrow(/não cadastrado/);
  });
});
