// ============================================================
// A API fora da busca (06/10/2026)
//
// O Search Console mostrava api.getaura.com.br/ rastreado. Toda resposta
// do host da API sai com X-Robots-Tag e /robots.txt pede Disallow: /.
// A vitrine do lojista (loja.getaura.com.br e dominio proprio), servida
// pelo MESMO processo, continua indexavel. E a vitrine Studio nao herda a
// meta robots que a casca do painel passou a trazer.
//
// No app DE VERDADE (src/app.js), como em uploadDoStudioTeto.test.js.
// ============================================================
'use strict';

const request = require('supertest');
const db = require('../src/config/database');
const { hostForaDaBusca } = require('../src/middleware/foraDaBusca');
const shell = require('../src/services/vitrineStudioShell');

let app;
beforeAll(() => {
  app = require('../src/app');
});

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] }); // loja inexistente
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('host da API', () => {
  test('GET /robots.txt: 200, text/plain, Disallow: /', async () => {
    const r = await request(app).get('/robots.txt').set('Host', 'api.getaura.com.br');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.text).toBe('User-agent: *\nDisallow: /\n');
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('a raiz da API sai com X-Robots-Tag', async () => {
    const r = await request(app).get('/').set('Host', 'api.getaura.com.br');
    expect(r.status).toBe(200);
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('rota da API (e o 404 dela) tambem', async () => {
    const health = await request(app).get('/health').set('Host', 'api.getaura.com.br');
    expect(health.headers['x-robots-tag']).toBe('noindex, nofollow');
    const nada = await request(app).get('/api/v1/nao-existe').set('Host', 'api.getaura.com.br');
    expect(nada.status).toBe(404);
    expect(nada.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  test('o dominio cru do Railway tambem', async () => {
    const r = await request(app).get('/').set('Host', 'aura-backend-production.up.railway.app');
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
});

describe('vitrine do lojista continua indexavel', () => {
  test('loja.getaura.com.br/<slug>: sem X-Robots-Tag', async () => {
    const r = await request(app).get('/loja-qualquer').set('Host', 'loja.getaura.com.br');
    expect(r.status).toBe(404); // loja inexistente no banco mockado
    expect(r.headers['x-robots-tag']).toBeUndefined();
  });

  test('loja.getaura.com.br/robots.txt nao recebe o Disallow da API', async () => {
    const r = await request(app).get('/robots.txt').set('Host', 'loja.getaura.com.br');
    expect(r.text).not.toBe('User-agent: *\nDisallow: /\n');
    expect(r.headers['x-robots-tag']).toBeUndefined();
  });

  test('dominio proprio do lojista: sem X-Robots-Tag', async () => {
    const r = await request(app).get('/').set('Host', 'www.loja-do-cliente.com.br');
    expect(r.headers['x-robots-tag']).toBeUndefined();
  });

  test('dominio proprio atras da Cloudflare (X-Aura-Host): sem X-Robots-Tag', async () => {
    const r = await request(app).get('/')
      .set('Host', 'loja.getaura.com.br')
      .set('cf-ray', 'teste')
      .set('X-Aura-Host', 'www.loja-do-cliente.com.br');
    expect(r.headers['x-robots-tag']).toBeUndefined();
  });

  test('a regra por host', () => {
    expect(hostForaDaBusca('api.getaura.com.br')).toBe(true);
    expect(hostForaDaBusca('x.up.railway.app')).toBe(true);
    expect(hostForaDaBusca('localhost')).toBe(true);
    expect(hostForaDaBusca('loja.getaura.com.br')).toBe(false);
    expect(hostForaDaBusca('www.loja-do-cliente.com.br')).toBe(false);
    expect(hostForaDaBusca('getaura.com.br.golpe.com')).toBe(false);
    expect(hostForaDaBusca('')).toBe(false);
  });
});

describe('vitrine Studio nao herda o noindex do painel', () => {
  const cascaDoApp = '<!DOCTYPE html><html><head>'
    + '<meta name="robots" content="noindex, nofollow" />\n'
    + '<title>Aura.</title></head><body><div id="root"></div>'
    + '<script src="/_expo/static/js/web/entry-abc.js" defer></script></body></html>';

  beforeEach(() => {
    shell.limparCache();
    global.fetch = jest.fn(async (url) => {
      const js = String(url).endsWith('.js');
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (js ? 'text/javascript' : 'text/html') : null) },
        text: async () => cascaDoApp,
      };
    });
  });
  afterEach(() => { delete global.fetch; shell.limparCache(); });

  test('sem cabecalho (metatags da loja falharam): a meta do app sai', async () => {
    const pagina = await shell.montarVitrineStudio('loja', '');
    expect(pagina).toContain('<div id="root">');
    expect(pagina).not.toMatch(/name="robots"/);
  });

  test('com cabecalho indexavel: nenhuma meta robots', async () => {
    const pagina = await shell.montarVitrineStudio('loja', '<title>Loja</title>');
    expect(pagina).not.toMatch(/name="robots"/);
  });

  test('pagina que a loja nao quer indexada (sacola): so o noindex dela', async () => {
    const cab = shell.metatagsDaVitrineStudio({ loja: { nome: 'Loja' }, peca: null, urlDaLoja: '', indexar: false });
    const pagina = await shell.montarVitrineStudio('loja', cab);
    const metas = pagina.match(/<meta name="robots"[^>]*>/g) || [];
    expect(metas).toEqual(['<meta name="robots" content="noindex">']);
  });
});
