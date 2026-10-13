// ============================================================
// AURA — Funil do trial: último acesso de verdade (12/10/2026)
//
// companies.last_active_at era NULL em todas as contas: ninguém gravava.
// requireCompanyAccess agora dispara UPDATE last_active_at = NOW() depois de
// resolver o papel — no máximo uma vez a cada 15 minutos por empresa, sem
// aguardar o banco e sem nunca bloquear o request. Staff em modo admin
// (bypass role='admin') não conta como acesso do cliente.
//
// O jest.setup.js troca o trialFunnel por no-op para não sujar os mocks dos
// outros testes; aqui ele volta a ser o real.
// ============================================================
'use strict';

jest.unmock('../src/services/trialFunnel');

const db = require('../src/config/database');
const { requireCompanyAccess } = require('../src/middleware/auth');
const trialFunnel = require('../src/services/trialFunnel');

const CID = 'company-trial-1';
const OTHER = 'company-trial-2';

function arrangeDb({ role = 'owner', updateError = null } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/UPDATE companies SET last_active_at/i.test(sql)) {
      if (updateError) throw updateError;
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT 'owner' AS role/i.test(sql)) return { rows: role ? [{ role }] : [] };
    throw new Error('SQL inesperado: ' + sql);
  });
}

const updates = () => db.query.mock.calls.filter(([sql]) => /UPDATE companies SET last_active_at/i.test(sql));

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

async function hit(companyId, user = { id: 'user-1', role: 'user' }) {
  const req = { user, params: { id: companyId } };
  const res = mockRes();
  const next = jest.fn();
  await requireCompanyAccess()(req, res, next);
  // O UPDATE é disparado num microtask: deixa a fila andar.
  await new Promise((r) => setImmediate(r));
  return { req, res, next };
}

let warn;
beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-10-12T13:00:00Z'));
  trialFunnel._resetForTests();
  db.query.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  warn.mockRestore();
});

describe('requireCompanyAccess grava last_active_at', () => {
  test('duas chamadas seguidas geram um UPDATE só', async () => {
    arrangeDb();
    const a = await hit(CID);
    const b = await hit(CID);
    expect(a.next).toHaveBeenCalledTimes(1);
    expect(b.next).toHaveBeenCalledTimes(1);
    expect(updates()).toHaveLength(1);
    expect(updates()[0][1]).toEqual([CID]);
  });

  test('depois de 15 minutos gera outro UPDATE', async () => {
    arrangeDb();
    await hit(CID);
    jest.advanceTimersByTime(14 * 60 * 1000);
    await hit(CID);
    expect(updates()).toHaveLength(1);
    jest.advanceTimersByTime(60 * 1000);
    await hit(CID);
    expect(updates()).toHaveLength(2);
  });

  test('o throttle é por empresa', async () => {
    arrangeDb();
    await hit(CID);
    await hit(OTHER);
    expect(updates().map(([, p]) => p[0])).toEqual([CID, OTHER]);
  });

  test('staff em modo admin não conta como acesso', async () => {
    arrangeDb();
    const { next, req } = await hit(CID, { id: 'staff-1', role: 'admin' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.companyRole).toBe('admin');
    expect(updates()).toHaveLength(0);
  });

  test('acesso negado não grava', async () => {
    arrangeDb({ role: null });
    const { next, res } = await hit(CID);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(updates()).toHaveLength(0);
  });

  test('UPDATE que falha não bloqueia o request e avisa uma vez só', async () => {
    arrangeDb({ updateError: Object.assign(new Error('pooler cheio'), { code: '53300' }) });
    const a = await hit(CID);
    const b = await hit(OTHER);
    expect(a.next).toHaveBeenCalledTimes(1);
    expect(b.next).toHaveBeenCalledTimes(1);
    expect(a.res.status).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
