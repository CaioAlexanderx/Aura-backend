// ============================================================
// AURA KARATÊ — Track K: REGRESSÕES (bugs B1 e B2)
//
// B1 (reescrito na F2-sync) — o header NUNCA pode ficar 'paid' com parcela
//      não paga. Antes, settleAnnuity escrevia direto no header (paid_at) e o
//      histórico do bug era o CHECK de status (migration 152/219). Agora o
//      sync LIQUIDA A PARCELA pelo primitivo do ledger e o header é DERIVADO
//      por syncAnnuityHeaderRollup — que só marca 'paid' quando TODAS as
//      parcelas pagam. Esta é EXATAMENTE a invariante do guardrail (Tarefa 3):
//      um pagamento parcial jamais marca a anuidade como paga.
//
// B2 — deferred (schema da Track K ausente, 42P01) NÃO pode ser drenado
//      como sucesso. No motor LIGHT (processFederationQueue) e no runner
//      dedicado (runFederationApply), um deferred deve fazer ROLLBACK e
//      deixar o evento 'pending' (sem status='ok', sem bump de attempts).
//
// Estes testes são "engine/runner-level": exercitam o caminho da fila com
// um db mockado — não só o núcleo puro.
// ============================================================
'use strict';

const { applyEvent } = require('../src/services/karateApplyEvent');
const { createFakeClient } = require('../tests/helpers/fakeSyncAnnuityDb');

const FED = 'fed-0000-0000-0000-000000000001';
const DOJO = 'dojo-0000-0000-0000-000000000001';

function ev(overrides = {}) {
  return {
    id: 'evt-1',
    connection_id: 'conn-1',
    federation_id: FED,
    dojo_id: DOJO,
    direction: 'dojo_to_fed',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════
// B1 (F2-sync) — header 'paid' ⇒ TODAS as parcelas pagas
// ════════════════════════════════════════════════════════════
describe("B1 — header nunca fica 'paid' com parcela não paga (invariante do guardrail)", () => {
  function seed(installments) {
    return {
      header: {
        id: 'ann-1', dojo_id: DOJO, federation_id: FED, reference_period: '2026',
        status: 'pending', paid_at: null, amount: 0, due_date: null,
        payment_method: null, transaction_id: null,
      },
      installments,
      payments: [],
      claims: [],
    };
  }
  function inst(o) {
    return {
      id: 'i1', annuity_id: 'ann-1', federation_id: FED, seq: 1, amount: 500,
      amount_paid: 0, status: 'pending', due_date: '2026-05-31', kind: 'anuidade',
      payment_method: null, paid_at: null, transaction_id: null, ...o,
    };
  }

  it('pagamento CHEIO → parcela paga e header DERIVA paid', async () => {
    const state = seed([inst({ amount: 100 })]);
    const client = createFakeClient(state);
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N1', reference_period: '2026', amount: 100, paid_at: '2026-06-01' },
    }));

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('annuity');
    expect(res.settled).toBe(true);
    expect(state.installments[0].status).toBe('paid');
    expect(state.header.status).toBe('paid');
  });

  it('pagamento PARCIAL → header DERIVA pending, NUNCA paid (o bug que o guardrail pega)', async () => {
    const state = seed([inst({ amount: 500 })]);
    const client = createFakeClient(state);
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N1b', reference_period: '2026', amount: 300 },
    }));

    expect(res.ok).toBe(true);
    expect(res.settled).toBe(true);
    expect(state.installments[0].status).toBe('partial');
    // invariante: header 'paid' ⇒ todas pagas. Aqui NÃO está pago.
    expect(state.header.status).not.toBe('paid');
    expect(state.header.status).toBe('pending');
  });

  it('sem cobrança prévia: HOLD (park-and-replay) — não drena, não aplica', async () => {
    const state = { header: null, installments: [], payments: [], claims: [] };
    const client = createFakeClient(state);
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N2', reference_period: '2099' },
    }));
    expect(res.ok).toBe(false);
    expect(res.hold).toBe(true);
    expect(state.payments).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
// B2 (engine) — processFederationQueue não drena um deferred
// ════════════════════════════════════════════════════════════
describe('B2 (engine) — deferred mantém pending, não vira status=ok', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('consumidor deferred → ROLLBACK, sem UPDATE status=ok, summary.deferred=1', async () => {
    const pendingEvent = ev({ id: 'evt-def', event_type: 'annuity_paid', attempts: 0, payload: { reference_period: '2026' } });

    const clientQueries = [];
    const fakeClient = {
      query: jest.fn().mockImplementation((sql) => {
        clientQueries.push(String(sql));
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };

    const dbQueries = [];
    const fakeDb = {
      query: jest.fn().mockImplementation((sql, params) => {
        dbQueries.push({ sql: String(sql), params });
        // 1ª chamada: SELECT pending events
        if (/FROM\s+karate_sync_events\s+WHERE\s+federation_id/i.test(String(sql))
            && /status\s*=\s*'pending'/i.test(String(sql))) {
          return Promise.resolve({ rows: [pendingEvent] });
        }
        // health-update no fim → ignorar
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      connect: jest.fn().mockResolvedValue(fakeClient),
    };

    jest.doMock('../src/config/database', () => fakeDb);
    // Consumidor força deferred (como se a migration 179 não existisse).
    jest.doMock('../src/services/karateApplyEvent', () => ({
      applyEvent: jest.fn().mockResolvedValue({ ok: false, deferred: true, applied: false }),
      isMissingSchema: (e) => e && (e.code === '42P01' || e.code === '42703'),
    }));

    const engine = require('../src/services/karateSyncEngine');
    const res = await engine.processFederationQueue(FED);

    // (regressão B2) deferred não conta como aplicado.
    expect(res.deferred).toBe(1);
    expect(res.applied).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.retried).toBe(0);

    // ROLLBACK foi emitido na transação do evento.
    expect(clientQueries.some(q => /ROLLBACK/i.test(q))).toBe(true);
    // NÃO houve UPDATE marcando status='ok'.
    expect(clientQueries.some(q => /UPDATE\s+karate_sync_events[\s\S]*status\s*=\s*'ok'/i.test(q))).toBe(false);
    // NÃO houve UPDATE bumpando attempts (não é falha).
    expect(clientQueries.some(q => /UPDATE\s+karate_sync_events[\s\S]*attempts\s*=/i.test(q))).toBe(false);
    // NÃO houve COMMIT da transação do evento.
    expect(clientQueries.some(q => /COMMIT/i.test(q))).toBe(false);
  });

  it('consumidor ok → status=ok + COMMIT (caminho de sucesso intacto)', async () => {
    const pendingEvent = ev({ id: 'evt-ok', event_type: 'practitioner_added', payload: { full_name: 'X', cpf: '1' } });
    const clientQueries = [];
    const fakeClient = {
      query: jest.fn().mockImplementation((sql) => { clientQueries.push(String(sql)); return Promise.resolve({ rows: [] }); }),
      release: jest.fn(),
    };
    const fakeDb = {
      query: jest.fn().mockImplementation((sql) => {
        if (/FROM\s+karate_sync_events/i.test(String(sql)) && /'pending'/i.test(String(sql))) {
          return Promise.resolve({ rows: [pendingEvent] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      connect: jest.fn().mockResolvedValue(fakeClient),
    };
    jest.doMock('../src/config/database', () => fakeDb);
    jest.doMock('../src/services/karateApplyEvent', () => ({
      applyEvent: jest.fn().mockResolvedValue({ ok: true, applied: true, kind: 'practitioner' }),
      isMissingSchema: (e) => e && (e.code === '42P01' || e.code === '42703'),
    }));

    const engine = require('../src/services/karateSyncEngine');
    const res = await engine.processFederationQueue(FED);

    expect(res.applied).toBe(1);
    expect(res.deferred).toBe(0);
    expect(clientQueries.some(q => /UPDATE\s+karate_sync_events[\s\S]*status='ok'/i.test(q))).toBe(true);
    expect(clientQueries.some(q => /COMMIT/i.test(q))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════
// B2 (runner) — rollback desfaz o claim; deferred mantém pending
// ════════════════════════════════════════════════════════════
describe('B2 (runner) — runFederationApply: rollback-undoes-claim + deferred pending', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  function setupRunner({ pendingEvent, consumerResult, consumerThrow }) {
    const clientQueries = [];
    const fakeClient = {
      query: jest.fn().mockImplementation((sql) => { clientQueries.push(String(sql)); return Promise.resolve({ rows: [] }); }),
      release: jest.fn(),
    };
    const fakeDb = {
      query: jest.fn().mockImplementation((sql) => {
        if (/FROM\s+karate_sync_events/i.test(String(sql)) && /'pending'/i.test(String(sql))) {
          return Promise.resolve({ rows: [pendingEvent] });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      connect: jest.fn().mockResolvedValue(fakeClient),
    };
    jest.doMock('../src/config/database', () => fakeDb);
    jest.doMock('../src/services/karateApplyEvent', () => ({
      applyEvent: jest.fn().mockImplementation(() => {
        if (consumerThrow) {
          const e = new Error(consumerThrow.message);
          if (consumerThrow.recoverable) e.recoverable = true;
          return Promise.reject(e);
        }
        return Promise.resolve(consumerResult);
      }),
      isMissingSchema: (e) => e && (e.code === '42P01' || e.code === '42703'),
    }));
    return { clientQueries, fakeClient };
  }

  it('falha recuperável → ROLLBACK ANTES do UPDATE de status (desfaz o claim)', async () => {
    const pendingEvent = ev({ id: 'evt-r', event_type: 'attendance', attempts: 0, payload: { cpf: '404', session_date: '2026-06-10' } });
    const { clientQueries } = setupRunner({
      pendingEvent,
      consumerThrow: { message: 'praticante não encontrado', recoverable: true },
    });

    const runner = require('../src/services/karateSyncApplyRunner');
    const summary = await runner.runFederationApply(FED);

    expect(summary.retried).toBe(1);
    expect(summary.failed).toBe(0);

    const rollbackIdx = clientQueries.findIndex(q => /ROLLBACK/i.test(q));
    const statusUpdIdx = clientQueries.findIndex(q => /UPDATE\s+karate_sync_events[\s\S]*attempts\s*=/i.test(q));
    expect(rollbackIdx).toBeGreaterThanOrEqual(0);
    expect(statusUpdIdx).toBeGreaterThanOrEqual(0);
    // (regressão) ROLLBACK precede o UPDATE de status — senão o claim de
    // dedupe persistiria e a re-tentativa nunca aplicaria.
    expect(rollbackIdx).toBeLessThan(statusUpdIdx);
  });

  it('deferred → ROLLBACK, mantém pending, sem bump de attempts', async () => {
    const pendingEvent = ev({ id: 'evt-d', event_type: 'annuity_paid', attempts: 0, payload: { reference_period: '2026' } });
    const { clientQueries } = setupRunner({
      pendingEvent,
      consumerResult: { ok: false, deferred: true, applied: false },
    });

    const runner = require('../src/services/karateSyncApplyRunner');
    const summary = await runner.runFederationApply(FED);

    expect(summary.deferred).toBe(1);
    expect(summary.applied).toBe(0);
    expect(summary.retried).toBe(0);
    expect(summary.failed).toBe(0);
    expect(clientQueries.some(q => /ROLLBACK/i.test(q))).toBe(true);
    // sem UPDATE de status (nem ok, nem attempts).
    expect(clientQueries.some(q => /UPDATE\s+karate_sync_events/i.test(q))).toBe(false);
  });

  it('hold (park-and-replay) → ROLLBACK, mantém pending, sem bump de attempts', async () => {
    const pendingEvent = ev({ id: 'evt-h', event_type: 'annuity_paid', attempts: 0, payload: { reference_period: '2026' } });
    const { clientQueries } = setupRunner({
      pendingEvent,
      consumerResult: { ok: false, hold: true, applied: false },
    });

    const runner = require('../src/services/karateSyncApplyRunner');
    const summary = await runner.runFederationApply(FED);

    // park-and-replay: não drena, não falha, não re-tenta com bump — fica pending.
    expect(summary.held).toBe(1);
    expect(summary.applied).toBe(0);
    expect(summary.retried).toBe(0);
    expect(summary.failed).toBe(0);
    expect(clientQueries.some(q => /ROLLBACK/i.test(q))).toBe(true);
    // ROLLBACK desfaz o claim; sem UPDATE de status (nem ok, nem attempts).
    expect(clientQueries.some(q => /UPDATE\s+karate_sync_events/i.test(q))).toBe(false);
  });
});
