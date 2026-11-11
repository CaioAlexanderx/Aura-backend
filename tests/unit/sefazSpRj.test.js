'use strict';
// ============================================================
// 11/11/2026 — RJ na engine própria de NFC-e (modelo 65), pela SVRS.
// Prova:
//   1. RJ funciona: webservices da SVRS (os mesmos do AP), QR Code e
//      urlChave do RJ, cUF 33 na chave e no XML, sem flag nova.
//   2. SP, AP e MG NÃO mudaram: objetos de endpoints com o mesmo hash dos de
//      origin/main (antes desta mudança) e o XML de SP/AP segue no golden
//      byte a byte de sefazSpMg.test.js.
//   3. UF ainda sem emissão própria (ex.: BA): erro tipado p/ as rotas e
//      texto gentil para o lojista.
// Empresa e documentos FICTÍCIOS.
// ============================================================
const crypto = require('crypto');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = process.env.CERT_MASTER_KEY || crypto.randomBytes(32).toString('hex');

const {
  getEndpoints, ENDPOINTS, SVRS_NFCE_WS, soapActionFor,
  UfNaoSuportadaError, ufSuportada, mensagemUfNaoSuportada,
} = require('../../src/services/sefazSp/endpoints');
const { getEndpoints55 } = require('../../src/services/sefazSp/nfe55');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { ufToCodigo } = require('../../src/services/sefazSp/nfeHelpers');
const contingency = require('../../src/services/sefazSp/contingency');
const sefazSp = require('../../src/services/sefazSp');
const { verifyNfeSignature } = require('../../src/services/sefazSp/signer');
const { encryptBuffer, encryptString } = require('../../src/utils/secretCrypto');

const QR_RJ = 'https://consultadfe.fazenda.rj.gov.br/consultaNFCe/QRCode';
const CHAVE_RJ = 'https://www.fazenda.rj.gov.br/nfce/consulta';

// Loja fictícia no RJ (capital, IBGE 3304557). CNPJ válido por DV, de teste.
const companyRj = {
  id: '00000000-0000-4000-8000-000000000033',
  cnpj: '11222333000181',
  legal_name: 'Loja Teste RJ Ltda',
  trade_name: 'Loja Teste RJ',
  address_street: 'Rua de Teste', address_number: '10', address_neighborhood: 'Centro',
  address_city: 'Rio de Janeiro', address_state: 'RJ', address_zip: '20010000',
  ibge_code: '3304557', inscricao_estadual: '12345678', phone: '(21) 3000-0000',
  tax_regime: 'simples_nacional',
};

const nfceData = {
  items: [
    { product_id: 'p1', code: 'p1', name: 'Produto Teste A', ncm: '64022000', cfop: '5102', unit: 'UN', quantity: 1, price: 50 },
    { product_id: 'p2', code: 'p2', name: 'Produto Teste B', ncm: '42029220', cfop: '5102', unit: 'UN', quantity: 2, price: 25, discount: 5 },
  ],
  payments: [{ method: '01', value: 95, indPag: 0 }],
  total_value: 95, serie: 1, numero: 7,
};

// O xmlBuilder lê alguns NFCE_* do ambiente (taxEngine) — isola o teste.
let savedEnv;
beforeAll(() => {
  savedEnv = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('NFCE_') || k.startsWith('AURA_RESP_TEC_')) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  }
});
afterAll(() => { Object.assign(process.env, savedEnv); });

const SERVICOS = ['autorizacao', 'retAutorizacao', 'statusServico', 'consultaProtocolo', 'recepcaoEvento', 'inutilizacao'];

describe('endpoints — RJ pela SVRS', () => {
  test('homologação: os 6 webservices da SVRS (portal DF-e SVRS), QR e urlChave do RJ', () => {
    const h = getEndpoints('RJ', 'homologacao');
    expect(h.autorizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(h.retAutorizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx');
    expect(h.statusServico).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
    expect(h.consultaProtocolo).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx');
    expect(h.recepcaoEvento).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx');
    expect(h.inutilizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx');
    expect(h.qrCodeBase).toBe(QR_RJ);
    expect(h.urlConsulta).toBe(CHAVE_RJ);
  });

  test('produção: SVRS de produção, mesmo QR e urlChave (ENCAT: iguais nos dois ambientes)', () => {
    const p = getEndpoints('RJ', 1);
    expect(p.autorizacao).toBe('https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(p.retAutorizacao).toBe('https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx');
    expect(p.statusServico).toBe('https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
    expect(p.consultaProtocolo).toBe('https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx');
    expect(p.recepcaoEvento).toBe('https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx');
    expect(p.inutilizacao).toBe('https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx');
    expect(p.qrCodeBase).toBe(QR_RJ);
    expect(p.urlConsulta).toBe(CHAVE_RJ);
    for (const k of SERVICOS) expect(p[k]).not.toMatch(/homologacao/);
  });

  test('webservices do RJ = os do AP (mesma SVRS); só QR/urlChave diferem', () => {
    for (const amb of ['homologacao', 'producao']) {
      for (const k of SERVICOS) {
        expect(ENDPOINTS.RJ[amb][k]).toBe(ENDPOINTS.AP[amb][k]);
        expect(ENDPOINTS.RJ[amb][k]).toBe(SVRS_NFCE_WS[amb][k]);
      }
      expect(ENDPOINTS.RJ[amb].qrCodeBase).not.toBe(ENDPOINTS.AP[amb].qrCodeBase);
    }
  });

  test('RJ sem flag nova (sem SOAPAction, sem infRespTec) — caminho do AP', () => {
    for (const amb of ['homologacao', 'producao']) {
      expect(ENDPOINTS.RJ[amb].soapAction).toBeUndefined();
      expect(ENDPOINTS.RJ[amb].infRespTec).toBeUndefined();
      expect(soapActionFor(ENDPOINTS.RJ[amb], 'autorizacao')).toBeNull();
    }
  });

  test('aceita minúsculas e tpAmb numérico', () => {
    expect(getEndpoints('rj', 2).autorizacao).toContain('nfce-homologacao.svrs.rs.gov.br');
  });
});

describe('endpoints — SP, AP e MG idênticos aos de antes', () => {
  // sha256 de cada objeto (chaves ordenadas), gerado com o endpoints.js de
  // origin/main (012c4fb2), antes desta mudança.
  function stable(o) {
    if (o && typeof o === 'object') {
      return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
    }
    return JSON.stringify(o);
  }
  const GOLDEN = {
    SP: '2287810dfaa7929c3e571838ae2bf8ee1a2eecd2c5bde0345349b4d59b579100',
    AP: 'bef7e4c221cad626ff7ede2e22fb693d66e05ebc865abd58d855c3d8f1cd40f7',
    MG: '540b72c39509b5cf20b7dd2548f0040041b63fe9fc50701413e8c69c88b01d38',
  };
  for (const [uf, hash] of Object.entries(GOLDEN)) {
    test(`${uf}: mesmo objeto de endpoints`, () => {
      expect(crypto.createHash('sha256').update(stable(ENDPOINTS[uf])).digest('hex')).toBe(hash);
    });
  }
});

describe('UF ainda sem emissão própria (ex.: BA)', () => {
  test('getEndpoints lança UfNaoSuportadaError com code e uf (detalhe técnico na mensagem)', () => {
    let err;
    try { getEndpoints('BA', 2); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UfNaoSuportadaError);
    expect(err.code).toBe('UF_NAO_SUPORTADA');
    expect(err.uf).toBe('BA');
    expect(err.message).toMatch(/UF BA não suportada na emissão própria\. UFs disponíveis: .*RJ/);
  });

  test('ufSuportada deriva do mapa de endpoints (SP, AP, MG, RJ)', () => {
    for (const uf of ['SP', 'AP', 'MG', 'RJ', 'rj', ' mg ']) expect(ufSuportada(uf)).toBe(true);
    for (const uf of ['BA', 'PR', 'XX']) expect(ufSuportada(uf)).toBe(false);
    expect(ufSuportada(null)).toBe(true); // sem UF = SP, como a engine inteira
  });

  test('mensagem gentil: cita a UF, não cita SEFAZ-SP nem soa como recusa', () => {
    const m = mensagemUfNaoSuportada('ba');
    expect(m).toBe('A emissão de NFC-e para lojas de BA está sendo ligada pela equipe Aura. A venda foi registrada normalmente.');
    expect(m).not.toMatch(/SEFAZ|sefazSp|não suportada|indisponível/i);
    expect(mensagemUfNaoSuportada('')).toMatch(/lojas do seu estado/);
  });
});

describe('xmlBuilder — RJ', () => {
  const FIX = { cNF: '12345678', dhEmi: '2026-11-11T10:00:00-03:00' };
  test('cUF 33 na chave e no XML, <UF>RJ</UF>, cMunFG do RJ, CRT 1 (Simples)', () => {
    expect(ufToCodigo('RJ')).toBe(33);
    const r = xb.buildInfNfe(companyRj, nfceData, { ...FIX, tpAmb: 2 });
    expect(r.chave).toMatch(/^33\d{42}$/);
    expect(r.chave.slice(20, 22)).toBe('65');
    expect(r.infNfeXml).toContain('<ide><cUF>33</cUF>');
    expect(r.infNfeXml).toContain('<UF>RJ</UF>');
    expect(r.infNfeXml).toContain('<cMunFG>3304557</cMunFG>');
    expect(r.infNfeXml).toContain('<CRT>1</CRT>');
    // Simples: grupo ICMSSN102 sem campo de FCP (o FECP do Simples vai no DAS)
    expect(r.infNfeXml).toContain('<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>');
    expect(r.infNfeXml).not.toMatch(/<pFCP>|infRespTec/);
  });
});

describe('NF-e 55 — RJ pela SVRS (Portal Nacional da NF-e)', () => {
  test('mesmos endpoints SVRS do AP, homologação e produção', () => {
    expect(getEndpoints55('RJ', 'homologacao').autorizacao)
      .toBe('https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(getEndpoints55('RJ', 1).autorizacao)
      .toBe('https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(getEndpoints55('RJ', 1)).toEqual(getEndpoints55('AP', 1));
    expect(getEndpoints55('RJ', 2)).toEqual(getEndpoints55('AP', 2));
  });
});

// ---------- fim a fim (orquestrador, SOAP mockado — nada sai da máquina) ----------

const PFX_PASSWORD = 'senha-a1';
function makeTestPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '09';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'LOJA TESTE RJ:11222333000181' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD, { algorithm: '3des' })
  ).getBytes(), 'binary');
}

const RET_STATUS = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
  + '<nfeResultMsg><retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ></nfeResultMsg></soap:Body></soap:Envelope>';

function okTransport(calls) {
  return async (url, envelope, extra) => {
    calls.push({ url, envelope, extra });
    const chave = envelope.match(/Id="NFe(\d{44})"/)[1];
    return {
      status: 200,
      body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
        + '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
        + `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><nProt>333260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`
        + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>',
    };
  };
}

describe('sefazSp — RJ fim a fim', () => {
  let db;
  beforeAll(() => {
    const { enc, iv } = encryptBuffer(makeTestPfx());
    db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('FROM company_certificates')) {
          return { rows: [{ pfx_enc: enc, pfx_iv: iv, password_enc: encryptString(PFX_PASSWORD),
            not_after: new Date(Date.now() + 365 * 86400e3), subject_cn: 'LOJA TESTE RJ' }] };
        }
        return { rows: [] };
      }),
    };
  });
  beforeEach(() => contingency.reset());

  const CONFIG_RJ = {
    company_id: companyRj.id, uf: 'RJ', ambiente: 'homologacao', serie_nfce: 1,
    csc_id: '000001', csc_token_enc: encryptString('A1B2C3D4E5F6G7H8'), provider: 'sefaz_sp',
  };

  test('homologação: autoriza na SVRS, chave 33, QR e urlChave do RJ, sem SOAPAction', async () => {
    const calls = [];
    const r = await sefazSp.emitNfce(companyRj, nfceData, { db, config: CONFIG_RJ, transport: okTransport(calls) });
    expect(r.status).toBe('autorizado');
    expect(r.chave_acesso.slice(0, 2)).toBe('33');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(calls[0].extra).toBeUndefined();
    expect(calls[0].envelope).toContain('<cUF>33</cUF>');
    // QR Code v2: <base>?p=chave|2|tpAmb|idCSC|HASH
    expect(r.qr_code).toMatch(new RegExp(`^${QR_RJ.replace(/[.?/]/g, '\\$&')}\\?p=${r.chave_acesso}\\|2\\|2\\|1\\|[0-9A-F]{40}$`));
    expect(r.url_consulta).toBe(CHAVE_RJ);
    expect(r.xml_signed).toContain(`<qrCode><![CDATA[${r.qr_code}]]></qrCode><urlChave>${CHAVE_RJ}</urlChave>`);
    expect(r.xml_signed).not.toContain('infRespTec');
    expect(verifyNfeSignature(r.xml_signed).valid).toBe(true);
  });

  test('produção (transport mockado): SVRS de produção, tpAmb 1 no QR', async () => {
    const calls = [];
    const r = await sefazSp.emitNfce(companyRj, nfceData, {
      db, config: { ...CONFIG_RJ, ambiente: 'producao' }, transport: okTransport(calls),
    });
    expect(calls[0].url).toBe('https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(r.qr_code).toMatch(new RegExp(`\\?p=${r.chave_acesso}\\|2\\|1\\|1\\|[0-9A-F]{40}$`));
    expect(r.xml_signed).toContain('<tpAmb>1</tpAmb>');
  });

  test('status do serviço: SVRS com cUF 33', async () => {
    const calls = [];
    const t = async (url, envelope, extra) => { calls.push({ url, envelope, extra }); return { status: 200, body: RET_STATUS }; };
    const r = await sefazSp.statusServico({ config: CONFIG_RJ, db, companyId: companyRj.id, transport: t });
    expect(r.online).toBe(true);
    expect(calls[0].url).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
    expect(calls[0].envelope).toContain('<cUF>33</cUF>');
  });

  test('loja da BA: a engine lança o erro tipado ANTES de abrir certificado', async () => {
    db.query.mockClear();
    const companyBa = { ...companyRj, address_state: 'BA', ibge_code: '2927408', address_city: 'Salvador' };
    await expect(sefazSp.emitNfce(companyBa, nfceData, { db, config: { ...CONFIG_RJ, uf: 'BA' } }))
      .rejects.toMatchObject({ code: 'UF_NAO_SUPORTADA', uf: 'BA' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
