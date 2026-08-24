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

describe('regra de estoque', () => {
  const { EM_ESTOQUE } = require('../src/services/catalogoPaginado');

  test('a mesma regra vale pra contagem e pra pagina', () => {
    // O cliente escondia esgotado DEPOIS de receber a pagina, e a
    // contagem vinha do servidor sem esse filtro: em "Bolsa" a loja dizia
    // "29 produtos" e mostrava 19, e a conta de paginas saia errada.
    const builder = require('fs').readFileSync(
      require('path').join(__dirname, '../src/services/storefrontBuilder.js'), 'utf8',
    );
    // A contagem do catalogo e a pagina 1 embutida usam a constante.
    expect(builder).toContain('EM_ESTOQUE');
    expect((builder.match(/\$\{EM_ESTOQUE\}/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('produto com variante depende do saldo DA VARIANTE', () => {
    // Produto pai com stock_qty 0 mas variante com saldo continua a
    // venda — e o inverso tambem: pai com saldo e todas as variantes
    // zeradas nao pode aparecer.
    expect(EM_ESTOQUE).toContain('product_variants');
    expect(EM_ESTOQUE).toContain('v.stock_qty > 0');
    expect(EM_ESTOQUE).toContain('products.stock_qty > 0');
  });

  test('o cliente nao filtra de novo', () => {
    const grade = require('fs').readFileSync(
      require('path').join(__dirname, '../src/templates/storefront/parts/products.js'), 'utf8',
    );
    expect(grade).not.toContain('return p.in_stock;');
  });
});

describe('barra de categorias', () => {
  const buildScript = require('../src/templates/storefront/index');

  function comCategorias(lista) {
    return buildScript(
      JSON.stringify({ products: [], site: {}, settings: {}, contact: {}, categorias_barra: lista }),
      'loja', '',
    );
  }

  test('a barra NAO sai mais dos produtos carregados', () => {
    // Com paginacao de 24, derivar de PRODUCTS mostrava so as categorias
    // que caiam na pagina 1: a Finesse tem 28 e mostrava 11.
    const s = comCategorias([]);
    expect(s).not.toContain('ALL_CATS');
    expect(s).toContain('__S.categorias_barra');
  });

  test('categoria sem produto visivel nao entra', () => {
    const filtro = new Function(
      '__S',
      comCategorias([]).match(/var CATEGORIAS = [\s\S]*?\n\}\);/)[0] + '\nreturn CATEGORIAS;',
    );
    const saida = filtro({
      categorias_barra: [
        { nome: 'Vestidos', total: 143 },
        { nome: 'Fantasma', total: 0 },
        { nome: '', total: 9 },
        null,
      ],
    });
    expect(saida.map((c) => c.nome)).toEqual(['Vestidos']);
  });

  test('quantas cabem depende da largura', () => {
    const s = comCategorias([]);
    const monta = (w) =>
      new Function('window', s.match(/function cabemNaBarra[\s\S]*?\n\}/)[0] + '\nreturn cabemNaBarra;')({ innerWidth: w })();
    expect(monta(390)).toBe(4);
    expect(monta(1440)).toBeGreaterThan(monta(390));
    // Nunca menos de 4: uma barra com 1 chip nao e uma barra.
    expect(monta(280)).toBeGreaterThanOrEqual(4);
  });

  test('o painel abre com TODAS, nao so com as que cabem', () => {
    const s = comCategorias([]);
    // renderCategorias corta pra barra; abrirPainelCats percorre a lista
    // inteira. Se os dois usassem o mesmo recorte, o botao "Todas as
    // categorias" mentiria.
    const painel = s.slice(s.indexOf('function abrirPainelCats'));
    expect(painel.slice(0, 1200)).toContain('CATEGORIAS.map');
    expect(painel.slice(0, 1200)).not.toContain('slice(0, cabemNaBarra())');
  });
});
