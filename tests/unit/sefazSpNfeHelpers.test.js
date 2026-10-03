'use strict';
const fs = require('fs');
const path = require('path');
const helpers = require('../../src/services/sefazSp/nfeHelpers');

const ENGINE_DIR = path.join(__dirname, '../../src/services/sefazSp');

describe('sefazSp/nfeHelpers', () => {
  test('a engine própria não importa o módulo do gateway', () => {
    const offenders = fs.readdirSync(ENGINE_DIR)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /require\(['"][^'"]*nuvemfiscal['"]\)/.test(
        fs.readFileSync(path.join(ENGINE_DIR, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('services/nuvemfiscal reexporta as mesmas funções', () => {
    const gateway = require('../../src/services/nuvemfiscal');
    for (const name of Object.keys(helpers)) {
      expect(gateway[name]).toBe(helpers[name]);
    }
  });

  test('ufToCodigo: código IBGE da UF, SP como padrão', () => {
    expect(helpers.ufToCodigo('sp')).toBe(35);
    expect(helpers.ufToCodigo(' AP ')).toBe(16);
    expect(helpers.ufToCodigo(undefined)).toBe(35);
  });

  test('isoBR: horário de Brasília com offset -03:00', () => {
    expect(helpers.isoBR(new Date('2026-10-03T15:30:45.123Z'))).toBe('2026-10-03T12:30:45-03:00');
  });

  test('generateCNF: 8 dígitos', () => {
    expect(helpers.generateCNF()).toMatch(/^\d{8}$/);
  });

  test('buildAccessKey44: 44 dígitos com DV módulo 11', () => {
    const chave = helpers.buildAccessKey44({
      cUF: 35, ano2: '26', mes2: '10', cnpj: '11.222.333/0001-81',
      mod: 65, serie: 2, nNF: 900, tpEmis: 1, cNF: '12345678',
    });
    expect(chave).toHaveLength(44);
    expect(chave.slice(0, 43)).toBe('3526101122233300018165002000000900112345678');
    expect(chave.slice(-1)).toBe(helpers.calcDvChaveAcesso(chave.slice(0, 43)));
  });

  test('calcDvChaveAcesso: valor fixado', () => {
    expect(helpers.calcDvChaveAcesso('5206043300991100250655012000000780026730161')).toBe('5');
  });

  test('validateTpag: aceita os códigos do leiaute, o resto vira 99', () => {
    expect(helpers.validateTpag('17')).toBe('17');
    expect(helpers.validateTpag('1')).toBe('01');
    expect(helpers.validateTpag(undefined)).toBe('01');
    expect(helpers.validateTpag('dinheiro')).toBe('99');
  });
});
