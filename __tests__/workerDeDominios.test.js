// ============================================================
// O Worker que atende os dominios proprios (03/09/2026)
//
// Ele existe porque o Railway roteia pelo cabecalho Host e o plano Hobby
// so tem 2 vagas de dominio, ja gastas com loja e api. O Worker troca o
// Host para loja.getaura.com.br e guarda o original em X-Aura-Host, que
// e o que src/middleware/customDomain.js le do outro lado.
//
// O que este teste guarda:
//  - o host nosso NUNCA e reescrito (senao loja.getaura.com.br chama a si
//    mesma e a loja inteira entra em loop);
//  - rota, query e https sobrevivem a troca;
//  - o dominio da lojista chega minusculo, do jeito que o middleware espera;
//  - e os dois lados continuam falando do MESMO cabecalho.
// ============================================================
const fs = require('fs');
const path = require('path');
const { ORIGEM, CABECALHO, ehNosso, destino } = require('../workers/dominios/src/regras');

describe('ehNosso', () => {
  test('o dominio da casa e os subdominios dele', () => {
    expect(ehNosso('getaura.com.br')).toBe(true);
    expect(ehNosso('loja.getaura.com.br')).toBe(true);
    expect(ehNosso('api.getaura.com.br')).toBe(true);
    // Um subdominio que ainda nem existe ja entra: a regra e o sufixo,
    // nao uma lista que alguem precisa lembrar de editar.
    expect(ehNosso('admin.getaura.com.br')).toBe(true);
    expect(ehNosso('LOJA.GetAura.com.br')).toBe(true);
  });

  test('o dominio da lojista, nao', () => {
    expect(ehNosso('www.davicalcados2.com.br')).toBe(false);
    expect(ehNosso('finesse.com.br')).toBe(false);
  });

  test('um dominio que so TERMINA parecido tambem nao', () => {
    // "naogetaura.com.br" nao e nosso; o ponto no sufixo e o que separa.
    expect(ehNosso('naogetaura.com.br')).toBe(false);
  });

  test('host vazio nao quebra', () => {
    expect(ehNosso('')).toBe(false);
    expect(ehNosso(undefined)).toBe(false);
  });
});

describe('destino', () => {
  test('troca o host e devolve o original em minusculas', () => {
    const r = destino('https://WWW.DaviCalcados2.com.br/');
    expect(r.url).toBe('https://loja.getaura.com.br/');
    expect(r.hostDaPessoa).toBe('www.davicalcados2.com.br');
  });

  test('rota e query atravessam intactas', () => {
    const r = destino('https://www.davicalcados2.com.br/catalogo?cat=masculino&pagina=2');
    expect(r.url).toBe('https://loja.getaura.com.br/catalogo?cat=masculino&pagina=2');
  });

  test('sempre https na origem, e sem porta pendurada', () => {
    const r = destino('http://www.davicalcados2.com.br:8080/order');
    expect(r.url).toBe('https://loja.getaura.com.br/order');
  });
});

describe('os dois lados falam do mesmo cabecalho', () => {
  const raiz = path.join(__dirname, '..');

  test('a origem e o host que o Railway conhece', () => {
    expect(ORIGEM).toBe('loja.getaura.com.br');
  });

  test('o nome do cabecalho bate com o que customDomain.js le', () => {
    const middleware = fs.readFileSync(
      path.join(raiz, 'src', 'middleware', 'customDomain.js'), 'utf8');
    expect(CABECALHO.toLowerCase()).toBe('x-aura-host');
    expect(middleware).toContain("req.headers['x-aura-host']");
  });

  test('a casca do Worker usa as regras, sem decidir por conta propria', () => {
    const entry = fs.readFileSync(
      path.join(raiz, 'workers', 'dominios', 'src', 'index.mjs'), 'utf8');
    expect(entry).toContain("import regras from './regras.js'");
    expect(entry).toContain('ehNosso(entrada.hostname)');
    expect(entry).toContain('headers.set(CABECALHO, hostDaPessoa)');
    // append duplicaria um cabecalho vindo de fora; set descarta.
    expect(entry).not.toContain('headers.append');
  });

  test('o wrangler aponta para a casca certa', () => {
    const toml = fs.readFileSync(
      path.join(raiz, 'workers', 'dominios', 'wrangler.toml'), 'utf8');
    expect(toml).toContain('main = "src/index.mjs"');
    expect(toml).toContain('name = "aura-dominios"');
    // Rotas moram no painel: um deploy com rota errada derrubaria o painel
    // da Aura, que vive na mesma zona.
    expect(toml).not.toContain('routes');
  });
});
