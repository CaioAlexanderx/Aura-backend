// ============================================================
// Cinco defeitos apontados olhando a loja da Finesse no ar (31/08):
//
//  1. CTA "Ver produtos" que so rolava 200px ate a grade ja visivel
//  2. logo retangular mutilado pela caixa quadrada da topbar
//  3. rodape com a Aura em dois cantos dizendo a mesma coisa
//  4. menu de categorias mudo ao mouse
//  5. clique de categoria rolando a pagina pra longe do proprio menu
//
// Cada bloco guarda a REGRA que saiu da correcao, nao o pixel — pra
// proxima feature nao desfazer a decisao sem que alguem decida isso.
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');
const buildStyles = require('../src/templates/storefrontStyles');
const { parseBanners } = require('../src/services/storefrontBuilder');

const css = buildStyles('#7C3AED', '#7C3AED', false, 'classic');

function pagina(site, extra) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7C3AED', ...(site || {}) },
    settings: {},
    contact: {},
    products: [],
    categories: [],
    ...(extra || {}),
  }, 'loja');
}

// ── 1. CTA do banner ─────────────────────────────────────
describe('CTA do banner so existe com destino de verdade', () => {
  test('cta escrito SEM cta_url nao vira botao nenhum', () => {
    // A decisao do fallback (parseBanners) vale pro banner escrito
    // tambem: rolar ate uma grade que ja esta na tela e ruido.
    const html = pagina({ banners: [{ headline: 'Nova colecao', cta: 'Ver produtos' }] });
    // A classe .banner-cta segue no CSS (pro banner COM destino); o que
    // nao pode existir e o elemento no markup.
    expect(html).not.toContain('class="banner-cta"');
    expect(html).not.toContain('scrollToProducts');
  });

  test('cta com cta_url vira link, em nova aba', () => {
    const html = pagina({ banners: [{
      headline: 'Nova colecao', cta: 'Ver o lookbook',
      cta_url: 'https://instagram.com/finesse',
    }] });
    const i = html.indexOf('<a class="banner-cta"');
    expect(i).toBeGreaterThan(0);
    const tag = html.slice(i, html.indexOf('>', i));
    expect(tag).toContain('href="https://instagram.com/finesse"');
    // Nova aba: o carrinho vive em memoria (state_utils); navegar na
    // mesma aba jogaria a sacola da cliente fora.
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener"');
  });

  test('o parse so aceita http(s) — javascript: nao passa', () => {
    const [ruim] = parseBanners([{ headline: 'x', cta: 'clique', cta_url: 'javascript:alert(1)' }]);
    expect(ruim.cta_url).toBe('');
    const [bom] = parseBanners([{ headline: 'x', cta: 'clique', cta_url: '  https://getaura.com.br/promo ' }]);
    expect(bom.cta_url).toBe('https://getaura.com.br/promo');
  });

  test('o helper de rolagem morreu junto com o CTA de rolagem', () => {
    // Sem markup que o chame, o window.* orfao seria API fantasma.
    const html = pagina({ banners: [{ headline: 'x' }] });
    expect(html).not.toContain('scrollToProducts');
  });
});

// ── 2. Logo na topbar ────────────────────────────────────
describe('o logo da lojista entra inteiro na topbar', () => {
  test('contain, nao cover — cover cortava logo retangular', () => {
    const i = css.indexOf('.topbar-logo img{');
    expect(i).toBeGreaterThan(0);
    const decl = css.slice(i, css.indexOf('}', i));
    expect(decl).toContain('object-fit:contain');
    expect(decl).not.toContain('cover');
  });

  test('com imagem a caixa larga o quadrado; a inicial mantem o dela', () => {
    // O quadrado preenchido de marca e a capa da INICIAL (loja sem
    // logo), nao uma moldura pra mutilar o logo de quem tem.
    const i = css.indexOf('.topbar-logo:has(img){');
    expect(i).toBeGreaterThan(0);
    const decl = css.slice(i, css.indexOf('}', i));
    expect(decl).toContain('background:transparent');
    // Teto de largura: o logo nao pode empurrar nome e busca pra fora.
    expect(decl).toContain('max-width');
  });

  test('img quebrado SAI do DOM — display:none ainda casaria o :has(img)', () => {
    const html = pagina({ logo_url: 'https://cdn.exemplo.com/logo.png' });
    expect(html).toContain('onerror="this.remove();');
    expect(html).not.toContain("onerror=\"this.style.display='none'");
  });

  test('o selo Aberta tem respiro do nome', () => {
    const i = css.indexOf('.topbar-brand-text{');
    const decl = css.slice(i, css.indexOf('}', i));
    expect(decl).toContain('gap:4px');
  });
});

// ── 3. Rodape ────────────────────────────────────────────
describe('a Aura aparece UMA vez no rodape, num lugar so', () => {
  const html = pagina({});
  // Ate o </footer>, e nao ate o fim da pagina: depois dele vem o <script>
  // da loja, que carrega o endereco da API — e passou a conter
  // "getaura.com.br" quando o endereco deixou de nomear o provedor
  // (02/09). Contar a marca ali dentro nao e o que este teste quer dizer.
  const foot = html.slice(html.indexOf('<footer'), html.indexOf('</footer>') + 9);

  test('assinatura e convite viraram uma frase so, e a frase e o link', () => {
    expect((foot.match(/getaura\.com\.br/g) || []).length).toBe(1);
    expect(foot).not.toContain('Quero uma loja como essa');
    const i = foot.indexOf('<a class="powered"');
    expect(i).toBeGreaterThan(0);
    const link = foot.slice(i, foot.indexOf('</a>', i));
    expect(link).toContain('Loja desenvolvida com');
    expect(link).toContain('quero a minha');
  });

  test('a identidade da loja abre o rodape sozinha; a assinatura mora no rodape do rodape', () => {
    const id = foot.indexOf('site-footer-id');
    const bottom = foot.indexOf('site-footer-bottom');
    const powered = foot.indexOf('<a class="powered"');
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(bottom);
    expect(powered).toBeGreaterThan(bottom);
  });
});

// ── 4. Menu de categorias vivo ───────────────────────────
describe('o menu de categorias responde ao mouse', () => {
  test('uma regua neutra cresce sob a palavra no hover', () => {
    const i = css.indexOf('.cat-chip::after,.cat-sub::after{');
    expect(i).toBeGreaterThan(0);
    const decl = css.slice(i, css.indexOf('}', i));
    expect(decl).toContain('transform:scaleX(0)');
    expect(decl).toContain('transition:transform');
    // Neutra, NAO de marca: a regua de marca e o distintivo da ativa,
    // e a previa nao pode se vestir igual ao estado.
    expect(decl).not.toContain('var(--sf-brand)');
    expect(css).toContain('.cat-chip:hover::after,.cat-sub:hover::after{transform:scaleX(1);}');
  });

  test('a previa some na ativa — la quem fala e a regua de marca', () => {
    expect(css).toContain('.cat-chip.active::after,.cat-sub.active::after{content:none;}');
  });

  test('"Todas" responde no proprio pontilhado, nao na regua dos chips', () => {
    expect(css).toContain('.cat-todas:hover{border-bottom-color:var(--sf-ink-3);}');
  });

  test('a resposta nao mexe em peso nem tamanho — texto que engorda faz a barra dancar', () => {
    // Da primeira mencao a .cat-chip ate o painel: cobre a barra, os
    // filtros e a segunda linha (onde moram as reguas de hover).
    const bloco = css.slice(css.indexOf('.cat-chip'), css.indexOf('.cats-painel'));
    const hovers = bloco.match(/:hover[^{]*\{[^}]*\}/g) || [];
    for (const h of hovers) {
      expect(h).not.toContain('font-weight');
      expect(h).not.toContain('font-size');
      expect(h).not.toContain('translateY');
    }
  });
});

// ── 5. Rolagem: paginacao rola, navegacao nao ────────────
describe('trocar de categoria nao arranca a pagina da mao', () => {
  const prods = fs.readFileSync(
    path.join(__dirname, '../src/templates/storefront/parts/products.js'), 'utf8',
  );

  test('categoria, filtro, busca e ordem recarregam SEM rolar', () => {
    // Todos passam por recarregarDoInicio: a pessoa esta com a mao num
    // controle (menu, filtro, busca) que a rolagem tiraria da tela.
    expect(prods).toContain('irParaPagina(1,{rolar:false})');
  });

  test('a paginacao continua rolando: clique sem opcoes rola por padrao', () => {
    expect(prods).toContain('var rolar=!(opcoes&&opcoes.rolar===false);');
    // Os botoes de pagina chamam sem opcoes — o padrao vale pra eles.
    expect(prods).toContain('onclick="irParaPagina(\'+n+\')"');
  });

  test('sem rolar, a pagina nunca DESCE — so sobe ate o topo da grade', () => {
    // Trocar de categoria no pe da pagina 5 e ficar olhando o meio da
    // grade nova e outra forma de se perder; subir ate o topo dela nao
    // esconde o menu, que e sticky.
    expect(prods).toContain('rolar||window.scrollY>topo');
  });

  test('o pedido pendente lembra se devia rolar', () => {
    // O clique feito durante uma carga em curso roda depois — com a
    // MESMA intencao de rolagem, nao com a do padrao.
    expect(prods).toContain('pedidoPendente={n:n,rolar:rolar}');
  });

  test('rolagem suave respeita prefers-reduced-motion', () => {
    // O bloco reduced-motion do CSS nao alcanca o parametro do
    // scrollTo; o JS pergunta ao sistema por conta propria.
    expect(prods).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });
});
