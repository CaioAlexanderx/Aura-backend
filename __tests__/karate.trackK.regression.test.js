// ============================================================
// AURA KARATÊ — Track K: REGRESSÕES (bugs B1 e B2)
//
// B1 — settleAnnuity marca a anuidade do header como PAGA (status='paid').
//      Historicamente o CHECK da migration 152 proibia 'paid' e setar esse
//      status estourava 23514 — daí o fix antigo escrever só paid_at. A
//      migration 219 AMPLIOU o CHECK para incluir 'pending'/'paid' (o mesmo
//      vocabulário que a conciliação canônica já grava), então setar
//      status='paid' agora é correto e necessário: as leituras (GET
//      /annuities/dojos, summary) derivam "pago" de status='paid', não de
//      paid_at. Este teste passou a exigir status='paid' (pós-219).
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

// Conjunto de status permitidos pelo CHECK — pós-migration 219 (une a saúde
// da filiação com o ciclo de pagamento: inclui 'pending' e 'paid').
const ALLOWED_ANNUITY_STATUS = ['active', 'expiring', 'overdue', 'defaulting', 'suspended', 'pending', 'paid'];

// ════════════════════════════════════════════════════════════
// B1 — annuity_paid marca status='paid' (pós-219) sem violar o CHECK
// ════════════════════════════════════════════════════════════
describe('B1 — settleAnnuity marca a anuidade como paga (migration 219)', () => {
  // Mock client que ENFORÇA o CHECK: se um UPDATE em
  // karate_dojo_annuity_history setar status para fora da lista permitida,
  // estoura 23514 (check_violation), exatamente como o Postgres real.
  function makeCheckEnforcingClient(annuityUpdateRows) {
    const calls = [];
    const query = jest.fn().mockImplementation((sql, params) => {
      calls.push({ sql, params });
      const s = String(sql);

      // claim (INSERT karate_sync_applied ... RETURNING id) → reivindica
      if (/INSERT\s+INTO\s+karate_sync_applied/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 'applied-b1' }] });
      }

      // o UPDATE da anuidade
      if (/UPDATE\s+karate_dojo_annuity_history/i.test(s)) {
        // Se o SQL tentar escrever uma string literal status='X' inválida
        // (fora da lista pós-219), simula o check_violation como o Postgres.
        const m = s.match(/SET[\s\S]*?status\s*=\s*'([^']+)'/i);
        if (m && !ALLOWED_ANNUITY_STATUS.includes(m[1])) {
          const e = new Error(
            `new row for relation "karate_dojo_annuity_history" violates check constraint`
          );
          e.code = '23514';
          return Promise.reject(e);
        }
        return Promise.resolve({ rows: annuityUpdateRows });
      }

      // tagApplied UPDATE karate_sync_applied
      return Promise.resolve({ rows: [] });
    });
    return { query, calls };
  }

  it('seta status=paid e paid_at (sem violar o CHECK pós-219) quando há cobrança a conciliar', async () => {
    const client = makeCheckEnforcingClient([{ id: 'ann-1' }]);
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N1', reference_period: '2026', amount: 100, paid_at: '2026-06-01' },
    }));

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('annuity');
    expect(res.settled).toBe(true);

    // Encontra o UPDATE da anuidade e inspeciona o SQL emitido.
    const updCall = client.calls.find(c => /UPDATE\s+karate_dojo_annuity_history/i.test(String(c.sql)));
    expect(updCall).toBeTruthy();
    const sql = String(updCall.sql);

    // Marca a anuidade como PAGA (é o status que as leituras derivam como "pago").
    expect(sql).toMatch(/SET[\s\S]*?status\s*=\s*'paid'/i);

    // e continua setando paid_at (sinal que para a régua de lembretes)
    expect(sql).toMatch(/paid_at\s*=/i);

    // WHERE com paid_at IS NULL (no-op idempotente quando já liquidado)
    expect(sql).toMatch(/WHERE[\s\S]*paid_at\s+IS\s+NULL/i);
  });

  it('sem cobrança prévia: settled=false, ainda sem violar o CHECK (drena idempotente)', async () => {
    const client = makeCheckEnforcingClient([]); // UPDATE não casa nenhuma linha
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N2', reference_period: '2099' },
    }));
    expect(res.ok).toBe(true);
    expect(res.settled).toBe(false);
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
});
