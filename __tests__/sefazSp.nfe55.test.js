/**
 * sefazSp/nfe55 — emissão própria da NF-e 55 de devolução (Aura Notas).
 *
 * Cobre:
 *  - montagem do XML (mod 55, tpNF=0, finNFe=4, NFref na posição B12a,
 *    dest = próprio emitente, pag tPag=90, sem infNFeSupl)
 *  - endpoints NF-e (host nfe.fazenda.sp.gov.br, ≠ NFC-e)
 *  - orquestração: autorizada, rejeitada, e transporte com mocks
 *    (certStore/pfx/signer mockados; SOAP via transport injetado)
 */

'use strict';

jest.mock('../src/services/sefazSp/certStore', () => ({
  loadCertificate: jest.fn(async () => ({ pfx: Buffer.from('pfx-fake'), password: 'senha' })),
}));
jest.mock('../src/services/sefazSp/pfx', () => ({
  openPfx: jest.fn(() => ({ keyPem: 'KEY', certDerBase64: 'CERT', certPem: 'PEM' })),
  assertValidity: jest.fn(),
}));
jest.mock('../src/services/sefazSp/signer', () => ({
  signInfNfe: jest.fn(() => ({ signatureXml: '<Signature>fake</Signature>' })),
}));

const nfe55 = require('../src/services/sefazSp/nfe55');
const {
  buildInfNfe55Devolucao, buildPagSemPagamentoXml, buildDestSelf55Xml, getEndpoints55,
} = nfe55;

const COMPANY = {
  id: 'c-davi',
  cnpj: '47.123.119/0002-04',
  legal_name: 'Davi Calcados Villa Branca LTDA',
  trade_name: 'Davi Calcados',
  inscricao_estadual: '123456789012',
  ibge_code: '3524402',
  address_street: 'Rua das Flores',
  address_number: '100',
  address_neighborhood: 'Villa Branca',
  address_city: 'Jacarei',
  address_state: 'SP',
  address_zip: '12300-000',
  phone: '(12) 3456-7890',
  tax_regime: 'simples',
};

const CHAVE_ORIG = '35260747123119000204650300000000281951475443';

const ITEMS = [{
  code: 'prod-1', name: 'Tenis Runner', quantity: 1, price: 249.99,
  cfop: '1202', ncm: '64041900', barcode: '7891234567895', unit: 'UN',
}];

function buildOk(overrides = {}) {
  return buildInfNfe55Devolucao(COMPANY, {
    items: ITEMS,
    refNFe: CHAVE_ORIG,
    serie: 1,
    numero: 1,
    natureza_operacao: 'devolução de mercadoria adquirida por não contribuinte',
    infAdFisco: 'Devolução de mercadoria referente à NFC-e chave ' + CHAVE_ORIG + '.',
    ...overrides.nfeData,
  }, { tpAmb: 1, ...overrides.opts });
}

describe('nfe55 — buildInfNfe55Devolucao (XML modelo 55)', () => {
  it('gera chave com mod=55 e monta ide com tpNF=0 / finNFe=4 / tpImp=1', () => {
    const built = buildOk();
    expect(built.chave).toHaveLength(44);
    expect(built.chave.slice(20, 22)).toBe('55'); // mod na posição 21-22 da chave
    expect(built.infNfeXml).toContain('<mod>55</mod>');
    expect(built.infNfeXml).toContain('<tpNF>0</tpNF>');
    expect(built.infNfeXml).toContain('<finNFe>4</finNFe>');
    expect(built.infNfeXml).toContain('<tpImp>1</tpImp>');
    expect(built.infNfeXml).toContain(`Id="NFe${built.chave}"`);
  });

  it('NFref fica na posição B12a: após cMunFG e ANTES de tpImp (ordem XSD)', () => {
    const { infNfeXml } = buildOk();
    const iCMun = infNfeXml.indexOf('</cMunFG>');
    const iNFref = infNfeXml.indexOf('<NFref><refNFe>');
    const iTpImp = infNfeXml.indexOf('<tpImp>');
    expect(iNFref).toBeGreaterThan(iCMun);
    expect(iNFref).toBeLessThan(iTpImp);
    expect(infNfeXml).toContain(`<refNFe>${CHAVE_ORIG}</refNFe>`);
  });

  it('dest = próprio emitente (CNPJ do emit, indIEDest=1 com IE, endereço completo)', () => {
    const { infNfeXml } = buildOk();
    const dest = infNfeXml.slice(infNfeXml.indexOf('<dest>'), infNfeXml.indexOf('</dest>'));
    expect(dest).toContain('<CNPJ>47123119000204</CNPJ>');
    expect(dest).toContain('<indIEDest>1</indIEDest>');
    expect(dest).toContain('<IE>123456789012</IE>');
    expect(dest).toContain('<enderDest>');
    expect(dest).toContain('<cMun>3524402</cMun>');
    // ordem TDest: enderDest ANTES de indIEDest
    expect(dest.indexOf('</enderDest>')).toBeLessThan(dest.indexOf('<indIEDest>'));
  });

  it('pag = Sem Pagamento (tPag 90, vPag 0.00) — Rejeição 871', () => {
    const { infNfeXml } = buildOk();
    expect(infNfeXml).toContain('<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>');
    expect(buildPagSemPagamentoXml()).toBe('<pag><detPag><tPag>90</tPag><vPag>0.00</vPag></detPag></pag>');
  });

  it('item leva CFOP 1202 + CSOSN 102 (Simples) e total fecha em 249.99', () => {
    const { infNfeXml } = buildOk();
    expect(infNfeXml).toContain('<CFOP>1202</CFOP>');
    expect(infNfeXml).toContain('<CSOSN>102</CSOSN>');
    expect(infNfeXml).toContain('<vNF>249.99</vNF>');
  });

  it('homologação: dest.xNome vira o literal obrigatório (Rejeição 703)', () => {
    const dest = buildDestSelf55Xml(COMPANY, 2);
    expect(dest).toContain('NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');
  });

  it('refNFe inválida (≠44 dígitos) lança erro claro', () => {
    expect(() => buildOk({ nfeData: { refNFe: '123' } }))
      .toThrow(/refNFe deve ter 44 d/);
  });
});

describe('nfe55 — getEndpoints55', () => {
  it('produção SP usa host da NF-e (nfe.fazenda.sp.gov.br), não o da NFC-e', () => {
    const eps = getEndpoints55('SP', 1);
    expect(eps.autorizacao).toBe('https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx');
    expect(eps.autorizacao).not.toContain('nfce.');
  });

  it('homologação SP usa homologacao.nfe.fazenda.sp.gov.br', () => {
    const eps = getEndpoints55('SP', 'homologacao');
    expect(eps.autorizacao).toContain('homologacao.nfe.fazenda.sp.gov.br');
  });

  it('UF fora do escopo lança erro pedindo o gateway', () => {
    expect(() => getEndpoints55('RJ', 1)).toThrow(/não suportada/);
  });
});

// ---------- orquestração (transport SOAP injetado) ----------

function soapRetEnviNFe({ cStat, xMotivo, nProt = null, chNFe = '3'.repeat(44) }) {
  const infProt = `<infProt><tpAmb>1</tpAmb><verAplic>SP_TEST</verAplic>`
    + `<chNFe>${chNFe}</chNFe><dhRecbto>2026-08-03T15:00:00-03:00</dhRecbto>`
    + (nProt ? `<nProt>${nProt}</nProt><digVal>x</digVal>` : '')
    + `<cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo></infProt>`;
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
    + '<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
    + '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
    + '<tpAmb>1</tpAmb><cStat>104</cStat><xMotivo>Lote processado</xMotivo>'
    + `<protNFe versao="4.00">${infProt}</protNFe>`
    + '</retEnviNFe></nfeResultMsg></soap:Body></soap:Envelope>';
}

const PARAMS = {
  originalChave: CHAVE_ORIG,
  items: ITEMS,
  consumerInfo: { name: 'Maria', cpf: '12345678901', motivo: 'Troca' },
  serie: 1,
  numero: 7,
};

const CONFIG_PROD = { company_id: 'c-davi', uf: 'SP', ambiente: 'producao', provider: null };
const FAKE_DB = { query: jest.fn(async () => ({ rows: [] })) };

describe('nfe55 — emitNfeDevolucao55 (orquestração)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('autorizada: cStat 100 → status autorizado + protocolo + xml_signed', async () => {
    const transport = jest.fn(async () => ({
      status: 200,
      body: soapRetEnviNFe({ cStat: '100', xMotivo: 'Autorizado o uso da NF-e', nProt: '135260000000001' }),
    }));
    const out = await nfe55.emitNfeDevolucao55(COMPANY, PARAMS, {
      db: FAKE_DB, config: CONFIG_PROD, transport,
    });
    expect(out.status).toBe('autorizado');
    expect(out.provider).toBe('sefaz_sp');
    expect(out.protocolo).toBe('135260000000001');
    expect(out.codigo_status).toBe('100');
    expect(out.chave_acesso).toHaveLength(44);
    expect(out.chave_acesso.slice(20, 22)).toBe('55');
    // XML final assinado, SEM infNFeSupl (exclusivo da NFC-e)
    expect(out.xml_signed).toContain('<mod>55</mod>');
    expect(out.xml_signed).not.toContain('infNFeSupl');
    // transmitiu no endpoint da NF-e (produção)
    const [url, envelope] = transport.mock.calls[0];
    expect(url).toBe('https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx');
    expect(envelope).toContain('<indSinc>1</indSinc>');
  });

  it('rejeitada (ex.: 778 NCM): status rejeitado com cStat/xMotivo — SEM throw', async () => {
    const transport = jest.fn(async () => ({
      status: 200,
      body: soapRetEnviNFe({ cStat: '778', xMotivo: 'Informado NCM inexistente' }),
    }));
    const out = await nfe55.emitNfeDevolucao55(COMPANY, PARAMS, {
      db: FAKE_DB, config: CONFIG_PROD, transport,
    });
    expect(out.status).toBe('rejeitado');
    expect(out.codigo_status).toBe('778');
    expect(out.motivo_status).toMatch(/NCM/);
  });

  it('homologação usa o endpoint de homologação', async () => {
    const transport = jest.fn(async () => ({
      status: 200,
      body: soapRetEnviNFe({ cStat: '100', xMotivo: 'Autorizado', nProt: '1' }),
    }));
    await nfe55.emitNfeDevolucao55(COMPANY, PARAMS, {
      db: FAKE_DB, config: { ...CONFIG_PROD, ambiente: 'homologacao' }, transport,
    });
    expect(transport.mock.calls[0][0]).toContain('homologacao.nfe.fazenda.sp.gov.br');
  });

  it('originalChave inválida lança erro antes de qualquer transporte', async () => {
    const transport = jest.fn();
    await expect(nfe55.emitNfeDevolucao55(COMPANY, { ...PARAMS, originalChave: '123' }, {
      db: FAKE_DB, config: CONFIG_PROD, transport,
    })).rejects.toThrow(/44 d/);
    expect(transport).not.toHaveBeenCalled();
  });
});
