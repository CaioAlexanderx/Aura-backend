'use strict';
// Encerramento gracioso (t1-03): SIGTERM espera a requisição em andamento,
// força a saída quando o tempo esgota, não roda duas vezes e só chama
// pool.end() depois que o servidor parou de atender.
const http = require('http');
const path = require('path');
const { encerrar, stopsDosJobsCarregados, comLimite, _resetForTests } = require('../../src/utils/encerrar');

const logMudo = { log: () => {}, warn: () => {}, error: () => {} };

function subir(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Requisição sem keep-alive (agent: false), devolve { status, corpo } ou o erro.
function pedir(server, caminho = '/') {
  const port = typeof server === 'number' ? server : server.address().port;
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: caminho, agent: false }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, corpo }));
    });
    req.on('error', (e) => resolve({ erro: e.code || e.message }));
    req.end();
  });
}

function poolFalso(ordem) {
  return { end: jest.fn(async () => { ordem.push('pool.end'); }) };
}

beforeEach(() => _resetForTests());

describe('encerrar', () => {
  it('espera a requisição em andamento terminar e só depois fecha o pool e sai', async () => {
    const ordem = [];
    let chegou;
    const chegada = new Promise((r) => { chegou = r; });
    const server = await subir((req, res) => {
      chegou();
      setTimeout(() => { ordem.push('resposta'); res.end('ok'); }, 150);
    });

    const resposta = pedir(server);
    await chegada;

    const sair = jest.fn((c) => ordem.push(`sair(${c})`));
    const pool = poolFalso(ordem);
    const job = jest.fn(() => ordem.push('job parado'));
    const r = await encerrar({ server, pool, jobs: [job], timeoutMs: 2000, sair, log: logMudo });

    expect(await resposta).toEqual({ status: 200, corpo: 'ok' });
    expect(r).toEqual({ forcado: false, pool: 'fechado' });
    expect(job).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(sair).toHaveBeenCalledWith(0);
    // jobs param no início; pool.end e saída só depois da resposta.
    expect(ordem).toEqual(['job parado', 'resposta', 'pool.end', 'sair(0)']);
    expect(server.listening).toBe(false);
  });

  it('para de aceitar conexões novas assim que começa', async () => {
    let chegou;
    const chegada = new Promise((r) => { chegou = r; });
    const server = await subir((req, res) => { chegou(); setTimeout(() => res.end('ok'), 200); });
    const porta = server.address().port;
    const primeira = pedir(server);
    await chegada;

    const fim = encerrar({ server, pool: poolFalso([]), timeoutMs: 2000, sair: jest.fn(), log: logMudo });
    const nova = await pedir(porta);
    expect(nova.erro).toBeTruthy();
    expect((await primeira).status).toBe(200);
    await fim;
  });

  it('tempo esgotado: corta as conexões, fecha o pool e sai mesmo assim', async () => {
    let chegou;
    const chegada = new Promise((r) => { chegou = r; });
    const server = await subir(() => { chegou(); /* nunca responde */ });
    const resposta = pedir(server);
    await chegada;

    const sair = jest.fn();
    const pool = poolFalso([]);
    const inicio = Date.now();
    const r = await encerrar({ server, pool, timeoutMs: 100, sair, log: logMudo });

    expect(r.forcado).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(1500);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(sair).toHaveBeenCalledWith(0);
    // closeAllConnections derrubou o cliente pendurado.
    expect((await resposta).erro).toBeTruthy();
  });

  it('pool.end pendurado não segura a saída', async () => {
    const server = await subir((req, res) => res.end('ok'));
    const pool = { end: jest.fn(() => new Promise(() => {})) };
    const sair = jest.fn();
    const r = await encerrar({ server, pool, timeoutMs: 100, timeoutPoolMs: 50, sair, log: logMudo });
    expect(r.pool).toBe('limite');
    expect(sair).toHaveBeenCalledWith(0);
  });

  it('pool.end que falha não impede a saída', async () => {
    const server = await subir((req, res) => res.end('ok'));
    const pool = { end: jest.fn(async () => { throw new Error('ja fechado'); }) };
    const sair = jest.fn();
    const r = await encerrar({ server, pool, timeoutMs: 100, sair, log: logMudo });
    expect(r.pool).toBe('erro');
    expect(sair).toHaveBeenCalledWith(0);
  });

  it('chamada dupla não executa duas vezes', async () => {
    const server = await subir((req, res) => res.end('ok'));
    const pool = poolFalso([]);
    const sair = jest.fn();
    const job = jest.fn();
    const a = encerrar({ server, pool, jobs: [job], timeoutMs: 500, sair, log: logMudo });
    const b = encerrar({ server, pool, jobs: [job], timeoutMs: 500, sair, log: logMudo, sinal: 'SIGINT' });
    expect(b).toBe(a);
    await Promise.all([a, b]);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(sair).toHaveBeenCalledTimes(1);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('um job que lança não impede os outros nem a saída', async () => {
    const server = await subir((req, res) => res.end('ok'));
    const outro = jest.fn();
    const comStop = { stop: jest.fn() };
    const sair = jest.fn();
    await encerrar({
      server, pool: poolFalso([]), timeoutMs: 200, sair, log: logMudo,
      jobs: [() => { throw new Error('quebrou'); }, outro, comStop],
    });
    expect(outro).toHaveBeenCalled();
    expect(comStop.stop).toHaveBeenCalled();
    expect(sair).toHaveBeenCalledWith(0);
  });

  it('sem servidor e sem pool ainda sai', async () => {
    const sair = jest.fn();
    const r = await encerrar({ sair, log: logMudo, timeoutMs: 50 });
    expect(r).toEqual({ forcado: false, pool: 'sem_pool' });
    expect(sair).toHaveBeenCalledWith(0);
  });
});

describe('stopsDosJobsCarregados', () => {
  it('pega só as funções stop* de módulos dentro de src/jobs', () => {
    const dir = path.join('/x', 'src', 'jobs');
    const stopA = jest.fn();
    const stopB = jest.fn();
    const cache = {
      [path.join(dir, 'a.js')]: { exports: { initA: jest.fn(), stopA, tick: jest.fn() } },
      [path.join(dir, 'b.js')]: { exports: { stopB, stopper: 'nao e funcao', stopping: jest.fn() } },
      [path.join('/x', 'src', 'services', 'c.js')]: { exports: { stopC: jest.fn() } },
      [path.join(dir, 'd.js')]: { exports: null },
    };
    expect(stopsDosJobsCarregados(cache, dir)).toEqual([stopA, stopB]);
  });

  it('no repositório real acha os stop* dos jobs carregados', () => {
    require('../../src/jobs/waDispatcherJob');
    const stops = stopsDosJobsCarregados();
    expect(stops.map((f) => f.name)).toContain('stopWaDispatcher');
  });
});

describe('comLimite', () => {
  it('devolve o valor quando chega antes do limite e o marcador quando não', async () => {
    expect(await comLimite(Promise.resolve('a'), 100, 'limite')).toBe('a');
    expect(await comLimite(new Promise(() => {}), 20, 'limite')).toBe('limite');
  });
});
