// ============================================================
// A borda reescreve o caminho antes do middleware (08/09/2026)
//
// Ao publicar a URL propria da peca, `loja.getaura.com.br/finesse/p/<id>`
// deu 404 pela Cloudflare e 200 na origem. A regra da zona monta
// "/api/v1/storefront" + caminho + "/page" para qualquer caminho; so
// `/<slug>` sobrevive. O middleware desfaz isso e segue o fluxo normal.
// ============================================================
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (_sql, params) => ({
    rows: params && params[0] === 'www.davicalcados2.com.br' ? [{ slug: 'davi-calcados' }] : [],
  })),
}));

const { customDomainMiddleware, desfazerReescritaDaBorda } = require('../src/middleware/customDomain');

function requisicao({ hostname = 'loja.getaura.com.br', url = '/', headers = {} } = {}) {
  return { hostname, url, method: 'GET', headers };
}
const resposta = () => ({ setHeader: jest.fn(), sendStatus: jest.fn() });
const CF = { 'cf-ray': '8a1b2c3d4e5f-GRU' };

describe('desfazerReescritaDaBorda', () => {
  test('a forma da regra: prefixo + caminho + /page', () => {
    expect(desfazerReescritaDaBorda('/api/v1/storefront/finesse/p/abc/page')).toBe('/finesse/p/abc');
    expect(desfazerReescritaDaBorda('/api/v1/storefront/finesse/catalogo/page?limit=1')).toBe('/finesse/catalogo?limit=1');
    expect(desfazerReescritaDaBorda('/api/v1/storefront/finesse/page')).toBe('/finesse');
    // Raiz do dominio proprio: caminho vazio entre o prefixo e o sufixo.
    expect(desfazerReescritaDaBorda('/api/v1/storefront//page')).toBe('/');
  });

  test('a variante que so anexa /page', () => {
    expect(desfazerReescritaDaBorda('/finesse/p/abc/page')).toBe('/finesse/p/abc');
    expect(desfazerReescritaDaBorda('/finesse/p/abc/page?x=1')).toBe('/finesse/p/abc?x=1');
    // Um segmento so antes do sufixo E a pagina — fica.
    expect(desfazerReescritaDaBorda('/finesse/page')).toBe('/finesse/page');
  });

  test('o que nao tem a marca da regra passa intacto', () => {
    expect(desfazerReescritaDaBorda('/finesse')).toBe('/finesse');
    expect(desfazerReescritaDaBorda('/finesse/p/abc')).toBe('/finesse/p/abc');
    expect(desfazerReescritaDaBorda('/api/v1/storefront/finesse/catalogo')).toBe('/api/v1/storefront/finesse/catalogo');
  });
});

describe('o middleware, com a borda no meio', () => {
  test('a peca pela loja.getaura.com.br chega na rota certa', async () => {
    const req = requisicao({ url: '/api/v1/storefront/finesse/p/abc/page', headers: CF });
    const next = jest.fn();
    await customDomainMiddleware(req, resposta(), next);
    expect(req.url).toBe('/api/v1/storefront/finesse/p/abc');
    expect(next).toHaveBeenCalled();
  });

  test('a pagina da loja continua a mesma (idempotente)', async () => {
    const req = requisicao({ url: '/api/v1/storefront/finesse/page', headers: CF });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/finesse/page');
  });

  test('o catalogo com query', async () => {
    const req = requisicao({ url: '/api/v1/storefront/finesse/catalogo/page?limit=1', headers: CF });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/finesse/catalogo?limit=1');
  });

  test('dominio do cliente atras do Worker: a peca e a raiz', async () => {
    const h = { ...CF, 'x-aura-host': 'www.davicalcados2.com.br' };
    const peca = requisicao({ url: '/api/v1/storefront/p/abc/page', headers: h });
    await customDomainMiddleware(peca, resposta(), jest.fn());
    expect(peca.url).toBe('/api/v1/storefront/davi-calcados/p/abc');
    const raiz = requisicao({ url: '/api/v1/storefront//page', headers: h });
    await customDomainMiddleware(raiz, resposta(), jest.fn());
    expect(raiz.url).toBe('/api/v1/storefront/davi-calcados/page');
  });

  test('a API de verdade (api.getaura.com.br) nao e tocada', async () => {
    const req = requisicao({ hostname: 'api.getaura.com.br', url: '/api/v1/storefront/finesse/p/abc/page', headers: CF });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/finesse/p/abc/page');
  });

  test('sem cf-ray, nada de desfazer', async () => {
    const req = requisicao({ url: '/api/v1/storefront/finesse/p/abc/page' });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/finesse/p/abc/page');
  });
});
