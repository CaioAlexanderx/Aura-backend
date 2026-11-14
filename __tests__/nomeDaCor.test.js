// ============================================================
// AURA. — services/nomeDaCor (CP2a da revisão de cores, 14/11/2026)
// Os casos em comum com o app estão em fixtures/nomeDaCor.casos.json.
// ============================================================
'use strict';

const casos = require('./fixtures/nomeDaCor.casos.json');
const {
  nomeDaCor, rotuloDaVariante, nomeDaCorDaVariante, nomeGravadoQueAparece,
  colunasDoRotulo, COLUNAS_DO_ROTULO_NULAS, aplicarRotulo,
} = require('../src/services/nomeDaCor');

describe('casos em comum com o app: nomeDaCor', () => {
  test.each(casos.nomeDaCor.map((c) => [c.caso, c]))('%s', (_, c) => {
    expect(nomeDaCor(c.entrada)).toBe(c.nome);
  });
});

describe('casos em comum com o app: rotuloDaVariante', () => {
  test.each(casos.rotuloDaVariante.map((c) => [c.caso, c]))('%s', (_, c) => {
    expect(rotuloDaVariante(c.variante, c.separador)).toBe(c.rotulo);
  });
});

describe('nomeDaCorDaVariante', () => {
  test('aceita os formatos de atributo das consultas ({a, v} e attribute_name)', () => {
    expect(nomeDaCorDaVariante({ color_name: 'Caqui', attributes: [{ a: 'Cor', v: '#C3B091' }] })).toBe('Caqui');
    expect(nomeDaCorDaVariante({ attributes: [{ attribute_name: 'Cor', value: '#000000' }] })).toBe('Preto');
  });
  test('sem atributo de cor: null', () => {
    expect(nomeDaCorDaVariante({ color_name: 'Caqui', attributes: [{ attribute: 'Tamanho', value: 'M' }] })).toBeNull();
  });
});

describe('nomeGravadoQueAparece (a regra da etiqueta)', () => {
  test.each([
    ['Off White', 'Off White'], ['AMORA', 'Amora'], ['AZUL ESCUR', null], ['', null],
    ['#FFFFFF', null], ['FFFFF', null], [null, null], ['Azul petróleo', 'Azul petróleo'],
  ])('%p → %p', (entrada, saida) => {
    expect(nomeGravadoQueAparece(entrada)).toBe(saida);
  });
});

describe('colunasDoRotulo / aplicarRotulo', () => {
  test('só aceita expressão alias.coluna', () => {
    expect(colunasDoRotulo('pv.id')).toContain('_rv.variant_id = pv.id');
    expect(() => colunasDoRotulo('pv.id; DROP TABLE x')).toThrow();
    expect(COLUNAS_DO_ROTULO_NULAS).toContain('_rotulo_attrs');
  });
  test('troca o campo pelo rótulo e tira as colunas de apoio', () => {
    const r = aplicarRotulo({
      label: 'OFF WHITE-M', _rotulo_color_name: 'Off White', _rotulo_sku_suffix: 'OFF WHITE-M',
      _rotulo_attrs: [{ attribute: 'Cor', value: '#FAF9F6' }, { attribute: 'Tamanho', value: 'M' }],
    }, 'label', ' / ');
    expect(r).toEqual({ label: 'Off White / M' });
  });
  test('linha sem variante fica como veio', () => {
    expect(aplicarRotulo({ label: null, _rotulo_color_name: null, _rotulo_sku_suffix: null, _rotulo_attrs: null }, 'label'))
      .toEqual({ label: null });
    expect(aplicarRotulo({ dia: '2026-11-14' }, 'variante')).toEqual({ dia: '2026-11-14' });
  });
});
