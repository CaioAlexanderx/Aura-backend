// ============================================================
// t1-08 — bipe rápido: só o bipe a cada 30 s, alerta em 3 falhas seguidas,
// um aviso por evento junto com o bipe de 5 min (jobs/canaryJob.js).
// ============================================================
'use strict';

const canary = require('../../src/services/canary');
const rapido = require('../../src/services/canaryBipeRapido');
const rapidoJob = require('../../src/jobs/canaryBipeRapidoJob');
const canaryJob = require('../../src/jobs/canaryJob');

const T0 = new Date('2026-10-13T15:00:00.000Z');
const seg = (n) => new Date(T0.getTime() + n * 1000);

const CFG = {
  companyId: 'b0463109-e68e-4d55-a2d4-40c8a758ae0b',
  userId: '5c19f573-0943-4263-beba-805456e32b13',
  barcode: '789',
  baseUrl: 'https://api.test',
  timeoutMs: 100,
};
const ENV_CANARIO = { CANARY_COMPANY_ID: CFG.companyId, CANARY_USER_ID: CFG.userId, CANARY_BARCODE: '789' };

const mailerFake = () => ({
  sendMail: jest.fn(async () => ({ id: 'm1' })),
  escapeHtml: (s) => String(s),
  emailLayout: (h) => h,
});

const okBipe = () => ({ ok: true, duracao_ms: 180, erro: null, passo_falho: null, passos: [{ passo: 'token', ok: true, ms: 1 }, { passo: 'bipe', ok: true, ms: 180 }] });
const falhaBipe = (erro = 'HTTP 500 (esperado 200) — max clients reached') => ({
  ok: false, duracao_ms: 900, erro: `bipe: ${erro}`, passo_falho: 'bipe',
  passos: [{ passo: 'token', ok: true, ms: 1 }, { passo: 'bipe', ok: false, ms: 900, status: 500, erro }],
});

// Banco sem nada avisado (o laço rápido só lê canary_runs na hora de avisar).
const dbVazio = () => ({ query: jest.fn(async () => ({ rows: [] })) });

function rodar(n, resultado, extra = {}) {
  return rapido.rodarUmaVez(CFG, {
    agora: seg(n * 30), db: extra.db || dbVazio(), mailer: extra.mailer, env: {},
    executar: jest.fn(async () => resultado), ...extra,
  });
}

beforeEach(() => {
  rapidoJob._resetForTests();
  canaryJob._resetForTests();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { rapidoJob.stopCanaryBipeRapidoJob(); canaryJob.stopCanaryJob(); jest.restoreAllMocks(); });

describe('configuração', () => {
  test('dormente sem as envs do canário', () => {
    expect(rapido.configuracaoRapida({})).toBeNull();
  });
  test('ligado por padrão com as envs, tempo-limite de 10 s', () => {
    expect(rapido.configuracaoRapida(ENV_CANARIO)).toMatchObject({ companyId: CFG.companyId, barcode: '789', timeoutMs: 10000 });
  });
  test('CANARY_BIPE_TIMEOUT_MS ajusta o tempo-limite', () => {
    expect(rapido.configuracaoRapida({ ...ENV_CANARIO, CANARY_BIPE_TIMEOUT_MS: '4000' }).timeoutMs).toBe(4000);
  });
  test('CANARY_BIPE_RAPIDO_ENABLED=false desliga só este laço', () => {
    expect(rapido.configuracaoRapida({ ...ENV_CANARIO, CANARY_BIPE_RAPIDO_ENABLED: 'false' })).toBeNull();
    expect(canary.configuracao({ ...ENV_CANARIO, CANARY_BIPE_RAPIDO_ENABLED: 'false' })).not.toBeNull();
  });
  test('CANARY_ENABLED=false desliga os dois', () => {
    expect(rapido.configuracaoRapida({ ...ENV_CANARIO, CANARY_ENABLED: 'false' })).toBeNull();
  });
});

describe('executarSoBipe (caminho HTTP real, fetch simulado)', () => {
  const resp = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  test('bipe ok: uma única chamada, GET do scan, sem venda', async () => {
    const fetch = jest.fn(async () => resp(200, { match: 'exact', product: { id: 'p1', price: 1 } }));
    const r = await canary.executarSoBipe(CFG, { fetch, gerarToken: () => 'tok' });
    expect(r.ok).toBe(true);
    expect(r.passos.map((p) => p.passo)).toEqual(['token', 'bipe']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://api.test/api/v1/companies/${CFG.companyId}/pdv/scan/789`);
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  test('erro do servidor vira falha no passo bipe, com o motivo', async () => {
    const fetch = jest.fn(async () => resp(500, { error: 'max clients reached' }));
    const r = await canary.executarSoBipe(CFG, { fetch, gerarToken: () => 'tok' });
    expect(r).toMatchObject({ ok: false, passo_falho: 'bipe' });
    expect(r.erro).toMatch(/bipe: HTTP 500 \(esperado 200\) — max clients reached/);
  });

  test('produto não achado (match diferente de exact) é falha', async () => {
    const fetch = jest.fn(async () => resp(200, { match: 'none', product: null }));
    const r = await canary.executarSoBipe(CFG, { fetch, gerarToken: () => 'tok' });
    expect(r.ok).toBe(false);
    expect(r.erro).toMatch(/match=none/);
  });

  test('token que não assina: falha sem chamar a rede', async () => {
    const fetch = jest.fn();
    const r = await canary.executarSoBipe(CFG, { fetch, gerarToken: () => { throw new Error('sem segredo'); } });
    expect(r).toMatchObject({ ok: false, passo_falho: 'token' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('executar() completo continua igual no passo do bipe (refatoração do conferirBipe)', async () => {
    const fetch = jest.fn(async () => resp(200, { match: 'exact', product: { id: 'p1', price: -1 } }));
    const r = await canary.executar(CFG, { fetch, gerarToken: () => 'tok' });
    expect(r.erro).toBe('bipe: produto canário sem preço válido (price=-1)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('alerta em 3 falhas seguidas', () => {
  test('1 e 2 falhas não avisam; a 3ª avisa "caiu" com o passo bipe; a 4ª fica quieta', async () => {
    const mailer = mailerFake();
    await rodar(0, falhaBipe(), { mailer });
    await rodar(1, falhaBipe(), { mailer });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    const r3 = await rodar(2, falhaBipe(), { mailer });
    expect(r3.aviso).toBe('caiu');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.to).toBe('contato@getaura.com.br');
    expect(mail.subject).toMatch(/fora do ar.*"bipe"/);
    expect(mail.text).toMatch(/3 execuções seguidas/);
    expect(mail.text).toMatch(/max clients reached/);
    expect(mail.text).toMatch(/bipe rápido/);
    for (const n of [3, 4, 5, 6]) await rodar(n, falhaBipe(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  test('detecta em até 3 min: 3 falhas a cada 30 s = 1 min depois da primeira', async () => {
    const mailer = mailerFake();
    await rodar(0, falhaBipe(), { mailer });
    await rodar(1, falhaBipe(), { mailer });
    await rodar(2, falhaBipe(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(seg(2 * 30) - seg(0)).toBeLessThanOrEqual(3 * 60000);
  });

  test('falha, ok, falha, falha, ok: nunca chega a 3 seguidas, nunca avisa', async () => {
    const mailer = mailerFake();
    for (const [n, r] of [[0, falhaBipe()], [1, okBipe()], [2, falhaBipe()], [3, falhaBipe()], [4, okBipe()]]) await rodar(n, r, { mailer });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('recuperação: "voltou" uma vez depois de uma queda que este laço avisou', async () => {
    const mailer = mailerFake();
    for (const n of [0, 1, 2]) await rodar(n, falhaBipe(), { mailer });
    const r = await rodar(3, okBipe(), { mailer });
    expect(r.aviso).toBe('voltou');
    expect(mailer.sendMail.mock.calls[1][0].subject).toMatch(/voltou/);
    await rodar(4, okBipe(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });

  test('e-mail que falha não marca: a próxima execução tenta de novo', async () => {
    const mailer = mailerFake();
    mailer.sendMail.mockRejectedValueOnce(new Error('resend 500'));
    for (const n of [0, 1, 2]) await rodar(n, falhaBipe(), { mailer });
    expect(rapido.quedaAtiva()).toBe(false);
    await rodar(3, falhaBipe(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(rapido.quedaAtiva()).toBe(true);
  });

  test('executar que lança conta como falha', async () => {
    const mailer = mailerFake();
    for (const n of [0, 1, 2]) {
      await rapido.rodarUmaVez(CFG, { agora: seg(n * 30), db: dbVazio(), mailer, env: {}, executar: async () => { throw new Error('estourou'); } });
    }
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });
});

// ── Um aviso por evento entre os dois laços ──────────────────────────────────
// Banco em memória do canary_runs, só o que o tick de 5 min usa.
function makeDbCanario() {
  const runs = [];
  let seq = 0;
  const query = jest.fn(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('INSERT INTO canary_runs')) {
      const t = new Date(params[0]).getTime();
      if (runs.some((r) => r.started_at.getTime() === t)) return { rows: [] };
      const row = { id: ++seq, started_at: new Date(t), ok: null, alerta: null, passos: [], venda_id: null, venda_pendente: false };
      runs.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (s.startsWith('SELECT id, venda_id FROM canary_runs')) return { rows: [] };
    if (s.startsWith('UPDATE canary_runs SET finished_at')) {
      const [id, ok, passos, dur, erro] = params;
      Object.assign(runs.find((r) => r.id === id), { ok, passos: JSON.parse(passos), duracao_ms: dur, erro });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE canary_runs SET alerta')) { runs.find((r) => r.id === params[1]).alerta = params[0]; return { rows: [] }; }
    if (s.startsWith('SELECT id, started_at, ok, alerta') || s.startsWith('SELECT ok, alerta FROM canary_runs')) {
      return { rows: runs.filter((r) => r.ok !== null).sort((a, b) => b.started_at - a.started_at).slice(0, 40) };
    }
    if (s.startsWith('DELETE FROM canary_runs')) return { rows: [], rowCount: 0 };
    if (s.startsWith('INSERT INTO painel_alertas') || s.startsWith('DELETE FROM painel_alertas')) return { rows: [] };
    throw new Error('SQL inesperado: ' + s.slice(0, 80));
  });
  return { query, runs };
}

const falhaCompleta = (passo = 'bipe') => ({
  ok: false, duracao_ms: 900, erro: `${passo}: HTTP 500`, passo_falho: passo, venda_id: null, venda_pendente: false,
  passos: [{ passo: 'bipe', ok: passo !== 'bipe', ms: 100 }, ...(passo === 'bipe' ? [] : [{ passo, ok: false, ms: 800, erro: 'HTTP 500' }])],
});
const okCompleto = () => ({ ok: true, duracao_ms: 1200, erro: null, passo_falho: null, venda_id: null, venda_pendente: false, passos: [{ passo: 'bipe', ok: true, ms: 100 }] });
const min = (n) => new Date(T0.getTime() + n * 60000);
const tickLento = (db, m, resultado, mailer) => canaryJob.tick({ agora: min(m), cfg: CFG, db, mailer, env: {}, executar: jest.fn(async () => resultado), gerarToken: () => 'tok' });

describe('um aviso por evento (bipe rápido + bipe de 5 min)', () => {
  test('o rápido avisa "caiu"; o de 5 min só registra o seu "caiu" e o "voltou"', async () => {
    const db = makeDbCanario();
    const mailer = mailerFake();
    // Queda: o rápido pega em 1 min.
    for (const n of [0, 1, 2]) await rodar(n, falhaBipe(), { mailer, db });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    // O de 5 min falha duas vezes e decide "caiu": já avisado, só registra.
    await tickLento(db, 0, falhaCompleta(), mailer);
    await tickLento(db, 5, falhaCompleta(), mailer);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(db.runs[1].alerta).toBe('caiu');

    // O bipe volta: o rápido manda "voltou".
    await rodar(21, okBipe(), { mailer, db });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(mailer.sendMail.mock.calls[1][0].subject).toMatch(/voltou/);

    // O de 5 min passa e decide "voltou": já avisado, só registra.
    await tickLento(db, 15, okCompleto(), mailer);
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(db.runs[2].alerta).toBe('voltou');
  });

  test('o de 5 min avisa primeiro (venda falhando): o rápido não repete o "caiu" nem manda "voltou"', async () => {
    const db = makeDbCanario();
    const mailer = mailerFake();
    await tickLento(db, 0, falhaCompleta('venda'), mailer);
    await tickLento(db, 5, falhaCompleta('venda'), mailer);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1); // "caiu" do de 5 min

    for (const n of [20, 21, 22, 23]) await rodar(n, falhaBipe(), { mailer, db });
    await rodar(24, okBipe(), { mailer, db });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    await tickLento(db, 15, okCompleto(), mailer); // quem avisou a queda manda o "voltou"
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(mailer.sendMail.mock.calls[1][0].subject).toMatch(/voltou/);
  });

  test('memória perdida (deploy) com queda já avisada no banco: o rápido não repete o "caiu"', async () => {
    const db = makeDbCanario();
    const mailer = mailerFake();
    await tickLento(db, 0, falhaCompleta(), mailer);
    await tickLento(db, 5, falhaCompleta(), mailer);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    rapido._resetForTests(); // processo novo
    for (const n of [20, 21, 22]) await rodar(n, falhaBipe(), { mailer, db });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(rapido.quedaAtiva()).toBe(true);
  });

  test('canary_runs ausente (42P01) não impede o aviso', async () => {
    const mailer = mailerFake();
    const db = { query: jest.fn(async () => { const e = new Error('nao existe'); e.code = '42P01'; throw e; }) };
    for (const n of [0, 1, 2]) await rodar(n, falhaBipe(), { mailer, db });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('job (timer)', () => {
  test('tick dormente sem config: não chama nada', async () => {
    const executar = jest.fn();
    expect(await rapidoJob.tick({ env: {}, executar })).toBeNull();
    expect(executar).not.toHaveBeenCalled();
  });

  test('tick não sobrepõe execuções', async () => {
    let solta;
    const lenta = new Promise((r) => { solta = r; });
    const executar = jest.fn(() => lenta);
    const a = rapidoJob.tick({ cfg: CFG, executar, db: dbVazio(), env: {}, agora: seg(0) });
    expect(await rapidoJob.tick({ cfg: CFG, executar, db: dbVazio(), env: {}, agora: seg(30) })).toBeNull();
    solta(okBipe());
    await a;
    expect(executar).toHaveBeenCalledTimes(1);
  });

  test('init: dormente sem envs, desligado pelo kill switch, ligado com envs', () => {
    rapidoJob.initCanaryBipeRapidoJob({});
    expect(rapidoJob._ativo()).toBe(false);
    rapidoJob.initCanaryBipeRapidoJob({ ...ENV_CANARIO, CANARY_BIPE_RAPIDO_ENABLED: 'false' });
    expect(rapidoJob._ativo()).toBe(false);
    rapidoJob.initCanaryBipeRapidoJob(ENV_CANARIO);
    expect(rapidoJob._ativo()).toBe(true);
    rapidoJob.stopCanaryBipeRapidoJob();
    expect(rapidoJob._ativo()).toBe(false);
  });

  test('initCanaryJob sobe o laço rápido junto (com as envs)', () => {
    const antes = { ...process.env };
    try {
      Object.assign(process.env, ENV_CANARIO);
      delete process.env.CANARY_ENABLED;
      delete process.env.CANARY_BIPE_RAPIDO_ENABLED;
      canaryJob.initCanaryJob();
      expect(rapidoJob._ativo()).toBe(true);
    } finally {
      for (const k of Object.keys(ENV_CANARIO)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
    }
  });
});
