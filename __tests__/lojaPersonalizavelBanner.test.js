// ============================================================
// Loja comum com produto personalizavel: selo, "a partir de", botao
// "Personalizar" e o banner A da home (p-180, loja unica 3.2b, 17/11/2026)
//
// Mockup p-132, versao A (D9 do Caio). O que este teste segura:
//   1. o cartao do personalizavel ganha o selo "Personalize", o "a partir
//      de" e a linha "Com o seu nome ou a sua arte"; o cartao comum, nao;
//   2. a pagina da peca troca "Adicionar a sacola" por "Personalizar", que
//      dispara o evento `aura:personalizar` (o quadro e o p-182);
//   3. o banner A entra no lugar do hero so com tem_personalizavel E o
//      modelo escolhido; sem configuracao, o hero e o de hoje;
//   4. CSS e JS novos so na loja com tem_personalizavel;
//   5. a home lembrada (60 s) responde com a CSP guardada junto;
//   6. a rota do painel grava o banner saneado e esquece a home.
// Loja SEM personalizavel byte a byte igual: lojaSemPersonalizavel.fixture.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const cache = require('../src/services/cacheDaPaginaDaLoja');
const storefront = require('../src/routes/storefront');
const buildPage = require('../src/templates/storefrontPage');
const card = require('../src/templates/storefront/parts/card');
const productDetail = require('../src/templates/storefront/parts/product_detail');
const promocao = require('../src/templates/storefront/parts/promocao');
const campanha = require('../src/templates/storefront/parts/campanha');
const pz = require('../src/templates/storefront/parts/personalizavel');
const bannerPz = require('../src/services/bannerPersonalizados');
const { AGORA, cenarios } = require('./fixtures/lojaSemPersonalizavel/dados');

const CANECA = '0b1a9999-0000-4000-8000-000000000001';

// ── 1. O cartao, rodando o JS de verdade ──────────────────────
function cartaoDe(src) {
  const fn = new Function(
    'getProductCartQty', 'INICIAIS', 'PARCELAS_TXT', 'FUNDO_CAPA', 'fmt', 'esc', '__S', 'SETTINGS', 'document',
    `${src}\nreturn cardHtml;`);
  return fn(
    () => 0, (n) => String(n).slice(0, 2), () => '', () => '#eee',
    (v) => 'R$ ' + Number(v).toFixed(2).replace('.', ','), (s) => String(s == null ? '' : s),
    { pix_discount_pct: 0 }, { show_prices: true }, { getElementById: () => ({}) });
}
const peca = (extra) => Object.assign({ id: 'p1', name: 'Caneca', price: 38, image_url: 'https://r2/caneca.jpg', variants: [] }, extra || {});

describe('o cartao', () => {
  const cardHtml = cartaoDe(pz.aplicarNoCartao(card));

  test('personalizavel: selo "Personalize", "a partir de" e a linha da arte', () => {
    const h = cardHtml(peca({ personalizavel: true, is_new: true }));
    expect(h).toContain('<span class="pz-selo">');
    expect(h).toContain('Personalize</span>');
    expect(h).not.toContain('card-badge'); // o selo fica no lugar do NOVO
    expect(h).toContain('<small class="pz-apartir">a partir de</small><span class="product-price mono">R$ 38,00</span>');
    expect(h).toContain('<div class="pz-linha">Com o seu nome ou a sua arte</div>');
  });

  test('peca comum no mesmo cartao: igual ao cartao de hoje', () => {
    const hoje = cartaoDe(card);
    const p = peca({ is_new: true });
    expect(cardHtml(p)).toBe(hoje(p));
  });

  test('com o "De" riscado da promocao, os dois convivem', () => {
    const comPromo = cartaoDe(pz.aplicarNoCartao(promocao.aplicarNoCartao(card)));
    const h = comPromo(peca({ personalizavel: true, em_promocao: true, preco_de: 50 }));
    expect(h).toContain('product-de');
    expect(h).toContain('a partir de</small><span class="product-price mono">R$ 38,00</span>');
    expect(h).toContain('pz-selo');
  });
});

// ── 2. A pagina da peca ───────────────────────────────────────
describe('a pagina da peca', () => {
  test('cada troca acha o trecho uma vez, sozinha e depois de promocao e campanha', () => {
    expect(() => pz.aplicarNoDetalhe(productDetail)).not.toThrow();
    const daCampanha = { ativa: true, ate_pct: 30, ate_data: '2026-11-30' };
    const composto = campanha.aplicarNoDetalhe(promocao.aplicarNoDetalhe(productDetail), daCampanha);
    expect(() => pz.aplicarNoDetalhe(composto)).not.toThrow();
  });

  test('o botao vira "Personalizar" e pede o personalizador antes da sacola', () => {
    const d = pz.aplicarNoDetalhe(productDetail);
    expect(d).toContain("(p.personalizavel?'Personalizar':'Adicionar à sacola')");
    expect(d).toContain("if(p.personalizavel){ personalizarPeca(p,'detalhe'); return; }");
    expect(d).toContain('var hasVar=!p.personalizavel&&');
    expect(d).toContain('+comoFuncionaHtml(p)');
    expect(pz.EXTRA).toContain("new CustomEvent('aura:personalizar',{cancelable:true");
  });

  test('sem ninguem ouvindo, "Personalizar" leva ao WhatsApp da loja', () => {
    const abertos = [];
    const ouvintes = [];
    const fn = new Function('window', 'CustomEvent', 'CONTACT', 'numeroDoWhatsapp', 'showToast', 'PROD_MAP', 'showDetail',
      `${pz.EXTRA}\nreturn { personalizarPeca: personalizarPeca, abrirPersonalizavel: abrirPersonalizavel };`);
    class Ev { constructor(t, o) { this.type = t; this.detail = o.detail; this.defaultPrevented = false; } preventDefault() { this.defaultPrevented = true; } }
    const janela = {
      open: (u) => abertos.push(u),
      dispatchEvent: (e) => ouvintes.forEach((f) => f(e)),
    };
    const vistos = [];
    const api = fn(janela, Ev, { whatsapp: '(12) 98136-5134' }, () => '5512981365134', () => {}, { [CANECA]: {} }, (id) => vistos.push(id));
    api.personalizarPeca({ id: CANECA, name: 'Caneca' }, 'detalhe');
    expect(abertos[0]).toContain('https://wa.me/5512981365134?text=');
    expect(decodeURIComponent(abertos[0])).toContain('Quero personalizar "Caneca"');

    // O quadro (p-182) chama preventDefault: nada de WhatsApp.
    ouvintes.push((e) => { if (e.type === 'aura:personalizar') e.preventDefault(); });
    api.personalizarPeca({ id: CANECA, name: 'Caneca' }, 'detalhe');
    expect(abertos).toHaveLength(1);

    // Banner: com o quadro ouvindo, o link nao navega.
    const a = { getAttribute: (k) => ({ 'data-produto': CANECA, 'data-modo': '3d' }[k]) };
    expect(api.abrirPersonalizavel(a)).toBe(false);
    ouvintes.length = 0;
    // Sem quadro: abre a peca se ela esta carregada; senao segue o link.
    expect(api.abrirPersonalizavel(a)).toBe(false);
    expect(vistos).toEqual([CANECA]);
    const fora = { getAttribute: (k) => ({ 'data-produto': 'outra', 'data-modo': '' }[k]) };
    expect(api.abrirPersonalizavel(fora)).toBe(true);
  });
});

// ── 3 e 4. A pagina inteira, pela rota de verdade ─────────────
const BANNER_GRAVADO = {
  ativo: true, produto_id: CANECA,
  kicker: '', titulo: 'Canecas com o seu nome', texto: '', botao: '', botao_3d: '', mostrar_3d: true,
};

/** loja_simples do fixture, agora com uma caneca personalizavel. */
function lojaComPersonalizavel({ banner, imagem = 'https://r2.exemplo/caneca.jpg' } = {}) {
  const loja = cenarios.loja_simples();
  loja.config.banner_personalizados = banner || null;
  loja.produtos = loja.produtos.concat([Object.assign({}, loja.produtos[0], {
    id: CANECA, name: 'Caneca personalizada', price: '38.00', stock_qty: '0', personalizavel: true,
  })]);
  loja.peca_do_banner = imagem ? { id: CANECA, name: 'Caneca personalizada', image_url: imagem } : null;
  return loja;
}

let naoRespondidas = [];
function bancoDa(loja, { temPersonalizavel }) {
  return async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    const cabeca = s.split(' WHERE ')[0];
    const ids = Array.isArray(params[0]) ? params[0] : [];
    if (s.startsWith('WITH todos AS')) return { rows: loja.resumo ? [loja.resumo] : [] };
    if (s.startsWith('WITH visiveis AS')) return { rows: loja.arvore };
    if (s.startsWith('WITH pecas AS')) return { rows: loja.capas };
    if (s.includes(' AS restam')) return { rows: loja.ultimas };
    if (s.includes(' AS vendidos')) return { rows: loja.mais_vendidos };
    if (s.includes(' AS atributo')) return { rows: loja.facetas };
    if (s.includes('category AS nome')) return { rows: loja.barra };
    if (s.includes('::float AS min')) return { rows: [loja.faixa] };
    if (s.includes('COUNT(*)::int AS n')) return { rows: [{ n: loja.total, tem_personalizavel: temPersonalizavel }] };
    if (s.includes('ORDER BY (id::text = $2) DESC')) return { rows: loja.peca_do_banner ? [loja.peca_do_banner] : [] };
    if (/FROM product_variants pv /.test(s)) return { rows: loja.variantes.filter((v) => ids.includes(v.product_id)) };
    if (cabeca.includes('company_pdv_settings') || cabeca === 'SELECT * FROM digital_channel_config') {
      return { rows: params[0] === loja.config.slug ? [loja.config] : [] };
    }
    if (cabeca.includes('FROM companies_payment_gateways')) return { rows: loja.gateway };
    if (cabeca.startsWith('SELECT trade_name')) return { rows: [loja.empresa] };
    if (cabeca.includes('FROM product_category_links')) return { rows: loja.vinculos.filter((l) => ids.includes(l.product_id)) };
    if (cabeca.includes('FROM product_categories')) return { rows: loja.categorias };
    if (cabeca.includes('FROM product_images')) return { rows: [] };
    if (cabeca.includes('FROM products')) {
      if (cabeca.includes('stock_min')) return { rows: loja.novidades };
      if (s.includes('AND id = $2')) return { rows: loja.produtos.filter((p) => p.id === params[1]) };
      return { rows: loja.produtos };
    }
    naoRespondidas.push(s.slice(0, 160));
    throw new Error('consulta sem resposta no teste: ' + s.slice(0, 160));
  };
}

const app = express();
app.use('/api/v1/storefront', storefront);

beforeAll(() => {
  jest.useFakeTimers({
    now: new Date(AGORA),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
      'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  naoRespondidas = [];
  cache.esquecerPagina();
  db.query.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  expect(naoRespondidas).toEqual([]);
});

async function home(loja, temPersonalizavel) {
  db.query.mockImplementation(bancoDa(loja, { temPersonalizavel }));
  cache.esquecerPagina();
  const r = await request(app).get(`/api/v1/storefront/${loja.config.slug}/page`);
  expect(r.status).toBe(200);
  return r.text;
}
const heroDe = (html) => (html.match(/<section class="hero[^"]*" id="bannerStage">[\s\S]*?<\/section>/) || [null])[0];
const scripts = (html) => (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((s) => s.replace(/^<script>/, '').replace(/<\/script>$/, ''));

describe('a home da loja com personalizavel', () => {
  test('com o modelo escolhido: o banner A no lugar do hero, com a faixa de confianca', async () => {
    const html = await home(lojaComPersonalizavel({ banner: BANNER_GRAVADO }), true);
    expect(heroDe(html)).toBeNull();
    expect(html).toContain('<section class="home-sec pz-banner" id="bannerPersonalizados"');
    expect(html).toContain('<h2 class="pz-banner-tit serif">Canecas com o seu nome</h2>');
    // Texto vazio = o do modelo.
    expect(html).toContain('<div class="pz-banner-ey">Feito sob encomenda</div>');
    expect(html).toContain('>Personalizar agora</a>');
    expect(html).toContain('>Ver como fica em 3D</a>');
    expect(html).toContain(`data-produto="${CANECA}" data-modo="3d" onclick="return abrirPersonalizavel(this)"`);
    expect(html).toContain('<img src="https://r2.exemplo/caneca.jpg" alt="Caneca personalizada"');
    // Faixa: aprova a arte + o que a loja ligou (retirada, Pix) + troca.
    expect(html).toContain('<b>Você aprova a arte</b><small>antes de produzir</small>');
    expect(html).toContain('<b>Retire na loja</b>');
    expect(html).toContain('<b>Pix</b><small>pagamento seguro</small>');
    expect(html).toContain('<b>Troca em até 7 dias</b><small>nas peças de prateleira</small>');
    // O CSS do banner e da peca no <head>, so aqui.
    expect(html).toContain('.pz-banner-palco{');
    expect(html).toContain('@media (max-width:640px){.pz-banner-palco{grid-template-columns:1fr');
    for (const s of scripts(html)) expect(() => new Function(s)).not.toThrow();
  });

  test('sem configuracao do banner: o hero e o de hoje, so o selo nas pecas', async () => {
    const hoje = await home(cenarios.loja_simples(), false);
    const html = await home(lojaComPersonalizavel(), true);
    expect(heroDe(html)).toBe(heroDe(hoje));
    expect(html).not.toContain('pz-banner');
    expect(html).toContain('.pz-selo{'); // o estilo da peca entra
    expect(html).toContain('function seloPersonalize(p)');
    expect(html).toContain('"personalizavel":true');
  });

  test('modelo desligado ou sem foto da peca: a home de hoje', async () => {
    const hoje = heroDe(await home(cenarios.loja_simples(), false));
    const desligado = await home(lojaComPersonalizavel({ banner: { ...BANNER_GRAVADO, ativo: false } }), true);
    expect(heroDe(desligado)).toBe(hoje);
    const semFoto = await home(lojaComPersonalizavel({ banner: BANNER_GRAVADO, imagem: null }), true);
    expect(heroDe(semFoto)).toBe(hoje);
  });

  test('banner gravado numa loja que deixou de ter personalizavel: nao aparece, nada novo', async () => {
    const hoje = await home(cenarios.loja_simples(), false);
    const loja = cenarios.loja_simples();
    loja.config.banner_personalizados = BANNER_GRAVADO;
    const html = await home(loja, false);
    expect(html).toBe(hoje);
  });

  test('o payload leva a peca marcada e o banner', async () => {
    const loja = lojaComPersonalizavel({ banner: BANNER_GRAVADO });
    db.query.mockImplementation(bancoDa(loja, { temPersonalizavel: true }));
    const r = await request(app).get(`/api/v1/storefront/${loja.config.slug}`);
    const caneca = r.body.products.find((p) => p.id === CANECA);
    expect(caneca.personalizavel).toBe(true);
    expect(r.body.products.filter((p) => p.personalizavel)).toHaveLength(1);
    expect(r.body.banner_personalizado).toEqual(expect.objectContaining({
      titulo: 'Canecas com o seu nome', botao: 'Personalizar agora', botao_3d: 'Ver como fica em 3D',
      produto: { id: CANECA, name: 'Caneca personalizada', image_url: 'https://r2.exemplo/caneca.jpg' },
    }));
  });
});

describe('o CSS e o JS novos so na loja com personalizavel', () => {
  const payload = (extra) => ({
    site: { name: 'Ateliê', primary_color: '#2a221b' }, contact: {}, settings: {},
    products: [{ id: 'p1', name: 'Bolsa', price: 219.9, variants: [] }],
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] }, ...extra,
  });
  test('sem tem_personalizavel: nenhum pz-, nenhum evento novo', () => {
    const html = buildPage(payload(), 'atelie');
    expect(html).not.toMatch(/pz-|aura:personalizar|seloPersonalize/);
  });
  test('com tem_personalizavel: o estilo no head e as funcoes no script', () => {
    const html = buildPage(payload({ tem_personalizavel: true }), 'atelie');
    expect(html).toMatch(/<style>\.pz-selo\{[^<]*<\/style>\n<\/head>/);
    expect(html).toContain("window.dispatchEvent(ev)");
  });
  test('o texto do banner sobre a cor da loja: branco no escuro, preto no claro', () => {
    expect(pz.cssDe({ primary: '#2a221b', comBanner: true })).toContain('--pz-tinta:#fff;--pz-linha:rgba(255,255,255,.6)');
    expect(pz.cssDe({ primary: '#f5d76e', comBanner: true })).toContain('--pz-tinta:#000;--pz-linha:rgba(0,0,0,.45)');
  });
  test('o banner escapa o texto da lojista', () => {
    const h = pz.bannerHtml({ titulo: '<script>x</script>', botao: 'Ir"', produto: { id: 'p"1', name: 'A', image_url: 'https://r2/a.jpg' }, faixa: [] }, { urlDaLoja: 'https://loja.getaura.com.br/atelie/' });
    expect(h).not.toContain('<script>x');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('href="https://loja.getaura.com.br/atelie/p/p%221"');
  });
});

// ── 5. A home lembrada com a CSP ──────────────────────────────
describe('a home lembrada guarda a CSP junto', () => {
  test('o hit responde com a CSP da entrada', async () => {
    cache.lembrarPagina('com-csp', '<html>guardada</html>', "default-src 'self'; frame-src https://app.exemplo");
    expect(cache.entradaLembrada('com-csp')).toEqual({ html: '<html>guardada</html>', csp: "default-src 'self'; frame-src https://app.exemplo" });
    const r = await request(app).get('/api/v1/storefront/com-csp/page');
    expect(r.headers['x-aura-cache']).toBe('hit');
    expect(r.headers['content-security-policy']).toBe("default-src 'self'; frame-src https://app.exemplo");
    expect(r.text).toBe('<html>guardada</html>');
  });
  test('entrada sem CSP (quem guardou nao informou): a CSP padrao, como antes', async () => {
    cache.lembrarPagina('sem-csp', '<html>x</html>');
    const r = await request(app).get('/api/v1/storefront/sem-csp/page');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(cache.paginaLembrada('sem-csp')).toBe('<html>x</html>');
  });
});

// ── O servico do banner ───────────────────────────────────────
describe('bannerPersonalizados', () => {
  test('sanearBanner: corta, exige https, uuid e objeto', () => {
    expect(bannerPz.sanearBanner(null)).toBeNull();
    expect(bannerPz.sanearBanner([1])).toBeNull();
    const b = bannerPz.sanearBanner({
      ativo: true, produto_id: 'nao-e-uuid', imagem_url: 'http://inseguro/a.jpg',
      titulo: '  Muito   ' + 'x'.repeat(200), mostrar_3d: false,
    });
    expect(b).toEqual(expect.objectContaining({ ativo: true, produto_id: null, imagem_url: null, mostrar_3d: false }));
    expect(b.titulo.startsWith('Muito x')).toBe(true);
    expect(b.titulo.length).toBe(bannerPz.LIMITES.titulo);
    expect(bannerPz.sanearBanner('{"ativo":true}').ativo).toBe(true);
  });

  test('faixa: entrega e pagamento do que a loja ligou', () => {
    expect(bannerPz.faixaDeConfianca({ delivery_enabled: true, delivery_free_above_amount: 150, has_pix: true, has_card: true }))
      .toEqual([
        { icone: '✓', titulo: 'Você aprova a arte', texto: 'antes de produzir' },
        { icone: '→', titulo: 'Entrega', texto: 'grátis acima de R$ 150' },
        { icone: '$', titulo: 'Pix ou cartão', texto: 'pagamento seguro' },
        { icone: '↺', titulo: 'Troca em até 7 dias', texto: 'nas peças de prateleira' },
      ]);
    const semNada = bannerPz.faixaDeConfianca({ pickup_enabled: false });
    expect(semNada.map((i) => i.titulo)).toEqual(['Você aprova a arte', 'Troca em até 7 dias']);
  });

  test('montarBanner: sem escolha nao consulta o banco', async () => {
    expect(await bannerPz.montarBanner({ config: {}, cid: 'c', visibilityWhere: 'true' })).toBeNull();
    expect(await bannerPz.montarBanner({ config: { banner_personalizados: { ativo: false } }, cid: 'c', visibilityWhere: 'true' })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('montarBanner: a imagem da lojista vira a capa; 3D desligado some', async () => {
    db.query.mockResolvedValue({ rows: [{ id: CANECA, name: 'Caneca', image_url: null }] });
    const b = await bannerPz.montarBanner({
      config: { banner_personalizados: { ativo: true, imagem_url: 'https://r2/banner.jpg', mostrar_3d: false } },
      cid: 'c', visibilityWhere: 'true', cfgDosSelos: {},
    });
    expect(b.produto).toEqual({ id: CANECA, name: 'Caneca', image_url: 'https://r2/banner.jpg' });
    expect(b.botao_3d).toBe('');
    expect(b.titulo).toBe(bannerPz.PADRAO.titulo);
    // Com imagem propria, a consulta aceita peca sem foto.
    expect(String(db.query.mock.calls[0][0])).not.toContain("AND NULLIF(TRIM(image_url), '') IS NOT NULL");
  });

  test('montarBanner: consulta que falha = home de hoje', async () => {
    db.query.mockRejectedValue(new Error('caiu'));
    expect(await bannerPz.montarBanner({ config: { banner_personalizados: { ativo: true } }, cid: 'c', visibilityWhere: 'true' })).toBeNull();
  });
});

// ── 6. A rota do painel ───────────────────────────────────────
describe('PUT /digital-channel/banner-personalizados', () => {
  const painel = express();
  painel.use(express.json());
  painel.use((req, res, next) => { req.user = { role: 'client' }; next(); });
  painel.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));
  const CID = '0b1a0000-0000-4000-8000-000000000001';

  test('grava o banner saneado e esquece a home da loja', async () => {
    cache.lembrarPagina('minha-loja', '<html>velha</html>');
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('SELECT 1 FROM products')) return { rows: [{ '?column?': 1 }] };
      if (s.includes('UPDATE digital_channel_config SET banner_personalizados')) return { rows: [{ slug: 'minha-loja' }] };
      return { rows: [] };
    });
    const r = await request(painel).put(`/companies/${CID}/digital-channel/banner-personalizados`)
      .send({ ativo: true, produto_id: CANECA, titulo: 'Oi', extra: 'ignorado' });
    expect(r.status).toBe(200);
    expect(r.body.banner).toEqual(expect.objectContaining({ ativo: true, produto_id: CANECA, titulo: 'Oi' }));
    expect(r.body.banner).not.toHaveProperty('extra');
    const update = db.query.mock.calls.find((c) => String(c[0]).includes('UPDATE digital_channel_config'));
    expect(update[1][0]).toBe(CID);
    expect(JSON.parse(update[1][1])).toEqual(r.body.banner);
    // A home velha saiu da memoria: o banner novo sai na proxima visita.
    expect(cache.paginaLembrada('minha-loja')).toBeNull();
  });

  test('peca que nao e personalizavel da loja: 400, nada gravado', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await request(painel).put(`/companies/${CID}/digital-channel/banner-personalizados`)
      .send({ ativo: true, produto_id: CANECA });
    expect(r.status).toBe(400);
    expect(db.query.mock.calls.some((c) => String(c[0]).includes('UPDATE'))).toBe(false);
  });

  test('GET: sem a coluna (migration 458 nao rodou) devolve banner null e as pecas', async () => {
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes('SELECT banner_personalizados')) { const e = new Error('col'); e.code = '42703'; throw e; }
      return { rows: [{ id: CANECA, name: 'Caneca', image_url: 'https://r2/c.jpg' }] };
    });
    const r = await request(painel).get(`/companies/${CID}/digital-channel/banner-personalizados`);
    expect(r.status).toBe(200);
    expect(r.body.banner).toBeNull();
    expect(r.body.pecas).toHaveLength(1);
    expect(r.body.padrao.botao_3d).toBe('Ver como fica em 3D');
  });
});
