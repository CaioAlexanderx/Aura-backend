'use strict';
// Alerta de linha parada em 'sending' (wa_outbox) — banco simulado.
// A SQL real contra Postgres esta em waSendingParadaJob.banco.test.js.

const { verificarSendingParadas, PARADA_MIN, MARCA_ALERTADA } = require('../src/jobs/waSendingParadaJob');

function fakeDb({ recupera = [], claim = [], alertaFalha = false } = {}) {
  const db = { query: jest.fn() };
  db.query.mockImplementation(async (sql, params) => {
    if (/wa:sending-parada-recupera/.test(sql)) return { rows: recupera };
    if (/wa:sending-parada-claim/.test(sql)) return { rows: claim };
    if (/wa:sending-parada-alerta/.test(sql)) {
      if (alertaFalha) throw Object.assign(new Error('boom'), { code: 'XX000' });
      return { rows: [] };
    }
    return { rows: [] };
  });
  return db;
}
const chamadas = (db, re) => db.query.mock.calls.filter((c) => re.test(c[0]));

test('com wamid: marca sent, sem alerta e sem reenvio', async () => {
  const db = fakeDb({ recupera: [{ id: 'o1', company_id: 'c1', wa_message_id: 'wamid.X' }] });
  const log = jest.fn();
  const r = await verificarSendingParadas({ db, log });
  expect(r).toEqual({ recuperadas: 1, alertadas: 0 });
  expect(chamadas(db, /wa:sending-parada-alerta/)).toHaveLength(0);
  const sql = chamadas(db, /wa:sending-parada-recupera/)[0];
  expect(sql[0]).toMatch(/SET status = 'sent'/);
  expect(sql[0]).toMatch(/wa_message_id IS NOT NULL/);
  expect(sql[1]).toEqual([String(PARADA_MIN)]);
});

test('sem wamid: alerta a equipe Aura (alert_history) e loga; nada e reenviado', async () => {
  const db = fakeDb({ claim: [{ id: 'o2', company_id: 'c2', kind: 'text', source_type: 'humano', template_name: null, updated_at: new Date() }] });
  const log = jest.fn();
  const r = await verificarSendingParadas({ db, log });
  expect(r).toEqual({ recuperadas: 0, alertadas: 1 });
  const ins = chamadas(db, /wa:sending-parada-alerta/);
  expect(ins).toHaveLength(1);
  expect(ins[0][0]).toMatch(/INSERT INTO alert_history/);
  expect(ins[0][1][0]).toBe('c2');
  expect(ins[0][1][2]).toMatch(/outbox o2/);
  expect(JSON.parse(ins[0][1][3]).outbox_id).toBe('o2');
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/outbox=o2.*NAO reenviada/));
  // nunca mexe em status para pending (reenvio)
  expect(db.query.mock.calls.some((c) => /status\s*=\s*'pending'/.test(c[0]))).toBe(false);
});

test('a SQL do claim so pega sem wamid, nao alertadas, e nao toca updated_at', async () => {
  const db = fakeDb();
  await verificarSendingParadas({ db, log: jest.fn() });
  const sql = chamadas(db, /wa:sending-parada-claim/)[0][0];
  expect(sql).toMatch(/wa_message_id IS NULL/);
  expect(sql).toContain(`last_error IS DISTINCT FROM '${MARCA_ALERTADA}'`);
  expect(sql).toMatch(/SET last_error = '[A-Z_]+'\s+WHERE/);
});

test('sem linhas: silencio', async () => {
  const log = jest.fn();
  expect(await verificarSendingParadas({ db: fakeDb(), log })).toEqual({ recuperadas: 0, alertadas: 0 });
  expect(log).not.toHaveBeenCalled();
});

test('falha ao gravar o alerta desfaz o carimbo (proxima rodada tenta de novo)', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const db = fakeDb({ claim: [{ id: 'o3', company_id: 'c3', kind: 'text', source_type: 'x' }], alertaFalha: true });
  expect(await verificarSendingParadas({ db, log: jest.fn() })).toBeNull();
  expect(chamadas(db, /wa:sending-parada-unclaim/)).toHaveLength(1);
  spy.mockRestore();
});

test('schema parcial (42P01) nao quebra', async () => {
  const db = { query: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' })) };
  expect(await verificarSendingParadas({ db, log: jest.fn() })).toBeNull();
});
