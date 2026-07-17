// ============================================================
// AURA. — Aura Notas / Gestão (STAFF): unit dos validadores/normalizadores
// e do shape de provider_efetivo (modo AUTO). Puro, sem supertest/db.
// ============================================================
'use strict';

const g = require('../../src/services/auraNotas/gestao');

describe('normalizeProvider', () => {
  test("'auto' e null viram NULL (modo AUTO)", () => {
    expect(g.normalizeProvider('auto')).toEqual({ ok: true, value: null });
    expect(g.normalizeProvider(null)).toEqual({ ok: true, value: null });
  });
  test('undefined não mexe', () => {
    expect(g.normalizeProvider(undefined)).toEqual({ ok: true, value: undefined });
  });
  test('sefaz_sp e nuvemfiscal passam', () => {
    expect(g.normalizeProvider('sefaz_sp')).toEqual({ ok: true, value: 'sefaz_sp' });
    expect(g.normalizeProvider('nuvemfiscal')).toEqual({ ok: true, value: 'nuvemfiscal' });
  });
  test('valor fora da whitelist falha', () => {
    expect(g.normalizeProvider('focusnfe').ok).toBe(false);
    expect(g.normalizeProvider('xyz').ok).toBe(false);
  });
});

describe('validateInscricaoEstadual', () => {
  test('só dígitos', () => {
    expect(g.validateInscricaoEstadual('123456789')).toEqual({ ok: true, value: '123456789' });
  });
  test('ISENTO aceito', () => {
    expect(g.validateInscricaoEstadual('isento')).toEqual({ ok: true, value: 'ISENTO' });
  });
  test('com letras falha', () => {
    expect(g.validateInscricaoEstadual('12a45').ok).toBe(false);
  });
  test('vazio limpa (null)', () => {
    expect(g.validateInscricaoEstadual('')).toEqual({ ok: true, value: null });
  });
});

describe('validateCep / validateIbge', () => {
  test('CEP 8 dígitos ok (remove máscara)', () => {
    expect(g.validateCep('01310-100')).toEqual({ ok: true, value: '01310100' });
  });
  test('CEP tamanho errado falha', () => {
    expect(g.validateCep('123').ok).toBe(false);
  });
  test('IBGE 7 dígitos ok', () => {
    expect(g.validateIbge('3550308')).toEqual({ ok: true, value: '3550308' });
  });
  test('IBGE com letra falha', () => {
    expect(g.validateIbge('35503o8').ok).toBe(false);
    expect(g.validateIbge('355030').ok).toBe(false);
  });
});

describe('validateTaxRegime', () => {
  test('whitelist', () => {
    expect(g.validateTaxRegime('simples_nacional').ok).toBe(true);
    expect(g.validateTaxRegime('mei').ok).toBe(true);
  });
  test('fora da whitelist falha', () => {
    expect(g.validateTaxRegime('lucro_arbitrado').ok).toBe(false);
  });
});

describe('validateCscId', () => {
  test('numérico até 6 dígitos', () => {
    expect(g.validateCscId('1')).toEqual({ ok: true, value: '1' });
    expect(g.validateCscId('000001')).toEqual({ ok: true, value: '000001' });
  });
  test('7 dígitos falha', () => {
    expect(g.validateCscId('1234567').ok).toBe(false);
  });
  test('não-numérico falha', () => {
    expect(g.validateCscId('12a').ok).toBe(false);
    expect(g.validateCscId('').ok).toBe(false);
    expect(g.validateCscId(null).ok).toBe(false);
  });
});

describe('validateCscToken', () => {
  const ok36 = 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8'; // 36 alfanum
  const okUuid = '82adf14f-9d3b-4320-be1f-b4101554c4c9'; // formato real SEFAZ-SP
  test('36 alfanuméricos ok', () => {
    expect(g.validateCscToken(ok36)).toEqual({ ok: true, value: ok36 });
  });
  test('UUID com hífens (formato SEFAZ-SP) ok, preservado exato', () => {
    expect(g.validateCscToken(okUuid)).toEqual({ ok: true, value: okUuid });
    expect(g.validateCscToken('x'.repeat(19)).ok).toBe(false);
    expect(g.validateCscToken('x'.repeat(45)).ok).toBe(false);
    expect(g.validateCscToken('82adf14f_9d3b').ok).toBe(false);
  });
  test('35 ou 37 falha', () => {
    expect(g.validateCscToken(ok36.slice(0, 15)).ok).toBe(false);
    expect(g.validateCscToken((ok36 + ok36).slice(0, 45)).ok).toBe(false);
  });
  test('com símbolo falha', () => {
    expect(g.validateCscToken('A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R*').ok).toBe(false);
  });
});

describe('validateSerieSefazSp / validateAmbiente / validateUf', () => {
  test('série 1–999', () => {
    expect(g.validateSerieSefazSp('2')).toEqual({ ok: true, value: 2 });
    expect(g.validateSerieSefazSp(0).ok).toBe(false);
    expect(g.validateSerieSefazSp(1000).ok).toBe(false);
  });
  test('ambiente', () => {
    expect(g.validateAmbiente('producao').ok).toBe(true);
    expect(g.validateAmbiente('homologacao').ok).toBe(true);
    expect(g.validateAmbiente('sandbox').ok).toBe(false);
  });
  test('uf 2 letras uppercase', () => {
    expect(g.validateUf('sp')).toEqual({ ok: true, value: 'SP' });
    expect(g.validateUf('SPX').ok).toBe(false);
  });
});

describe('cscOk / engineCapable', () => {
  test('cscOk exige id + algum token', () => {
    expect(g.cscOk({ csc_id: '1', csc_token_enc: 'v1:..' })).toBe(true);
    expect(g.cscOk({ csc_id: '1', csc_token: 'claro' })).toBe(true);
    expect(g.cscOk({ csc_id: '1' })).toBe(false);
    expect(g.cscOk({ csc_token_enc: 'v1:..' })).toBe(false);
    expect(g.cscOk(null)).toBe(false);
  });
  test('engineCapable = cscOk AND cert vigente', () => {
    const cfg = { csc_id: '1', csc_token_enc: 'v1:..' };
    expect(g.engineCapable(cfg, true)).toBe(true);
    expect(g.engineCapable(cfg, false)).toBe(false);
    expect(g.engineCapable({ csc_id: '1' }, true)).toBe(false);
  });
});

describe('providerEfetivo (modo AUTO)', () => {
  test("provider='nuvemfiscal' => sempre gateway (kill-switch)", () => {
    expect(g.providerEfetivo('nuvemfiscal', true)).toBe('nuvemfiscal');
    expect(g.providerEfetivo('nuvemfiscal', false)).toBe('nuvemfiscal');
  });
  test("provider='sefaz_sp' => sempre engine (forçado)", () => {
    expect(g.providerEfetivo('sefaz_sp', false)).toBe('sefaz_sp');
    expect(g.providerEfetivo('sefaz_sp', true)).toBe('sefaz_sp');
  });
  test('NULL/auto => engine só quando apta', () => {
    expect(g.providerEfetivo(null, true)).toBe('sefaz_sp');
    expect(g.providerEfetivo(null, false)).toBe('nuvemfiscal');
  });
});

describe('daysLeft', () => {
  test('null quando sem data', () => {
    expect(g.daysLeft(null)).toBeNull();
  });
  test('calcula dias (piso)', () => {
    const now = new Date('2026-07-16T12:00:00Z');
    expect(g.daysLeft('2026-07-26T12:00:00Z', now)).toBe(10);
    expect(g.daysLeft('2026-07-16T00:00:00Z', now)).toBe(-1);
  });
});
