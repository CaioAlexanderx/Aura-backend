// ============================================================
// AURA. — services/nomeDaCorNaGrade (14/11/2026)
// Regras puras do nome da cor ao salvar a grade. O caminho com o Postgres
// de verdade está em variante.nomeDaCor.banco.test.js.
// ============================================================
'use strict';

const {
  colorNameParaGravar, nomeDaPaletaDoApp, parteDaCorNoSufixo,
  coresDoProduto, resolverNomeDaCor, nomeSugeridoDoSufixo,
} = require('../src/services/nomeDaCorNaGrade');

describe('colorNameParaGravar', () => {
  test('tira o espaço das pontas e guarda a grafia da lojista', () => {
    expect(colorNameParaGravar('  Off White ')).toBe('Off White');
  });
  test('vazio, não-texto e hex (6 ou 5 dígitos, com ou sem #) ficam de fora', () => {
    for (const v of ['', '   ', null, undefined, 12, '#FFFFFF', 'ffffff', 'FFFFF', '#1f2a4']) {
      expect(colorNameParaGravar(v)).toBeNull();
    }
  });
  test('teto de 60 caracteres', () => {
    expect(colorNameParaGravar('x'.repeat(80))).toHaveLength(60);
  });
});

describe('nomeDaPaletaDoApp (o hexToName de utils/colorNames.ts)', () => {
  test.each([
    ['#000000', 'Preto'], ['#FAF9F6', 'Branco'], ['#C3B091', 'Prata'],
    ['#1F2A44', 'Cinza escuro'], ['#06B6D4', 'Azul'], ['#3B82F6', 'Azul'],
  ])('%s → %s', (hex, nome) => {
    expect(nomeDaPaletaDoApp(hex)).toBe(nome);
  });
  test('hex inválido → null', () => {
    expect(nomeDaPaletaDoApp('azul')).toBeNull();
  });
});

describe('parteDaCorNoSufixo / nomeSugeridoDoSufixo', () => {
  test.each([
    ['OFF WHITE-M', 'M', 'OFF WHITE'],
    ['OFF-WHITE-M', 'M', 'OFF-WHITE'],
    ['AZUL ESCUR-GG', 'GG', 'AZUL ESCUR'],
    ['VERMELHO', null, 'VERMELHO'],
    ['1F2A44-M', 'M', null],
    ['1F2A44', null, null],
    ['', 'M', null],
    ['OUTRO FORMATO', 'M', 'OUTRO FORMATO'],
    ['OFF-WHITE-P', 'M', 'OFF'],
  ])('%s (tamanho %s) → %s', (sku, tam, esperado) => {
    expect(parteDaCorNoSufixo(sku, tam)).toBe(esperado);
    expect(nomeSugeridoDoSufixo(sku, tam)).toBe(esperado);
  });
});

describe('resolverNomeDaCor', () => {
  const antiga = (sku, tam = 'M', hex = '#FAF9F6') =>
    coresDoProduto([{ colorHex: hex, sizeValue: tam, sku_suffix: sku, color_name: null }]).get(hex.toUpperCase());

  test('cor nova: grava o nome que veio', () => {
    expect(resolverNomeDaCor('#FAF9F6', 'Off White', undefined))
      .toEqual({ gravar: 'Off White', paraNova: 'Off White', nomeDoSku: 'Off White', manterSku: false });
  });

  test('cor nova sem nome: nada a gravar, o sufixo cai no hex como sempre', () => {
    expect(resolverNomeDaCor('#FAF9F6', '', undefined))
      .toEqual({ gravar: null, paraNova: null, nomeDoSku: null, manterSku: false });
  });

  test('variante antiga: o pedaço "OFF WHITE" que o GET devolvia não é gravado', () => {
    const r = resolverNomeDaCor('#FAF9F6', 'OFF WHITE', antiga('OFF WHITE-M'));
    expect(r).toEqual({ gravar: null, paraNova: null, nomeDoSku: 'OFF WHITE', manterSku: true });
  });

  test('variante antiga: "OFF" (cortado no hífen) não é gravado; o sufixo fica "OFF-WHITE"', () => {
    const r = resolverNomeDaCor('#F3EFE7', 'OFF', antiga('OFF-WHITE-M', 'M', '#F3EFE7'));
    expect(r.gravar).toBeNull();
    expect(r.manterSku).toBe(true);
    expect(r.nomeDoSku).toBe('OFF-WHITE');
  });

  test('variante antiga: o nome da paleta que o app antigo põe não é gravado', () => {
    for (const nome of ['Branco', 'branco', 'BRANCO']) {
      expect(resolverNomeDaCor('#FAF9F6', nome, antiga('OFF WHITE-M')).gravar).toBeNull();
    }
  });

  test('variante antiga: hex de 5 dígitos ("FFFFF") não é gravado', () => {
    expect(resolverNomeDaCor('#FFFFFF', 'FFFFF', antiga('FFFFF-P', 'P', '#FFFFFF')).gravar).toBeNull();
  });

  test('variante antiga: nome que a lojista escreveu é gravado', () => {
    expect(resolverNomeDaCor('#FAF9F6', 'Off White', antiga('OFF WHITE-M')))
      .toEqual({ gravar: 'Off White', paraNova: 'Off White', nomeDoSku: 'Off White', manterSku: false });
  });

  test('variante antiga: nome em maiúsculas que não é o pedaço do sufixo é gravado', () => {
    expect(resolverNomeDaCor('#FAF9F6', 'PEROLA', antiga('OFF WHITE-M')).gravar).toBe('PEROLA');
  });

  test('cor com nome gravado: vazio, ausente ou null mantém (não apaga)', () => {
    const info = coresDoProduto([{ colorHex: '#C3B091', sizeValue: 'M', sku_suffix: 'CAQUI-M', color_name: 'Caqui' }]).get('#C3B091');
    for (const v of ['', '   ', undefined, null]) {
      expect(resolverNomeDaCor('#C3B091', v, info))
        .toEqual({ gravar: null, paraNova: 'Caqui', nomeDoSku: 'Caqui', manterSku: true });
    }
  });

  test('cor com nome gravado: nome novo troca', () => {
    const info = coresDoProduto([{ colorHex: '#C3B091', sizeValue: 'M', sku_suffix: 'CAQUI-M', color_name: 'Caqui' }]).get('#C3B091');
    expect(resolverNomeDaCor('#C3B091', 'Areia', info).gravar).toBe('Areia');
  });
});

describe('coresDoProduto', () => {
  test('agrupa por hex sem diferença de caixa e pega o primeiro nome gravado', () => {
    const m = coresDoProduto([
      { colorHex: '#c3b091', sizeValue: 'P', sku_suffix: 'CAQUI-P', color_name: null },
      { colorHex: '#C3B091', sizeValue: 'M', sku_suffix: 'CAQUI-M', color_name: 'Caqui' },
      { colorHex: null, sizeValue: 'G', sku_suffix: 'G', color_name: null },
    ]);
    expect(m.size).toBe(1);
    const c = m.get('#C3B091');
    expect(c.gravado).toBe('Caqui');
    expect(c.parteDoSku).toBe('CAQUI');
    expect([...c.pedacos]).toEqual(['CAQUI']);
  });
});
