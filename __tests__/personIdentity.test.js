// ============================================================
// AURA — src/utils/personIdentity.js (F7.0)
// Helper de BORDA: o mesmo dado precisa estar escrito do mesmo jeito nos
// dois lados para poder subir do dojô para a federação.
// Módulo puro, sem banco — teste unitário direto.
// ============================================================
'use strict';

const {
  onlyDigits,
  normalizeCpf,
  isCpfLength,
  isCnpjLength,
  normalizeSex,
  toDojoSex,
  isKnownSex,
  normalizeUf,
  normalizeZipCode,
  SEX_CANONICAL,
  SEX_DOJO,
} = require('../src/utils/personIdentity');

const { digitsOnly } = require('../src/services/karatePractitionerDedup');

describe('CPF — semânticas diferentes de propósito', () => {
  it('onlyDigits devolve STRING (compatível com regexp_replace do Postgres)', () => {
    expect(onlyDigits('529.982.247-25')).toBe('52998224725');
    expect(onlyDigits('')).toBe('');
    expect(onlyDigits(null)).toBe('');
    expect(onlyDigits(undefined)).toBe('');
  });

  it('normalizeCpf devolve NULL quando vazio — é o que vai para a COLUNA', () => {
    // '' furaria qualquer UNIQUE parcial `WHERE cpf IS NOT NULL`.
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(normalizeCpf('   ')).toBeNull();
    expect(normalizeCpf(null)).toBeNull();
  });

  it('onlyDigits é byte-a-byte igual ao digitsOnly histórico do matcher', () => {
    // Enquanto os dois existirem, eles NÃO podem divergir: o matcher compara
    // o resultado dele com regexp_replace(...) direto em SQL.
    for (const v of ['529.982.247-25', '', null, undefined, 'abc', '12.345.678/0001-90', 0]) {
      expect(onlyDigits(v)).toBe(digitsOnly(v));
    }
  });

  it('reconhece tamanho de CPF e de CNPJ', () => {
    expect(isCpfLength('529.982.247-25')).toBe(true);
    expect(isCpfLength('5299822472')).toBe(false);
    expect(isCnpjLength('12.345.678/0001-90')).toBe(true);
    expect(isCnpjLength('52998224725')).toBe(false);
  });
});

describe('Sexo — três vocabulários, um canônico', () => {
  it('o canônico é o de customers.sex (CHECK da migration 205)', () => {
    expect(SEX_CANONICAL).toEqual(['masculino', 'feminino', 'outro']);
    expect(SEX_DOJO).toEqual(['M', 'F', 'other']);
  });

  it('normalizeSex traduz QUALQUER vocabulário para o canônico', () => {
    expect(normalizeSex('M')).toBe('masculino');
    expect(normalizeSex('m')).toBe('masculino');
    expect(normalizeSex(' Masculino ')).toBe('masculino');
    expect(normalizeSex('F')).toBe('feminino');
    expect(normalizeSex('feminino')).toBe('feminino');
    expect(normalizeSex('other')).toBe('outro');
    expect(normalizeSex('outro')).toBe('outro');
  });

  it('toDojoSex volta para o vocabulário do dojô (zero mudança visível no app)', () => {
    expect(toDojoSex('masculino')).toBe('M');
    expect(toDojoSex('M')).toBe('M');
    expect(toDojoSex('feminino')).toBe('F');
    expect(toDojoSex('outro')).toBe('other');
    expect(toDojoSex('other')).toBe('other');
  });

  it('ida e volta é estável nos dois sentidos', () => {
    for (const v of SEX_DOJO) expect(toDojoSex(normalizeSex(v))).toBe(v);
    for (const v of SEX_CANONICAL) expect(normalizeSex(toDojoSex(v))).toBe(v);
  });

  it('NUNCA chuta: valor desconhecido e ausência viram null', () => {
    expect(normalizeSex('sei-la')).toBeNull();
    expect(normalizeSex('')).toBeNull();
    expect(normalizeSex(null)).toBeNull();
    expect(normalizeSex(undefined)).toBeNull();
    expect(toDojoSex('sei-la')).toBeNull();
    expect(isKnownSex('M')).toBe(true);
    expect(isKnownSex(null)).toBe(false);
  });

  it('customers.gender (M/F/outro, odonto DEPRECADO) também é traduzível', () => {
    // A coluna morre numa fase posterior; enquanto isso, o helper já lê.
    expect(normalizeSex('M')).toBe('masculino');
    expect(normalizeSex('outro')).toBe('outro');
  });
});

describe('Endereço — vocabulário compartilhado dojô ↔ federação', () => {
  it('UF vira 2 letras maiúsculas ou null', () => {
    expect(normalizeUf('pa')).toBe('PA');
    expect(normalizeUf(' sp ')).toBe('SP');
    expect(normalizeUf('S.P.')).toBe('SP');
    expect(normalizeUf('Pará')).toBeNull(); // nome por extenso não é UF
    expect(normalizeUf('')).toBeNull();
    expect(normalizeUf(null)).toBeNull();
  });

  it('CEP vira 8 dígitos sem máscara ou null', () => {
    expect(normalizeZipCode('66.000-000')).toBe('66000000');
    expect(normalizeZipCode('66000000')).toBe('66000000');
    expect(normalizeZipCode('123')).toBeNull();
    expect(normalizeZipCode(null)).toBeNull();
  });
});
