// ============================================================
// jobs/painelDiarioScheduler — horário de disparo e trava por dia.
//
// 06h BRT é o piso; "já rodou hoje" mora em painel_runs (pode haver mais de
// uma instância). Quem insere a linha do dia roda; quem não insere, desiste.
// ============================================================
'use strict';

const job = require('../../src/jobs/painelDiarioScheduler');

// `now` no formato do job: um Date cujo relógio UTC é a hora de Brasília.
const brt = (dia, hora, min = 0) => new Date(`${dia}T${String(hora).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`);

function makeDb({ pegaTrava = true, terminou = true, semTabela = false } = {}) {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (semTabela) {
        const err = new Error('relation "painel_runs" does not exist');
        err.code = '42P01';
        throw err;
      }
      if (s.startsWith('INSERT INTO painel_runs')) return { rows: pegaTrava ? [{ dia: params[0] }] : [] };
      if (s.startsWith('SELECT (finished_at IS NOT NULL)')) return { rows: [{ terminou }] };
      return { rows: [] };
    }),
  };
}

const okRun = () => jest.fn(async ({ hoje }) => ({ dia: hoje, erros: [], blocos: ['pagantes'], alertas: 2 }));

beforeEach(() => {
  job._resetForTests();
  delete process.env.PAINEL_DIARIO_ENABLED;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('tick — horário', () => {
  test('antes das 06h BRT não dispara', () => {
    const db = makeDb();
    expect(job.tick({ now: brt('2026-10-13', 5, 59), db, rodar: okRun() })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('às 06:00 BRT dispara, com o dia de Brasília', async () => {
    const db = makeDb();
    const rodar = okRun();
    const r = await job.tick({ now: brt('2026-10-13', 6, 0), db, rodar });
    expect(rodar).toHaveBeenCalledTimes(1);
    expect(rodar.mock.calls[0][0].hoje).toBe('2026-10-13');
    expect(r.blocos).toEqual(['pagantes']);
  });

  test('uma vez por dia: o tick do minuto seguinte não dispara de novo', async () => {
    const db = makeDb();
    const rodar = okRun();
    await job.tick({ now: brt('2026-10-13', 6, 0), db, rodar });
    expect(job.tick({ now: brt('2026-10-13', 6, 1), db, rodar })).toBeNull();
    expect(job.tick({ now: brt('2026-10-13', 18, 30), db, rodar })).toBeNull();
    expect(rodar).toHaveBeenCalledTimes(1);
  });

  test('no dia seguinte dispara de novo', async () => {
    const db = makeDb();
    const rodar = okRun();
    await job.tick({ now: brt('2026-10-13', 6, 0), db, rodar });
    await job.tick({ now: brt('2026-10-14', 6, 0), db, rodar });
    expect(rodar.mock.calls.map((c) => c[0].hoje)).toEqual(['2026-10-13', '2026-10-14']);
  });

  test('processo que sobe depois das 06h recupera o dia', async () => {
    const db = makeDb();
    const rodar = okRun();
    await job.tick({ now: brt('2026-10-13', 14, 20), db, rodar });
    expect(rodar).toHaveBeenCalledTimes(1);
  });

  test('kill switch PAINEL_DIARIO_ENABLED=false', () => {
    process.env.PAINEL_DIARIO_ENABLED = 'false';
    const db = makeDb();
    expect(job.tick({ now: brt('2026-10-13', 6, 0), db, rodar: okRun() })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('trava por dia (painel_runs)', () => {
  test('quem insere a linha do dia roda e fecha a linha com ok e duração', async () => {
    const db = makeDb({ pegaTrava: true });
    const rodar = okRun();
    await job.executarDia('2026-10-13', { db, rodar });

    const [trava, fecha] = db.calls;
    expect(trava.sql).toContain('INSERT INTO painel_runs (dia, started_at)');
    expect(trava.sql).toContain('ON CONFLICT (dia) DO UPDATE');
    expect(trava.sql).toContain('RETURNING dia');
    expect(trava.params).toEqual(['2026-10-13']);
    expect(fecha.sql).toContain('UPDATE painel_runs SET finished_at = NOW(), ok = $2, erro = $3, duracao_ms = $4');
    expect(fecha.params[0]).toBe('2026-10-13');
    expect(fecha.params[1]).toBe(true);
    expect(fecha.params[2]).toBeNull();
    expect(typeof fecha.params[3]).toBe('number');
  });

  test('quem não insere (outra instância já pegou) não roda nada', async () => {
    const db = makeDb({ pegaTrava: false });
    const rodar = okRun();
    const r = await job.executarDia('2026-10-13', { db, rodar });
    expect(r).toBeNull();
    expect(rodar).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(1); // só a tentativa de trava
  });

  test('só assume a linha de outra instância se ela foi abandonada (sem fim há 30+ min)', async () => {
    const db = makeDb();
    await job.pegarTrava('2026-10-13', { db });
    const sql = db.calls[0].sql;
    expect(sql).toContain('WHERE painel_runs.finished_at IS NULL');
    expect(sql).toContain(`make_interval(mins => ${job.ABANDONO_MIN})`);
  });

  test('etapa com erro: a linha fecha com ok=false e o erro escrito', async () => {
    const db = makeDb();
    const rodar = jest.fn(async () => ({ erros: [{ etapa: 'bloco:fiscal', erro: 'boom' }], blocos: [], alertas: 0 }));
    await job.executarDia('2026-10-13', { db, rodar });
    const fecha = db.calls[1];
    expect(fecha.params[1]).toBe(false);
    expect(fecha.params[2]).toBe('bloco:fiscal: boom');
  });

  test('o passo diário lançando também fecha a linha (não fica travada)', async () => {
    const db = makeDb();
    const rodar = jest.fn(async () => { throw new Error('banco caiu'); });
    await job.executarDia('2026-10-13', { db, rodar });
    expect(db.calls[1].params.slice(1, 3)).toEqual([false, 'banco caiu']);
  });

  test('trava de outra instância que já terminou: dia dado por feito', async () => {
    const db = makeDb({ pegaTrava: false, terminou: true });
    const rodar = okRun();
    await job.tick({ now: brt('2026-10-13', 6, 0), agoraMs: 1000, db, rodar });
    expect(job.tick({ now: brt('2026-10-13', 7, 0), agoraMs: 1000 + 3600000, db, rodar })).toBeNull();
    expect(rodar).not.toHaveBeenCalled();
  });

  test('trava de outra instância ainda rodando: volta a olhar em 10 minutos', async () => {
    const db = makeDb({ pegaTrava: false, terminou: false });
    const rodar = okRun();
    const t0 = 1_000_000;
    await job.tick({ now: brt('2026-10-13', 6, 0), agoraMs: t0, db, rodar });
    // antes de 10 min: quieto
    expect(job.tick({ now: brt('2026-10-13', 6, 5), agoraMs: t0 + 5 * 60000, db, rodar })).toBeNull();
    // depois de 10 min: tenta a trava de novo
    const antes = db.calls.length;
    await job.tick({ now: brt('2026-10-13', 6, 11), agoraMs: t0 + 11 * 60000, db, rodar });
    expect(db.calls.length).toBeGreaterThan(antes);
    expect(db.calls[antes].sql).toContain('INSERT INTO painel_runs');
  });

  test('painel_runs ainda não existe (42P01): não perde o dia, tenta no próximo tick', async () => {
    const db = makeDb({ semTabela: true });
    const rodar = okRun();
    expect(await job.tick({ now: brt('2026-10-13', 6, 0), db, rodar })).toBeNull();
    const depois = makeDb();
    await job.tick({ now: brt('2026-10-13', 6, 1), db: depois, rodar });
    expect(rodar).toHaveBeenCalledTimes(1);
  });
});
