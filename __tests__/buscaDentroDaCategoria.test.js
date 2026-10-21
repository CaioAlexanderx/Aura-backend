// ============================================================
// Busca dentro de uma categoria (tq-62, 20/10/2026)
//
// Na Felic, em Combos > Gin, "ballantine" dava 0 — e a loja tem 5. A
// busca vai ao servidor com a categoria aberta, e nada dizia isso.
//
// Com busca E categoria, uma linha "Buscando em <categoria>" com "Buscar
// na loja toda" (tira a categoria, mantem o termo). Sem categoria, ou sem
// busca, nada aparece — a loja de quem nao esta nesse caso fica igual.
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');

const src = fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/products.js'), 'utf8');
const ini = src.indexOf('function escopoDaBusca');
const fim = src.indexOf('/**\n * Barra de paginas');
const trecho = src.slice(ini, fim);

/** DOM minimo: so o que as tres funcoes tocam. */
function montar({ busca, cat, nomes = {} }) {
  const doc = { els: {}, criados: [], removidos: 0 };
  const cab = {
    insertAdjacentElement(_pos, el) { doc.els[el.id] = el; doc.criados.push(el); },
  };
  const document = {
    getElementById: (id) => doc.els[id] || null,
    querySelector: (sel) => (sel === '#productsAnchor .products-header' ? cab : null),
    createElement: () => {
      const el = { id: '', innerHTML: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
        remove() { delete doc.els[this.id]; doc.removidos++; } };
      return el;
    },
  };
  const chamadas = [];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const api = new Function('document', 'esc', 'nomeDoCaminho', 'filterCat', 'searchTerm', 'currentCat',
    trecho + '\nreturn { escopoDaBusca, renderEscopoDaBusca, buscarNaLojaToda };')(
    document, esc, (c) => nomes[c] || null, (c, el) => chamadas.push([c, el]), busca, cat);
  return { api, doc, chamadas };
}

describe('quando a linha aparece', () => {
  test('busca dentro de categoria: diz onde e oferece a loja toda', () => {
    const { api, doc } = montar({ busca: 'ballantine', cat: '/combos/gin', nomes: { '/combos/gin': 'Gin' } });
    expect(api.escopoDaBusca()).toBe('Gin');
    api.renderEscopoDaBusca(api.escopoDaBusca());
    expect(doc.els.buscaEscopo.innerHTML).toContain('Buscando em Gin');
    expect(doc.els.buscaEscopo.innerHTML).toContain('onclick="return buscarNaLojaToda()"');
    expect(doc.els.buscaEscopo.innerHTML).toContain('Buscar na loja toda');
  });

  test('loja sem arvore: usa o nome da categoria como veio', () => {
    const { api } = montar({ busca: 'x', cat: 'Gin' });
    expect(api.escopoDaBusca()).toBe('Gin');
  });

  test('nome da categoria e escapado', () => {
    const { api, doc } = montar({ busca: 'x', cat: '<b>' });
    api.renderEscopoDaBusca(api.escopoDaBusca());
    expect(doc.els.buscaEscopo.innerHTML).toContain('Buscando em &lt;b&gt;');
  });

  test.each([
    ['busca sem categoria', 'ballantine', 'Todos'],
    ['categoria sem busca', '', '/combos/gin'],
    ['so espacos na busca', '   ', '/combos/gin'],
    ['home', '', 'Todos'],
  ])('%s: nenhuma linha, nenhum elemento criado', (_n, busca, cat) => {
    const { api, doc } = montar({ busca, cat });
    expect(api.escopoDaBusca()).toBeNull();
    api.renderEscopoDaBusca(api.escopoDaBusca());
    expect(doc.criados).toHaveLength(0);
  });

  test('a linha sai quando a busca ou a categoria saem', () => {
    const { api, doc } = montar({ busca: 'x', cat: '/combos/gin', nomes: { '/combos/gin': 'Gin' } });
    api.renderEscopoDaBusca('Gin');
    api.renderEscopoDaBusca('Gin');
    expect(doc.criados).toHaveLength(1);
    api.renderEscopoDaBusca(null);
    expect(doc.els.buscaEscopo).toBeUndefined();
    expect(doc.removidos).toBe(1);
  });
});

describe('"Buscar na loja toda"', () => {
  test('tira a categoria e nao mexe no termo', () => {
    const { api, chamadas } = montar({ busca: 'ballantine', cat: '/combos/gin' });
    expect(api.buscarNaLojaToda()).toBe(false);
    expect(chamadas).toEqual([['Todos', null]]);
    // filterCat so troca a categoria; searchTerm nao e tocado aqui.
    expect(trecho.slice(trecho.indexOf('function buscarNaLojaToda'))).not.toContain('searchTerm');
  });
});

describe('a grade usa o escopo', () => {
  test('roda em todo render; no zero a linha sai e o vazio assume', () => {
    const r = src.slice(src.indexOf('function renderProducts'), src.indexOf('// ── Busca dentro'));
    const chamada = 'renderEscopoDaBusca(visiveis.length?escopo:null);';
    expect(r.indexOf(chamada)).toBeGreaterThan(0);
    expect(r.indexOf(chamada)).toBeLessThan(r.indexOf('if(!visiveis.length)'));
  });
  test('zero resultado na categoria: o vazio oferece a loja toda; sem categoria, o texto de sempre', () => {
    expect(src).toContain("'Nada em '+esc(escopo)+'. <a href=\"#\" onclick=\"return buscarNaLojaToda()\"");
    expect(src).toContain(":'Tente outra palavra ou veja todas as categorias.';");
  });
  test('o HTML da pagina nao ganha elemento fixo (a linha nasce no JS)', () => {
    const html = buildPage({ site: { name: 'Loja', banners: [] }, contact: {}, settings: {}, products: [], categories: [] }, 'loja');
    expect(html).not.toContain('id="buscaEscopo"');
    const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    expect(() => new Function(js.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
