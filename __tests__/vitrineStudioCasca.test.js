// ============================================================
// A casca da vitrine Studio nao pode apontar para um bundle que sumiu
// (incidente de 28/09/2026)
//
// Depois de todo deploy do app, a casca guardada aqui continuava
// apontando para o `entry-<hash>.js` antigo. A Cloudflare apaga o arquivo
// e responde 200 com a pagina de fallback (text/html) no lugar; o
// navegador nao roda aquilo e a loja abre em branco por ate 10 minutos.
// A Sheid Mania ficou fora do ar assim. Estes testes guardam as tres
// camadas: conferir o entry antes de confiar no cache, cache curto com
// stale-while-revalidate e a autocura no navegador com `?_casca=`.
// ============================================================
const vm = require('vm');

const shell = require('../src/services/vitrineStudioShell');
const {
  buscarCasca, montarVitrineStudio, entryDaCasca, scriptDeAutocura, limparCache,
  _esperarAtualizacao, VALIDADE_MS, VALIDACAO_MS, INTERVALO_FORCADA_MS, HOST_DO_APP,
  cspDaVitrineStudio,
} = shell;

const casca = (hash) => '<!DOCTYPE html><html><head><title>Aura.</title></head>'
  + '<body><div id="root"></div>'
  + `<script src="/_expo/static/js/web/entry-${hash}.js" defer></script></body></html>`;

/**
 * Um app de mentira: `/` devolve a casca do deploy atual; o entry do
 * deploy atual e JavaScript; qualquer outro entry e o fallback da
 * Cloudflare — 200, text/html, como em producao.
 */
function appFalso() {
  const app = { hash: 'aaa111', fora: false, chamadas: [] };
  app.deploy = (hash) => { app.hash = hash; };
  global.fetch = jest.fn(async (url, opts = {}) => {
    const metodo = opts.method || 'GET';
    app.chamadas.push(`${metodo} ${url}`);
    if (app.fora) throw new Error('fetch failed');
    const caminho = String(url).slice(HOST_DO_APP.length);
    const headers = (tipo) => ({ get: (k) => (k.toLowerCase() === 'content-type' ? tipo : null) });
    if (caminho === '/') {
      return { ok: true, status: 200, headers: headers('text/html'), text: async () => casca(app.hash) };
    }
    if (caminho === `/_expo/static/js/web/entry-${app.hash}.js`) {
      return { ok: true, status: 200, headers: headers('text/javascript') };
    }
    return { ok: true, status: 200, headers: headers('text/html'), text: async () => '<html>fallback</html>' };
  });
  app.buscasDaCasca = () => app.chamadas.filter((c) => c === `GET ${HOST_DO_APP}/`).length;
  app.heads = () => app.chamadas.filter((c) => c.startsWith('HEAD ')).length;
  return app;
}

let agora;
let avisos;
beforeEach(() => {
  limparCache();
  agora = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => agora);
  avisos = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe('o entry da casca', () => {
  test('acha o caminho do bundle principal', () => {
    expect(entryDaCasca(casca('abc'))).toBe('/_expo/static/js/web/entry-abc.js');
  });
  test('casca sem entry nao inventa um', () => {
    expect(entryDaCasca('<html></html>')).toBeNull();
  });
});

describe('camada 1: conferir o entry antes de confiar no cache', () => {
  test('o caso do incidente: deploy novo, HEAD no entry antigo devolve text/html, a casca e buscada de novo', async () => {
    const app = appFalso();
    expect(await buscarCasca()).toContain('entry-aaa111.js');

    app.deploy('bbb222');
    agora += VALIDACAO_MS; // a conferencia anterior venceu
    const html = await buscarCasca();

    expect(html).toContain('entry-bbb222.js');
    expect(html).not.toContain('entry-aaa111.js');
    expect(app.buscasDaCasca()).toBe(2);
    expect(avisos).toHaveBeenCalledWith(expect.stringContaining('sumiu do app'), expect.stringContaining('aaa111'));
  });

  test('a conferencia vale 30 s: nada de um HEAD por requisicao de cliente', async () => {
    const app = appFalso();
    await buscarCasca();
    const headsDepoisDaPrimeira = app.heads();
    for (let i = 0; i < 20; i++) { agora += 1000; await buscarCasca(); }
    expect(app.heads()).toBe(headsDepoisDaPrimeira);
    agora += VALIDACAO_MS;
    await buscarCasca();
    expect(app.heads()).toBe(headsDepoisDaPrimeira + 1);
  });

  test('a casca nova tambem e conferida antes de ser guardada', async () => {
    const app = appFalso();
    await buscarCasca();
    expect(app.chamadas).toContain(`HEAD ${HOST_DO_APP}/_expo/static/js/web/entry-aaa111.js`);
  });

  test('entry sumiu e o app nao responde: serve a casca antiga (melhor que nada) e registra', async () => {
    const app = appFalso();
    await buscarCasca();
    app.deploy('bbb222');
    agora += VALIDACAO_MS;
    // O HEAD responde, a busca da casca nova nao.
    const original = global.fetch;
    global.fetch = jest.fn(async (url, opts = {}) => {
      if ((opts.method || 'GET') === 'GET' && String(url) === HOST_DO_APP + '/') throw new Error('app caiu');
      return original(url, opts);
    });
    const html = await buscarCasca();
    expect(html).toContain('entry-aaa111.js');
    expect(avisos).toHaveBeenCalledWith(expect.stringContaining('servindo a guardada'), 'app caiu');
  });

  test('nao conseguir perguntar (rede) nao derruba a casca guardada', async () => {
    const app = appFalso();
    await buscarCasca();
    app.fora = true;
    agora += VALIDACAO_MS;
    expect(await buscarCasca()).toContain('entry-aaa111.js');
  });

  test('sem casca guardada e com o app fora, a vitrine devolve null (a loja comum atende)', async () => {
    const app = appFalso();
    app.fora = true;
    expect(await montarVitrineStudio('sheid-mania')).toBeNull();
  });
});

describe('camada 2: cache de 60 s com stale-while-revalidate', () => {
  test('a validade caiu de 10 min para 60 s', () => {
    expect(VALIDADE_MS).toBe(60 * 1000);
    expect(VALIDACAO_MS).toBe(30 * 1000);
  });

  test('passou de 60 s: quem pede recebe a guardada na hora e a nova chega em segundo plano', async () => {
    const app = appFalso();
    await buscarCasca();
    // Deploy novo em que o entry antigo AINDA existe (o HEAD passa): so o
    // stale-while-revalidate traz a casca nova.
    global.fetch.mockImplementation(async (url, opts = {}) => {
      const caminho = String(url).slice(HOST_DO_APP.length);
      const headers = (tipo) => ({ get: () => tipo });
      if (caminho === '/') return { ok: true, status: 200, headers: headers('text/html'), text: async () => casca('ccc333') };
      return { ok: true, status: 200, headers: headers('application/javascript') };
    });
    agora += VALIDADE_MS;
    expect(await buscarCasca()).toContain('entry-aaa111.js');
    await _esperarAtualizacao();
    expect(await buscarCasca()).toContain('entry-ccc333.js');
  });

  test('antes de 60 s nao busca a casca de novo', async () => {
    const app = appFalso();
    await buscarCasca();
    agora += VALIDADE_MS - 1;
    await buscarCasca();
    await _esperarAtualizacao();
    expect(app.buscasDaCasca()).toBe(1);
  });
});

describe('camada 3: `?_casca=` forca a busca, com limite de 10 s', () => {
  test('forcar ignora o cache e traz a casca do deploy novo na hora', async () => {
    const app = appFalso();
    await buscarCasca();
    app.deploy('bbb222');
    agora += 1000; // conferencia ainda valida: sem o forcar, sairia a velha
    expect(await buscarCasca()).toContain('entry-aaa111.js');
    expect(await buscarCasca({ forcar: true })).toContain('entry-bbb222.js');
  });

  test('duas forcadas dentro de 10 s: a segunda segue o caminho normal', async () => {
    const app = appFalso();
    await buscarCasca({ forcar: true });
    expect(app.buscasDaCasca()).toBe(1);
    agora += INTERVALO_FORCADA_MS - 1;
    await buscarCasca({ forcar: true });
    await buscarCasca({ forcar: true });
    expect(app.buscasDaCasca()).toBe(1);
    agora += 1;
    await buscarCasca({ forcar: true });
    expect(app.buscasDaCasca()).toBe(2);
  });

  test('o limite e global, nao por loja', async () => {
    const app = appFalso();
    await montarVitrineStudio('loja-a', '', { forcarCasca: true });
    await montarVitrineStudio('loja-b', '', { forcarCasca: true });
    expect(app.buscasDaCasca()).toBe(1);
  });

  test('a rota passa o `_casca` da URL para a vitrine', () => {
    const rota = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'storefront.js'), 'utf8');
    expect(rota).toContain("typeof req.query._casca === 'string'");
    expect(rota).toContain('montarVitrineStudio(slug, cabecalho, { forcarCasca })');
  });
});

describe('a casca servida leva o script de autocura', () => {
  test('antes do entry, e com o recado da loja', async () => {
    appFalso();
    const pagina = await montarVitrineStudio('sheid-mania');
    const autocura = pagina.indexOf('aura_casca_recarregada');
    expect(autocura).toBeGreaterThan(-1);
    expect(autocura).toBeLessThan(pagina.indexOf('entry-aaa111.js'));
    expect(pagina).toContain('"sheid-mania"');
  });

  test('cabe na CSP atual: script inline, sem eval, e a CSP nao afrouxou', () => {
    const s = scriptDeAutocura();
    expect(s).toMatch(/^<script>[\s\S]*<\/script>$/);
    expect(s).not.toMatch(/\beval\(|new Function|setTimeout\(['"]/);
    const csp = cspDaVitrineStudio('https://api.getaura.com.br');
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });
});

// ── O script no "navegador" ─────────────────────────────────────────
// Roda o script de verdade com window, location e sessionStorage de
// mentira, e dispara os eventos que o navegador dispararia.
function navegador(url, { sessao = {}, semSessao = false } = {}) {
  const ouvintes = {};
  const armazenado = { ...sessao };
  const nav = { recarregouPara: null, barra: url, armazenado };
  const location = {
    get href() { return nav.barra; },
    replace: (u) => { nav.recarregouPara = u; },
  };
  const sessionStorage = semSessao
    ? { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); }, removeItem() {} }
    : {
      getItem: (k) => (k in armazenado ? armazenado[k] : null),
      setItem: (k, v) => { armazenado[k] = String(v); },
      removeItem: (k) => { delete armazenado[k]; },
    };
  const window = {
    addEventListener: (tipo, fn) => { (ouvintes[tipo] = ouvintes[tipo] || []).push(fn); },
  };
  const ctx = {
    window, location, sessionStorage, URL,
    history: { state: null, replaceState: (_s, _t, u) => { nav.barra = new URL(u, nav.barra).href; } },
  };
  window.window = window;
  const codigo = scriptDeAutocura().replace(/^<script>/, '').replace(/<\/script>$/, '');
  vm.runInNewContext(codigo, ctx);
  nav.disparar = (tipo, ev = {}) => (ouvintes[tipo] || []).forEach((fn) => fn(ev));
  nav.bundleSubiu = () => { window.__r = function () {}; };
  return nav;
}

const ENTRY = `${HOST_DO_APP}/_expo/static/js/web/entry-aaa111.js`;

describe('a autocura no navegador', () => {
  test('o <script> do entry falhou (nosniff barrou o HTML): recarrega com ?_casca=', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania/p/42?produto=9');
    nav.disparar('error', { target: { tagName: 'SCRIPT', src: ENTRY } });
    const destino = new URL(nav.recarregouPara);
    expect(destino.pathname).toBe('/sheid-mania/p/42');
    expect(destino.searchParams.get('produto')).toBe('9');
    expect(destino.searchParams.get('_casca')).toMatch(/^\d+$/);
  });

  test('erro global com filename do entry, antes do bundle subir: recarrega', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania');
    nav.disparar('error', { filename: ENTRY, message: "Unexpected token '<'" });
    expect(nav.recarregouPara).toContain('_casca=');
  });

  test('o bundle nao rodou (erro cross-origin chega sem filename): o load pega', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania');
    nav.disparar('error', { message: 'Script error.', filename: '' });
    expect(nav.recarregouPara).toBeNull();
    nav.disparar('load');
    expect(nav.recarregouPara).toContain('_casca=');
  });

  test('recarrega UMA vez: se falhar de novo, nao entra em laco', () => {
    const primeira = navegador('https://loja.getaura.com.br/sheid-mania');
    primeira.disparar('load');
    expect(primeira.recarregouPara).not.toBeNull();
    const segunda = navegador(primeira.recarregouPara, { sessao: primeira.armazenado });
    segunda.disparar('load');
    expect(segunda.recarregouPara).toBeNull();
  });

  test('carregou bem: nao recarrega e libera a proxima autocura', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania', { sessao: { aura_casca_recarregada: '1' } });
    nav.bundleSubiu();
    nav.disparar('load');
    expect(nav.recarregouPara).toBeNull();
    expect(nav.armazenado.aura_casca_recarregada).toBeUndefined();
  });

  test('erro de outro script, ou erro do app depois de subir, nao recarrega', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania');
    nav.disparar('error', { target: { tagName: 'SCRIPT', src: 'https://www.googletagmanager.com/gtag/js' } });
    nav.bundleSubiu();
    nav.disparar('error', { filename: ENTRY, message: 'TypeError' });
    nav.disparar('load');
    expect(nav.recarregouPara).toBeNull();
  });

  test('sem sessionStorage nao recarrega (sem trava, poderia entrar em laco)', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania', { semSessao: true });
    nav.disparar('load');
    expect(nav.recarregouPara).toBeNull();
  });

  test('o _casca sai da barra antes do app ler a URL', () => {
    const nav = navegador('https://loja.getaura.com.br/sheid-mania?produto=9&_casca=123#x');
    expect(nav.barra).toBe('https://loja.getaura.com.br/sheid-mania?produto=9#x');
  });
});
