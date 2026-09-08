// ============================================================
// URL propria do produto (08/09/2026)
//
// No QA das lojas, a peca nao tinha endereco: nao dava para mandar um
// vestido no WhatsApp, e o Voltar do navegador saia da loja. A pagina
// aberta em /<slug>/p/<id> traz a peca no payload, com titulo e foto
// dela nas metatags, e o script abre a peca ao carregar.
// ============================================================
const buildPage = require('../src/templates/storefrontPage');
const { metatagsDeSeo } = require('../src/services/rastreadores');

function paginaDe(extra) {
  return buildPage({
    slug: 'finesse',
    site: { name: 'Finesse', tagline: 'O look perfeito', primary_color: '#7a1f3a', storefront_url: 'https://loja.getaura.com.br/finesse', logo_url: 'https://cdn/logo.jpg' },
    contact: {}, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
    ...extra,
  }, 'finesse');
}

const peca = {
  id: '1f4a63bc-9c6c-43e0-a590-ab6516d58748', name: 'Vestido chiffon RF alcinha',
  description: 'Vestido leve de alcinha.', price: 155, image_url: 'https://cdn/vestido.jpg',
  thumb_url: null, gallery_urls: [], category: 'Vestido casual', variants: [], in_stock: true,
};

function scripts(html) {
  return (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map((s) => s.replace(/^<script>/, '').replace(/<\/script>$/, ''));
}

describe('a pagina de uma peca', () => {
  const html = paginaDe({ produto_inicial: peca });

  test('o titulo e a metatag sao da peca, com a loja como site', () => {
    expect(html).toContain('<title>Vestido chiffon RF alcinha · Finesse</title>');
    expect(html).toContain('<meta property="og:type" content="product">');
    expect(html).toContain('<meta property="og:title" content="Vestido chiffon RF alcinha · Finesse">');
    expect(html).toContain('<meta property="og:site_name" content="Finesse">');
    expect(html).toContain('<meta property="og:image" content="https://cdn/vestido.jpg">');
    expect(html).toContain('<meta name="description" content="Vestido leve de alcinha.">');
  });

  test('a URL canonica e a da peca, montada sobre o endereco da loja', () => {
    expect(html).toContain('<link rel="canonical" href="https://loja.getaura.com.br/finesse/p/1f4a63bc-9c6c-43e0-a590-ab6516d58748">');
  });

  test('a peca atravessa ate o <script> e o boot abre ela', () => {
    expect(html).toContain('"produto_inicial":{"id":"1f4a63bc-9c6c-43e0-a590-ab6516d58748"');
    expect(html).toContain("showDetail(PRODUTO_INICIAL.id,{historico:'trocar'})");
  });

  test('peca sem descricao ganha uma frase com o nome e a loja', () => {
    const semDesc = paginaDe({ produto_inicial: { ...peca, description: null } });
    expect(semDesc).toContain('<meta name="description" content="Vestido chiffon RF alcinha na Finesse">');
  });

  test('o script continua sendo JS valido', () => {
    scripts(html).forEach((src) => {
      expect(() => new Function(src.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
    });
  });
});

describe('a loja sem peca na URL', () => {
  test('mantem titulo, tipo e canonica da loja', () => {
    const html = paginaDe({});
    expect(html).toContain('<title>Finesse</title>');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<link rel="canonical" href="https://loja.getaura.com.br/finesse">');
    expect(html).toContain('"produto_inicial":null');
  });

  test('peca que saiu de linha vira aviso, nao erro', () => {
    const html = paginaDe({ produto_ausente: true });
    expect(html).toContain('"produto_ausente":true');
    expect(html).toContain('Essa peça não está mais disponível na loja.');
  });
});

describe('o script da peca', () => {
  const html = paginaDe({});
  const js = scripts(html)[0];

  test('cada peca aberta vira uma entrada no historico com a propria URL', () => {
    expect(js).toContain("history.pushState({produto:p.id},'',urlDoProduto(p.id))");
    expect(js).toContain('function urlDoProduto(id)');
  });

  test('o Voltar do navegador reabre a peca anterior quando ela existe', () => {
    expect(js).toContain("showDetail(st.produto,{historico:'nenhum'})");
  });

  test('a peca tem botao de compartilhar', () => {
    expect(js).toContain('class="pd-share" id="pdShare"');
    expect(js).toContain('navigator.share');
  });

  test('BASE_PATH tira o sufixo da peca do caminho', () => {
    // O regex vive num template literal: no navegador chega com uma barra
    // de escape so. Executa o trecho como o navegador executaria.
    const m = /var BASE_PATH = ([^;]+);/.exec(js);
    expect(m).toBeTruthy();
    const calc = (pathname) => new Function('window', `return ${m[1]};`)({ location: { pathname } });
    expect(calc('/finesse/p/abc-123')).toBe('/finesse');
    expect(calc('/finesse')).toBe('/finesse');
    expect(calc('/p/abc-123')).toBe('/');
    expect(calc('/')).toBe('/');
  });
});

describe('metatagsDeSeo', () => {
  test('tipo product e nome da loja separado do titulo', () => {
    const tags = metatagsDeSeo({ titulo: 'Peca · Loja', descricao: 'd', url: 'https://x/p/1', imagem: 'https://x/i.jpg', tipo: 'product', nomeDaLoja: 'Loja' });
    expect(tags).toContain('og:type" content="product"');
    expect(tags).toContain('og:site_name" content="Loja"');
  });
  test('sem tipo continua website, como antes', () => {
    expect(metatagsDeSeo({ titulo: 'Loja' })).toContain('og:type" content="website"');
    expect(metatagsDeSeo({ titulo: 'Loja' })).toContain('og:site_name" content="Loja"');
  });
});
