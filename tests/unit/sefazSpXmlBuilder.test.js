const xb = require('../../src/services/sefazSp/xmlBuilder');
const { calcDvChaveAcesso } = require('../../src/services/nuvemfiscal');
const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

const OPTS_HOMOLOG = { tpAmb: 2, cNF: '12345678', dhEmi: '2026-06-10T10:00:00-03:00' };

function build(overridesData = {}, overridesOpts = {}) {
  return xb.buildInfNfe(
    companyDavi,
    { ...nfceDataVendaTipica, ...overridesData },
    { ...OPTS_HOMOLOG, ...overridesOpts }
  );
}

describe('sefazSp/xmlBuilder — chave de acesso', () => {
  test('44 dígitos, cUF=35, mod=65, série/número corretos', () => {
    const { chave } = build();
    expect(chave).toMatch(/^\d{44}$/);
    expect(chave.slice(0, 2)).toBe('35');           // SP
    expect(chave.slice(2, 6)).toBe('2606');         // AAMM
    expect(chave.slice(6, 20)).toBe('11222333000181');
    expect(chave.slice(20, 22)).toBe('65');         // modelo
    expect(chave.slice(22, 25)).toBe('001');        // série
    expect(chave.slice(25, 34)).toBe('000000231');  // nNF
    expect(chave.slice(34, 35)).toBe('1');          // tpEmis
    expect(chave.slice(35, 43)).toBe('12345678');   // cNF
  });

  test('DV (módulo 11) confere', () => {
    const { chave } = build();
    expect(chave.slice(-1)).toBe(calcDvChaveAcesso(chave.slice(0, 43)));
  });

  test('Id do infNFe = NFe + chave; cDV no ide bate', () => {
    const { infNfeXml, chave } = build();
    expect(infNfeXml).toContain(`Id="NFe${chave}"`);
    expect(infNfeXml).toContain(`<cDV>${chave.slice(-1)}</cDV>`);
  });
});

describe('sefazSp/xmlBuilder — estrutura e ordem', () => {
  test('blocos na ordem do XSD: ide,emit,dest,det,total,transp,pag', () => {
    const { infNfeXml } = build();
    const order = ['<ide>', '<emit>', '<dest>', '<det nItem="1">', '<total>', '<transp>', '<pag>'];
    let last = -1;
    for (const piece of order) {
      const idx = infNfeXml.indexOf(piece);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  });

  test('ide: mod=65, tpImp=4, idDest=1, indPres=1, sem dhCont fora de contingência', () => {
    const { infNfeXml } = build();
    expect(infNfeXml).toContain('<mod>65</mod>');
    expect(infNfeXml).toContain('<tpImp>4</tpImp>');
    expect(infNfeXml).not.toContain('<dhCont>');
  });

  test('emit: CRT=1 (Simples), cMun IBGE Jacareí, IE limpa', () => {
    const { infNfeXml } = build();
    expect(infNfeXml).toContain('<CRT>1</CRT>');
    expect(infNfeXml).toContain('<cMun>3524402</cMun>');
    expect(infNfeXml).toContain('<IE>111222333444</IE>');
  });

  test('nenhuma tag vazia', () => {
    const { infNfeXml } = build();
    expect(infNfeXml).not.toMatch(/<[A-Za-z]+><\/[A-Za-z]+>/);
  });
});

describe('sefazSp/xmlBuilder — dest', () => {
  test('homologação: xNome do dest é o texto fixo (anti-rejeição 703)', () => {
    const { infNfeXml } = build();
    expect(infNfeXml).toContain(`<xNome>${xb.HOMOLOG_DEST_XNOME}</xNome>`);
    expect(infNfeXml).toContain('<CPF>39053344705</CPF>');
    expect(infNfeXml).toContain('<indIEDest>9</indIEDest>');
  });

  test('produção: xNome real do consumidor', () => {
    const { infNfeXml } = build({}, { tpAmb: 1 });
    expect(infNfeXml).toContain('<xNome>Cliente Teste</xNome>');
  });

  test('consumidor não identificado: sem bloco dest', () => {
    const { infNfeXml } = build({ recipient_cpf: null, recipient_name: null });
    expect(infNfeXml).not.toContain('<dest>');
  });
});

describe('sefazSp/xmlBuilder — det/total (Simples Nacional, matriz Davi)', () => {
  test('CSOSN 102 em todos os itens, PIS/COFINS NT 07', () => {
    const { infNfeXml } = build();
    expect((infNfeXml.match(/<CSOSN>102<\/CSOSN>/g) || []).length).toBe(3);
    expect((infNfeXml.match(/<PISNT><CST>07<\/CST><\/PISNT>/g) || []).length).toBe(3);
  });

  test('totais: vProd soma itens, vDesc aplicado, vNF = total da venda', () => {
    const { infNfeXml } = build();
    expect(infNfeXml).toContain('<vProd>559.96</vProd>');
    expect(infNfeXml).toContain('<vDesc>10.00</vDesc>');
    expect(infNfeXml).toContain('<vNF>549.96</vNF>');
  });

  test('formatos: qCom sem zeros à direita, vUnCom mínimo 2 casas', () => {
    expect(xb.fmtQty(2)).toBe('2');
    expect(xb.fmtQty(1.5)).toBe('1.5');
    expect(xb.fmtQty(0.125)).toBe('0.125');
    expect(xb.fmtUnit(159.99)).toBe('159.99');
    expect(xb.fmtUnit(0.3333333)).toBe('0.3333333');
  });

  test('NCM inválido rejeita localmente (não vira rejeição SEFAZ)', () => {
    expect(() => build({ items: [{ name: 'X', ncm: '123', quantity: 1, price: 1 }] }))
      .toThrow(/NCM inválido/);
  });

  test('barcode não-numérico vira SEM GTIN', () => {
    const { infNfeXml } = build({
      items: [{ name: 'X', ncm: '64022000', quantity: 1, price: 10, barcode: 'ABC' }],
      payments: [{ method: '01', value: 10 }], total_value: 10,
    });
    expect(infNfeXml).toContain('<cEAN>SEM GTIN</cEAN>');
  });
});

describe('sefazSp/xmlBuilder — pag (paridade com gateway)', () => {
  test('multi-pagamento: PIX→99/xPag PIX, dinheiro, crediário tPag 05 indPag 1, troco', () => {
    const { infNfeXml } = build();
    expect(infNfeXml).toContain('<tPag>99</tPag><xPag>PIX</xPag><vPag>300.00</vPag>');
    expect(infNfeXml).toContain('<indPag>1</indPag><tPag>05</tPag><vPag>99.96</vPag>');
    expect(infNfeXml).toContain('<vTroco>0.04</vTroco>');
  });

  test('cartão (03/04) leva card/tpIntegra=2', () => {
    const { infNfeXml } = build({
      payments: [{ method: '03', value: 549.96 }],
    });
    expect(infNfeXml).toContain('<card><tpIntegra>2</tpIntegra></card>');
  });

  test('sem payments[]: fallback dinheiro pelo total', () => {
    const { infNfeXml } = build({ payments: undefined });
    expect(infNfeXml).toContain('<tPag>01</tPag><vPag>549.96</vPag>');
  });
});

describe('sefazSp/xmlBuilder — contingência (tpEmis=9)', () => {
  test('exige dhCont/xJust', () => {
    expect(() => build({}, { tpEmis: 9 })).toThrow(/dhCont e xJust/);
  });

  test('emite dhCont/xJust e tpEmis na chave', () => {
    const r = build({}, {
      tpEmis: 9, dhCont: '2026-06-10T10:05:00-03:00',
      xJust: 'Falha de comunicacao com a SEFAZ-SP detectada pelo monitor',
    });
    expect(r.infNfeXml).toContain('<tpEmis>9</tpEmis>');
    expect(r.infNfeXml).toContain('<dhCont>2026-06-10T10:05:00-03:00</dhCont>');
    expect(r.chave.slice(34, 35)).toBe('9');
  });
});

describe('sefazSp/xmlBuilder — escaping e composição', () => {
  test('caracteres especiais escapados (& < >)', () => {
    const { infNfeXml } = build({
      items: [{ name: 'Sapato P&B <40>', ncm: '64022000', quantity: 1, price: 10 }],
      payments: [{ method: '01', value: 10 }], total_value: 10,
    });
    expect(infNfeXml).toContain('Sapato P&amp;B &lt;40&gt;');
  });

  test('composeNfe: NFe com infNFe + infNFeSupl + Signature na ordem', () => {
    const nfe = xb.composeNfe({
      signedInfNfeXml: '<infNFe Id="NFe1"/>',
      infNfeSuplXml: '<infNFeSupl/>',
      signatureXml: '<Signature/>',
    });
    expect(nfe.indexOf('<infNFe')).toBeLessThan(nfe.indexOf('<infNFeSupl'));
    expect(nfe.indexOf('<infNFeSupl')).toBeLessThan(nfe.indexOf('<Signature'));
    expect(nfe).toContain(`xmlns="${xb.NFE_NS}"`);
  });
});
