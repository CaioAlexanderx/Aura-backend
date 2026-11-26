'use strict';

const { urlPublicaDoApp, URL_PADRAO } = require('../src/utils/urlPublicaDoApp');
const { linkDoPosCompra } = require('../src/services/marcaDaLoja');

const ANTES = { pub: process.env.APP_PUBLIC_URL, app: process.env.APP_URL };
afterEach(() => {
  if (ANTES.pub === undefined) delete process.env.APP_PUBLIC_URL; else process.env.APP_PUBLIC_URL = ANTES.pub;
  if (ANTES.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = ANTES.app;
});

describe('urlPublicaDoApp', () => {
  test('APP_PUBLIC_URL tem prioridade e perde a barra final', () => {
    process.env.APP_PUBLIC_URL = 'https://publico.exemplo.com/';
    process.env.APP_URL = 'https://app.exemplo.com';
    expect(urlPublicaDoApp()).toBe('https://publico.exemplo.com');
  });

  test('APP_PUBLIC_URL vazia: usa APP_URL', () => {
    process.env.APP_PUBLIC_URL = '';
    process.env.APP_URL = 'https://app.getaura.com.br';
    expect(urlPublicaDoApp()).toBe('https://app.getaura.com.br');
  });

  test('as duas vazias: dominio padrao', () => {
    process.env.APP_PUBLIC_URL = '  ';
    delete process.env.APP_URL;
    expect(urlPublicaDoApp()).toBe(URL_PADRAO);
    expect(URL_PADRAO).toBe('https://app.getaura.com.br');
  });
});

describe('linkDoPosCompra sem vitrine_v2', () => {
  test('devolve URL absoluta mesmo com APP_PUBLIC_URL vazia', () => {
    process.env.APP_PUBLIC_URL = '';
    delete process.env.APP_URL;
    const config = { slug: 'loja', is_published: true, studio_settings: {} };
    expect(linkDoPosCompra({ config, tipo: 'aprovacao', token: 'abc' }))
      .toBe('https://app.getaura.com.br/aprovacao/abc');
    expect(linkDoPosCompra({ config: null, tipo: 'acompanhar', token: 'abc' }))
      .toBe('https://app.getaura.com.br/acompanhar/abc');
  });
});
