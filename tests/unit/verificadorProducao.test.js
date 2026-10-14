'use strict';
// t1-04: verificador de produção (.github/scripts/verificador-producao.js).
const fs = require('fs');
const path = require('path');
const v = require('../../.github/scripts/verificador-producao');

const MAIN = 'bcba99671e0c2de73a22fff899d48f0517b535ff';
const agora = new Date('2026-10-14T12:00:00Z');
const haMin = (m) => new Date(agora.getTime() - m * 60000).toISOString();

describe('avaliarAlvo', () => {
  it('em dia quando o sha curto do /health é prefixo de main', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: 'bcba9967', mainSha: MAIN, mainData: haMin(60) }, agora);
    expect(r).toMatchObject({ estado: 'em_dia', falha: false });
  });

  it('em dia com sha completo (version.json do app)', () => {
    const r = v.avaliarAlvo({ nome: 'app', noAr: MAIN, mainSha: MAIN, mainData: haMin(5) }, agora);
    expect(r.estado).toBe('em_dia');
  });

  it('limite padrão é 30 min', () => {
    expect(v.LIMITE_MIN_PADRAO).toBe(30);
  });

  it('atrasado (não falha) até 30 min do último commit de main', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(30) }, agora);
    expect(r).toMatchObject({ estado: 'atrasado', falha: false, minutos: 30 });
  });

  it('defasado (falha) passados 30 min do último commit de main', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(31) }, agora);
    expect(r).toMatchObject({ estado: 'defasado', falha: true, minutos: 31 });
    expect(r.resumo).toContain('3bbe1bbd');
    expect(r.resumo).toContain('bcba9967');
  });

  it('rajada de merges: conta do último commit, não do mais antigo que falta', () => {
    // O primeiro merge da rajada foi há 50 min, mas main mudou há 5: ainda subindo.
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(5), pendentes: ['src/a.js'] }, agora);
    expect(r).toMatchObject({ estado: 'atrasado', falha: false, minutos: 5 });
  });

  it('respeita o limite configurado', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(35) }, agora, 40);
    expect(r.estado).toBe('atrasado');
  });

  it('só documentação pendente (docs/** ou *.md): em dia, sem deploy esperado', () => {
    const r = v.avaliarAlvo({ nome: 'app', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(120), pendentes: ['docs/deploy.md', 'README.md', 'docs/mockups/x.html'] }, agora);
    expect(r).toMatchObject({ estado: 'so_docs', falha: false });
    expect(r.resumo).toMatch(/só mudou documentação/);
  });

  it('documentação junto com código ainda conta como atraso', () => {
    const r = v.avaliarAlvo({ nome: 'app', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(120), pendentes: ['docs/deploy.md', 'app/index.tsx'] }, agora);
    expect(r.estado).toBe('defasado');
  });

  it('sha "main" do version.json (deploy hook) é sem_sha e não falha', () => {
    const r = v.avaliarAlvo({ nome: 'app', noAr: 'main', mainSha: MAIN, mainData: haMin(60), builtAt: haMin(50) }, agora);
    expect(r).toMatchObject({ estado: 'sem_sha', falha: false });
    expect(r.resumo).toMatch(/posterior/);
  });

  it('sem_sha com build anterior ao último commit anota, mas não falha', () => {
    const r = v.avaliarAlvo({ nome: 'app', noAr: 'main', mainSha: MAIN, mainData: haMin(60), builtAt: haMin(90) }, agora);
    expect(r).toMatchObject({ estado: 'sem_sha', falha: false });
    expect(r.resumo).toMatch(/ANTERIOR/);
  });

  it('/health com "1.0.0" (deploy sem commit) é sem_sha', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '1.0.0', mainSha: MAIN, mainData: haMin(60) }, agora);
    expect(r).toMatchObject({ estado: 'sem_sha', falha: false });
  });

  it('erro de leitura é inacessível e falha', () => {
    const r = v.avaliarAlvo({ nome: 'backend', erro: 'sem resposta em 10 s', mainSha: MAIN, mainData: haMin(1) }, agora);
    expect(r).toMatchObject({ estado: 'indisponivel', falha: true });
    expect(r.resumo).toMatch(/inacessível/);
  });
});

describe('soDocumentacao / pendenteSoDocs', () => {
  it.each([
    ['docs/deploy.md', true], ['docs/mockups/a.html', true], ['README.md', true], ['CLAUDE.MD', true],
    ['src/app.js', false], ['documentos/x.js', false], ['.github/workflows/ci.yml', false],
  ])('%s → %s', (arq, esperado) => expect(v.soDocumentacao(arq)).toBe(esperado));

  it('lista vazia ou desconhecida não é "só docs"', () => {
    expect(v.pendenteSoDocs([])).toBe(false);
    expect(v.pendenteSoDocs(null)).toBe(false);
  });
});

describe('decidirIssue', () => {
  const ok = { falha: false };
  const ruim = { falha: true };
  it.each([
    [[ok, ok], null, 'nada'],
    [[ok, ruim], null, 'abrir'],
    [[ruim], { number: 1 }, 'atualizar'],
    [[ok, ok], { number: 1 }, 'fechar'],
  ])('%#', (res, issue, esperado) => expect(v.decidirIssue(res, issue)).toBe(esperado));
});

describe('corpoIssue / falhasRegistradas', () => {
  it('guarda quais alvos falham numa marca escondida', () => {
    const corpo = v.corpoIssue([
      { nome: 'app', falha: true, resumo: 'app: DEFASADO' },
      { nome: 'backend', falha: false, resumo: 'backend: em dia' },
    ], agora, 'https://x/run/1');
    expect(corpo).toContain(v.MARCA_ISSUE);
    expect(v.falhasRegistradas(corpo)).toBe('app');
    expect(corpo).toContain('Retry build');
    expect(v.falhasRegistradas('sem marca')).toBeNull();
  });
});

// ── executar(): rede simulada ──────────────────────────────────────────────
function resposta(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

function montarFetch({ health, version, issues = [], mainBackend = MAIN, mainApp = MAIN, compare = null, mainData = haMin(40), quebrar = null }) {
  const chamadas = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const metodo = opts.method || 'GET';
    chamadas.push({ metodo, url, signal: opts.signal, body: opts.body ? JSON.parse(opts.body) : null });
    if (quebrar && quebrar(url, metodo)) {
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    }
    if (url.endsWith('/health')) return resposta(health);
    if (url.endsWith('/version.json')) return resposta(version);
    if (url.includes('/repos/CaioAlexanderx/Aura-backend/commits/main')) return resposta({ sha: mainBackend, commit: { committer: { date: mainData } } });
    if (url.includes('/repos/CaioAlexanderx/aura-app/commits/main')) return resposta({ sha: mainApp, commit: { committer: { date: mainData } } });
    if (url.includes('/compare/')) return compare ? resposta(compare) : resposta({}, 404);
    if (url.includes('/issues?state=open')) return resposta(issues);
    if (metodo === 'POST' && url.endsWith('/issues')) return resposta({ number: 42 }, 201);
    if (metodo === 'PATCH' || (metodo === 'POST' && url.endsWith('/comments'))) return resposta({}, 200);
    return resposta({}, 404);
  });
  return { fetchFn, chamadas };
}

const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'CaioAlexanderx/Aura-backend' };
const logMudo = { log: () => {}, error: () => {} };
const rodar = (fetchFn) => v.executar({ env, fetchFn, log: logMudo, agora, esperaMs: 0 });

describe('executar', () => {
  it('tudo em dia: não falha e não mexe em issue', async () => {
    const { fetchFn, chamadas } = montarFetch({ health: { version: 'bcba9967' }, version: { sha: MAIN, builtAt: haMin(30) } });
    const r = await rodar(fetchFn);
    expect(r.falhou).toBe(false);
    expect(r.acao).toBe('nada');
    expect(chamadas.filter((c) => c.metodo !== 'GET')).toEqual([]);
  });

  it('toda chamada externa leva tempo-limite (AbortSignal)', async () => {
    const { fetchFn, chamadas } = montarFetch({ health: { version: '3bbe1bbd' }, version: { sha: MAIN } });
    await rodar(fetchFn);
    expect(chamadas.length).toBeGreaterThan(4);
    for (const c of chamadas) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it('backend defasado (40 min do último commit): falha e abre a issue', async () => {
    const { fetchFn, chamadas } = montarFetch({
      health: { version: '3bbe1bbd' }, version: { sha: MAIN },
      compare: { files: [{ filename: 'src/routes/pdvSettings.js' }] },
    });
    const r = await rodar(fetchFn);
    expect(r.falhou).toBe(true);
    expect(r.acao).toBe('abrir');
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/issues'));
    expect(post.body.title).toBe(v.TITULO_ISSUE);
    expect(post.body.body).toContain('backend: DEFASADO há 40 min');
  });

  it('só docs pendentes no app: em dia, sem issue', async () => {
    const { fetchFn } = montarFetch({
      health: { version: 'bcba9967' }, version: { sha: 'a34d0f0bdeadbeef' },
      compare: { files: [{ filename: 'docs/mockups/etiqueta.html' }, { filename: 'CLAUDE.md' }] },
    });
    const r = await rodar(fetchFn);
    expect(r.falhou).toBe(false);
    expect(r.resultados.find((x) => x.nome === 'app').estado).toBe('so_docs');
  });

  it('versão no ar que não responde (tempo-limite): inacessível, abre a issue', async () => {
    const { fetchFn, chamadas } = montarFetch({
      health: { version: 'bcba9967' }, version: { sha: MAIN },
      quebrar: (url) => url.endsWith('/health'),
    });
    const r = await rodar(fetchFn);
    const back = r.resultados.find((x) => x.nome === 'backend');
    expect(back).toMatchObject({ estado: 'indisponivel', falha: true });
    expect(back.resumo).toMatch(/sem resposta em 10 s/);
    expect(chamadas.filter((c) => c.url.endsWith('/health'))).toHaveLength(3); // 3 tentativas
    expect(r.acao).toBe('abrir');
  });

  it('API do GitHub fora no main de um repositório: o alvo vira inacessível, sem estourar', async () => {
    const { fetchFn } = montarFetch({
      health: { version: 'bcba9967' }, version: { sha: MAIN },
      quebrar: (url) => url.includes('/aura-app/commits/main'),
    });
    const r = await rodar(fetchFn);
    expect(r.resultados.find((x) => x.nome === 'app').estado).toBe('indisponivel');
    expect(r.resultados.find((x) => x.nome === 'backend').estado).toBe('em_dia');
  });

  it('falha ao mexer na issue só vai para o log', async () => {
    const { fetchFn } = montarFetch({
      health: { version: '3bbe1bbd' }, version: { sha: MAIN },
      quebrar: (url, metodo) => url.includes('/issues'),
    });
    const r = await rodar(fetchFn);
    expect(r.falhou).toBe(true);
    expect(r.acao).toBeNull();
  });

  it('app com sha "main": registra e não falha', async () => {
    const { fetchFn } = montarFetch({ health: { version: 'bcba9967' }, version: { sha: 'main', builtAt: haMin(10) } });
    const r = await rodar(fetchFn);
    expect(r.falhou).toBe(false);
    expect(r.resultados.find((x) => x.nome === 'app').estado).toBe('sem_sha');
  });

  it('issue aberta e mesma falha: atualiza o corpo sem comentar de novo', async () => {
    const corpoAntigo = v.corpoIssue([{ nome: 'backend', falha: true, resumo: 'x' }], agora, null);
    const { fetchFn, chamadas } = montarFetch({
      health: { version: '3bbe1bbd' }, version: { sha: MAIN },
      issues: [{ number: 7, title: v.TITULO_ISSUE, body: corpoAntigo }],
    });
    const r = await rodar(fetchFn);
    expect(r.acao).toBe('atualizar');
    expect(chamadas.some((c) => c.metodo === 'PATCH' && c.url.endsWith('/issues/7'))).toBe(true);
    expect(chamadas.some((c) => c.url.endsWith('/comments'))).toBe(false);
  });

  it('issue aberta e tudo em dia: comenta e fecha', async () => {
    const { fetchFn, chamadas } = montarFetch({
      health: { version: 'bcba9967' }, version: { sha: MAIN },
      issues: [{ number: 7, title: v.TITULO_ISSUE, body: '' }, { number: 8, title: 'outra', body: '' }],
    });
    const r = await rodar(fetchFn);
    expect(r.acao).toBe('fechar');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    expect(patch.url).toMatch(/\/issues\/7$/);
    expect(patch.body.state).toBe('closed');
  });
});

describe('workflow e saída', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'verificador-producao.yml'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'scripts', 'verificador-producao.js'), 'utf8');

  it('roda a cada 15 min, limite de 30 min, e nunca derruba a execução (Wait for CI da Railway)', () => {
    expect(yml).toMatch(/cron:\s*"\*\/15 \* \* \* \*"/);
    expect(yml).toMatch(/LIMITE_MIN:\s*"30"/);
    expect(yml).toMatch(/\n {4}continue-on-error:\s*true/); // job
    expect(yml).toMatch(/\n {8}continue-on-error:\s*true/); // passo
    expect(yml).toMatch(/issues:\s*write/);
  });

  it('o script sai sempre com código 0 (o alerta é a issue)', () => {
    expect(script).toMatch(/\.finally\(\(\) => \{ process\.exitCode = 0; \}\)/);
    expect(script).not.toMatch(/process\.exitCode = (falhou|1)/);
  });
});
