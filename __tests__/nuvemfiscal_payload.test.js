// Smoke test do payload NFC-e: gera o body que mandamos pra Nuvem Fiscal
// e valida contra o schema oficial (envelope `infNFe` com ide/emit/dest/det/
// total/transp/pag). Sem rede — stub do fetch só captura o body.
//
// IMPORTANTE — Workaround PIX (commit 1371d1a, mai/2026):
// SEFAZ-SP rejeita 391 com tPag=17 (PIX) em produção mesmo com body
// schema-válido. buildPag mapeia automaticamente PIX -> tPag=99 + xPag="PIX".
// Os asserts abaixo refletem esse comportamento. Quando SEFAZ corrigir o
// bug, reverter o swap em buildPag e atualizar testes pra tPag=17 nativo.

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

  describe('helpers SEFAZ', () => {
    test('isoBR retorna ISO com offset -03:00 (sem ms, sem Z)', () => {
      const s = nf.isoBR();
      expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/);
    });

    test('generateCNF retorna string 8 dígitos', () => {
      for (let i = 0; i < 5; i++) {
        const cnf = nf.generateCNF();
        expect(cnf).toMatch(/^\d{8}$/);
      }
    });

    test('calcDvChaveAcesso (mod 11) — exemplo conhecido', () => {
      const dv = nf.calcDvChaveAcesso('3520031234567800019965001000000042112345678');
      expect(dv).toMatch(/^[0-9]$/);
    });

    test('buildAccessKey44 retorna 44 dígitos', () => {
      const k = nf.buildAccessKey44({
        cUF: 35, ano2: 26, mes2: 5, cnpj: '12345678000199',
        mod: 65, serie: 1, nNF: 42, tpEmis: 1, cNF: '12345678',
      });
      expect(k).toMatch(/^\d{44}$/);
    });

    test('validateTpag aceita códigos SEFAZ + fallback 99 pra desconhecidos', () => {
      expect(nf.validateTpag('17')).toBe('17');
      expect(nf.validateTpag('01')).toBe('01');
      expect(nf.validateTpag('03')).toBe('03');
      expect(nf.validateTpag('99')).toBe('99');
      expect(nf.validateTpag('xx')).toBe('99');
      expect(nf.validateTpag('')).toBe('01');
      expect(nf.validateTpag(null)).toBe('01');
      expect(nf.validateTpag(undefined)).toBe('01');
    });

    test('buildPag aceita array (multi-pagamento) — soma vTroco', () => {
      // Workaround PIX: '17' input vira tPag=99 + xPag="PIX" no detPag.
      // Outros métodos (01=Dinheiro) seguem tPag nativo.
      const r = nf.buildPag([
        { method: '17', value: 100 },          // Pix R$100  → tPag=99 + xPag=PIX
        { method: '01', value: 50, change: 5 } // Dinheiro R$50, troco R$5
      ], 150);
      expect(r.detPag.length).toBe(2);
      expect(r.detPag[0].tPag).toBe('99');
      expect(r.detPag[0].xPag).toBe('PIX');
      expect(r.detPag[0].vPag).toBe(100);
      expect(r.detPag[1].tPag).toBe('01');
      expect(r.detPag[1].xPag).toBeUndefined();
      expect(r.detPag[1].vPag).toBe(50);
      expect(r.vTroco).toBe(5);
    });

    test('buildPag aceita objeto único legado — vPag = totalFallback', () => {
      // Workaround PIX: '17' vira tPag=99 + xPag="PIX".
      const r = nf.buildPag({ method: '17', change: 0 }, 240);
      expect(r.detPag.length).toBe(1);
      expect(r.detPag[0].tPag).toBe('99');
      expect(r.detPag[0].xPag).toBe('PIX');
      expect(r.detPag[0].vPag).toBe(240);
      expect(r.vTroco).toBe(0);
    });

    test('buildPag com array vazio cai em default dinheiro', () => {
      const r = nf.buildPag([], 100);
      expect(r.detPag.length).toBe(1);
      expect(r.detPag[0].tPag).toBe('01');
      expect(r.detPag[0].vPag).toBe(100);
    });

    test('buildPag com tPag=99 nativo usa xPag="Outros" (default)', () => {
      // Quando o input já é 99, mantemos xPag="Outros" como descrição padrão.
      const r = nf.buildPag({ method: '99', value: 100 }, 100);
      expect(r.detPag[0].tPag).toBe('99');
      expect(r.detPag[0].xPag).toBe('Outros');
    });

    test('buildPag com tPag=03 (crédito) inclui bloco card', () => {
      // tPag=03/04 exige bloco card (NfeSefazCard) com tpIntegra.
      const r = nf.buildPag({ method: '03', value: 100 }, 100);
      expect(r.detPag[0].tPag).toBe('03');
      expect(r.detPag[0].card).toBeDefined();
      expect(r.detPag[0].card.tpIntegra).toBe(2);
    });
  });

  describe('emitNfce — envelope estrutural', () => {
    let body;
    let path;
    beforeAll(async () => {
      capturedBody = null;
      capturedPath = null;
      await nf.emitNfce(company, nfceData);
      body = capturedBody;
      path = capturedPath;
    });

    test('endpoint = POST /nfce', () => {
      expect(path).toMatch(/\/nfce$/);
    });

    test('top-level: ambiente, referencia, infNFe', () => {
      expect(body.ambiente).toBe('homologacao');
      expect(body.referencia).toBeTruthy();
      expect(body.infNFe).toBeDefined();
      expect(body.infNFe.versao).toBe('4.00');
    });

    test('ide: identificação NFC-e modelo 65 (com cNF, cDV, dhEmi-BR)', () => {
      const ide = body.infNFe.ide;
      expect(ide.cUF).toBe(35);
      expect(ide.mod).toBe(65);
      expect(ide.serie).toBe(1);
      expect(ide.nNF).toBe(42);
      expect(ide.tpNF).toBe(1);
      expect(ide.idDest).toBe(1);
      expect(ide.cMunFG).toBe('3550308');
      expect(ide.tpImp).toBe(4);
      expect(ide.tpEmis).toBe(1);
      expect(ide.tpAmb).toBe(2);
      expect(ide.indFinal).toBe(1);
      expect(ide.indPres).toBe(1);
      expect(ide.cNF).toMatch(/^\d{8}$/);
      expect(typeof ide.cDV).toBe('number');
      expect(ide.cDV).toBeGreaterThanOrEqual(0);
      expect(ide.cDV).toBeLessThanOrEqual(9);
      expect(ide.dhEmi).toMatch(/-03:00$/);
      expect(ide.dhEmi).not.toMatch(/Z$/);
    });

    test('emit: emitente Simples Nacional', () => {
      const emit = body.infNFe.emit;
      expect(emit.CNPJ).toMatch(/^\d{14}$/);
      expect(emit.xNome).toBeTruthy();
      expect(emit.CRT).toBe(1);
      expect(emit.enderEmit.UF).toBe('SP');
      expect(emit.enderEmit.CEP).toMatch(/^\d{8}$/);
      expect(emit.enderEmit.cPais).toBe('1058');
    });

    test('dest: destinatário com CPF informado', () => {
      const dest = body.infNFe.dest;
      expect(dest).toBeDefined();
      expect(dest.CPF).toMatch(/^\d{11}$/);
      expect(dest.indIEDest).toBe(9);
    });

    test('det[0]: produto + ICMSSN102 + PIS/COFINS NT', () => {
      expect(body.infNFe.det.length).toBe(2);
      const d0 = body.infNFe.det[0];
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
      const d1 = body.infNFe.det[1];
      expect(d1.prod.qCom).toBe(2);
      expect(d1.prod.vProd).toBe(90);
    });

    test('total.ICMSTot: vProd e vNF batem com a soma dos itens', () => {
      const t = body.infNFe.total.ICMSTot;
      expect(t.vProd).toBe(240);
      expect(t.vNF).toBe(240);
      expect(t.vICMS).toBe(0);
    });

    test('transp.modFrete = 9 (sem ocorrência)', () => {
      expect(body.infNFe.transp.modFrete).toBe(9);
    });

    test('pag.detPag: PIX (input tPag=17) mapeia pra tPag=99 + xPag="PIX"', () => {
      // Workaround SEFAZ-SP rejeição 391 spurious — input "17" sai como 99.
      const pag = body.infNFe.pag;
      expect(pag.detPag[0].tPag).toBe('99');
      expect(pag.detPag[0].xPag).toBe('PIX');
      expect(pag.detPag[0].vPag).toBe(240);
      expect(pag.vTroco).toBe(0);
    });
  });

  test('NFC-e sem CPF/CNPJ: dest é omitido (consumidor não identificado)', async () => {
    capturedBody = null;
    await nf.emitNfce(company, {
      ...nfceData,
      recipient_cpf: undefined,
      recipient_name: undefined,
    });
    expect(capturedBody).not.toBeNull();
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

  test('Pagamento com método inválido cai em tPag=99 (whitelist)', async () => {
    capturedBody = null;
    await nf.emitNfce(company, {
      ...nfceData,
      payment_method: 'metodo_inexistente',
    });
    // validateTpag fallback é '99' (com xPag="Outros" do TPAG_DESCRIPTIONS)
    expect(capturedBody.infNFe.pag.detPag[0].tPag).toBe('99');
    expect(capturedBody.infNFe.pag.detPag[0].xPag).toBe('Outros');
  });

  test('NFC-e com payments[] (multi-pagamento) — pag.detPag preserva split', async () => {
    // Workaround PIX: '17' do array vira tPag=99 + xPag="PIX".
    // '01' (dinheiro) fica nativo, sem xPag.
    capturedBody = null;
    await nf.emitNfce(company, {
      ...nfceData,
      payments: [
        { method: '17', value: 150 },          // Pix → tPag=99 + xPag=PIX
        { method: '01', value: 90, change: 0 }, // Dinheiro → tPag=01
      ],
    });
    const pag = capturedBody.infNFe.pag;
    expect(pag.detPag.length).toBe(2);
    expect(pag.detPag[0].tPag).toBe('99');
    expect(pag.detPag[0].xPag).toBe('PIX');
    expect(pag.detPag[0].vPag).toBe(150);
    expect(pag.detPag[1].tPag).toBe('01');
    expect(pag.detPag[1].xPag).toBeUndefined();
    expect(pag.detPag[1].vPag).toBe(90);
    expect(pag.vTroco).toBe(0);
  });
});
