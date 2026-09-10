// ============================================================
// Banner com arte pronta e destino (10/09/2026)
//
// Os banners da vitrine Finesse trazem o texto e o "Ver ..." desenhados
// na arte (texto branco sobre gradiente nao funciona sobre areia). Sem um
// destino que a loja saiba abrir, o convite da arte nao tem clique:
//  - "#vista=todos|novidades|mais_vendidos" vira destino valido, ao lado
//    de "#cat=/caminho" e http(s);
//  - slide com foto, sem texto nosso e com destino, e um link inteiro.
// ============================================================
const buildPage = require('../src/templates/storefrontPage');
const { destinoDoCta } = require('../src/services/storefrontBuilder');

function paginaCom(banners) {
  return buildPage({
    slug: 'finesse',
    site: { name: 'Finesse', primary_color: '#7a1f3a', banners },
    contact: {}, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, 'finesse');
}
const foto = 'https://cdn/banner_0.jpg';

describe('destinoDoCta aceita as vistas da grade', () => {
  test('as tres vistas passam; qualquer outra coisa nao', () => {
    expect(destinoDoCta('#vista=todos')).toBe('#vista=todos');
    expect(destinoDoCta('#vista=novidades')).toBe('#vista=novidades');
    expect(destinoDoCta('#vista=mais_vendidos')).toBe('#vista=mais_vendidos');
    expect(destinoDoCta('#vista=promocao')).toBe('');
    expect(destinoDoCta('#vista=')).toBe('');
    expect(destinoDoCta('#todos')).toBe('');
  });
  test('categoria e http(s) continuam como antes', () => {
    expect(destinoDoCta('#cat=/vestidos/festa')).toBe('#cat=/vestidos/festa');
    expect(destinoDoCta('https://loja.com/x')).toBe('https://loja.com/x');
    expect(destinoDoCta('javascript:alert(1)')).toBe('');
  });
});

describe('o slide inteiro vira link quando a arte ja traz o texto', () => {
  test('foto + destino interno, sem texto: link por cima que navega na mesma aba', () => {
    const html = paginaCom([{ image_url: foto, cta_url: '#vista=novidades' }]);
    expect(html).toContain('<a class="hero-link" href="#vista=novidades" aria-label="Finesse" onclick="return irPeloCta(this)"></a>');
    // Sem texto nosso: nem scrim nem botao.
    expect(html).not.toMatch(/class="banner-slide hero-slide[^"]*com-texto/);
    expect(html).not.toContain('class="banner-cta"');
  });

  test('destino http(s) abre em nova aba', () => {
    const html = paginaCom([{ image_url: foto, cta_url: 'https://instagram.com/finesse' }]);
    expect(html).toContain('<a class="hero-link" href="https://instagram.com/finesse" aria-label="Finesse" target="_blank" rel="noopener"></a>');
  });

  test('com texto nosso, o botao de sempre — e nada de link por cima', () => {
    const html = paginaCom([{ image_url: foto, headline: 'Festa', cta: 'Ver', cta_url: '#cat=/vestidos/festa' }]);
    expect(html).toContain('class="banner-cta"');
    expect(html).not.toContain('class="hero-link"');
  });

  test('sem destino, nada muda', () => {
    expect(paginaCom([{ image_url: foto }])).not.toContain('class="hero-link"');
  });

  test('o link fica acima do scrim e abaixo dos pontos', () => {
    const html = paginaCom([{ image_url: foto, cta_url: '#vista=todos' }]);
    expect(html).toContain('.hero-link{position:absolute;inset:0;z-index:2;');
    expect(html).toContain('.hero .banner-dots{position:absolute;left:0;right:0;bottom:18px;display:flex;justify-content:center;gap:6px;z-index:3;}');
  });
});

describe('o script abre a vista', () => {
  const js = paginaCom([]).match(/<script>([\s\S]*?)<\/script>/)[1];
  test('pelo CTA e pelo link colado', () => {
    expect(js).toContain("var v=/^#vista=(todos|novidades|mais_vendidos)$/.exec(h);");
    expect(js).toContain("if(v){ verTudo(v[1]); return false; }");
    expect(js).toContain("if(v) setTimeout(function(){ verTudo(v[1]); },0);");
  });
  test('o script continua sendo JS valido', () => {
    expect(() => new Function(js.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
