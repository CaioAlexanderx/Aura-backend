// ============================================================
// Vitrine Finesse (10/09/2026): a loja-modelo como demo comercial.
//
// Cinco achados da critica de design, todos nossos:
//  1. 4-5 s de tela branca antes do primeiro byte (home sai da memoria)
//  2. capa de categoria cortava a cabeca da modelo (foco no terco de cima)
//  3. a home repetia as 8 pecas de "Acabaram de chegar" em "Todos os
//     produtos" (home curada: grade fora, botao "Ver todas as pecas")
//  4. TAMANHO encostado nos nomes das cores na pagina da peca
//  6. trilha "Vestidos / Casual / Vestido casual" (nivel redundante some)
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const html = buildPage({
  slug: 'finesse',
  site: { name: 'Finesse', primary_color: '#7a1f3a' },
  contact: {}, settings: {}, products: [], categories: [],
  categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
  home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
}, 'finesse');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

describe('1. a home sai da memoria', () => {
  const cache = require('../src/services/cacheDaPaginaDaLoja');

  beforeEach(() => cache.esquecerPagina());

  test('guarda por loja e devolve dentro do TTL', () => {
    cache.lembrarPagina('finesse', '<html>a</html>');
    expect(cache.paginaLembrada('finesse')).toBe('<html>a</html>');
    expect(cache.paginaLembrada('davi')).toBeNull();
  });

  test('vence depois do TTL', () => {
    const agora = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(agora);
    cache.lembrarPagina('finesse', 'x');
    spy.mockReturnValue(agora + cache.TTL_MS + 1);
    expect(cache.paginaLembrada('finesse')).toBeNull();
    spy.mockRestore();
  });

  test('esquecer sem slug limpa tudo; com slug, so aquela', () => {
    cache.lembrarPagina('a', '1'); cache.lembrarPagina('b', '2');
    cache.esquecerPagina('a');
    expect(cache.paginaLembrada('a')).toBeNull();
    expect(cache.paginaLembrada('b')).toBe('2');
    cache.esquecerPagina();
    expect(cache.paginaLembrada('b')).toBeNull();
  });

  test('so a HOME entra: peca na URL e query string passam direto', () => {
    const rota = fonte('src/routes/storefront.js');
    expect(rota).toContain("const ehHome = !produtoId && !String(req.url || '').includes('?');");
    expect(rota).toContain('if (ehHome) { lembrarPagina(slug, html);');
    expect(rota).toContain("res.setHeader('X-Aura-Cache', 'hit');");
  });

  test('salvar a loja ou subir imagem esquece a home guardada', () => {
    const canal = fonte('src/routes/digitalChannel.js');
    // Uma no PUT (com o slug salvo) e uma no upload de imagem (todas).
    expect(canal).toContain('esquecerPagina(savedConfig.slug || undefined);');
    expect((canal.match(/esquecerPagina\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('2. a capa de categoria mostra o rosto', () => {
  test('foco no terco de cima da foto', () => {
    expect(html).toContain('.tira-cat-arte img{width:100%;height:100%;object-fit:cover;object-position:50% 18%;');
  });
});

describe('3. home curada: grade fora, "Ver todas as pecas" dentro', () => {
  test('a grade some so quando ha bloco desenhado', () => {
    expect(html).toContain('body.home-curada .products-section{display:none;}');
    expect(js).toContain("['tiraCats','homeMaisVendidos','homeUltimas','homeNovidades'].some(");
    expect(js).toContain("document.body.classList.toggle('home-curada',curada);");
  });

  test('o botao leva a vista "Todas as pecas", em ordem de destaque', () => {
    expect(html).toContain('<section class="home-sec home-vertudo" id="homeVerTudo" hidden></section>');
    expect(js).toContain("todos:'Todas as peças'");
    expect(js).toContain("ordem=(criterio==='todos')?'destaque':criterio;");
    expect(js).toContain(`onclick="verTudo(\\'todos\\')"`);
  });

  test('o botao nao e preenchido: a acao principal continua sendo a sacola', () => {
    const i = html.indexOf('.home-vertudo-btn{');
    expect(html.slice(i, html.indexOf('}', i))).not.toContain('background:var(--sf-brand)');
  });
});

describe('4. cor e tamanho respiram', () => {
  test('grupo seguinte ganha margem', () => {
    expect(html).toContain('.op-grupo+.op-grupo{margin-top:22px;}');
  });
});

describe('6. a trilha nao repete o nome do pai', () => {
  // Executa a funcao pura como o navegador executaria.
  const ini = js.indexOf('function nivelRedundante');
  const fim = js.indexOf('\n}\n', ini) + 3;
  const nivelRedundante = new Function(js.slice(ini, fim) + '\nreturn nivelRedundante;')();

  test('folha que contem o pai e redundante', () => {
    expect(nivelRedundante('Casual', 'Vestido casual')).toBe(true);
    expect(nivelRedundante('Festa', 'Vestido Midi Festa')).toBe(true);
    expect(nivelRedundante('Macacão', 'Macacao longo')).toBe(true);
  });

  test('nome proprio continua na trilha', () => {
    expect(nivelRedundante('Casual', 'Tricot')).toBe(false);
    expect(nivelRedundante('', 'Casual')).toBe(false);
  });

  test('so vale do terceiro nivel em diante', () => {
    expect(js).toContain('if(i>=2&&nivelRedundante(anterior,no.nome)) return;');
  });

  test('o script continua sendo JS valido', () => {
    expect(() => new Function(js.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
