// ============================================================
// AURA. — Testes unitários: parser NF-e XML
// Cobertura: nfeProc wrapper, NFe raw, det único vs array,
//            decimal BR, EAN SEM GTIN, namespace, erros.
// Roda sem banco/HTTP: unit puro.
// ============================================================

const { parseNFeXML, parseBRFloat } = require('../src/utils/nfeParser');

// ── Fixtures ─────────────────────────────────────────────────

// NF-e com 2 itens, namespace completo, wrapper nfeProc
const XML_TWO_ITEMS = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe43260488379771004170550008283091828309539">
      <ide>
        <nNF>828309</nNF>
        <serie>5</serie>
        <dhEmi>2026-04-30T11:36:36-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>04883797000141</CNPJ>
        <xNome>CALCADOS BEIRA RIO S/A</xNome>
      </emit>
      <det nItem="1">
        <prod>
          <cProd>27920512</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>SAPATO FEM. DE USO COMUM C/ SOLA SINT.</xProd>
          <NCM>64029990</NCM>
          <CFOP>6101</CFOP>
          <uCom>PAR</uCom>
          <qCom>1.0000</qCom>
          <vUnCom>76.1000000000</vUnCom>
          <vProd>76.10</vProd>
        </prod>
      </det>
      <det nItem="2">
        <prod>
          <cProd>27920516</cProd>
          <cEAN>7891234567890</cEAN>
          <xProd>SAPATO FEM. DE USO COMUM C/ SOLA SINT. TAM 35</xProd>
          <NCM>64029990</NCM>
          <CFOP>6101</CFOP>
          <uCom>PAR</uCom>
          <qCom>2.0000</qCom>
          <vUnCom>76.1000000000</vUnCom>
          <vProd>152.20</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>228.30</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;

// NF-e com 1 item (det não-array) e wrapper simples
const XML_ONE_ITEM = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc>
  <NFe>
    <infNFe>
      <ide>
        <nNF>001</nNF>
        <dhEmi>2026-01-15T10:00:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>12345678000100</CNPJ>
        <xNome>FORNECEDOR TESTE LTDA</xNome>
      </emit>
      <det nItem="1">
        <prod>
          <cProd>SKU001</cProd>
          <cEAN>SEM GTIN</cEAN>
          <xProd>Produto Unico</xProd>
          <NCM>61159500</NCM>
          <uCom>un</uCom>
          <qCom>10.0000</qCom>
          <vUnCom>25.5000</vUnCom>
          <vProd>255.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>255.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;

// NFe raw sem wrapper nfeProc, data em dEmi (sem hora)
const XML_RAW_NFE = `<?xml version="1.0"?>
<NFe>
  <infNFe>
    <ide>
      <nNF>999</nNF>
      <dEmi>2025-12-01</dEmi>
    </ide>
    <emit>
      <CNPJ>99999999000199</CNPJ>
      <xNome>FORNECEDOR RAW LTDA</xNome>
    </emit>
    <det nItem="1">
      <prod>
        <cProd>RAW001</cProd>
        <xProd>Produto Raw</xProd>
        <NCM>42029220</NCM>
        <uCom>un</uCom>
        <qCom>5</qCom>
        <vUnCom>100</vUnCom>
        <vProd>500</vProd>
      </prod>
    </det>
    <total><ICMSTot><vNF>500.00</vNF></ICMSTot></total>
  </infNFe>
</NFe>`;

// Decimais no formato brasileiro (vírgula)
const XML_BR_DECIMALS = `<nfeProc>
  <NFe>
    <infNFe>
      <ide><nNF>100</nNF></ide>
      <emit><CNPJ>11111111000111</CNPJ><xNome>TESTE BR</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>BR001</cProd>
          <xProd>Produto Decimal Brasileiro</xProd>
          <NCM>64029990</NCM>
          <uCom>PAR</uCom>
          <qCom>1,0000</qCom>
          <vUnCom>76,1000000000</vUnCom>
          <vProd>76,10</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>76,10</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;

// EAN válido de 13 dígitos
const XML_WITH_EAN = `<nfeProc>
  <NFe>
    <infNFe>
      <ide><nNF>200</nNF></ide>
      <emit><xNome>EAN TESTE</xNome></emit>
      <det nItem="1">
        <prod>
          <cProd>EAN001</cProd>
          <cEAN>7891000315507</cEAN>
          <xProd>Produto Com EAN</xProd>
          <NCM>21069090</NCM>
          <uCom>un</uCom>
          <qCom>3</qCom>
          <vUnCom>10.00</vUnCom>
          <vProd>30.00</vProd>
        </prod>
      </det>
      <total><ICMSTot><vNF>30.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;

// ── Suite: parseNFeXML ────────────────────────────────────────

describe('parseNFeXML', () => {

  describe('nfeProc com dois itens', () => {
    let result;
    beforeAll(() => { result = parseNFeXML(XML_TWO_ITEMS); });

    test('retorna array com 2 itens', () => {
      expect(result.items).toHaveLength(2);
    });

    test('extrai dados do emitente corretamente', () => {
      expect(result.supplier_name).toBe('CALCADOS BEIRA RIO S/A');
      expect(result.supplier_cnpj).toBe('04883797000141');
    });

    test('extrai número e série da NF', () => {
      expect(result.invoice_number).toBe('828309');
      expect(result.invoice_series).toBe('5');
    });

    test('extrai data de emissão (sem hora)', () => {
      expect(result.invoice_date).toBe('2026-04-30');
    });

    test('extrai valor total da nota', () => {
      expect(result.total_value).toBe(228.3);
    });

    test('item 1: campos de produto corretos', () => {
      const item = result.items[0];
      expect(item.description).toBe('SAPATO FEM. DE USO COMUM C/ SOLA SINT.');
      expect(item.quantity).toBe(1);
      expect(item.unit_cost).toBe(76.1);
      expect(item.unit).toBe('PAR');
      expect(item.ncm).toBe('64029990');
      expect(item.supplier_code).toBe('27920512');
    });

    test('item 1: EAN "SEM GTIN" retorna null', () => {
      expect(result.items[0].ean).toBeNull();
    });

    test('item 2: EAN numérico válido é retornado', () => {
      expect(result.items[1].ean).toBe('7891234567890');
    });

    test('item 2: quantidade 2', () => {
      expect(result.items[1].quantity).toBe(2);
    });
  });

  describe('det único (não-array)', () => {
    test('single det é normalizado para array de 1 item', () => {
      const result = parseNFeXML(XML_ONE_ITEM);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].description).toBe('Produto Unico');
      expect(result.items[0].quantity).toBe(10);
      expect(result.items[0].unit_cost).toBe(25.5);
      expect(result.items[0].ncm).toBe('61159500');
    });
  });

  describe('NFe raw sem wrapper nfeProc', () => {
    test('parseia corretamente sem nfeProc', () => {
      const result = parseNFeXML(XML_RAW_NFE);
      expect(result.supplier_name).toBe('FORNECEDOR RAW LTDA');
      expect(result.invoice_number).toBe('999');
    });

    test('data em dEmi (sem hora) é extraída corretamente', () => {
      const result = parseNFeXML(XML_RAW_NFE);
      expect(result.invoice_date).toBe('2025-12-01');
    });
  });

  describe('decimal no formato brasileiro', () => {
    test('vírgula como separador decimal é convertida corretamente', () => {
      const result = parseNFeXML(XML_BR_DECIMALS);
      expect(result.items[0].unit_cost).toBeCloseTo(76.1, 2);
      expect(result.items[0].quantity).toBeCloseTo(1, 2);
      expect(result.total_value).toBeCloseTo(76.1, 2);
    });
  });

  describe('EAN válido', () => {
    test('EAN numérico de 13 dígitos é retornado como string', () => {
      const result = parseNFeXML(XML_WITH_EAN);
      expect(result.items[0].ean).toBe('7891000315507');
    });
  });

  describe('erros e edge cases', () => {
    test('XML completamente inválido lança erro', () => {
      expect(() => parseNFeXML('isso nao e xml <<<')).toThrow();
    });

    test('XML válido sem elemento NFe lança erro descritivo', () => {
      expect(() => parseNFeXML('<root><foo>bar</foo></root>')).toThrow(/NFe/);
    });

    test('NFe sem itens det lança erro "Nenhum item"', () => {
      const semDet = `<nfeProc><NFe><infNFe>
        <ide><nNF>1</nNF></ide>
        <emit><xNome>X</xNome></emit>
        <total><ICMSTot><vNF>0</vNF></ICMSTot></total>
      </infNFe></NFe></nfeProc>`;
      expect(() => parseNFeXML(semDet)).toThrow(/Nenhum item/);
    });

    test('string vazia lança erro', () => {
      expect(() => parseNFeXML('')).toThrow();
    });
  });
});

// ── Suite: parseBRFloat ──────────────────────────────────────

describe('parseBRFloat', () => {
  test('decimal americano (ponto)', () => {
    expect(parseBRFloat('76.1000')).toBeCloseTo(76.1);
  });

  test('decimal brasileiro (vírgula)', () => {
    expect(parseBRFloat('76,1000')).toBeCloseTo(76.1);
  });

  test('milhar + decimal BR (ponto=milhar, vírgula=decimal)', () => {
    expect(parseBRFloat('1.234,56')).toBeCloseTo(1234.56);
  });

  test('inteiro sem separador', () => {
    expect(parseBRFloat('100')).toBe(100);
  });

  test('número JS direto', () => {
    expect(parseBRFloat(76.1)).toBeCloseTo(76.1);
  });

  test('null retorna 0', () => {
    expect(parseBRFloat(null)).toBe(0);
  });

  test('undefined retorna 0', () => {
    expect(parseBRFloat(undefined)).toBe(0);
  });

  test('string vazia retorna 0', () => {
    expect(parseBRFloat('')).toBe(0);
  });
});
