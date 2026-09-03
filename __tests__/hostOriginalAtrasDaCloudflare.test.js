// ============================================================
// O dominio do cliente chega por X-Aura-Host, nao pelo Host (02/09/2026)
//
// Descoberto ao montar o dominio proprio do Davi Calcados: o Railway
// roteia pelo Host e responde "Application not found" a qualquer host que
// ele nao conheca. Entao a Cloudflare reescreve o Host para
// loja.getaura.com.br e manda o original em X-Aura-Host.
//
// O que este teste guarda:
//  - com cf-ray, o X-Aura-Host manda (normalizado: minusculas, sem porta);
//  - sem cf-ray, o cabecalho e ignorado — quem bate direto na origem nao
//    escolhe a loja de outro cliente inventando um host;
//  - e o fluxo antigo (loja.getaura.com.br/<slug>) segue intacto.
// ============================================================
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (_sql, params) => ({
    rows: params[0] === 'www.davicalcados2.com.br' ? [{ slug: 'davi-calcados' }] : [],
  })),
}));

const { customDomainMiddleware, hostOriginal } = require('../src/middleware/customDomain');

function requisicao({ hostname = 'loja.getaura.com.br', url = '/', headers = {} } = {}) {
  return { hostname, url, method: 'GET', headers };
}
const resposta = () => ({ setHeader: jest.fn(), sendStatus: jest.fn() });

describe('hostOriginal', () => {
  test('sem cf-ray, X-Aura-Host nao vale nada', () => {
    const req = requisicao({ headers: { 'x-aura-host': 'www.davicalcados2.com.br' } });
    expect(hostOriginal(req)).toBe('loja.getaura.com.br');
  });

  test('com cf-ray, o X-Aura-Host manda — em minusculas e sem porta', () => {
    const req = requisicao({ headers: { 'cf-ray': '8a1b2c3d4e5f-GRU', 'x-aura-host': ' WWW.DaviCalcados2.com.br:443 ' } });
    expect(hostOriginal(req)).toBe('www.davicalcados2.com.br');
  });

  test('com cf-ray mas sem X-Aura-Host, cai no req.hostname', () => {
    const req = requisicao({ headers: { 'cf-ray': 'x', 'x-aura-host': '   ' } });
    expect(hostOriginal(req)).toBe('loja.getaura.com.br');
  });
});

describe('o middleware, de ponta a ponta', () => {
  test('dominio do cliente atras da Cloudflare vira a vitrine dele', async () => {
    const req = requisicao({ url: '/?utm=x', headers: { 'cf-ray': 'x', 'x-aura-host': 'www.davicalcados2.com.br' } });
    const next = jest.fn();
    await customDomainMiddleware(req, resposta(), next);
    expect(req.url).toBe('/api/v1/storefront/davi-calcados/page?utm=x');
    expect(next).toHaveBeenCalled();
  });

  test('o subcaminho do dominio do cliente tambem', async () => {
    const req = requisicao({ url: '/order', headers: { 'cf-ray': 'x', 'x-aura-host': 'www.davicalcados2.com.br' } });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/davi-calcados/order');
  });

  test('a mesma requisicao sem cf-ray e a raiz de loja.getaura.com.br: passa direto', async () => {
    const req = requisicao({ url: '/', headers: { 'x-aura-host': 'www.davicalcados2.com.br' } });
    const next = jest.fn();
    await customDomainMiddleware(req, resposta(), next);
    expect(req.url).toBe('/');
    expect(next).toHaveBeenCalled();
  });

  test('loja.getaura.com.br/<slug> segue como sempre', async () => {
    const req = requisicao({ url: '/finesse/catalogo?pagina=2', headers: { 'cf-ray': 'x' } });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/finesse/catalogo?pagina=2');
  });

  test('a API nunca e reescrita, venha de onde vier', async () => {
    const req = requisicao({ url: '/api/v1/storefront/finesse/catalogo', headers: { 'cf-ray': 'x', 'x-aura-host': 'api.getaura.com.br' } });
    await customDomainMiddleware(req, resposta(), jest.fn());
    expect(req.url).toBe('/api/v1/storefront/finesse/catalogo');
  });
});
