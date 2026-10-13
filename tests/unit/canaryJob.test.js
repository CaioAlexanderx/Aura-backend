// ============================================================
// jobs/canaryJob — janela de 5 min, trava entre réplicas, alerta e limpeza.
//
// O banco é uma simulação em memória de canary_runs + painel_alertas: o que
// importa aqui é a conversa entre as execuções (quem já avisou, quando), e
// ela mora nas linhas gravadas.
// ============================================================
'use strict';

const job = require('../../src/jobs/canaryJob');

const T0 = new Date('2026-10-13T15:00:00.000Z'); // 12:00 BRT, múltiplo de 5 min
const min = (n) => new Date(T0.getTime() + n * 60000);

const CFG = {
  companyId: 'b0463109-e68e-4d55-a2d4-40c8a758ae0b',
  userId: '5c19f573-0943-4263-beba-805456e32b13',
  barcode: '789',
  baseUrl: 'https://api.test',
  timeoutMs: 100,
};
const VENDA = '11111111-2222-3333-4444-555555555555';

function makeDb(semeadas = []) {
  const runs = semeadas.map((r, i) => ({
    id: 1000 + i, ok: true, alerta: null, passos: [], duracao_ms: 100, erro: null,
    venda_id: null, venda_pendente: false, finished_at: new Date(), ...r,
  }));
  const painel = new Map();
  let seq = 0;
  const deletesDeRetencao = [];

  const query = jest.fn(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO canary_runs')) {
      const t = new Date(params[0]).getTime();
      if (runs.some((r) => new Date(r.started_at).getTime() === t)) return { rows: [] };
      const row = { id: ++seq, started_at: new Date(t), ok: null, alerta: null, passos: [], duracao_ms: null, erro: null, venda_id: null, venda_pendente: false };
      runs.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (s.startsWith('SELECT id, venda_id FROM canary_runs')) {
      return { rows: runs.filter((r) => r.venda_pendente && r.venda_id).map((r) => ({ id: r.id, venda_id: r.venda_id })) };
    }
    if (s.startsWith('UPDATE canary_runs SET finished_at')) {
      const [id, ok, passos, dur, erro, vendaId, pend] = params;
      Object.assign(runs.find((r) => r.id === id), {
        ok, passos: JSON.parse(passos), duracao_ms: dur, erro, venda_id: vendaId, venda_pendente: pend,
      });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE canary_runs SET venda_pendente')) {
      runs.find((r) => r.id === params[0]).venda_pendente = false;
      return { rows: [] };
    }
    if (s.startsWith('UPDATE canary_runs SET alerta')) {
      runs.find((r) => r.id === params[1]).alerta = params[0];
      return { rows: [] };
    }
    if (s.startsWith('SELECT id, started_at, ok, alerta')) {
      const rows = runs.filter((r) => r.ok !== null).sort((a, b) => b.started_at - a.started_at).slice(0, 40);
      return { rows };
    }
    if (s.startsWith('DELETE FROM canary_runs WHERE started_at <')) {
      const corte = new Date(params[0]).getTime();
      deletesDeRetencao.push(corte);
      const antes = runs.length;
      for (let i = runs.length - 1; i >= 0; i--) if (new Date(runs[i].started_at).getTime() < corte) runs.splice(i, 1);
      return { rows: [], rowCount: antes - runs.length };
    }
    if (s.startsWith('INSERT INTO painel_alertas')) {
      const [dia, tipo, chave, titulo, detalhe, verbo, bloco] = params;
      painel.set(`${dia}|${tipo}|${chave}`, { dia, tipo, chave, titulo, detalhe, verbo, bloco });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM painel_alertas')) {
      painel.delete(`${params[0]}|${params[1]}|${params[2]}`);
      return { rows: [] };
    }
    throw new Error('SQL inesperado no teste: ' + s.slice(0, 80));
  });

  return { query, runs, painel, deletesDeRetencao };
}

const ok = (ms = 1200) => ({
  ok: true, duracao_ms: ms, erro: null, passo_falho: null, venda_id: VENDA, venda_pendente: false,
  passos: [{ passo: 'bipe', ok: true, ms: 200 }, { passo: 'venda', ok: true, ms: 800 }],
});
const falha = (passo = 'venda', erro = 'HTTP 500 (esperado 201) — Erro ao registrar venda', ms = 4300) => ({
  ok: false, duracao_ms: 5000, erro: `${passo}: ${erro}`, passo_falho: passo, venda_id: null, venda_pendente: false,
  passos: [{ passo: 'bipe', ok: true, ms: 200 }, { passo, ok: false, ms, status: 500, erro }],
});

const mailerFake = () => ({
  sendMail: jest.fn(async () => ({ id: 'm1' })),
  escapeHtml: (s) => String(s),
  emailLayout: (h) => h,
});

// Um tick na janela de `minutos` depois de T0, com o resultado dado.
function rodar(db, minutos, resultado, extra = {}) {
  return job.tick({
    agora: min(minutos), cfg: CFG, db, mailer: extra.mailer, env: {},
    executar: jest.fn(async () => resultado),
    gerarToken: () => 'tok', ...extra,
  });
}

beforeEach(() => {
  job._resetForTests();
  for (const k of ['CANARY_COMPANY_ID', 'CANARY_USER_ID', 'CANARY_BARCODE', 'CANARY_ENABLED', 'ALERTA_EMAIL']) delete process.env[k];
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('dormência e guarda', () => {
  test('sem as envs o tick não toca o banco nem a rede', async () => {
    const db = makeDb();
    const executar = jest.fn();
    expect(await job.tick({ agora: T0, db, executar })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expect(executar).not.toHaveBeenCalled();
  });

  test('kill switch CANARY_ENABLED=false mesmo com as envs', async () => {
    Object.assign(process.env, { CANARY_COMPANY_ID: CFG.companyId, CANARY_USER_ID: CFG.userId, CANARY_BARCODE: '789', CANARY_ENABLED: 'false' });
    const db = makeDb();
    expect(await job.tick({ agora: T0, db, executar: jest.fn() })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('uma execução por janela de 5 min; a próxima janela roda de novo', async () => {
    const db = makeDb();
    const executar = jest.fn(async () => ok());
    const base = { cfg: CFG, db, executar, mailer: mailerFake(), env: {} };
    await job.tick({ ...base, agora: min(0) });
    expect(await job.tick({ ...base, agora: min(1) })).toBeNull();
    expect(await job.tick({ ...base, agora: min(4) })).toBeNull();
    expect(executar).toHaveBeenCalledTimes(1);
    await job.tick({ ...base, agora: min(5) });
    expect(executar).toHaveBeenCalledTimes(2);
    expect(db.runs.map((r) => r.started_at.toISOString())).toEqual([
      '2026-10-13T15:00:00.000Z', '2026-10-13T15:05:00.000Z',
    ]);
  });

  test('janela truncada a 5 min: um tick às 15:03 grava 15:00', async () => {
    const db = makeDb();
    await rodar(db, 3, ok(), { mailer: mailerFake() });
    expect(db.runs[0].started_at.toISOString()).toBe('2026-10-13T15:00:00.000Z');
  });

  test('trava entre réplicas: outra instância já pegou a janela → não executa', async () => {
    const db = makeDb();
    const a = jest.fn(async () => ok());
    await job.tick({ agora: min(0), cfg: CFG, db, executar: a, mailer: mailerFake(), env: {} });
    job._resetForTests(); // "outro processo": memória zerada, mesmo banco
    const b = jest.fn(async () => ok());
    expect(await job.tick({ agora: min(2), cfg: CFG, db, executar: b, mailer: mailerFake(), env: {} })).toBeNull();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(db.runs).toHaveLength(1);
  });

  test('migration 378 pendente (42P01): dormente, sem estourar', async () => {
    const db = { query: jest.fn(async () => { const e = new Error('relation "canary_runs" does not exist'); e.code = '42P01'; throw e; }) };
    expect(await job.tick({ agora: T0, cfg: CFG, db, executar: jest.fn(), mailer: mailerFake(), env: {} })).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('resultado gravado', () => {
  test('execução ok guarda passos, duração e a venda', async () => {
    const db = makeDb();
    await rodar(db, 0, ok(1500), { mailer: mailerFake() });
    expect(db.runs[0]).toMatchObject({ ok: true, duracao_ms: 1500, erro: null, venda_id: VENDA, venda_pendente: false });
    expect(db.runs[0].passos.map((p) => p.passo)).toEqual(['bipe', 'venda']);
  });

  test('execução que lança é falha do canário, gravada — nunca silêncio', async () => {
    const db = makeDb();
    await job.tick({ agora: T0, cfg: CFG, db, mailer: mailerFake(), env: {}, executar: async () => { throw new Error('estourou'); } });
    expect(db.runs[0].ok).toBe(false);
    expect(db.runs[0].erro).toMatch(/canário: estourou/);
  });
});

describe('alerta', () => {
  test('uma falha isolada não avisa; duas seguidas avisam com passo, erro e latência', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(db.painel.size).toBe(0);

    await rodar(db, 5, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.to).toBe('contato@getaura.com.br');
    expect(mail.subject).toMatch(/fora do ar.*"venda"/);
    expect(mail.text).toMatch(/Passo que falhou: venda/);
    expect(mail.text).toMatch(/Erro: venda: HTTP 500/);
    expect(mail.text).toMatch(/4\.300 ms/);
    expect(mail.text).toMatch(/2 execuções seguidas/);
    expect(db.runs[1].alerta).toBe('caiu');
    expect(db.runs[0].alerta).toBeNull();
  });

  test('ALERTA_EMAIL troca o destinatário', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer, env: { ALERTA_EMAIL: 'plantao@getaura.com.br' } });
    await rodar(db, 5, falha(), { mailer, env: { ALERTA_EMAIL: 'plantao@getaura.com.br' } });
    expect(mailer.sendMail.mock.calls[0][0].to).toBe('plantao@getaura.com.br');
  });

  test('painel: plataforma_caida entra na 2ª falha e é regravada a cada execução, sem duplicar', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, falha(), { mailer });
    await rodar(db, 10, falha('bipe', 'HTTP 500 (esperado 200)', 90), { mailer });
    expect(db.painel.size).toBe(1);
    const a = db.painel.get('2026-10-13|plataforma_caida|canary');
    expect(a).toMatchObject({ bloco: 'plataforma', verbo: 'Ver' });
    expect(a.titulo).toMatch(/Caixa fora do ar.*há 10 min/);
    expect(a.detalhe).toMatch(/bipe: HTTP 500/);
    expect(a.detalhe).toMatch(/3 execuções seguidas/);
  });

  test('silêncio enquanto continua caído: um lembrete a cada 30 min, não a cada 5', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, falha(), { mailer }); // caiu
    for (const m of [10, 15, 20, 25, 30]) await rodar(db, m, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    await rodar(db, 35, falha(), { mailer }); // 30 min depois do "caiu"
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(mailer.sendMail.mock.calls[1][0].subject).toMatch(/segue fora/);
    expect(db.runs.find((r) => r.started_at.getTime() === min(35).getTime()).alerta).toBe('repeticao');

    for (const m of [40, 45, 50, 55, 60]) await rodar(db, m, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    await rodar(db, 65, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(3);
  });

  test('recuperação: "voltou" uma vez, painel limpo, e a execução seguinte fica quieta', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, falha(), { mailer });
    expect(db.painel.size).toBe(1);

    await rodar(db, 10, ok(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(mailer.sendMail.mock.calls[1][0].subject).toMatch(/voltou/);
    expect(mailer.sendMail.mock.calls[1][0].text).toMatch(/2 execuções seguidas falhando/);
    expect(db.painel.size).toBe(0);
    expect(db.runs[2].alerta).toBe('voltou');

    await rodar(db, 15, ok(), { mailer });
    await rodar(db, 20, ok(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });

  test('depois de recuperar, uma falha solta volta a contar do zero (sem novo aviso)', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, falha(), { mailer });
    await rodar(db, 10, ok(), { mailer });
    await rodar(db, 15, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2); // caiu + voltou
    await rodar(db, 20, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(3); // nova queda
  });

  test('blip (falha, ok, falha, ok) nunca avisa e nunca mexe no painel', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, ok(), { mailer });
    await rodar(db, 10, falha(), { mailer });
    await rodar(db, 15, ok(), { mailer });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(db.painel.size).toBe(0);
  });

  test('e-mail que falha não grava o aviso: a próxima execução tenta de novo', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    mailer.sendMail.mockRejectedValueOnce(new Error('resend 500'));
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, falha(), { mailer });
    expect(db.runs[1].alerta).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[canary] e-mail de alerta falhou:', 'resend 500');

    await rodar(db, 10, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
    expect(db.runs[2].alerta).toBe('caiu');
  });

  test('o estado do aviso vem do banco: outra instância não repete o "caiu"', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, falha(), { mailer });
    await rodar(db, 5, falha(), { mailer });
    job._resetForTests(); // deploy: memória zerada
    await rodar(db, 10, falha(), { mailer });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('venda que ficou aberta', () => {
  const resp = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  test('a próxima execução estorna a pendente antes de vender de novo', async () => {
    const db = makeDb([{ started_at: min(-5), ok: false, venda_id: VENDA, venda_pendente: true }]);
    const fetch = jest.fn(async () => resp(200, { ok: true, sale_id: VENDA }));
    await rodar(db, 0, ok(), { mailer: mailerFake(), fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://api.test/api/v1/companies/${CFG.companyId}/sales/${VENDA}/cancel`);
    expect(db.runs[0].venda_pendente).toBe(false);
  });

  test('estorno que continua falhando mantém a pendência', async () => {
    const db = makeDb([{ started_at: min(-5), ok: false, venda_id: VENDA, venda_pendente: true }]);
    const fetch = jest.fn(async () => resp(500, { error: 'boom' }));
    await rodar(db, 0, ok(), { mailer: mailerFake(), fetch });
    expect(db.runs[0].venda_pendente).toBe(true);
  });
});

describe('retenção de 30 dias', () => {
  test('apaga o que passou de 30 dias e guarda o resto', async () => {
    const dia = 86400000;
    const db = makeDb([
      { started_at: new Date(T0.getTime() - 31 * dia) },
      { started_at: new Date(T0.getTime() - 29 * dia) },
    ]);
    await rodar(db, 0, ok(), { mailer: mailerFake() });
    expect(db.deletesDeRetencao).toEqual([T0.getTime() - 30 * dia]);
    expect(db.runs.map((r) => r.started_at.getTime())).toEqual([T0.getTime() - 29 * dia, T0.getTime()]);
  });

  test('a limpeza roda no máximo uma vez por hora', async () => {
    const db = makeDb();
    const mailer = mailerFake();
    await rodar(db, 0, ok(), { mailer });
    await rodar(db, 5, ok(), { mailer });
    await rodar(db, 30, ok(), { mailer });
    expect(db.deletesDeRetencao).toHaveLength(1);
    await rodar(db, 65, ok(), { mailer });
    expect(db.deletesDeRetencao).toHaveLength(2);
  });
});

describe('decidir (pura)', () => {
  const alerta = require('../../src/services/canaryAlerta');
  const r = (m, okk, al = null) => ({ started_at: min(m), ok: okk, alerta: al });

  test('o limite do lembrete é 30 min cravados', () => {
    const base = [r(30, false), r(25, false), r(20, false), r(15, false), r(10, false), r(5, false, 'caiu'), r(0, false)];
    expect(alerta.decidir(base.slice(1), min(30))).toBeNull(); // 25 min
    expect(alerta.decidir(base, min(35))).toMatchObject({ tipo: 'repeticao' });
  });

  test('ok depois de queda NUNCA avisada não manda "voltou"', () => {
    expect(alerta.decidir([r(10, true), r(5, false), r(0, true)], min(10))).toBeNull();
  });
});
