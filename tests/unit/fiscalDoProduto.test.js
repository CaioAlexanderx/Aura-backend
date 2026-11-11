// ============================================================
// 11/11/2026 — o cadastro do produto decide a nota (NFC-e própria):
// "imposto já veio pago" (icms_st_paid) → CSOSN 500 + CFOP 5405, origem
// e CEST do produto no XML, e MEI (CRT 4) sem IBS/CBS em produção.
// ============================================================
const taxEngine = require('../../src/services/sefazSp/taxEngine');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { companyDavi } = require('../fixtures/nfceDavi');

describe('taxEngine — fiscal do cadastro', () => {
  test('sem nada no cadastro: 102 / 5102 / origem 0 (igual a antes)', () => {
    const t = taxEngine.resolveItemTax({ taxProfile: null, crt: 1 });
    expect([t.csosn, t.cfop, t.orig]).toEqual(['102', '5102', '0']);
  });

  test('"imposto já veio pago" = Sim → ST: CSOSN 500 e CFOP 5405', () => {
    const t = taxEngine.resolveItemTax({ taxProfile: null, crt: 4, icmsStPaid: true });
    expect([t.csosn, t.icmsGroup, t.cfop]).toEqual(['500', 'ICMSSN500', '5405']);
  });

  test('"Não" ou vazio continua 102', () => {
    expect(taxEngine.resolveItemTax({ crt: 1, icmsStPaid: false }).csosn).toBe('102');
    expect(taxEngine.resolveItemTax({ crt: 1, icmsStPaid: null }).csosn).toBe('102');
  });

  test('tax_profile preenchido continua mandando (ajuste fino)', () => {
    const t = taxEngine.resolveItemTax({ taxProfile: 'simples_isento_faixa', crt: 1, icmsStPaid: true });
    expect([t.csosn, t.cfop]).toEqual(['103', '5102']);
  });

  test('origem vem do produto; fora de 0–8 cai em 0', () => {
    expect(taxEngine.resolveItemTax({ crt: 1, origem: 2 }).orig).toBe('2');
    expect(taxEngine.resolveItemTax({ crt: 1, origem: '1' }).orig).toBe('1');
    expect(taxEngine.resolveItemTax({ crt: 1, origem: 9 }).orig).toBe('0');
    expect(taxEngine.resolveItemTax({ crt: 1, origem: null }).orig).toBe('0');
  });

  test('MEI em produção não destaca IBS/CBS (como o Simples)', () => {
    expect(taxEngine.resolveItemIbsCbs({ crt: 4, tpAmb: 1, vBC: 100 })).toBeNull();
    expect(taxEngine.resolveItemIbsCbs({ crt: 1, tpAmb: 1, vBC: 100 })).toBeNull();
    // homologação segue exigindo o grupo; regime normal segue destacando
    expect(taxEngine.resolveItemIbsCbs({ crt: 4, tpAmb: 2, vBC: 100 })).not.toBeNull();
    expect(taxEngine.resolveItemIbsCbs({ crt: 3, tpAmb: 1, vBC: 100 })).not.toBeNull();
  });
});

describe('xmlBuilder — CEST e ST no item', () => {
  const base = { payments: [{ method: '01', value: 9 }], total_value: 9, serie: 1, numero: 1 };
  const opts = { tpAmb: 1, cNF: '12345678', dhEmi: '2026-11-11T10:00:00-03:00' };

  test('CEST logo depois do NCM, com CSOSN 500 e CFOP 5405', () => {
    const { infNfeXml } = xb.buildInfNfe({ ...companyDavi, tax_regime: 'mei' }, {
      ...base, items: [{ name: 'Biscoito', ncm: '19053100', cest: '17.053.00', csosn: '500', orig: '2', cfop: '5405', quantity: 1, price: 9 }],
    }, opts);
    expect(infNfeXml).toContain('<NCM>19053100</NCM><CEST>1705300</CEST><CFOP>5405</CFOP>');
    expect(infNfeXml).toContain('<ICMSSN500><orig>2</orig><CSOSN>500</CSOSN></ICMSSN500>');
    expect(infNfeXml).not.toContain('IBSCBS');
  });

  test('sem CEST (ou incompleto) não escreve a tag', () => {
    const { infNfeXml } = xb.buildInfNfe(companyDavi, {
      ...base, items: [{ name: 'Capa', ncm: '39269090', cest: '12345', quantity: 1, price: 9 }],
    }, opts);
    expect(infNfeXml).not.toContain('<CEST>');
    expect(infNfeXml).toContain('<NCM>39269090</NCM><CFOP>5102</CFOP>');
  });
});
