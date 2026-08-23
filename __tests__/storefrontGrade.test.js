// A grade da loja comum roda no NAVEGADOR, dentro de um template literal.
// Testar o texto do template nao pega nada: o bug classico daqui e a barra
// invertida que some (CLAUDE.md, armadilha 8). Entao estes testes
// EXECUTAM o codigo que a pagina vai receber.
//
// Busca e ordenacao sairam do cliente em 23/08/2026 — agora sao do
// servidor (services/catalogoPaginado.js, coberto por
// __tests__/catalogoPaginado.test.js). O que sobrou aqui e a paginacao.
const buildScript = require('../src/templates/storefront/index');
const { janelaDePaginas: janelaServidor } = require('../src/services/catalogoPaginado');

function carregarDaPagina(nomes) {
  const s = buildScript({ products: [], categories: [] }, 'loja', '');
  return nomes
    .map((n) => {
      const m = s.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n\\}'));
      if (!m) throw new Error('funcao ausente no <script>: ' + n);
      return m[0];
    })
    .join('\n');
}

describe('janela de paginas no navegador', () => {
  const janelaCliente = new Function(
    carregarDaPagina(['janelaDePaginas']) + '\nreturn janelaDePaginas;',
  )();

  test('poucas paginas: mostra todas', () => {
    expect(janelaCliente(2, 3)).toEqual([1, 2, 3]);
    expect(janelaCliente(1, 1)).toEqual([1]);
  });

  test('catalogo grande nao vira parede de numeros', () => {
    // A Finesse tem 1302 produtos = 55 paginas de 24.
    expect(janelaCliente(28, 55)).toEqual([1, '...', 27, 28, 29, '...', 55]);
  });

  test('primeira e ultima sempre visiveis', () => {
    for (const p of [1, 2, 27, 54, 55]) {
      const j = janelaCliente(p, 55);
      expect(j[0]).toBe(1);
      expect(j[j.length - 1]).toBe(55);
    }
  });

  test('CONCORDA com a do servidor', () => {
    // As duas sao a mesma regra em lugares diferentes. Se divergirem, a
    // barra desenha uma pagina que o servidor nao serve — ou esconde uma
    // que ele serve.
    for (const total of [1, 2, 3, 7, 20, 55, 120]) {
      for (const atual of [1, 2, Math.ceil(total / 2), total - 1, total]) {
        if (atual < 1) continue;
        expect(janelaCliente(atual, total)).toEqual(janelaServidor(atual, total));
      }
    }
  });
});

describe('barra de paginas', () => {
  function barra(pagina, total) {
    let html = null;
    let escondido = null;
    const el = {
      set hidden(v) { escondido = v; },
      get hidden() { return escondido; },
      set innerHTML(v) { html = v; },
    };
    const fn = new Function(
      'document', 'paginaAtual', 'totalFiltrado', 'POR_PAGINA',
      carregarDaPagina(['janelaDePaginas', 'totalDePaginas', 'renderPaginacao']) +
        '\nreturn renderPaginacao;',
    )({ getElementById: () => el }, pagina, total * 24, 24);
    fn();
    return { html, escondido };
  }

  test('uma pagina so: barra nao aparece', () => {
    // Loja de 9 produtos nao precisa de "Pagina 1 de 1".
    expect(barra(1, 1).escondido).toBe(true);
  });

  test('desenha numeros, setas e a posicao atual', () => {
    const { html } = barra(3, 10);
    expect(html).toContain('pg-bar');
    expect(html).toContain('Anterior');
    expect(html).toContain('Próxima');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Página 3 de 10');
  });

  test('na primeira pagina, "Anterior" fica desabilitado', () => {
    expect(barra(1, 10).html).toMatch(/Anterior[\s\S]*?/);
    const { html } = barra(1, 10);
    // O disabled tem que estar no botao Anterior, nao no Proxima.
    const anterior = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    expect(anterior).toContain('disabled');
  });

  test('na ultima, "Proxima" fica desabilitado', () => {
    const { html } = barra(10, 10);
    const proxima = html.slice(html.lastIndexOf('<button'));
    expect(proxima).toContain('disabled');
  });

  test('o rodape nao manda mais a cliente embora', () => {
    // "Mais 802 produtos no catalogo — use a busca" dizia "nao vamos te
    // atender, procure em outra loja". O rodape agora so navega.
    //
    // A assercao olha o HTML RENDERIZADO, nao o texto do template: o
    // comentario que explica esta mudanca cita a frase antiga, e o
    // comentario viaja junto no <script>.
    for (const [pagina, total] of [[1, 10], [5, 10], [10, 10]]) {
      const { html } = barra(pagina, total);
      expect(html).not.toMatch(/use a busca/i);
      expect(html).not.toMatch(/no cat[aá]logo/i);
    }
  });
});

describe('pagina de produto', () => {
  const s = buildScript({ products: [], categories: [] }, 'loja', '');

  test('o cartao nao tem mais botao de comprar', () => {
    // A decisao acontece na PAGINA do produto, onde tem foto grande, cor,
    // tamanho, descricao e frete. Comprar direto da grade pulava tudo
    // isso — e em produto com variante nem era possivel.
    expect(s).not.toContain('class="card-action"');
    expect(s).toContain('card-tag');
  });

  test('duas acoes: adicionar e comprar', () => {
    expect(s).toContain('Adicionar ao carrinho');
    expect(s).toContain('Comprar agora');
  });

  test('"Comprar agora" pula o carrinho e vai pro checkout', () => {
    // Ancora no LISTENER, nao na primeira mencao de '#pdComprar' — a
    // primeira esta em repintar(), que so liga/desliga os dois botoes.
    const i = s.indexOf("querySelector('#pdComprar').addEventListener");
    expect(i).toBeGreaterThan(0);
    const trecho = s.slice(i, i + 500);
    expect(trecho).toContain('addToCart');
    expect(trecho).toContain('openCheckout()');
  });

  test('"Adicionar ao carrinho" NAO leva pro checkout', () => {
    // As duas acoes existem porque sao coisas diferentes: uma continua
    // comprando, a outra fecha. Se as duas fossem pro checkout, a
    // primeira nao teria razao de existir.
    const i = s.indexOf("querySelector('#pdAdd').addEventListener");
    expect(i).toBeGreaterThan(0);
    const trecho = s.slice(i, i + 500);
    expect(trecho).toContain('addToCart');
    expect(trecho).not.toContain('openCheckout()');
  });

  test('a seta volta pra onde a pessoa estava', () => {
    const fn = new Function(
      'searchTerm', 'currentCat',
      s.match(/function origemAtual[\s\S]*?\n}/)[0] + '\nreturn origemAtual;',
    );
    expect(fn('vestido', 'Todos')()).toBe('Voltar para a busca');
    expect(fn('', 'Bolsa')()).toBe('Voltar para Bolsa');
    expect(fn('', 'Todos')()).toBe('Voltar para a loja');
  });

  test('tem secao de relacionados', () => {
    expect(s).toContain('Produtos relacionados');
    expect(s).toContain('function carregarRelacionados');
  });
});

describe('cor por nome', () => {
  const s = buildScript({ products: [], categories: [] }, 'loja', '');
  const corDoValor = new Function(
    s.match(/var CORES_PT[\s\S]*?\n};/)[0] + '\n' +
      s.match(/function corDoValor[\s\S]*?\n}/)[0] +
      '\nreturn corDoValor;',
  )();

  test('nome de cor vira swatch — a lojista nao digita hex', () => {
    // O swatch antigo so aparecia com "#000000". Lojista escreve "Preto".
    expect(corDoValor('Preto')).toBe('#111111');
    expect(corDoValor('azul marinho')).toBe('#1B2A4A');
    expect(corDoValor('Off White')).toBe('#F3EFE7');
  });

  test('acento e caixa nao atrapalham', () => {
    expect(corDoValor('Lilás')).toBe(corDoValor('lilas'));
    expect(corDoValor('VERMELHO')).toBe(corDoValor('vermelho'));
  });

  test('hex continua funcionando', () => {
    expect(corDoValor('#e11d48')).toBe('#e11d48');
    expect(corDoValor('#abc')).toBe('#abc');
  });

  test('o que nao e cor vira chip de texto', () => {
    // "Xadrez", "P", "38" nao sao cores — chip de texto e o certo.
    expect(corDoValor('Xadrez')).toBeNull();
    expect(corDoValor('38')).toBeNull();
    expect(corDoValor('')).toBeNull();
  });

  test('so o atributo de COR vira bolinha', () => {
    const atributoDeCor = new Function(
      s.match(/function atributoDeCor[\s\S]*?\n}/)[0] + '\nreturn atributoDeCor;',
    )();
    expect(atributoDeCor('Cor')).toBe(true);
    expect(atributoDeCor('Cor da alça')).toBe(true);
    expect(atributoDeCor('Tamanho')).toBe(false);
    // "Corte" comeca com "cor" mas nao e cor... e um caso real de moda.
    // Aceito o falso positivo: o valor ("Reto", "Slim") nao acha cor no
    // mapa e cai em chip de texto de qualquer jeito.
    expect(atributoDeCor('Material')).toBe(false);
  });
});

describe('nome da cor quando a lojista grava hex', () => {
  const s = buildScript({ products: [], categories: [] }, 'loja', '');
  const nomeDaCor = new Function(
    s.match(/var CORES_PT[\s\S]*?\n};/)[0] + '\n' +
      s.match(/function nomeDaCor[\s\S]*?\n}/)[0] +
      '\nreturn nomeDaCor;',
  )();

  test('hex vira nome de verdade', () => {
    // A Finesse grava "#EC4899". Mostrar isso embaixo do circulo e mostrar
    // codigo, nao cor — e nao serve pra leitor de tela nenhum.
    expect(nomeDaCor('#FFFFFF')).toBe('Branco');
    expect(nomeDaCor('#000000')).toBe('Preto');
    expect(nomeDaCor('#1B2A4A')).toBe('Azul marinho');
    expect(nomeDaCor('#7a1f3a')).toBe('Vinho');
  });

  test('tom aproximado ganha o nome do vizinho', () => {
    // Nao precisa bater exato: #111 nao esta no mapa e ainda assim e preto.
    expect(nomeDaCor('#0a0a0a')).toBe('Preto');
    expect(nomeDaCor('#fdfdfd')).toBe('Branco');
  });

  test('forma curta funciona', () => {
    expect(nomeDaCor('#000')).toBe('Preto');
    expect(nomeDaCor('#fff')).toBe('Branco');
  });

  test('entrada invalida nao inventa nome', () => {
    expect(nomeDaCor('Preto')).toBeNull();
    expect(nomeDaCor('')).toBeNull();
    expect(nomeDaCor(null)).toBeNull();
    expect(nomeDaCor('#12')).toBeNull();
  });

  test('nunca devolve o proprio hex como rotulo', () => {
    for (const h of ['#FFFFFF', '#000000', '#EC4899', '#1B2A4A', '#0bbdea']) {
      const n = nomeDaCor(h);
      if (n !== null) expect(n).not.toContain('#');
    }
  });
});
