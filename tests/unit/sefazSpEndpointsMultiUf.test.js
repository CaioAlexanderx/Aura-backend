'use strict';
// Cobertura da extensão multi-UF dos endpoints da engine própria
// (06/08/2026 — Nuvem Fiscal não existe mais, toda emissão sai pela
// engine própria; AP entra via SVRS). Ver services/sefazSp/endpoints.js
// e services/sefazSp/nfe55.js.

const { getEndpoints, ENDPOINTS } = require('../../src/services/sefazSp/endpoints');
const { getEndpoints55, ENDPOINTS_NFE55 } = require('../../src/services/sefazSp/nfe55');

describe('sefazSp/endpoints — NFC-e 65 multi-UF', () => {
  test('SP continua resolvendo (regressão) — homologação e produção', () => {
    expect(() => getEndpoints('SP', 'homologacao')).not.toThrow();
    expect(() => getEndpoints('SP', 'producao')).not.toThrow();
    const homolog = getEndpoints('SP', 'homologacao');
    expect(homolog.autorizacao).toContain('homologacao.nfce.fazenda.sp.gov.br');
  });

  test('AP resolve via SVRS — homologação', () => {
    const ep = getEndpoints('AP', 'homologacao');
    expect(ep.autorizacao).toBe('https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(ep.retAutorizacao).toContain('svrs.rs.gov.br');
    expect(ep.statusServico).toContain('svrs.rs.gov.br');
    expect(ep.qrCodeBase).toBeTruthy();
    expect(ep.urlConsulta).toBeTruthy();
  });

  test('AP resolve via SVRS — produção', () => {
    const ep = getEndpoints('AP', 'producao');
    expect(ep.autorizacao).toBe('https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
    expect(ep.autorizacao).not.toContain('homologacao');
  });

  test('aceita tpAmb numérico (1=produção, 2=homologação) pra AP', () => {
    expect(getEndpoints('AP', 1).autorizacao).toContain('nfce.svrs.rs.gov.br');
    expect(getEndpoints('AP', 2).autorizacao).toContain('nfce-homologacao.svrs.rs.gov.br');
  });

  test('lowercase/whitespace de UF é normalizado', () => {
    expect(() => getEndpoints('ap', 'homologacao')).not.toThrow();
  });

  test('UF não suportada ainda lança erro claro (sem prometer "escopo: SP")', () => {
    expect(() => getEndpoints('RJ', 'homologacao')).toThrow(/RJ.*não suportada/);
    expect(() => getEndpoints('RJ', 'homologacao')).not.toThrow(/escopo: SP/);
  });

  test('ENDPOINTS expõe exatamente as UFs suportadas hoje (SP, AP)', () => {
    expect(Object.keys(ENDPOINTS).sort()).toEqual(['AP', 'SP']);
  });
});

describe('sefazSp/nfe55 — endpoints multi-UF (NF-e 55 devolução)', () => {
  test('SP continua resolvendo (regressão)', () => {
    expect(() => getEndpoints55('SP', 'homologacao')).not.toThrow();
    expect(() => getEndpoints55('SP', 'producao')).not.toThrow();
  });

  test('AP resolve via SVRS — homologação e produção', () => {
    const homolog = getEndpoints55('AP', 'homologacao');
    expect(homolog.autorizacao).toBe('https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');

    const producao = getEndpoints55('AP', 'producao');
    expect(producao.autorizacao).toBe('https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx');
  });

  test('UF não suportada ainda lança erro claro', () => {
    expect(() => getEndpoints55('MG', 'homologacao')).toThrow(/MG.*não suportada/);
  });

  test('ENDPOINTS_NFE55 expõe exatamente as UFs suportadas hoje (SP, AP)', () => {
    expect(Object.keys(ENDPOINTS_NFE55).sort()).toEqual(['AP', 'SP']);
  });
});
