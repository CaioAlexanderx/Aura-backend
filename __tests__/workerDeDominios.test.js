// ============================================================
// O Worker que atende os dominios proprios (03/09/2026)
//
// Ele existe porque o Railway roteia pelo cabecalho Host e o plano Hobby
// so tem 2 vagas de dominio, ja gastas com loja e api. O Worker troca o
// Host para loja.getaura.com.br e guarda o original em X-Aura-Host, que
// e o que src/middleware/customDomain.js le do outro lado.
//
// COMO ESTE TESTE ALCANCA O WORKER
// O Worker e um modulo ESM (formato da Cloudflare) e o Jest deste repo
// roda CommonJS puro, sem babel. Em vez de manter uma copia CommonJS das
// regras — que sairia de sincronia em silencio —, o teste importa o
// ARQUIVO DE VERDADE pelo loader ESM do Node, num processo filho, e le o
// resultado. O que roda aqui e o mesmo byte que esta publicado.
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
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = path.join(RAIZ, 'workers', 'dominios', 'worker.js');

// Uma sonda so: importa o Worker e devolve tudo o que os testes precisam.
const SONDA = [
  "const m = await import(process.env.WORKER_URL);",
  "const nossos = ['getaura.com.br', 'loja.getaura.com.br', 'api.getaura.com.br',",
  "                'admin.getaura.com.br', 'LOJA.GetAura.com.br'];",
  "const alheios = ['www.davicalcados2.com.br', 'finesse.com.br', 'naogetaura.com.br'];",
  "console.log(JSON.stringify({",
  "  ORIGEM: m.ORIGEM,",
  "  CABECALHO: m.CABECALHO,",
  "  temFetchPadrao: typeof m.default.fetch === 'function',",
  "  nossos: nossos.map((h) => m.ehNosso(h)),",
  "  alheios: alheios.map((h) => m.ehNosso(h)),",
  "  vazio: m.ehNosso(''),",
  "  indefinido: m.ehNosso(undefined),",
  "  raiz: m.destino('https://WWW.DaviCalcados2.com.br/'),",
  "  comQuery: m.destino('https://www.davicalcados2.com.br/catalogo?cat=masculino&pagina=2'),",
  "  comPorta: m.destino('http://www.davicalcados2.com.br:8080/order'),",
  "}));",
].join('\n');

let W;
beforeAll(() => {
  const saida = execFileSync(process.execPath, ['--input-type=module', '-e', SONDA], {
    env: { ...process.env, WORKER_URL: pathToFileURL(ARQUIVO).href },
    encoding: 'utf8',
    // O Node avisa que reinterpretou o arquivo como ESM (o repo nao declara
    // "type": "module"). E so ruido; nao suja a saida do CI com ele.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  W = JSON.parse(saida);
});

describe('ehNosso', () => {
  test('o dominio da casa e os subdominios dele', () => {
    // Um subdominio que ainda nem existe ja entra: a regra e o sufixo,
    // nao uma lista que alguem precisa lembrar de editar.
    expect(W.nossos).toEqual([true, true, true, true, true]);
  });

  test('o dominio da lojista nao — nem um que so TERMINA parecido', () => {
    // "naogetaura.com.br" nao e nosso; o ponto no sufixo e o que separa.
    expect(W.alheios).toEqual([false, false, false]);
  });

  test('host vazio nao quebra', () => {
    expect(W.vazio).toBe(false);
    expect(W.indefinido).toBe(false);
  });
});

describe('destino', () => {
  test('troca o host e devolve o original em minusculas', () => {
    expect(W.raiz).toEqual({
      url: 'https://loja.getaura.com.br/',
      hostDaPessoa: 'www.davicalcados2.com.br',
    });
  });

  test('rota e query atravessam intactas', () => {
    expect(W.comQuery.url).toBe('https://loja.getaura.com.br/catalogo?cat=masculino&pagina=2');
  });

  test('sempre https na origem, e sem porta pendurada', () => {
    expect(W.comPorta.url).toBe('https://loja.getaura.com.br/order');
  });
});

describe('os dois lados falam do mesmo cabecalho', () => {
  test('a origem e o host que o Railway conhece', () => {
    expect(W.ORIGEM).toBe('loja.getaura.com.br');
  });

  test('o nome do cabecalho bate com o que customDomain.js le', () => {
    const middleware = fs.readFileSync(
      path.join(RAIZ, 'src', 'middleware', 'customDomain.js'), 'utf8');
    expect(W.CABECALHO.toLowerCase()).toBe('x-aura-host');
    expect(middleware).toContain("req.headers['x-aura-host']");
  });

  test('o Worker expoe um fetch, como a Cloudflare espera', () => {
    expect(W.temFetchPadrao).toBe(true);
  });
});

describe('o arquivo publicado', () => {
  test('e um modulo unico, sem import de vizinho', () => {
    // O editor do painel da Cloudflare aceita um modulo so. Um import
    // relativo aqui quebraria o deploy pelo painel em silencio.
    const fonte = fs.readFileSync(ARQUIVO, 'utf8');
    expect(fonte).not.toMatch(/^import .* from '\.\//m);
    expect(fonte).toContain('headers.set(CABECALHO, hostDaPessoa)');
    // append duplicaria um cabecalho vindo de fora; set descarta.
    expect(fonte).not.toContain('headers.append');
  });

  test('o wrangler aponta para ele', () => {
    const toml = fs.readFileSync(
      path.join(RAIZ, 'workers', 'dominios', 'wrangler.toml'), 'utf8');
    expect(toml).toContain('main = "worker.js"');
    expect(toml).toContain('name = "aura-dominios"');
    // Rotas moram no painel: um deploy com rota errada derrubaria o painel
    // da Aura, que vive na mesma zona.
    expect(toml).not.toContain('routes');
  });
});
