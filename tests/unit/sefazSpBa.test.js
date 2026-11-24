'use strict';
// ============================================================
// 23/11/2026 — BA na engine própria de NFC-e (modelo 65), pela SVRS.
// Prova:
//   1. BA funciona: webservices da SVRS (os mesmos do AP/RJ), QR Code e
//      urlChave da BA (ENCAT), cUF 29 na chave e no XML, sem flag nova.
//   2. SP, AP, MG e RJ NÃO mudaram: objetos de endpoints com o mesmo hash dos
//      de origin/main (antes desta mudança).
//   3. Prazo de cancelamento da BA (RICMS-BA art. 107-H, I) e urlChave da BA
//      no cupom (DANFE).
// Empresa e documentos FICTÍCIOS (Simples Nacional, CRT 1; IE da BA de 8
// dígitos, válida pelo DV do módulo 10).
// ============================================================
const crypto = require('crypto');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = process.env.CERT_MASTER_KEY || crypto.randomBytes(32).toString('hex');

const {
  getEndpoints, ENDPOINTS, SVRS_NFCE_WS, soapActionFor, ufSuportada,
} = require('../../src/services/sefazSp/endpoints');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { ufToCodigo } = require('../../src/services/sefazSp/nfeHelpers');
const contingency = require('../../src/services/sefazSp/contingency');
const sefazSp = require('../../src/services/sefazSp');
const { verifyNfeSignature } = require('../../src/services/sefazSp/signer');
const { encryptBuffer, encryptString } = require('../../src/utils/secretCrypto');
const prazo = require('../../src/services/nfcePrazoCancelamento');
const { buildDanfeNfceHtml } = require('../../src/utils/buildDanfeNfceHtml');

const QR_BA_H = 'http://hnfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx';
const QR_BA_P = 'http://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx';
const CHAVE_BA_H = 'http://hinternet.sefaz.ba.gov.br/nfce/consulta';
const CHAVE_BA_P = 'https://www.sefaz.ba.gov.br/nfce/consulta';

// Loja fictícia na BA (Vitória da Conquista, IBGE 2933307). CNPJ válido por
// DV, de teste. IE 12345663: 8 dígitos, DV certo no algoritmo da BA.
const companyBa = {
  id: '00000000-0000-4000-8000-000000000029',
  cnpj: '11222333000181',
  legal_name: 'Loja Teste BA Ltda',
  trade_name: 'Loja Teste BA',
  address_street: 'Rua de Teste', address_number: '73', address_neighborhood: 'Centro',
  address_city: 'Vitória da Conquista', address_state: 'BA', address_zip: '45000000',
  ibge_code: '2933307', inscricao_estadual: '12345663', phone: '(77) 3000-0000',
  tax_regime: 'simples_nacional',
};

const nfceData = {
  items: [
    { product_id: 'p1', code: 'p1', name: 'Armacao Teste', ncm: '90031100', cfop: '5102', unit: 'UN', quantity: 1, price: 150 },
    { product_id: 'p2', code: 'p2', name: 'Estojo Teste', ncm: '42029200', cfop: '5102', unit: 'UN', quantity: 2, price: 25, discount: 5 },
  ],
  payments: [{ method: '01', value: 195, indPag: 0 }],
  total_value: 195, serie: 1, numero: 1,
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

describe('endpoints — BA pela SVRS', () => {
  test('homologação: os 6 webservices da SVRS (lista da SEFAZ-BA), QR e urlChave da BA', () => {
    const h = getEndpoints('BA', 'homologacao');
    expect(h.autorizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(h.retAutorizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx');
    expect(h.statusServico).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
    expect(h.consultaProtocolo).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx');
    expect(h.recepcaoEvento).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx');
    expect(h.inutilizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx');
    expect(h.qrCodeBase).toBe(QR_BA_H);
    expect(h.urlConsulta).toBe(CHAVE_BA_H);
  });

  test('produção: SVRS de produção, QR e urlChave de produção da BA', () => {
    const p = getEndpoints('BA', 1);
    expect(p.autorizacao).toBe('https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(p.statusServico).toBe('https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
    expect(p.qrCodeBase).toBe(QR_BA_P);
    expect(p.urlConsulta).toBe(CHAVE_BA_P);
    for (const k of SERVICOS) expect(p[k]).not.toMatch(/homologacao/);
    expect(p.qrCodeBase).not.toMatch(/hnfe|hinternet/);
  });

  test('webservices da BA = os do AP e do RJ (mesma SVRS); só QR/urlChave diferem', () => {
    for (const amb of ['homologacao', 'producao']) {
      for (const k of SERVICOS) {
        expect(ENDPOINTS.BA[amb][k]).toBe(SVRS_NFCE_WS[amb][k]);
        expect(ENDPOINTS.BA[amb][k]).toBe(ENDPOINTS.AP[amb][k]);
        expect(ENDPOINTS.BA[amb][k]).toBe(ENDPOINTS.RJ[amb][k]);
      }
      expect(ENDPOINTS.BA[amb].qrCodeBase).toMatch(/sefaz\.ba\.gov\.br/);
      expect(ENDPOINTS.BA[amb].urlConsulta).toMatch(/sefaz\.ba\.gov\.br\/nfce\/consulta$/);
    }
  });

  test('BA sem flag nova (sem SOAPAction, sem infRespTec) — caminho do AP/RJ', () => {
    for (const amb of ['homologacao', 'producao']) {
      expect(ENDPOINTS.BA[amb].soapAction).toBeUndefined();
      expect(ENDPOINTS.BA[amb].infRespTec).toBeUndefined();
      expect(soapActionFor(ENDPOINTS.BA[amb], 'autorizacao')).toBeNull();
    }
  });

  test('ufSuportada: BA (e minúsculas)', () => {
    expect(ufSuportada('BA')).toBe(true);
    expect(ufSuportada(' ba ')).toBe(true);
    expect(getEndpoints('ba', 2).autorizacao).toContain('nfce-homologacao.svrs.rs.gov.br');
  });
});

describe('endpoints — SP, AP, MG e RJ idênticos aos de antes', () => {
  // sha256 de cada objeto (chaves ordenadas), gerado com o endpoints.js de
  // origin/main (98dad1fd), antes desta mudança.
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
    RJ: 'ab53aeeeb38660af3ad3b818953155518871ae2a5a24833674444919c947e057',
  };
  for (const [uf, hash] of Object.entries(GOLDEN)) {
    test(`${uf}: mesmo objeto de endpoints`, () => {
      expect(crypto.createHash('sha256').update(stable(ENDPOINTS[uf])).digest('hex')).toBe(hash);
    });
  }
});

describe('xmlBuilder — BA', () => {
  const FIX = { cNF: '12345678', dhEmi: '2026-11-23T10:00:00-03:00' };
  test('cUF 29 na chave e no XML, <UF>BA</UF>, cMunFG de Vitória da Conquista, CRT 1 (Simples)', () => {
    expect(ufToCodigo('BA')).toBe(29);
    const r = xb.buildInfNfe(companyBa, nfceData, { ...FIX, tpAmb: 2 });
    expect(r.chave).toMatch(/^29\d{42}$/);
    expect(r.chave.slice(20, 22)).toBe('65');
    expect(r.infNfeXml).toContain('<ide><cUF>29</cUF>');
    expect(r.infNfeXml).toContain('<UF>BA</UF>');
    expect(r.infNfeXml).toContain('<cMunFG>2933307</cMunFG>');
    expect(r.infNfeXml).toContain('<IE>12345663</IE>');
    expect(r.infNfeXml).toContain('<CRT>1</CRT>');
    // Simples: grupo ICMSSN102 sem campo de FCP (o Fundo de Pobreza do Simples vai no DAS)
    expect(r.infNfeXml).toContain('<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>');
    expect(r.infNfeXml).not.toMatch(/<pFCP>|infRespTec/);
  });
});

describe('prazo de cancelamento e cupom — BA', () => {
  test('BA: 30 minutos, com a fonte do RICMS-BA', () => {
    expect(prazo.PRAZO_NFCE_POR_UF.BA.minutos).toBe(30);
    expect(prazo.PRAZO_NFCE_POR_UF.BA.fonte).toMatch(/RICMS-BA.*107-H/);
    expect(prazo.minutosDoPrazoNfce('BA', {})).toBe(30);
  });

  test('cupom (DANFE) da loja da BA mostra a urlChave da BA, não o portal nacional', () => {
    const html = buildDanfeNfceHtml({
      company: companyBa,
      emission: {
        chave_acesso: '29' + '1'.repeat(42), numero: 1, serie: 1, protocolo: '129260000000001',
        authorized_at: '2026-11-23T13:00:00Z', items: [], total_nfce: 0,
      },
    });
    expect(html).toContain('www.sefaz.ba.gov.br/nfce/consulta');
    expect(html).not.toContain('www.nfe.fazenda.gov.br/portal/consulta.aspx');
  });
});

// ---------- fim a fim (orquestrador, SOAP mockado — nada sai da máquina) ----------

const PFX_PASSWORD = 'senha-a1';
function makeTestPfx() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '29';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'LOJA TESTE BA:11222333000181' }];
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
        + `<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><nProt>129260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`
        + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>',
    };
  };
}

describe('sefazSp — BA fim a fim', () => {
  let db;
  beforeAll(() => {
    const { enc, iv } = encryptBuffer(makeTestPfx());
    db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('FROM company_certificates')) {
          return { rows: [{ pfx_enc: enc, pfx_iv: iv, password_enc: encryptString(PFX_PASSWORD),
            not_after: new Date(Date.now() + 365 * 86400e3), subject_cn: 'LOJA TESTE BA' }] };
        }
        return { rows: [] };
      }),
    };
  });
  beforeEach(() => contingency.reset());

  const CONFIG_BA = {
    company_id: companyBa.id, uf: 'BA', ambiente: 'homologacao', serie_nfce: 1,
    csc_id: '000001', csc_token_enc: encryptString('A1B2C3D4E5F6G7H8'), provider: 'sefaz_sp',
  };

  test('homologação: autoriza na SVRS, chave 29, QR e urlChave de homologação da BA, sem SOAPAction', async () => {
    const calls = [];
    const r = await sefazSp.emitNfce(companyBa, nfceData, { db, config: CONFIG_BA, transport: okTransport(calls) });
    expect(r.status).toBe('autorizado');
    expect(r.chave_acesso.slice(0, 2)).toBe('29');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(calls[0].extra).toBeUndefined();
    expect(calls[0].envelope).toContain('<cUF>29</cUF>');
    // QR Code v2: <base>?p=chave|2|tpAmb|idCSC|HASH
    expect(r.qr_code).toMatch(new RegExp(`^${QR_BA_H.replace(/[.?/]/g, '\\$&')}\\?p=${r.chave_acesso}\\|2\\|2\\|1\\|[0-9A-F]{40}$`));
    expect(r.url_consulta).toBe(CHAVE_BA_H);
    expect(r.xml_signed).toContain(`<qrCode><![CDATA[${r.qr_code}]]></qrCode><urlChave>${CHAVE_BA_H}</urlChave>`);
    expect(r.xml_signed).not.toContain('infRespTec');
    expect(verifyNfeSignature(r.xml_signed).valid).toBe(true);
  });

  test('produção (transport mockado): SVRS de produção, QR de produção da BA, tpAmb 1', async () => {
    const calls = [];
    const r = await sefazSp.emitNfce(companyBa, nfceData, {
      db, config: { ...CONFIG_BA, ambiente: 'producao' }, transport: okTransport(calls),
    });
    expect(calls[0].url).toBe('https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(r.qr_code).toMatch(new RegExp(`^${QR_BA_P.replace(/[.?/]/g, '\\$&')}\\?p=${r.chave_acesso}\\|2\\|1\\|1\\|[0-9A-F]{40}$`));
    expect(r.url_consulta).toBe(CHAVE_BA_P);
    expect(r.xml_signed).toContain('<tpAmb>1</tpAmb>');
  });

  test('status do serviço: SVRS com cUF 29', async () => {
    const calls = [];
    const t = async (url, envelope, extra) => { calls.push({ url, envelope, extra }); return { status: 200, body: RET_STATUS }; };
    const r = await sefazSp.statusServico({ config: CONFIG_BA, db, companyId: companyBa.id, transport: t });
    expect(r.online).toBe(true);
    expect(calls[0].url).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx');
    expect(calls[0].envelope).toContain('<cUF>29</cUF>');
    expect(calls[0].extra).toBeUndefined();
  });

  test('endereço sem UF: usa a UF da config (BA) e a chave sai com 29', async () => {
    const calls = [];
    const semUf = { ...companyBa, address_state: '' };
    const r = await sefazSp.emitNfce(semUf, nfceData, { db, config: CONFIG_BA, transport: okTransport(calls) });
    expect(r.chave_acesso.slice(0, 2)).toBe('29');
  });

  test('config BA com endereço em outra UF: erro claro antes de abrir certificado', async () => {
    db.query.mockClear();
    await expect(sefazSp.emitNfce({ ...companyBa, address_state: 'SP' }, nfceData, { db, config: CONFIG_BA }))
      .rejects.toThrow(/UF da configuração da nota \(BA\) é diferente da UF do endereço da empresa \(SP\)/);
    expect(db.query).not.toHaveBeenCalled();
  });
});
