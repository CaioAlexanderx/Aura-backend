const taxEngine = require('../../src/services/sefazSp/taxEngine');
const contingency = require('../../src/services/sefazSp/contingency');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { companyDavi } = require('../fixtures/nfceDavi');

describe('S3.2 — taxEngine (Simples, piloto)', () => {
  test('perfis → CSOSN: padrao 102, isento_faixa 103, st 500, outros 900', () => {
    expect(taxEngine.resolveItemTax({ taxProfile: null, crt: 1 }).csosn).toBe('102');
    expect(taxEngine.resolveItemTax({ taxProfile: 'simples_isento_faixa', crt: 1 }).csosn).toBe('103');
    expect(taxEngine.resolveItemTax({ taxProfile: 'simples_st', crt: 1 }).csosn).toBe('500');
    expect(taxEngine.resolveItemTax({ taxProfile: 'simples_outros', crt: 4 }).csosn).toBe('900');
  });

  test('grupos do XSD por CSOSN', () => {
    expect(taxEngine.resolveItemTax({ taxProfile: 'simples_st', crt: 1 }).icmsGroup).toBe('ICMSSN500');
    expect(taxEngine.icmsGroupForCsosn('103')).toBe('ICMSSN102');
  });

  test('regime normal (CRT 3) fora do piloto: erro orientando gateway', () => {
    expect(() => taxEngine.resolveItemTax({ taxProfile: null, crt: 3 }))
      .toThrow(/gateway/);
  });

  test('tax_profile desconhecido: erro com os válidos', () => {
    expect(() => taxEngine.resolveItemTax({ taxProfile: 'lucro_real_st', crt: 1 }))
      .toThrow(/simples_padrao/);
  });

  test('validateNcm: formato, capítulo e aviso pro 00000000', () => {
    expect(taxEngine.validateNcm('64022000').valid).toBe(true);
    expect(taxEngine.validateNcm('123').valid).toBe(false);
    expect(taxEngine.validateNcm('99887766').valid).toBe(false); // capítulo 99
    const zero = taxEngine.validateNcm('00000000');
    expect(zero.valid).toBe(true);
    expect(zero.warning).toMatch(/778/);
  });

  test('xmlBuilder monta ICMSSN500/900 e PISOutr CST 49', () => {
    const data = {
      items: [
        { name: 'ST', ncm: '64022000', quantity: 1, price: 10, csosn: '500' },
        { name: 'Outros', ncm: '64041100', quantity: 1, price: 5, csosn: '900', pisCst: '49', cofinsCst: '49' },
      ],
      payments: [{ method: '01', value: 15 }],
      total_value: 15, serie: 1, numero: 9,
    };
    const { infNfeXml } = xb.buildInfNfe(companyDavi, data, { tpAmb: 2, cNF: '00000001', dhEmi: '2026-06-10T10:00:00-03:00' });
    expect(infNfeXml).toContain('<ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500>');
    expect(infNfeXml).toContain('<ICMSSN900><orig>0</orig><CSOSN>900</CSOSN></ICMSSN900>');
    expect(infNfeXml).toContain('<PISOutr><CST>49</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISOutr>');
    expect(infNfeXml).toContain('<COFINSNT>'); // item 1 mantém NT 07 default? não — item1 sem pisCst → 07
  });
});

describe('S3.1 — detector de indisponibilidade', () => {
  beforeEach(() => contingency.reset());

  test('1 falha não derruba; 2 consecutivas derrubam por 60s', () => {
    const t0 = 1000000;
    contingency.recordFailure(2, t0);
    expect(contingency.isLikelyOffline(2, t0 + 1)).toBe(false);
    contingency.recordFailure(2, t0 + 10);
    expect(contingency.isLikelyOffline(2, t0 + 11)).toBe(true);
    expect(contingency.isLikelyOffline(2, t0 + 10 + 60001)).toBe(false); // janela passou: sonda de novo
  });

  test('sucesso real zera o estado', () => {
    contingency.recordFailure(2);
    contingency.recordFailure(2);
    expect(contingency.isLikelyOffline(2)).toBe(true);
    contingency.recordSuccess(2);
    expect(contingency.isLikelyOffline(2)).toBe(false);
  });

  test('estados de homolog e produção são independentes', () => {
    contingency.recordFailure(1);
    contingency.recordFailure(1);
    expect(contingency.isLikelyOffline(1)).toBe(true);
    expect(contingency.isLikelyOffline(2)).toBe(false);
  });
});
