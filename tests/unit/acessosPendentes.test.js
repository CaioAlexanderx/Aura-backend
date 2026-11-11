// ============================================================
// services/acessosPendentes (p-106) — partes que a rota não exercita:
// leitura do extra_seats, fallback sem seat_passes, nunca lança.
// ============================================================
'use strict';

const svc = require('../../src/services/acessosPendentes');

const fakeDb = (impl) => ({ query: jest.fn(impl) });
const erro = (code) => Object.assign(new Error('x' + code), { code });

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('lerExtraSeats', () => {
  test('ausente', () => {
    expect(svc.lerExtraSeats(undefined)).toEqual({ presente: false });
    expect(svc.lerExtraSeats(null)).toEqual({ presente: false });
  });
  test('válidos', () => {
    expect(svc.lerExtraSeats(0)).toEqual({ presente: true, valor: 0 });
    expect(svc.lerExtraSeats(10)).toEqual({ presente: true, valor: 10 });
    expect(svc.lerExtraSeats(' 4 ')).toEqual({ presente: true, valor: 4 });
  });
  test.each([-1, 11, 1.5, NaN, Infinity, '1e1', '-1', '', 'dois', {}, false])('inválido: %p', (v) => {
    expect(svc.lerExtraSeats(v).erro).toMatch(/de 0 a 10/);
  });
});

describe('aplicarPendenciaDoPagamento', () => {
  const linha = { id: 'c1', plan: 'negocio', billing_cycle: 'monthly', billing_status: 'active',
    asaas_subscription_id: 'sub_1', extra_seats_granted: 5, pendente: 3, antes: 2 };

  test('aplica, sincroniza e audita', async () => {
    const db = fakeDb(async (sql) => (sql.includes('WITH alvo') ? { rows: [linha] } : { rows: [] }));
    const sync = jest.fn().mockResolvedValue({ updated: false, skipped: 'value_unchanged', value: 264 });
    const r = await svc.aplicarPendenciaDoPagamento({ companyId: 'c1', payment: { id: 'pay_1', subscription: 'sub_1' } }, { db, sync });
    expect(r).toMatchObject({ aplicado: true, extra_seats_granted: 5, pendente: 3, temporada: 2 });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1', extra_seats_granted: 5 }));
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('seat_passes');
    expect(params).toEqual(['c1', 'pay_1', 'sub_1']);
    const audit = db.query.mock.calls.find((c) => c[0].includes('INSERT INTO audit_log'));
    expect(audit[1][2]).toBe('billing.extra_seats_applied');
  });

  test('sem seat_passes (42P01): refaz sem a temporada', async () => {
    let n = 0;
    const db = fakeDb(async (sql) => {
      if (sql.includes('WITH alvo')) {
        n += 1;
        if (sql.includes('seat_passes')) throw erro('42P01');
        return { rows: [{ ...linha, extra_seats_granted: 3, antes: 0 }] };
      }
      return { rows: [] };
    });
    const r = await svc.aplicarPendenciaDoPagamento({ companyId: 'c1', payment: { id: 'pay_1' } },
      { db, sync: async () => ({ skipped: 'no_subscription' }) });
    expect(n).toBe(2);
    expect(r).toMatchObject({ aplicado: true, extra_seats_granted: 3, temporada: 0 });
  });

  test('nada pendente para esta cobrança', async () => {
    const db = fakeDb(async () => ({ rows: [] }));
    const sync = jest.fn();
    const r = await svc.aplicarPendenciaDoPagamento({ companyId: 'c1', payment: { id: 'pay_x' } }, { db, sync });
    expect(r).toEqual({ aplicado: false, motivo: 'sem_pendencia' });
    expect(sync).not.toHaveBeenCalled();
  });

  test('coluna ausente (42703) e erro qualquer: nunca lança', async () => {
    const r1 = await svc.aplicarPendenciaDoPagamento({ companyId: 'c1', payment: { id: 'p' } },
      { db: fakeDb(async () => { throw erro('42703'); }) });
    expect(r1).toEqual({ aplicado: false, motivo: 'migration_pendente' });
    const r2 = await svc.aplicarPendenciaDoPagamento({ companyId: 'c1', payment: { id: 'p' } },
      { db: fakeDb(async () => { throw new Error('caiu'); }) });
    expect(r2).toMatchObject({ aplicado: false, motivo: 'erro' });
  });

  test('sync que lança não desfaz a liberação', async () => {
    const db = fakeDb(async (sql) => (sql.includes('WITH alvo') ? { rows: [linha] } : { rows: [] }));
    const r = await svc.aplicarPendenciaDoPagamento({ companyId: 'c1', payment: { id: 'pay_1' } },
      { db, sync: async () => { throw new Error('asaas fora'); } });
    expect(r.aplicado).toBe(true);
    expect(r.sync).toMatchObject({ skipped: 'error' });
  });
});

describe('gravarPendencia', () => {
  test('grava e limpa', async () => {
    const db = fakeDb(async () => ({ rows: [] }));
    expect(await svc.gravarPendencia('c1', { qty: 2, subscriptionId: 's', paymentId: 'p' }, { db })).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual(['c1', 2, 's', 'p']);
    await svc.gravarPendencia('c1', { qty: null, subscriptionId: 's' }, { db });
    expect(db.query.mock.calls[1][1]).toEqual(['c1', null, null, null]);
  });
  test('falha não lança', async () => {
    expect(await svc.gravarPendencia('c1', { qty: 1 }, { db: fakeDb(async () => { throw erro('42703'); }) })).toBe(false);
    expect(await svc.gravarPendencia('c1', { qty: 1 }, { db: fakeDb(async () => { throw new Error('x'); }) })).toBe(false);
  });
});
