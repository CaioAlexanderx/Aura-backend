'use strict';
// t1-04: verificador de produção (.github/scripts/verificador-producao.js).
const fs = require('fs');
const path = require('path');
const v = require('../../.github/scripts/verificador-producao');

const MAIN = 'bcba99671e0c2de73a22fff899d48f0517b535ff';
const VELHO = '3bbe1bbdf50443c734a4d3f6afa05fa0cd4e39e9';
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

  it('atrasado (não falha) até 20 min', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(10), pendenteDesde: haMin(20) }, agora);
    expect(r).toMatchObject({ estado: 'atrasado', falha: false, minutos: 20 });
  });

  it('defasado (falha) depois de 20 min, contando do commit mais antigo que falta', () => {
    // main mudou há 5 min, mas o commit anterior também não subiu e está há 30 min.
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(5), pendenteDesde: haMin(30) }, agora);
    expect(r).toMatchObject({ estado: 'defasado', falha: true, minutos: 30 });
    expect(r.resumo).toContain('3bbe1bbd');
    expect(r.resumo).toContain('bcba9967');
  });

  it('sem o compare usa a data de main', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(25), pendenteDesde: null }, agora);
    expect(r).toMatchObject({ estado: 'defasado', minutos: 25 });
  });

  it('respeita o limite configurado', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '3bbe1bbd', mainSha: MAIN, mainData: haMin(25) }, agora, 30);
    expect(r.estado).toBe('atrasado');
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

  it('/health com "1.0.0" (sem commit) é sem_sha', () => {
    const r = v.avaliarAlvo({ nome: 'backend', noAr: '1.0.0', mainSha: MAIN, mainData: haMin(60) }, agora);
    expect(r).toMatchObject({ estado: 'sem_sha', falha: false });
  });

  it('erro de leitura é indisponivel e falha', () => {
    const r = v.avaliarAlvo({ nome: 'backend', erro: 'HTTP 502', mainSha: MAIN, mainData: haMin(1) }, agora);
    expect(r).toMatchObject({ estado: 'indisponivel', falha: true });
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

function montarFetch({ health, version, issues = [], mainBackend = MAIN, mainApp = MAIN, compare = null }) {
  const chamadas = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const metodo = opts.method || 'GET';
    chamadas.push({ metodo, url, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.endsWith('/health')) return health instanceof Error ? Promise.reject(health) : resposta(health);
    if (url.endsWith('/version.json')) return resposta(version);
    if (url.includes('/repos/CaioAlexanderx/Aura-backend/commits/main')) return resposta({ sha: mainBackend, commit: { committer: { date: haMin(40) } } });
    if (url.includes('/repos/CaioAlexanderx/aura-app/commits/main')) return resposta({ sha: mainApp, commit: { committer: { date: haMin(40) } } });
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

describe('executar', () => {
  it('tudo em dia: não falha e não mexe em issue', async () => {
    const { fetchFn, chamadas } = montarFetch({ health: { version: 'bcba9967' }, version: { sha: MAIN, builtAt: haMin(30) } });
    const r = await v.executar({ env, fetchFn, log: logMudo, agora });
    expect(r.falhou).toBe(false);
    expect(r.acao).toBe('nada');
    expect(chamadas.filter((c) => c.metodo !== 'GET')).toEqual([]);
  });

  it('backend defasado: falha e abre a issue', async () => {
    const { fetchFn, chamadas } = montarFetch({
      health: { version: '3bbe1bbd' }, version: { sha: MAIN },
      compare: { commits: [{ commit: { committer: { date: haMin(45) } } }] },
    });
    const r = await v.executar({ env, fetchFn, log: logMudo, agora });
    expect(r.falhou).toBe(true);
    expect(r.acao).toBe('abrir');
    const post = chamadas.find((c) => c.metodo === 'POST' && c.url.endsWith('/issues'));
    expect(post.body.title).toBe(v.TITULO_ISSUE);
    expect(post.body.body).toContain('backend: DEFASADO há 45 min');
  });

  it('app com sha "main": registra e não falha', async () => {
    const { fetchFn } = montarFetch({ health: { version: 'bcba9967' }, version: { sha: 'main', builtAt: haMin(10) } });
    const r = await v.executar({ env, fetchFn, log: logMudo, agora });
    expect(r.falhou).toBe(false);
    expect(r.resultados.find((x) => x.nome === 'app').estado).toBe('sem_sha');
  });

  it('issue aberta e mesma falha: atualiza o corpo sem comentar de novo', async () => {
    const corpoAntigo = v.corpoIssue([{ nome: 'backend', falha: true, resumo: 'x' }], agora, null);
    const { fetchFn, chamadas } = montarFetch({
      health: { version: '3bbe1bbd' }, version: { sha: MAIN },
      issues: [{ number: 7, title: v.TITULO_ISSUE, body: corpoAntigo }],
    });
    const r = await v.executar({ env, fetchFn, log: logMudo, agora });
    expect(r.acao).toBe('atualizar');
    expect(chamadas.some((c) => c.metodo === 'PATCH' && c.url.endsWith('/issues/7'))).toBe(true);
    expect(chamadas.some((c) => c.url.endsWith('/comments'))).toBe(false);
  });

  it('issue aberta e tudo em dia: comenta e fecha', async () => {
    const { fetchFn, chamadas } = montarFetch({
      health: { version: 'bcba9967' }, version: { sha: MAIN },
      issues: [{ number: 7, title: v.TITULO_ISSUE, body: '' }, { number: 8, title: 'outra', body: '' }],
    });
    const r = await v.executar({ env, fetchFn, log: logMudo, agora });
    expect(r.acao).toBe('fechar');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    expect(patch.url).toMatch(/\/issues\/7$/);
    expect(patch.body.state).toBe('closed');
  });
});

describe('workflow', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'verificador-producao.yml'), 'utf8');
  it('roda a cada 15 min e não derruba a execução (Wait for CI da Railway)', () => {
    expect(yml).toMatch(/cron:\s*"\*\/15 \* \* \* \*"/);
    expect(yml).toMatch(/\n {4}continue-on-error:\s*true/);
    expect(yml).toMatch(/issues:\s*write/);
  });
});
