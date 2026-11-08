'use strict';
// ============================================================
// 08/11/2026 — MG na engine própria de NFC-e (modelo 65).
// Prova duas coisas:
//   1. MG funciona: endpoints oficiais, SOAPAction, cUF 31, QR/urlChave,
//      infRespTec só com os dados da Aura configurados.
//   2. SP e AP NÃO mudaram: mesma requisição HTTP (sem header novo, mesmo
//      transport(url, envelope)) e XML byte a byte igual ao de antes
//      (hashes gerados com o xmlBuilder de origin/main antes da mudança).
// ============================================================
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = process.env.CERT_MASTER_KEY || crypto.randomBytes(32).toString('hex');

const endpointsMod = require('../../src/services/sefazSp/endpoints');
const { getEndpoints, soapActionFor, ENDPOINTS } = endpointsMod;
const sc = require('../../src/services/sefazSp/soapClient');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { loadRespTec } = require('../../src/services/sefazSp/respTec');
const contingency = require('../../src/services/sefazSp/contingency');
const sefazSp = require('../../src/services/sefazSp');
const { verifyNfeSignature } = require('../../src/services/sefazSp/signer');
const { encryptBuffer, encryptString } = require('../../src/utils/secretCrypto');
const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

const WSDL = 'http://www.portalfiscal.inf.br/nfe/wsdl';

// Empresa fictícia em MG (Divinópolis, IBGE 3122306). CNPJ/IE de teste.
const companyMg = {
  ...companyDavi,
  address_state: 'MG', address_city: 'Divinopolis', ibge_code: '3122306',
  address_zip: '35500000', tax_regime: 'mei',
};
const companyAp = { ...companyDavi, address_state: 'AP', ibge_code: '1600303', address_city: 'Macapa' };

// Dados FICTÍCIOS de responsável técnico (CNPJ válido por DV, não é o da Aura).
const RESP_TEC_ENV = {
  AURA_RESP_TEC_CNPJ: '11.444.777/0001-61',
  AURA_RESP_TEC_CONTATO: 'Equipe Teste',
  AURA_RESP_TEC_EMAIL: 'teste@exemplo.com.br',
  AURA_RESP_TEC_FONE: '(11) 99999-0000',
};

// O xmlBuilder lê alguns NFCE_* do ambiente (taxEngine). Os hashes de
// paridade foram gerados SEM eles — isola o teste do ambiente da máquina.
let savedEnv;
beforeAll(() => {
  savedEnv = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('NFCE_') || k.startsWith('AURA_RESP_TEC_')) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  }
});
afterAll(() => { Object.assign(process.env, savedEnv); });
afterEach(() => { for (const k of Object.keys(RESP_TEC_ENV)) delete process.env[k]; });

describe('endpoints — MG', () => {
  test('URLs oficiais (Portal SPED MG + ACBr [NFCe_MG_H]/[NFCe_MG_P])', () => {
    const h = getEndpoints('MG', 'homologacao');
    const p = getEndpoints('MG', 'producao');
    const svc = ['NFeAutorizacao4', 'NFeRetAutorizacao4', 'NFeStatusServico4',
      'NFeConsultaProtocolo4', 'NFeRecepcaoEvento4', 'NFeInutilizacao4'];
    const keys = ['autorizacao', 'retAutorizacao', 'statusServico', 'consultaProtocolo', 'recepcaoEvento', 'inutilizacao'];
    keys.forEach((k, i) => {
      expect(h[k]).toBe(`https://hnfce.fazenda.mg.gov.br/nfce/services/${svc[i]}`);
      expect(p[k]).toBe(`https://nfce.fazenda.mg.gov.br/nfce/services/${svc[i]}`);
    });
    expect(h.qrCodeBase).toBe('https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml');
    expect(p.qrCodeBase).toBe('https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml');
    expect(h.urlConsulta).toBe('https://hportalsped.fazenda.mg.gov.br/portalnfce');
    expect(p.urlConsulta).toBe('https://portalsped.fazenda.mg.gov.br/portalnfce');
    expect(h.soapAction).toBe(true);
    expect(p.infRespTec).toBe(true);
  });

  test('SP e AP não ganharam flag nenhuma', () => {
    for (const uf of ['SP', 'AP']) {
      for (const amb of ['homologacao', 'producao']) {
        expect(ENDPOINTS[uf][amb].soapAction).toBeUndefined();
        expect(ENDPOINTS[uf][amb].infRespTec).toBeUndefined();
      }
    }
  });

  test('RJ continua fora (erro claro)', () => {
    expect(() => getEndpoints('RJ', 2)).toThrow(/RJ.*não suportada/);
  });

  test('soapActionFor: MG = <wsdl ns>/<operação> (nomes do ACBr); SP/AP = null', () => {
    const mg = getEndpoints('MG', 2);
    expect(soapActionFor(mg, 'autorizacao')).toBe(`${WSDL}/NFeAutorizacao4/nfeAutorizacaoLote`);
    expect(soapActionFor(mg, 'retAutorizacao')).toBe(`${WSDL}/NFeRetAutorizacao4/nfeRetAutorizacaoLote`);
    expect(soapActionFor(mg, 'statusServico')).toBe(`${WSDL}/NFeStatusServico4/nfeStatusServicoNF`);
    expect(soapActionFor(mg, 'consultaProtocolo')).toBe(`${WSDL}/NFeConsultaProtocolo4/nfeConsultaNF`);
    expect(soapActionFor(mg, 'recepcaoEvento')).toBe(`${WSDL}/NFeRecepcaoEvento4/nfeRecepcaoEvento`);
    expect(soapActionFor(mg, 'inutilizacao')).toBe(`${WSDL}/NFeInutilizacao4/nfeInutilizacaoNF`);
    expect(soapActionFor(getEndpoints('SP', 2), 'autorizacao')).toBeNull();
    expect(soapActionFor(getEndpoints('AP', 1), 'statusServico')).toBeNull();
    expect(() => soapActionFor(mg, 'outro')).toThrow(/desconhecido/);
  });
});

// ---------- transporte ----------

const RET_STATUS = '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
  + '<nfeResultMsg><retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo></retConsStatServ></nfeResultMsg></soap:Body></soap:Envelope>';

function recordingTransport() {
  const calls = [];
  const fn = async (...args) => { calls.push(args); return { status: 200, body: RET_STATUS }; };
  fn.calls = calls;
  return fn;
}

describe('soapClient — transport injetado', () => {
  test('SP e AP: transport recebe EXATAMENTE (url, envelope), como antes', async () => {
    for (const uf of ['SP', 'AP']) {
      const t = recordingTransport();
      await sc.statusServico({ tpAmb: 2, cUF: uf === 'SP' ? 35 : 16, endpoints: getEndpoints(uf, 2), transport: t });
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0]).toHaveLength(2);
      expect(t.calls[0][0]).toBe(getEndpoints(uf, 2).statusServico);
    }
    // sem endpoints (padrão SP) também
    const t = recordingTransport();
    await sc.statusServico({ tpAmb: 2, transport: t });
    expect(t.calls[0]).toHaveLength(2);
  });

  test('MG: transport recebe { soapAction } e o envelope é o mesmo SOAP 1.2', async () => {
    const t = recordingTransport();
    const eps = getEndpoints('MG', 2);
    const r = await sc.statusServico({ tpAmb: 2, cUF: 31, endpoints: eps, transport: t });
    expect(r.online).toBe(true);
    const [url, envelope, extra] = t.calls[0];
    expect(url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4');
    expect(extra).toEqual({ soapAction: `${WSDL}/NFeStatusServico4/nfeStatusServicoNF` });
    expect(envelope).toContain('<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">');
    expect(envelope).toContain(`<nfeDadosMsg xmlns="${WSDL}/NFeStatusServico4">`);
    expect(envelope).toContain('<cUF>31</cUF>');
  });

  test('withSoapAction devolve o MESMO objeto opts para SP (sem chave nova)', () => {
    const opts = { pfx: null, transport: () => {} };
    expect(sc.withSoapAction(opts, getEndpoints('SP', 2), 'autorizacao')).toBe(opts);
    expect(sc.withSoapAction(opts, getEndpoints('AP', 2), 'autorizacao')).toBe(opts);
    const mg = sc.withSoapAction(opts, getEndpoints('MG', 2), 'autorizacao');
    expect(mg).not.toBe(opts);
    expect(mg.soapAction).toBe(`${WSDL}/NFeAutorizacao4/nfeAutorizacaoLote`);
  });
});

describe('soapClient — requisição HTTPS real (https.request espionado)', () => {
  let spy;
  let captured;
  beforeEach(() => {
    captured = [];
    spy = jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      captured.push(options);
      const req = new EventEmitter();
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        cb(res);
        res.emit('data', Buffer.from(RET_STATUS, 'utf8'));
        res.emit('end');
      };
      return req;
    });
  });
  afterEach(() => spy.mockRestore());

  test('SP: headers exatamente Content-Type + Content-Length (sem SOAPAction)', async () => {
    await sc.statusServico({ tpAmb: 2, cUF: 35, endpoints: getEndpoints('SP', 2) });
    const o = captured[0];
    expect(o.host).toBe('homologacao.nfce.fazenda.sp.gov.br');
    expect(o.path).toBe('/ws/NFeStatusServico4.asmx');
    expect(Object.keys(o.headers)).toEqual(['Content-Type', 'Content-Length']);
    expect(o.headers['Content-Type']).toBe('application/soap+xml; charset=utf-8');
  });

  test('AP: idem SP (sem header novo)', async () => {
    await sc.statusServico({ tpAmb: 1, cUF: 16, endpoints: getEndpoints('AP', 1) });
    expect(Object.keys(captured[0].headers)).toEqual(['Content-Type', 'Content-Length']);
    expect(captured[0].host).toBe('nfce.svrs.rs.gov.br');
  });

  test('MG: host/path sem .asmx + header SOAPAction entre aspas (formato ACBr)', async () => {
    await sc.statusServico({ tpAmb: 1, cUF: 31, endpoints: getEndpoints('MG', 1) });
    const o = captured[0];
    expect(o.host).toBe('nfce.fazenda.mg.gov.br');
    expect(o.port).toBe(443);
    expect(o.path).toBe('/nfce/services/NFeStatusServico4');
    expect(o.method).toBe('POST');
    expect(o.headers['Content-Type']).toBe('application/soap+xml; charset=utf-8');
    expect(o.headers.SOAPAction).toBe(`"${WSDL}/NFeStatusServico4/nfeStatusServicoNF"`);
  });
});

// ---------- XML ----------

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
const FIX = { cNF: '12345678', dhEmi: '2026-11-08T10:00:00-03:00' };

describe('xmlBuilder — paridade SP/AP byte a byte', () => {
  // Hashes gerados com o xmlBuilder de origin/main (18483601), antes desta mudança.
  const GOLDEN = {
    SP_h: [companyDavi, { ...FIX, tpAmb: 2 }, 4599, 'c7d66554111a0ef12b5a6c16c2cc7090404aaee3e70d3b7317baf2f3e7e7d31a'],
    SP_p: [companyDavi, { ...FIX, tpAmb: 1 }, 3164, '9310317335e530a7ee1308709672789f64db104f3ba519aaf23cbf3f6d383b95'],
    AP_h: [companyAp, { ...FIX, tpAmb: 2 }, 4598, 'f180e0e53d9b9d661dbfc07c783853af9938abd6d93ae53faf25026a477c7034'],
    AP_p: [companyAp, { ...FIX, tpAmb: 1 }, 3163, '636d8159f560b8e316b6f402544688e8c1c665b36721dde1b5bb026cfe0ca2ac'],
    SP_cont: [companyDavi, { ...FIX, tpAmb: 2, tpEmis: 9, dhCont: '2026-11-08T09:59:00-03:00',
      xJust: 'Falha de comunicacao com o autorizador detectada pelo emissor' }, 4717,
    '6811c1bacd65e4b256c27b2a70d036fc64fef97c9ed9cb05d15f5b5f5bd474b8'],
  };
  for (const [nome, [company, opts, len, hash]] of Object.entries(GOLDEN)) {
    test(`${nome}: igual ao de antes`, () => {
      const xml = xb.buildInfNfe(company, nfceDataVendaTipica, opts).infNfeXml;
      expect(xml.length).toBe(len);
      expect(sha(xml)).toBe(hash);
      // respTec: null (o que o orquestrador passa p/ SP/AP) não muda nada
      const xml2 = xb.buildInfNfe(company, nfceDataVendaTipica, { ...opts, respTec: null }).infNfeXml;
      expect(xml2).toBe(xml);
    });
  }
});

describe('xmlBuilder — MG', () => {
  test('cUF 31, chave começa com 31, <UF>MG</UF>, CRT 4 (MEI)', () => {
    const r = xb.buildInfNfe(companyMg, nfceDataVendaTipica, { ...FIX, tpAmb: 2 });
    expect(r.chave.slice(0, 2)).toBe('31');
    expect(r.infNfeXml).toContain('<cUF>31</cUF>');
    expect(r.infNfeXml).toContain('<UF>MG</UF>');
    expect(r.infNfeXml).toContain('<cMunFG>3122306</cMunFG>');
    expect(r.infNfeXml).toContain('<CRT>4</CRT>');
    expect(r.infNfeXml).not.toContain('infRespTec');
  });

  test('com respTec: grupo infRespTec logo após infAdic, antes de </infNFe>', () => {
    const respTec = loadRespTec(RESP_TEC_ENV);
    const data = { ...nfceDataVendaTipica, observacoes: 'obs' };
    const xml = xb.buildInfNfe(companyMg, data, { ...FIX, tpAmb: 2, respTec }).infNfeXml;
    expect(xml).toMatch(/<\/infAdic><infRespTec><CNPJ>11444777000161<\/CNPJ><xContato>Equipe Teste<\/xContato><email>teste@exemplo.com.br<\/email><fone>11999990000<\/fone><\/infRespTec><\/infNFe>$/);
  });
});

describe('respTec — só com as 4 variáveis válidas', () => {
  test('completo e válido', () => {
    expect(loadRespTec(RESP_TEC_ENV)).toEqual({
      cnpj: '11444777000161', xContato: 'Equipe Teste', email: 'teste@exemplo.com.br', fone: '11999990000',
    });
  });
  test('vazio → null (XML sem o grupo, como sempre)', () => {
    expect(loadRespTec({})).toBeNull();
  });
  test('CNPJ com DV errado, e-mail ruim ou fone curto → null', () => {
    expect(loadRespTec({ ...RESP_TEC_ENV, AURA_RESP_TEC_CNPJ: '11444777000162' })).toBeNull();
    expect(loadRespTec({ ...RESP_TEC_ENV, AURA_RESP_TEC_EMAIL: 'semarroba' })).toBeNull();
    expect(loadRespTec({ ...RESP_TEC_ENV, AURA_RESP_TEC_FONE: '123' })).toBeNull();
  });
});

describe('contingência — xJust neutro', () => {
  test('não cita SP e cabe no leiaute (15–256)', () => {
    expect(contingency.XJUST_DEFAULT).not.toMatch(/SP/);
    expect(contingency.XJUST_DEFAULT.length).toBeGreaterThanOrEqual(15);
    expect(contingency.XJUST_DEFAULT.length).toBeLessThanOrEqual(256);
  });
});

describe('companyComUfDaConfig', () => {
  const { companyComUfDaConfig } = sefazSp;
  test('SP/SP: devolve o mesmo objeto', () => {
    expect(companyComUfDaConfig(companyDavi, { uf: 'SP' })).toBe(companyDavi);
  });
  test('endereço sem UF: usa a da config', () => {
    const c = companyComUfDaConfig({ ...companyDavi, address_state: null }, { uf: 'MG' });
    expect(c.address_state).toBe('MG');
  });
  test('divergente: erro claro', () => {
    expect(() => companyComUfDaConfig(companyMg, { uf: 'SP' })).toThrow(/UF da configuração da nota \(SP\).*\(MG\)/);
  });
  test('sem UF no endereço e config SP: XML idêntico ao de SP com endereço', () => {
    const semUf = companyComUfDaConfig({ ...companyDavi, address_state: null }, { uf: 'SP' });
    const a = xb.buildInfNfe(semUf, nfceDataVendaTipica, { ...FIX, tpAmb: 2 }).infNfeXml;
    const b = xb.buildInfNfe(companyDavi, nfceDataVendaTipica, { ...FIX, tpAmb: 2 }).infNfeXml;
    expect(a).toBe(b);
  });
});

// ---------- fim a fim (orquestrador) ----------

const PFX_PASSWORD = 'senha-a1';
function makeTestPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '07';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'LOJA TESTE MG:11222333000181' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(
    forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PFX_PASSWORD, { algorithm: '3des' })
  ).getBytes(), 'binary');
}

describe('sefazSp.emitNfce — MG fim a fim (SOAP mockado)', () => {
  let db;
  beforeAll(() => {
    const { enc, iv } = encryptBuffer(makeTestPfx());
    db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('FROM company_certificates')) {
          return { rows: [{ pfx_enc: enc, pfx_iv: iv, password_enc: encryptString(PFX_PASSWORD),
            not_after: new Date(Date.now() + 365 * 86400e3), subject_cn: 'LOJA TESTE MG' }] };
        }
        return { rows: [] };
      }),
    };
  });
  beforeEach(() => contingency.reset());

  const CONFIG_MG = {
    company_id: companyMg.id, uf: 'MG', ambiente: 'homologacao', serie_nfce: 1,
    csc_id: '000001', csc_token_enc: encryptString('A1B2C3D4E5F6G7H8'), provider: 'sefaz_sp',
  };

  function okTransport(calls) {
    return async (url, envelope, extra) => {
      calls.push({ url, envelope, extra });
      const chave = envelope.match(/Id="NFe(\d{44})"/)[1];
      return {
        status: 200,
        body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
          + '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
          + `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><nProt>331260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`
          + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>',
      };
    };
  }

  test('autoriza em hnfce com SOAPAction, chave 31, QR e urlChave de MG; sem respTec configurado não há infRespTec', async () => {
    const calls = [];
    const r = await sefazSp.emitNfce(companyMg, nfceDataVendaTipica, { db, config: CONFIG_MG, transport: okTransport(calls) });
    expect(r.status).toBe('autorizado');
    expect(r.chave_acesso.slice(0, 2)).toBe('31');
    expect(r.qr_code.startsWith('https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=')).toBe(true);
    expect(r.url_consulta).toBe('https://hportalsped.fazenda.mg.gov.br/portalnfce');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4');
    expect(calls[0].extra).toEqual({ soapAction: `${WSDL}/NFeAutorizacao4/nfeAutorizacaoLote` });
    expect(r.xml_signed).toContain('<urlChave>https://hportalsped.fazenda.mg.gov.br/portalnfce</urlChave>');
    expect(r.xml_signed).not.toContain('infRespTec');
    expect(verifyNfeSignature(r.xml_signed).valid).toBe(true);
  });

  test('com as variáveis AURA_RESP_TEC_* o grupo vai assinado no XML', async () => {
    Object.assign(process.env, RESP_TEC_ENV);
    const calls = [];
    const r = await sefazSp.emitNfce(companyMg, nfceDataVendaTipica, { db, config: CONFIG_MG, transport: okTransport(calls) });
    expect(r.xml_signed).toContain('<infRespTec><CNPJ>11444777000161</CNPJ>');
    expect(verifyNfeSignature(r.xml_signed).valid).toBe(true);
  });

  test('SP com as variáveis AURA_RESP_TEC_* definidas continua SEM infRespTec e sem SOAPAction', async () => {
    Object.assign(process.env, RESP_TEC_ENV);
    const calls = [];
    const configSp = { ...CONFIG_MG, uf: 'SP', csc_token_enc: encryptString('TOKEN-CSC-HOMOLOG-SP-0001') };
    const r = await sefazSp.emitNfce(companyDavi, nfceDataVendaTipica, { db, config: configSp, transport: okTransport(calls) });
    expect(r.status).toBe('autorizado');
    expect(r.xml_signed).not.toContain('infRespTec');
    expect(calls[0].extra).toBeUndefined();
    expect(calls[0].url).toBe('https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx');
  });

  test('cancelamento e status em MG: endpoint de MG, SOAPAction do serviço, cOrgao/cUF 31', async () => {
    const calls = [];
    const t = async (url, envelope, extra) => {
      calls.push({ url, envelope, extra });
      if (url.endsWith('NFeRecepcaoEvento4')) {
        return { status: 200, body: '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
          + '<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><cStat>128</cStat>'
          + '<retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo><nProt>331260000000002</nProt></infEvento></retEvento>'
          + '</retEnvEvento></nfeResultMsg></soap:Body></soap:Envelope>' };
      }
      return { status: 200, body: RET_STATUS };
    };
    const chave = '31261111222333000181650010000002311123456780';
    await sefazSp.cancelNfce({ db, config: CONFIG_MG, companyId: companyMg.id, chave,
      protocolo: '331260000000001', justificativa: 'Venda cancelada a pedido do cliente', transport: t });
    expect(calls[0].url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRecepcaoEvento4');
    expect(calls[0].extra).toEqual({ soapAction: `${WSDL}/NFeRecepcaoEvento4/nfeRecepcaoEvento` });
    expect(calls[0].envelope).toContain('<cOrgao>31</cOrgao>');

    const st = await sefazSp.statusServico({ config: CONFIG_MG, db, companyId: companyMg.id, transport: t });
    expect(st.online).toBe(true);
    expect(calls[1].url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4');
    expect(calls[1].envelope).toContain('<cUF>31</cUF>');
    expect(calls[1].extra).toEqual({ soapAction: `${WSDL}/NFeStatusServico4/nfeStatusServicoNF` });
  });

  test('config MG com endereço em SP: recusa antes de transmitir', async () => {
    const calls = [];
    await expect(sefazSp.emitNfce(companyDavi, nfceDataVendaTipica, { db, config: CONFIG_MG, transport: okTransport(calls) }))
      .rejects.toThrow(/diferente da UF do endereço/);
    expect(calls).toHaveLength(0);
  });
});
