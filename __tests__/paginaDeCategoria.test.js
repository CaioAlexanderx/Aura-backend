// ============================================================
// A pagina de categoria (fase 4 do redesign, 02/09/2026)
//
// Migalhas, titulo com contagem, subcategorias em chips, lateral de
// filtros (tamanho, cor, preco) e a grade em tres colunas; no celular a
// lateral vira folha. As faixas de preco nascem do menor e do maior
// preco da loja — nunca de numeros fixos.
// ============================================================
const fs = require('fs');
const path = require('path');

const buildPage = require('../src/templates/storefrontPage');
const buildStyles = require('../src/templates/storefrontStyles');
const { faixasDePreco, precoRedondo } = require('../src/services/faixasDePreco');

const parts = (n) => fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/', n), 'utf8');
const semComentarios = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function pagina() {
  return buildPage({
    site: { name: 'Finesse', primary_color: '#7a1f3a', banners: [] },
    contact: {}, settings: {}, products: [], categories: [],
    facetas: { preco: { min: 75, max: 345 } },
  }, 'finesse');
}

describe('a estrutura da pagina de categoria', () => {
  const html = pagina();
  test('migalhas, titulo com contagem, ordenacao, subcategorias, lateral e grade — nessa ordem', () => {
    const ordem = ['id="crumbs"', 'id="catTitle"', 'id="prodCount"', 'id="filtroBtnMobile"', 'id="sortSelect"', 'id="catsSub"', 'class="products-layout"', 'id="filtrosWrap"', 'id="productsGrid"', 'id="gridMore"', 'id="filtrosOverlay"'];
    const idx = ordem.map((s) => html.indexOf(s));
    idx.forEach((i, k) => expect({ k: ordem[k], i }).toEqual({ k: ordem[k], i: expect.any(Number) }));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
  test('a lateral e um <aside> e nasce escondida', () => {
    expect(html).toMatch(/<aside class="filtros-wrap" id="filtrosWrap"[^>]*hidden/);
  });
  test('as faixas de preco atravessam ate o navegador', () => {
    expect(html).toContain('function faixasDePreco(');
    expect(html).toContain('"preco":{"min":75,"max":345}');
  });
});

describe('a lateral de filtros', () => {
  const src = semComentarios(parts('filtros.js'));
  test('tres grupos: tamanho em chips, cor em lista com amostra, preco em faixas', () => {
    expect(src).toContain('>Tamanho</div><div class="filtro-ops">');
    expect(src).toContain('>Cor</div><div class="filtro-lista">');
    expect(src).toContain('>Preço</div><div class="filtro-lista">');
    expect(src).toContain('class="filtro-bola"');
  });
  test('preco vai pra rota como preco_min / preco_max, e e uma faixa so por vez', () => {
    expect(src).toContain("q.push('preco_min=' + f.min)");
    expect(src).toContain("q.push('preco_max=' + f.max)");
    expect(src).toContain('precoSel = (precoSel === v) ? null : v;');
  });
  test('limparFiltros aceita nao recarregar (irParaHome recarrega por conta propria)', () => {
    expect(src).toContain('function limparFiltros(opts)');
    expect(src).toContain('if(!(opts && opts.semRecarregar)) recarregarDoInicio();');
  });
  test('no celular vira folha, com botao Filtrar na barra da grade', () => {
    expect(src).toContain('function abrirFolhaDeFiltros()');
    expect(src).toContain("getElementById('filtroBtnMobile')");
    const css = buildStyles('#7a1f3a', null, false, 'classic');
    expect(css).toMatch(/@media\(max-width:900px\)\{[\s\S]*\.filtros-wrap\{position:fixed/);
    expect(css).toContain('.filtros-wrap.aberto{transform:translateY(0);}');
  });
  test('na home nao ha lateral: grade em quatro; na categoria, tres ao lado da lateral', () => {
    const css = buildStyles('#7a1f3a', null, false, 'classic');
    expect(css).toContain('body.home .filtros-wrap,body.home .filtro-btn-mobile{display:none !important;}');
    // A pagina de categoria comeca nas migalhas: sem hero (peguei na Finesse no ar).
    expect(css).toContain('body:not(.home) .hero{display:none;}');
    expect(css).toContain('.products-layout{display:grid;grid-template-columns:230px minmax(0,1fr)');
    expect(css).toContain('body.home .products-layout{grid-template-columns:minmax(0,1fr);}');
    expect(css).toContain('.products-grid{grid-template-columns:repeat(3,1fr)');
    expect(css).toContain('body.home .products-grid{grid-template-columns:repeat(4,1fr)');
  });
});

describe('migalhas e titulo', () => {
  const src = semComentarios(parts('home.js'));
  test('Inicio / pai / categoria, a partir do caminho', () => {
    expect(src).toContain("itens.push('<a href=\"#\" onclick=\"return irParaHome()\">Início</a>')");
    expect(src).toContain("String(currentCat).split('/')");
    expect(src).toContain('aria-current="page"');
  });
  test('busca vira "Resultados para"', () => {
    expect(src).toContain("t.textContent='Resultados para “'+busca+'”'");
  });
});

describe('faixas de preco', () => {
  test('Finesse (75 a 345) vira tres faixas em numeros redondos', () => {
    expect(faixasDePreco(75, 345)).toEqual([
      { min: null, max: 150, rotulo: 'Até R$ 150' },
      { min: 150, max: 250, rotulo: 'R$ 150 a R$ 250' },
      { min: 250, max: null, rotulo: 'Acima de R$ 250' },
    ]);
  });
  test('faixa estreita demais nao corta: sem filtro', () => {
    expect(faixasDePreco(20, 30)).toEqual([]);
    expect(faixasDePreco(100, 100)).toEqual([]);
  });
  test('loja de moveis corta em centenas', () => {
    const f = faixasDePreco(400, 3000);
    expect(f).toHaveLength(3);
    expect(f[0].max % 100).toBe(0);
  });
  test('o arredondamento segue a ordem de grandeza', () => {
    expect(precoRedondo(23)).toBe(20);
    expect(precoRedondo(160)).toBe(150);
    expect(precoRedondo(740)).toBe(700);
    expect(precoRedondo(2400)).toBe(2500);
  });
  test('lixo vira lista vazia, nao excecao', () => {
    expect(faixasDePreco(null, undefined)).toEqual([]);
    expect(faixasDePreco('a', 'b')).toEqual([]);
  });
});
