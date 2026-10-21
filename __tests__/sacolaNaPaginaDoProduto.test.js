// ============================================================
// Sacola no topo da pagina do produto (tq-63, 20/10/2026)
//
// O topo da peca so tinha "Voltar" e as migalhas: depois de "Adicionado a
// sacola" nao havia como abrir a sacola sem voltar a home. Agora o mesmo
// icone com contador do topo da loja, que abre a mesma gaveta — e com o
// fundo escuro POR CIMA da pagina, senao clicar fora nao fecha.
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');
const buildStyles = require('../src/templates/storefrontStyles');

const parts = (n) => fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/', n), 'utf8');
const pd = parts('product_detail.js');
const trecho = pd.slice(pd.indexOf('function abrirSacolaDoProduto'), pd.indexOf('function fecharProduto'));
const css = buildStyles('#C7A956', '#C7A956', true, 'classic');

function funcoes(els, chamadas) {
  const document = { getElementById: (id) => els[id] || null };
  return new Function('document', 'openCart', 'getCount', trecho + '\nreturn { abrirSacolaDoProduto, sincronizarSacolaDoProduto };')(
    document, () => chamadas.push('openCart'), () => els.__count || 0);
}
function badge() {
  const cls = new Set();
  return { textContent: '', classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), has: (c) => cls.has(c) } };
}

describe('o topo da peca tem a sacola', () => {
  test('mesmo icone e contador do topo da loja, com rotulo acessivel', () => {
    expect(pd).toContain(`'<button type="button" class="cart-btn pd-sacola" id="pdSacola" aria-label="Abrir sacola">'`);
    expect(pd).toContain(`'<span class="cart-badge" id="pdCartBadge">0</span>'`);
    // O mesmo desenho da sacola do topo (storefrontHtml.js).
    const html = fs.readFileSync(path.join(__dirname, '../src/templates/storefrontHtml.js'), 'utf8');
    expect(html).toContain('<path d="M5 7h14l-1 13H6L5 7z"/><path d="M9 7V5a3 3 0 016 0v2"/>');
    expect(pd).toContain('<path d="M5 7h14l-1 13H6L5 7z"/><path d="M9 7V5a3 3 0 016 0v2"/>');
  });

  test('vem depois das migalhas, dentro do topo', () => {
    const i = pd.indexOf('pd-topo-inner');
    expect(pd.indexOf('pd-crumbs', i)).toBeLessThan(pd.indexOf('id="pdSacola"', i));
  });

  test('o clique abre a sacola; o contador acompanha ao abrir a peca e a cada mudanca', () => {
    expect(pd).toContain("el.querySelector('#pdSacola').addEventListener('click',abrirSacolaDoProduto);");
    const apos = pd.slice(pd.indexOf('document.body.appendChild(el);'));
    expect(apos.indexOf('sincronizarSacolaDoProduto();')).toBeGreaterThan(0);
    expect(apos.indexOf('sincronizarSacolaDoProduto();')).toBeLessThan(200);
    expect(parts('cart.js')).toContain("if(typeof sincronizarSacolaDoProduto==='function') sincronizarSacolaDoProduto();");
  });
});

describe('abrir a sacola daqui', () => {
  test('abre a gaveta e sobe o fundo para cima da pagina (201 > 200)', () => {
    const fundo = { style: {} };
    const chamadas = [];
    funcoes({ cartOverlay: fundo }, chamadas).abrirSacolaDoProduto();
    expect(chamadas).toEqual(['openCart']);
    expect(fundo.style.zIndex).toBe('201');
  });
  test('a camada da pagina e da sacola continuam onde estavam no CSS', () => {
    expect(css).toContain('.pd-overlay{position:fixed;inset:0;z-index:200;');
    expect(css).toContain('.cart-overlay{position:fixed;inset:0;z-index:200;');
    expect(css).toContain('.cart-drawer{position:fixed;top:0;right:0;bottom:0;z-index:201;');
  });
});

describe('o contador da peca', () => {
  test('mostra a contagem e acende com itens', () => {
    const b = badge();
    funcoes({ pdCartBadge: b, __count: 3 }, []).sincronizarSacolaDoProduto();
    expect(b.textContent).toBe(3);
    expect(b.classList.has('visible')).toBe(true);
  });
  test('sacola vazia: contador apagado', () => {
    const b = badge();
    funcoes({ pdCartBadge: b, __count: 0 }, []).sincronizarSacolaDoProduto();
    expect(b.classList.has('visible')).toBe(false);
  });
  test('sem pagina aberta, nao faz nada (updateCartUI chama sempre)', () => {
    expect(() => funcoes({}, []).sincronizarSacolaDoProduto()).not.toThrow();
  });
  test('"Adicionar a sacola" pulsa o contador desta pagina', () => {
    const clique = pd.slice(pd.indexOf("el.querySelector('#pdComprar').addEventListener"));
    expect(clique.indexOf("getElementById('pdCartBadge')")).toBeLessThan(clique.indexOf("b.textContent='Adicionado à sacola';"));
  });
});

describe('o desenho do topo nao muda', () => {
  test('a sacola fica fora do fluxo e centra sem transform (o hover do .cart-btn usa transform)', () => {
    const regra = css.match(/\n\.pd-sacola\{([^}]*)\}/)[1];
    expect(regra).toContain('position:absolute');
    expect(regra).toContain('top:0;bottom:0;margin:auto 0');
    expect(regra).not.toContain('transform');
  });
  test('as regras de antes do topo continuam iguais', () => {
    expect(css).toContain('.pd-topo-inner{max-width:1280px;margin:0 auto;padding:12px 32px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;}');
    expect(css).toContain('.pd-topo-inner{padding:10px 16px;flex-wrap:nowrap;flex-direction:column;align-items:flex-start;gap:2px;}');
  });
  test('no celular, a mesma borda do topo da loja (8px)', () => {
    expect(css).toContain('  .pd-sacola{right:8px;}');
  });
  test('a home nao ganha elemento: a sacola da peca nasce no JS, ao abrir a peca', () => {
    const html = buildPage({ site: { name: 'Loja', banners: [] }, contact: {}, settings: {}, products: [], categories: [] }, 'loja');
    const semScript = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    expect(semScript).not.toContain('pdSacola');
    const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    expect(() => new Function(js.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
