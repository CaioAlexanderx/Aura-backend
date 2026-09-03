// ============================================================
// O endereço da API não pode nomear o provedor (02/09/2026)
//
// O QUE ACONTECEU: o JavaScript da vitrine chama a API por um endereço
// absoluto, escrito na página que o servidor gera. Esse endereço era, por
// padrão, o domínio que o Railway dá à aplicação. Em 02/09 esse domínio
// passou a devolver 503 enquanto a aplicação seguia viva respondendo por
// `loja.getaura.com.br`.
//
// Resultado: TODAS as lojas abriam — o HTML é renderizado no servidor — e
// nada que dependesse da API funcionava. Categoria, paginação, busca,
// filtro e o envio do pedido, todos mudos. A loja parecia no ar e não
// vendia.
//
// O que este teste guarda:
//   1. Nenhum caminho da vitrine escreve o nome do provedor.
//   2. A página e o CSP leem a MESMA fonte — se divergirem, o navegador
//      bloqueia a chamada e o sintoma é idêntico ao de servidor fora.
// ============================================================
const fs = require('fs');
const path = require('path');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('enderecoDaApi', () => {
  const ANTES = process.env.STOREFRONT_API_BASE_URL;
  let enderecoDaApi, avisarSeNaoConfigurado, PADRAO;

  beforeAll(() => {
    ({ enderecoDaApi, avisarSeNaoConfigurado, PADRAO } = require('../src/config/enderecoDaApi'));
  });
  afterEach(() => {
    if (ANTES === undefined) delete process.env.STOREFRONT_API_BASE_URL;
    else process.env.STOREFRONT_API_BASE_URL = ANTES;
  });

  test('o padrão é um domínio NOSSO, não o do provedor', () => {
    delete process.env.STOREFRONT_API_BASE_URL;
    expect(enderecoDaApi()).toBe('https://api.getaura.com.br');
    expect(PADRAO).not.toMatch(/railway|render|fly\.io|vercel|herokuapp/i);
  });

  test('a variável de ambiente manda', () => {
    process.env.STOREFRONT_API_BASE_URL = 'https://api.exemplo.com.br';
    expect(enderecoDaApi()).toBe('https://api.exemplo.com.br');
  });

  test('barra no fim cai — "//api/v1" quebraria o casamento de origem do CSP', () => {
    process.env.STOREFRONT_API_BASE_URL = 'https://api.exemplo.com.br///';
    expect(enderecoDaApi()).toBe('https://api.exemplo.com.br');
  });

  test('variável vazia ou só espaço cai no padrão', () => {
    for (const v of ['', '   ']) {
      process.env.STOREFRONT_API_BASE_URL = v;
      expect(enderecoDaApi()).toBe(PADRAO);
    }
  });

  test('avisa no boot quando ninguém configurou', () => {
    delete process.env.STOREFRONT_API_BASE_URL;
    const ditos = [];
    avisarSeNaoConfigurado((m) => ditos.push(m));
    expect(ditos.join(' ')).toContain('STOREFRONT_API_BASE_URL');
    // O aviso diz a CONSEQUÊNCIA, não só o nome da variável.
    expect(ditos.join(' ')).toContain('abrem e nao vendem');

    process.env.STOREFRONT_API_BASE_URL = 'https://api.exemplo.com.br';
    const calados = [];
    avisarSeNaoConfigurado((m) => calados.push(m));
    expect(calados).toEqual([]);
  });
});

describe('o nome do provedor saiu do caminho da vitrine', () => {
  test.each([
    'src/templates/storefrontPage.js',
    'src/routes/storefront.js',
    'src/routes/studioStorefront.js',
  ])('%s não escreve o domínio do provedor', (rel) => {
    expect(fonte(rel)).not.toMatch(/up\.railway\.app/);
  });

  test('os três leem a mesma fonte', () => {
    for (const rel of ['src/templates/storefrontPage.js', 'src/routes/storefront.js', 'src/routes/studioStorefront.js']) {
      expect(fonte(rel)).toContain("require('../config/enderecoDaApi')");
    }
  });

  test('a página e o CSP concordam', () => {
    // Divergiram: o navegador bloqueia a chamada e o sintoma é igual ao de
    // servidor fora do ar — o erro mais caro de diagnosticar que temos.
    const rota = fonte('src/routes/storefront.js');
    expect(rota).toContain('const STOREFRONT_API_BASE = enderecoDaApi();');
    expect(rota).toContain('"connect-src \'self\' https://cloudflareinsights.com https://viacep.com.br https://brasilapi.com.br " + STOREFRONT_API_BASE');
    expect(fonte('src/templates/storefrontPage.js')).toContain('buildScript(storeData, escJs(slug), enderecoDaApi())');
  });

  test('o boot diz qual endereço está valendo', () => {
    expect(fonte('src/server.js')).toContain("console.log('   API:     ' + enderecoDaApi());");
  });
});
