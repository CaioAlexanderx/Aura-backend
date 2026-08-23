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
