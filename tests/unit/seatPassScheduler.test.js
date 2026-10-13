// ============================================================
// jobs/seatPassScheduler — quando a rodada diaria dispara.
// A regra (expirar/aplicar/ressincronizar) e' testada com Postgres real em
// tests/integration/seatPassLive.test.js; aqui so o gatilho.
// ============================================================
'use strict';

const sched = require('../../src/jobs/seatPassScheduler');

// 2026-11-01 as HH:00 em Brasilia (UTC-3)
const brt = (iso, hora) => Date.parse(iso + 'T00:00:00Z') + (hora + 3) * 3600000;

const ok = () => jest.fn(async () => ({ hoje: 'x', expirados: 1, aplicados: 0, cancelados: 0, ressincronizados: 0, erros: [] }));

beforeEach(() => {
  sched._resetForTests();
  delete process.env.SEAT_PASS_JOB_ENABLED;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('antes da 01h BRT nao roda', () => {
  const rodar = ok();
  expect(sched.tick({ rodar, agoraMs: brt('2027-02-01', 0) })).toBeNull();
  expect(rodar).not.toHaveBeenCalled();
});

test('a partir da 01h roda uma vez por dia, com a data de Brasilia', async () => {
  const rodar = ok();
  await sched.tick({ rodar, agoraMs: brt('2027-02-01', 1) });
  expect(rodar).toHaveBeenCalledTimes(1);
  expect(rodar.mock.calls[0][0].hoje).toBe('2027-02-01');

  expect(sched.tick({ rodar, agoraMs: brt('2027-02-01', 9) })).toBeNull();
  expect(rodar).toHaveBeenCalledTimes(1);

  await sched.tick({ rodar, agoraMs: brt('2027-02-02', 1) });
  expect(rodar).toHaveBeenCalledTimes(2);
});

test('21h de 31/01 em Brasilia ainda e 31/01 (nao expira antes da hora)', async () => {
  const rodar = ok();
  await sched.tick({ rodar, agoraMs: brt('2027-01-31', 21) });
  expect(rodar.mock.calls[0][0].hoje).toBe('2027-01-31');
});

test('rodada com erro (Asaas fora) tenta de novo em 30 min, nao no proximo dia', async () => {
  const rodar = jest.fn()
    .mockResolvedValueOnce({ expirados: 0, erros: [{ pass_id: 'p1', etapa: 'expirar', erro: 'Asaas fora' }] })
    .mockResolvedValue({ expirados: 1, erros: [] });
  const t0 = brt('2027-02-01', 6);

  await sched.tick({ rodar, agoraMs: t0 });
  expect(sched.tick({ rodar, agoraMs: t0 + 5 * 60000 })).toBeNull();      // dentro da espera
  await sched.tick({ rodar, agoraMs: t0 + 31 * 60000 });                   // passou
  expect(rodar).toHaveBeenCalledTimes(2);
  expect(sched.tick({ rodar, agoraMs: t0 + 90 * 60000 })).toBeNull();      // deu certo: dia feito
});

test('tabela ausente (migration 374 pendente) nao derruba e tenta depois', async () => {
  const rodar = jest.fn(async () => { const e = new Error('relation "seat_passes" does not exist'); e.code = '42P01'; throw e; });
  const r = await sched.tick({ rodar, agoraMs: brt('2026-10-14', 3) });
  expect(r.semTabela).toBe(true);
  expect(sched.tick({ rodar, agoraMs: brt('2026-10-14', 3) + 60000 })).toBeNull();
});

test('kill switch SEAT_PASS_JOB_ENABLED=false', () => {
  process.env.SEAT_PASS_JOB_ENABLED = 'false';
  const rodar = ok();
  expect(sched.tick({ rodar, agoraMs: brt('2027-02-01', 6) })).toBeNull();
  expect(rodar).not.toHaveBeenCalled();
});
