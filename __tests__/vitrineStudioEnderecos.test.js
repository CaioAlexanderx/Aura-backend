// ============================================================
// BE-1 · A loja Studio atende os enderecos da vitrine nova (25/09/2026)
//
// O app ganhou rota para cada tela (`/<slug>/sacola`, `/<slug>/pedido/<t>`
// ...). O middleware de dominio ja entregava esses caminhos ao storefront,
// que respondia 404 ANTES de o app carregar: recarregar a sacola ou abrir
// o link do pedido dava erro. E o link da peca colado no WhatsApp saia sem
// foto, porque o robo nao roda JavaScript e a casca so dizia "Aura.".
//
// O que estes testes guardam, pela porta de verdade (middleware de
// dominio + os tres routers de /storefront na ordem do index.js):
//   - as paginas novas servem a casca na loja Studio, nos dois modos;
//   - na loja comum elas voltam para a home (302), pelo mesmo host;
//   - a previa do link sai no <head>, escapada, sem sujar a casca guardada;
//   - NENHUMA rota de API do mesmo prefixo muda de dono.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { customDomainMiddleware } = require('../src/middleware/customDomain');
const { limparCache } = require('../src/services/vitrineStudioShell');
const storefront = require('../src/routes/storefront');

const PECA = '8f21c4a9-5b1e-4c7a-9d3e-2a6f0b1c9e77';
const OUTRA = '11111111-2222-3333-4444-555555555555';
const OID = '0a0b0c0d-1111-2222-3333-444455556666';

// A casca como o Expo exporta: titulo generico e o bundle.
const CASCA = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Aura.</title>'
  + '</head><body><div id="root"></div>'
  + '<script src="/_expo/static/js/web/entry-abc.js" defer></script></body></html>';

const LOJAS = {
  'sheid-mania': {
    company_id: 'cid-sheid', slug: 'sheid-mania', site_name: 'Sheid Mania',
    tagline: 'Canecas que viram presente', logo_url: 'https://r2/sheid-logo.png',
    company_pdv_settings: { studio_enabled: true }, company_display_name: 'Sheid LTDA',
    custom_domain: 'www.sheidmania.com.br', custom_domain_status: 'active',
  },
  'davi-calcados': {
    company_id: 'cid-davi', slug: 'davi-calcados', site_name: 'Davi Calcados',
    company_pdv_settings: {}, company_display_name: 'Davi',
  },
};
const DOMINIOS = { 'www.sheidmania.com.br': 'sheid-mania', 'www.davicalcados2.com.br': 'davi-calcados' };

let peca;

function mockDoBanco() {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (s.includes('WHERE custom_domain = $1')) {
      return { rows: DOMINIOS[params[0]] ? [{ slug: DOMINIOS[params[0]] }] : [] };
    }
    if (s.includes('company_pdv_settings')) {
      return { rows: LOJAS[params[0]] ? [LOJAS[params[0]]] : [] };
    }
    if (s.includes('FROM products') && s.includes('is_personalizable = true') && params[1] === PECA) {
      return { rows: params[0] === 'cid-sheid' && peca ? [peca] : [] };
    }
    return { rows: [] };
  });
}

function montarApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(customDomainMiddleware);
  app.use(express.json());
  const api = express.Router();
  // A MESMA ordem de src/routes/index.js (conferida no fim deste arquivo).
  api.use('/storefront', require('../src/routes/studioStorefrontVisual'));
  api.use('/storefront', require('../src/routes/studioStorefront'));
  api.use('/storefront', storefront);
  app.use('/api/v1', api);
  app.use((req, res) => res.status(404).json({ error: 'Rota nao encontrada' }));
  return app;
}

const app = montarApp();
const naLoja = (url) => request(app).get(url).set('Host', 'loja.getaura.com.br');

beforeEach(() => {
  limparCache();
  db.query.mockReset();
  mockDoBanco();
  peca = {
    id: PECA, name: 'Caneca Alça Coração', description: 'Porcelana branca, 325 ml, pronta para presente.',
    price: 49.9, image_url: 'https://r2/caneca-1600.jpg', image_thumb_url: 'https://r2/caneca-640.jpg',
    gallery_urls: ['https://r2/caneca-1600.jpg'],
  };
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => CASCA }));
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const CAMINHOS_NOVOS = [
  '/c/canecas', '/sacola', '/finalizar', '/pedido/tk_abc123', '/orcamento',
  '/acompanhar/tk_abc123', '/aprovacao/tk_abc123',
];

describe('as paginas da vitrine nova na loja Studio', () => {
  test.each(CAMINHOS_NOVOS)('loja.getaura.com.br/sheid-mania%s serve a casca', async (sub) => {
    const r = await naLoja('/sheid-mania' + sub);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.text).toContain('window.__AURA_VITRINE__={slug:"sheid-mania"');
    expect(r.text).toContain('https://app.getaura.com.br/_expo/static/js/web/entry-abc.js');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  test.each(CAMINHOS_NOVOS)('dominio proprio%s tambem (modo 2)', async (sub) => {
    const r = await request(app).get(sub).set('Host', 'www.sheidmania.com.br');
    expect(r.status).toBe(200);
    expect(r.text).toContain('window.__AURA_VITRINE__={slug:"sheid-mania"');
  });

  test('pela Cloudflare, com a reescrita da borda no meio', async () => {
    const r = await request(app).get('/api/v1/storefront/sheid-mania/pedido/tk_abc123/page')
      .set('Host', 'loja.getaura.com.br').set('cf-ray', '8a1b-GRU');
    expect(r.status).toBe(200);
    expect(r.text).toContain('window.__AURA_VITRINE__');
  });

  test('um caminho que NAO esta na lista continua 404 — nao ha curinga', async () => {
    const r = await naLoja('/sheid-mania/qualquer-coisa');
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('__AURA_VITRINE__');
  });

  test('sacola, checkout e paginas com token nao sao indexadas; categoria e', async () => {
    for (const sub of ['/sacola', '/finalizar', '/pedido/t', '/orcamento', '/acompanhar/t', '/aprovacao/t']) {
      expect((await naLoja('/sheid-mania' + sub)).text).toContain('<meta name="robots" content="noindex">');
    }
    expect((await naLoja('/sheid-mania/c/canecas')).text).not.toContain('noindex');
    expect((await naLoja('/sheid-mania')).text).not.toContain('noindex');
  });

  test('loja inexistente: a mesma pagina de "Loja nao encontrada"', async () => {
    const r = await naLoja('/nao-existe/sacola');
    expect(r.status).toBe(404);
    expect(r.text).toContain('Loja não encontrada');
  });
});

describe('as mesmas paginas numa loja que nao e Studio', () => {
  test.each(CAMINHOS_NOVOS)('loja.getaura.com.br/davi-calcados%s volta para a home', async (sub) => {
    const r = await naLoja('/davi-calcados' + sub);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/davi-calcados');
  });

  test('no dominio proprio, a home e a raiz', async () => {
    const r = await request(app).get('/sacola').set('Host', 'www.davicalcados2.com.br');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
  });

  test('direto na API (sem host de loja), a home e a pagina da API', async () => {
    const r = await request(app).get('/api/v1/storefront/davi-calcados/sacola').set('Host', 'api.getaura.com.br');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/api/v1/storefront/davi-calcados/page');
  });

  test('loja Studio com o app fora do ar tambem volta para a home', async () => {
    // A loja comum atende a home nesse caso; ela nao sabe desenhar a sacola.
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await naLoja('/sheid-mania/sacola');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/sheid-mania');
  });
});

describe('a previa do link na casca', () => {
  test('/p/<id>: titulo, descricao com preco, foto, canonica e tipo da peca', async () => {
    const r = await naLoja(`/sheid-mania/p/${PECA}`);
    expect(r.status).toBe(200);
    const h = r.text;
    expect(h).toContain('<title>Caneca Alça Coração · Sheid Mania</title>');
    expect(h).not.toContain('<title>Aura.</title>');
    expect(h).toContain('<meta property="og:title" content="Caneca Alça Coração · Sheid Mania">');
    expect(h).toContain('<meta property="og:description" content="R$ 49,90 · Porcelana branca, 325 ml, pronta para presente.">');
    expect(h).toContain('<meta property="og:image" content="https://r2/caneca-640.jpg">');
    expect(h).toContain('<meta property="og:type" content="product">');
    expect(h).toContain('<meta name="twitter:card" content="summary_large_image">');
    // Dominio proprio ativo: a canonica e a dele, como na loja comum.
    expect(h).toContain(`<meta property="og:url" content="https://www.sheidmania.com.br/p/${PECA}">`);
    expect(h).toContain(`<link rel="canonical" href="https://www.sheidmania.com.br/p/${PECA}">`);
  });

  test('as metatags ficam no <head>, antes do bundle', async () => {
    const h = (await naLoja(`/sheid-mania/p/${PECA}`)).text;
    const head = h.slice(0, h.indexOf('</head>'));
    expect(head).toContain('og:image');
    expect(head).toContain('__AURA_VITRINE__');
  });

  test('nome da peca com HTML nao sai do atributo nem do <title>', async () => {
    peca.name = 'Caneca "><script>alert(1)</script> $& fim';
    const h = (await naLoja(`/sheid-mania/p/${PECA}`)).text;
    expect(h).not.toContain('<script>alert(1)');
    expect(h).toContain('<meta property="og:title" content="Caneca &quot;>&lt;script>alert(1)&lt;/script> $&amp; fim · Sheid Mania">');
    expect(h).toContain('<title>Caneca &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; $&amp; fim · Sheid Mania</title>');
    // `$&` como texto, e nao como o padrao de substituicao do replace.
    expect(h).not.toContain('<title>Aura.</title>');
  });

  test('peca de outra loja ou inexistente: casca normal com as metatags da loja', async () => {
    for (const id of [OUTRA, 'nao-e-uuid']) {
      const r = await naLoja(`/sheid-mania/p/${id}`);
      expect(r.status).toBe(200);
      expect(r.text).toContain('<title>Sheid Mania</title>');
      expect(r.text).toContain('<meta property="og:type" content="website">');
      expect(r.text).toContain('<meta property="og:image" content="https://r2/sheid-logo.png">');
    }
  });

  test('peca oculta na vitrine Studio nao ganha previa (a consulta usa a regra da vitrine)', async () => {
    peca = null; // o banco nao devolve: oculta, inativa ou nao personalizavel
    const h = (await naLoja(`/sheid-mania/p/${PECA}`)).text;
    expect(h).toContain('<title>Sheid Mania</title>');
    const consulta = db.query.mock.calls.map((c) => String(c[0])).find((s) => s.includes('is_personalizable'));
    expect(consulta).toContain('studio_storefront_visible IS NOT FALSE');
    expect(consulta).toContain('customization_config IS NOT NULL');
    expect(consulta).toContain('is_active IS NOT FALSE');
  });

  test('peca sem foto usa o logo da loja', async () => {
    peca.image_url = null; peca.image_thumb_url = null; peca.gallery_urls = [];
    const h = (await naLoja(`/sheid-mania/p/${PECA}`)).text;
    expect(h).toContain('<meta property="og:image" content="https://r2/sheid-logo.png">');
  });

  test('home: nome, tagline e logo da loja', async () => {
    const h = (await naLoja('/sheid-mania')).text;
    expect(h).toContain('<title>Sheid Mania</title>');
    expect(h).toContain('<meta property="og:description" content="Canecas que viram presente">');
    expect(h).toContain('<meta property="og:image" content="https://r2/sheid-logo.png">');
    expect(h).toContain('<meta property="og:url" content="https://www.sheidmania.com.br">');
  });

  test('link da Aurinha (?produto=) tambem leva a foto da peca, com a canonica da peca', async () => {
    const h = (await naLoja(`/sheid-mania?produto=${PECA}&origem=aurinha&conversa=abc`)).text;
    expect(h).toContain('<title>Caneca Alça Coração · Sheid Mania</title>');
    expect(h).toContain(`<meta property="og:url" content="https://www.sheidmania.com.br/p/${PECA}">`);
  });

  test('a casca guardada nao e poluida: a peca de uma requisicao nao vaza na seguinte', async () => {
    await naLoja(`/sheid-mania/p/${PECA}`);
    const home = (await naLoja('/sheid-mania')).text;
    expect(home).not.toContain('Caneca Alça Coração');
    expect(home).toContain('<title>Sheid Mania</title>');
    // Uma busca so da casca: o cache continua valendo.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('loja comum em /p/<id> continua com a pagina gerada aqui (nada muda)', async () => {
    // O builder da loja comum faz varias consultas; basta ver que NAO e a casca.
    const r = await naLoja(`/davi-calcados/p/${PECA}`);
    expect(r.text).not.toContain('__AURA_VITRINE__');
  });
});

describe('as rotas de API do mesmo prefixo nao mudam de dono', () => {
  // Caminhos de API reais, como chegam depois do middleware.
  const API = [
    ['get', '/sheid-mania/catalogo'],
    ['get', '/sheid-mania/shipping-quote'],
    ['get', `/sheid-mania/produto/${PECA}/fotos`],
    ['post', '/sheid-mania/order'],
    ['get', `/sheid-mania/order/${OID}`],
    ['post', `/sheid-mania/order/${OID}/upload-proof`],
    ['post', `/sheid-mania/order/${OID}/mark-as-paid`],
    ['get', '/sheid-mania/studio/products'],
    ['get', '/sheid-mania/studio/shipping-quote'],
    ['post', '/sheid-mania/studio/order'],
    ['get', `/sheid-mania/studio/order/${OID}`],
    ['post', '/sheid-mania/studio/upload'],
    ['post', '/sheid-mania/studio/bulk-quote'],
    ['post', '/sheid-mania/studio/bulk-order'],
    ['get', `/sheid-mania/studio/products/${PECA}/visual-template`],
  ];

  test('nenhuma das rotas novas casa com um caminho de API', () => {
    // Prova estrutural, sem depender do que o handler responde: as camadas
    // declaradas pelas paginas novas nao casam com caminho de API algum.
    const novas = storefront.stack.filter((l) => l.route
      && storefront.PAGINAS_DA_VITRINE_STUDIO.some((p) => p.caminho === l.route.path));
    expect(novas).toHaveLength(storefront.PAGINAS_DA_VITRINE_STUDIO.length);
    for (const [, url] of API) {
      for (const camada of novas) expect([url, camada.match(url)]).toEqual([url, false]);
    }
  });

  test('e as paginas novas nao colidem com rota que ja existia', () => {
    const existentes = storefront.stack.filter((l) => l.route
      && !storefront.PAGINAS_DA_VITRINE_STUDIO.some((p) => p.caminho === l.route.path));
    const exemplos = CAMINHOS_NOVOS.map((s) => '/sheid-mania' + s);
    for (const url of exemplos) {
      for (const camada of existentes) {
        if (camada.route.methods.get) expect([url, camada.route.path, camada.match(url)]).toEqual([url, camada.route.path, false]);
      }
    }
  });

  test.each(API)('%s %s responde JSON, nunca a casca nem um 302', async (metodo, sub) => {
    const r = await request(app)[metodo](sub).set('Host', 'loja.getaura.com.br').send({});
    expect(r.status).not.toBe(302);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.text).not.toContain('__AURA_VITRINE__');
  });

  test('o JSON da loja (GET /storefront/:slug, pelo host da API) continua JSON', async () => {
    const r = await request(app).get('/api/v1/storefront/sheid-mania').set('Host', 'api.getaura.com.br');
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });

  test('a ordem de montagem do index.js e a que este teste reproduz', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'index.js'), 'utf8');
    const a = idx.indexOf("router.use('/storefront', require('./studioStorefrontVisual'))");
    const b = idx.indexOf("router.use('/storefront', require('./studioStorefront'))");
    const c = idx.indexOf("router.use('/storefront', require('./storefront'))");
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});
