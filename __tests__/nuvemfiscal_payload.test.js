// Smoke test do payload NFC-e: gera o body que mandamos pra Nuvem Fiscal
// e valida contra o schema oficial (envelope `infNFe` com ide/emit/dest/det/
// total/transp/pag). Sem rede — stub do fetch só captura o body.
//
// O CI do Jest captura todos arquivos __tests__/*.test.js, então precisa
// usar describe/test/expect (não IIFE standalone).

process.env.NUVEM_FISCAL_URL = 'https://api.sandbox.nuvemfiscal.com.br';
process.env.NUVEM_FISCAL_CLIENT_ID = 'fake_id';
process.env.NUVEM_FISCAL_CLIENT_SECRET = 'fake_secret';

let capturedBody = null;
let capturedPath = null;

beforeAll(() => {
  global.fetch = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      return { ok: true, json: async () => ({ access_token: 'fake_token', expires_in: 3600 }) };
    }
    capturedPath = url;
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        id: 'nfce_fake_001',
        status: 'autorizado',
        chave_acesso: '35260512345678901234650010000000011000000011',
        protocolo: '135260000000001',
        link_pdf: 'https://danfe.nuvemfiscal.com.br/fake.pdf',
        link_xml: 'https://xml.nuvemfiscal.com.br/fake.xml',
      }),
    };
  };
});

beforeEach(() => {
  capturedBody = null;
  capturedPath = null;
});

const company = {
  cnpj: '12345678000199',
  legal_name: 'Aura Pilot LTDA',
  trade_name: 'Aura Odonto',
  address_street: 'Rua das Flores',
  address_number: '100',
  address_neighborhood: 'Centro',
  address_city: 'São Paulo',
  address_state: 'SP',
  address_zip: '01310100',
  ibge_code: '3550308',
  inscricao_estadual: '110042490114',
  inscricao_municipal: '12345',
  email: 'fiscal@aura.test',
  phone: '11999998888',
  tax_regime: 'simples',
};

const nfceData = {
  serie: 1,
  numero: 42,
  reference: 'nfce-test-001',
  items: [
    { code: 'SKU001', name: 'Limpeza dental', quantity: 1, price: 150.00, ncm: '00000000', cfop: '5102' },
    { code: 'SKU002', name: 'Aplicação de flúor', quantity: 2, price: 45.00 },
  ],
  total_value: 240.00,
  payment_method: '17',
  recipient_cpf: '12345678901',
  recipient_name: 'Cliente Teste',
};

describe('NFC-e payload (services/nuvemfiscal.js)', () => {
  let nf;
  beforeAll(() => { nf = require('../src/services/nuvemfiscal'); });

  describe('emitNfce — envelope estrutural', () => {
    beforeAll(async () => {
      await nf.emitNfce(company, nfceData);
    });

    test('endpoint = POST /nfce', () => {
      expect(capturedPath).toMatch(/\/nfce$/);
    });

    test('top-level: ambiente, referencia, infNFe', () => {
      expect(capturedBody.ambiente).toBe('homologacao');
      expect(capturedBody.referencia).toBeTruthy();
      expect(capturedBody.infNFe).toBeDefined();
      expect(capturedBody.infNFe.versao).toBe('4.00');
    });

    test('ide: identificação NFC-e modelo 65', () => {
      const ide = capturedBody.infNFe.ide;
      expect(ide.cUF).toBe(35);          // SP
      expect(ide.mod).toBe(65);          // NFC-e
      expect(ide.serie).toBe(1);
      expect(ide.nNF).toBe(42);
      expect(ide.tpNF).toBe(1);          // saída
      expect(ide.idDest).toBe(1);        // operação interna
      expect(ide.cMunFG).toBe('3550308');
      expect(ide.tpImp).toBe(4);         // DANFE NFC-e
      expect(ide.tpEmis).toBe(1);        // emissão normal
      expect(ide.tpAmb).toBe(2);         // homologação
      expect(ide.indFinal).toBe(1);      // consumidor final
      expect(ide.indPres).toBe(1);       // presencial
      expect(ide.dhEmi).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    test('emit: emitente Simples Nacional', () => {
      const emit = capturedBody.infNFe.emit;
      expect(emit.CNPJ).toMatch(/^\d{14}$/);
      expect(emit.xNome).toBeTruthy();
      expect(emit.CRT).toBe(1);          // Simples Nacional
      expect(emit.enderEmit.UF).toBe('SP');
      expect(emit.enderEmit.CEP).toMatch(/^\d{8}$/);
      expect(emit.enderEmit.cPais).toBe('1058');
    });

    test('dest: destinatário com CPF informado', () => {
      const dest = capturedBody.infNFe.dest;
      expect(dest).toBeDefined();
      expect(dest.CPF).toMatch(/^\d{11}$/);
      expect(dest.indIEDest).toBe(9);
    });

    test('det[0]: produto + ICMSSN102 + PIS/COFINS NT', () => {
      expect(capturedBody.infNFe.det.length).toBe(2);
      const d0 = capturedBody.infNFe.det[0];
      expect(d0.nItem).toBe(1);
      expect(d0.prod.cProd).toBeTruthy();
      expect(d0.prod.NCM).toBe('00000000');
      expect(d0.prod.CFOP).toBe('5102');
      expect(d0.prod.uCom).toBe('UN');
      expect(d0.prod.qCom).toBe(1);
      expect(d0.prod.vUnCom).toBe(150);
      expect(d0.prod.vProd).toBe(150);
      expect(d0.prod.indTot).toBe(1);
      expect(d0.imposto.ICMS.ICMSSN102.CSOSN).toBe('102');
      expect(d0.imposto.PIS.PISNT.CST).toBe('07');
      expect(d0.imposto.COFINS.COFINSNT.CST).toBe('07');
    });

    test('det[1]: subtotal calculado (qty * price)', () => {
      const d1 = capturedBody.infNFe.det[1];
      expect(d1.prod.qCom).toBe(2);
      expect(d1.prod.vProd).toBe(90);
    });

    test('total.ICMSTot: vProd e vNF batem com a soma dos itens', () => {
      const t = capturedBody.infNFe.total.ICMSTot;
      expect(t.vProd).toBe(240);
      expect(t.vNF).toBe(240);
      expect(t.vICMS).toBe(0);   // Simples
    });

    test('transp.modFrete = 9 (sem ocorrência)', () => {
      expect(capturedBody.infNFe.transp.modFrete).toBe(9);
    });

    test('pag.detPag: tPag mapeado e vPag = total', () => {
      const pag = capturedBody.infNFe.pag;
      expect(pag.detPag[0].tPag).toBe('17');   // Pix
      expect(pag.detPag[0].vPag).toBe(240);
      expect(pag.vTroco).toBe(0);
    });
  });

  test('NFC-e sem CPF/CNPJ: dest é omitido (consumidor não identificado)', async () => {
    await nf.emitNfce(company, {
      ...nfceData,
      recipient_cpf: undefined,
      recipient_name: undefined,
    });
    expect(capturedBody.infNFe.dest).toBeUndefined();
  });

  test('NF-e (modelo 55) sem destinatário lança erro', async () => {
    await expect(
      nf.emitNfe(company, {
        ...nfceData,
        recipient_cpf: undefined,
        recipient_cnpj: undefined,
      })
    ).rejects.toThrow(/CPF ou CNPJ/);
  });
});
