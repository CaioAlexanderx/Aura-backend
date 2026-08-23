const {
  janelaDePaginas, normalizar, ordemSql, POR_PAGINA, LIMITE_MAXIMO,
} = require('../src/services/catalogoPaginado');

describe('janela de paginas', () => {
  test('poucas paginas: mostra todas', () => {
    expect(janelaDePaginas(2, 3)).toEqual([1, 2, 3]);
    expect(janelaDePaginas(1, 1)).toEqual([1]);
  });

  test('catalogo grande: nao desenha 55 botoes', () => {
    // A Finesse tem 1302 produtos = 55 paginas. Desenhar todas seria uma
    // parede de numeros; o padrao com reticencias todo mundo ja sabe usar.
    expect(janelaDePaginas(1, 55)).toEqual([1, 2, '...', 55]);
    expect(janelaDePaginas(28, 55)).toEqual([1, '...', 27, 28, 29, '...', 55]);
    expect(janelaDePaginas(55, 55)).toEqual([1, '...', 54, 55]);
  });

  test('primeira e ultima estao SEMPRE presentes', () => {
    for (const p of [1, 2, 10, 30, 54, 55]) {
      const j = janelaDePaginas(p, 55);
      expect(j[0]).toBe(1);
      expect(j[j.length - 1]).toBe(55);
    }
  });

  test('pagina fora do intervalo nao quebra', () => {
    expect(janelaDePaginas(0, 10)[0]).toBe(1);
    expect(janelaDePaginas(999, 10)).toContain(10);
    expect(janelaDePaginas(-5, 10)[0]).toBe(1);
  });

  test('sem pagina nenhuma devolve a primeira', () => {
    expect(janelaDePaginas(1, 0)).toEqual([1]);
  });
});

describe('ordenacao', () => {
  test('as ordens conhecidas viram SQL', () => {
    expect(ordemSql('preco_asc')).toContain('price ASC');
    expect(ordemSql('preco_desc')).toContain('price DESC');
    expect(ordemSql('nome')).toContain('name ASC');
  });

  test('ordem desconhecida NAO chega ao SQL', () => {
    // A ordem vem da query string. Interpolar direto seria injecao; o
    // mapa fechado garante que so sai o que esta na lista.
    expect(ordemSql('hack; DROP TABLE products')).toBe(ordemSql('destaque'));
    expect(ordemSql('')).toBe(ordemSql('destaque'));
    expect(ordemSql(null)).toBe(ordemSql('destaque'));
    expect(ordemSql(undefined)).toBe(ordemSql('destaque'));
  });

  test('preco nulo vai pro fim, nao pro topo', () => {
    // Produto sem preco encabecando "menor preco" seria mentira.
    expect(ordemSql('preco_asc')).toContain('NULLS LAST');
  });
});

describe('normalizacao da busca', () => {
  test('tira acento e caixa', () => {
    expect(normalizar('Vestído Longo')).toBe('vestido longo');
    expect(normalizar('AÇÚCAR')).toBe('acucar');
  });

  test('entrada vazia nao quebra', () => {
    expect(normalizar(null)).toBe('');
    expect(normalizar(undefined)).toBe('');
    expect(normalizar('   ')).toBe('');
  });
});

describe('limites', () => {
  test('a pagina tem tamanho de pagina, nao de catalogo', () => {
    expect(POR_PAGINA).toBeGreaterThanOrEqual(20);
    expect(POR_PAGINA).toBeLessThanOrEqual(30);
  });

  test('ha um teto por requisicao', () => {
    // Sem teto, `?limit=100000` traria o catalogo inteiro e derrubaria a
    // pagina — que e exatamente o problema que a paginacao veio resolver.
    expect(LIMITE_MAXIMO).toBeLessThanOrEqual(60);
  });
});
