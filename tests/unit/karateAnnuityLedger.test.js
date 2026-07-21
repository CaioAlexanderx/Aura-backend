// ============================================================
// AURA KARATÊ — Testes unitários: src/services/karateAnnuityLedger.js
// F1 da reforma da anuidade (21/07/2026) — motor de baixa FIFO.
//
// Sem Postgres real (mock de src/config/database, mesmo padrão de
// tests/unit/creditLedger.test.js) — os testes de FIFO/status/excedente
// batem direto em computeDistribution (motor puro, mesma técnica de
// tests/unit/creditUnify.test.js); dry-run/commit/dupla-escrita batem em
// applyAnnuityPayment com um client mockado que interpreta o SQL.
// ============================================================
'use strict';

jest.mock('../../src/services/karateAnnuityService', () => ({
  syncAnnuityHeaderRollup: jest.fn(async (client, annuityId) => ({
    id: annuityId,
    status: 'header-mock',
  })),
}));

const db = require('../../src/config/database');
const annuitySvc = require('../../src/services/karateAnnuityService');
const {
  applyAnnuityPayment,
  computeDistribution,
  deriveStatusFromAmountPaid,
  toIsoDate,
  AnnuityPaymentError,
} = require('../../src/services/karateAnnuityLedger');

function makeInstallment(overrides) {
  return {
    id: 'inst-1',
    annuity_id: 'annuity-1',
    federation_id: 'fed-1',
    seq: 1,
    amount: 100,
    amount_paid: 0,
    status: 'pending',
    due_date: new Date('2026-05-31T00:00:00.000Z'),
    kind: 'anuidade',
    ...overrides,
  };
}

// Client mockado que interpreta o SQL por regex (BEGIN/COMMIT/ROLLBACK,
// SELECT...FOR UPDATE devolve `rows` fixo, UPDATE/INSERT são registrados
// para asserção) — evita depender de Postgres real.
function makeMockClient(rows) {
  const calls = { update: [], insert: [], begin: 0, commit: 0, rollback: 0 };
  const query = jest.fn((sql, params) => {
    const text = String(sql).trim();
    if (/^BEGIN/.test(text)) { calls.begin++; return Promise.resolve({}); }
    if (/^COMMIT/.test(text)) { calls.commit++; return Promise.resolve({}); }
    if (/^ROLLBACK/.test(text)) { calls.rollback++; return Promise.resolve({}); }
    if (/FOR UPDATE/.test(text)) return Promise.resolve({ rows });
    if (/UPDATE karate_annuity_installments/.test(text)) {
      calls.update.push({ sql: text, params });
      return Promise.resolve({ rows: [] });
    }
    if (/INSERT INTO karate_annuity_payments/.test(text)) {
      calls.insert.push({ sql: text, params });
      return Promise.resolve({ rows: [] });
    }
    throw new Error('query inesperada no mock: ' + text);
  });
  return { client: { query, release: jest.fn() }, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── deriveStatusFromAmountPaid ────────────────────────────────────────
describe('deriveStatusFromAmountPaid', () => {
  test('amount_paid = 0 -> pending', () => {
    expect(deriveStatusFromAmountPaid(0, 100)).toBe('pending');
  });
  test('0 < amount_paid < amount -> partial', () => {
    expect(deriveStatusFromAmountPaid(40, 100)).toBe('partial');
  });
  test('amount_paid >= amount -> paid (com tolerância de arredondamento)', () => {
    expect(deriveStatusFromAmountPaid(100, 100)).toBe('paid');
    expect(deriveStatusFromAmountPaid(100.003, 100)).toBe('paid');
  });
});

// ── toIsoDate — CLAUDE.md armadilha nº1 (P0 de 500 em ~96% das reqs) ──
describe('toIsoDate', () => {
  test('Date -> YYYY-MM-DD, nunca o formato Date.toString() ("Sun Apr 17")', () => {
    const d = new Date('2026-04-17T00:00:00.000Z');
    const iso = toIsoDate(d);
    expect(iso).toBe('2026-04-17');
    expect(iso).not.toMatch(/[A-Za-z]{3}\s[A-Za-z]{3}\s\d{1,2}/);
  });
  test('null/undefined -> null', () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });
  test('string YYYY-MM-DD passa direto', () => {
    expect(toIsoDate('2026-01-05')).toBe('2026-01-05');
  });
});

// ── computeDistribution — motor FIFO puro ─────────────────────────────
describe('computeDistribution (motor FIFO puro)', () => {
  test('pagamento PARCIAL fatia só a 1ª parcela (a mais antiga)', () => {
    const installments = [
      makeInstallment({ id: 'a', seq: 1, amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'b', seq: 2, amount: 100, amount_paid: 0, due_date: new Date('2026-08-31') }),
    ];
    const result = computeDistribution(installments, 40);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].installment_id).toBe('a');
    expect(result.allocations[0].amount_applied).toBe(40);
    expect(result.allocations[0].amount_paid_after).toBe(40);
    expect(result.allocations[0].status_before).toBe('pending');
    expect(result.allocations[0].status_after).toBe('partial');
    expect(result.allocations[0].closes_installment).toBe(false);
    expect(result.allocations[0].due_date).toBe('2026-05-31'); // toIsoDate, não Date bruto
    expect(result.balance_before).toBe(200);
    expect(result.balance_after).toBeCloseTo(160, 2);
    // parcela "b" nem entra em allocations -- fica pending, intocada.
  });

  test('pagamento EXATO quita uma parcela (status vira paid, closes_installment=true)', () => {
    const installments = [makeInstallment({ id: 'a', amount: 100, amount_paid: 0 })];
    const result = computeDistribution(installments, 100);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].amount_applied).toBe(100);
    expect(result.allocations[0].status_after).toBe('paid');
    expect(result.allocations[0].closes_installment).toBe(true);
    expect(result.balance_after).toBe(0);
  });

  test('pagamento MÚLTIPLO transborda para a próxima parcela em aberto (FIFO por due_date)', () => {
    const installments = [
      makeInstallment({ id: 'old', seq: 1, amount: 100, amount_paid: 0, due_date: new Date('2026-02-28') }),
      makeInstallment({ id: 'new', seq: 2, amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
    ];
    const result = computeDistribution(installments, 150);

    expect(result.allocations).toHaveLength(2);
    expect(result.allocations[0].installment_id).toBe('old');
    expect(result.allocations[0].amount_applied).toBe(100);
    expect(result.allocations[0].status_after).toBe('paid');
    expect(result.allocations[1].installment_id).toBe('new');
    expect(result.allocations[1].amount_applied).toBe(50);
    expect(result.allocations[1].status_after).toBe('partial');
    expect(result.total_applied).toBe(150);
  });

  test('parcela já paga (balance<=0) é pulada pelo FIFO', () => {
    const installments = [
      makeInstallment({ id: 'paid-already', seq: 1, amount: 100, amount_paid: 100, status: 'paid', due_date: new Date('2026-02-28') }),
      makeInstallment({ id: 'open', seq: 2, amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
    ];
    const result = computeDistribution(installments, 30);
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].installment_id).toBe('open');
  });

  test('EXCEDENTE é recusado (AMOUNT_EXCEEDS_BALANCE) — não gera crédito, não paga a mais', () => {
    const installments = [makeInstallment({ id: 'a', amount: 100, amount_paid: 30 })]; // saldo 70
    let caught;
    try {
      computeDistribution(installments, 70.5);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AnnuityPaymentError);
    expect(caught.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(caught.status).toBe(422);
    expect(caught.details.balance).toBeCloseTo(70, 2);
  });

  test('pagamento igual ao saldo total (limite exato) NÃO é recusado', () => {
    const installments = [makeInstallment({ id: 'a', amount: 100, amount_paid: 30 })]; // saldo 70
    expect(() => computeDistribution(installments, 70)).not.toThrow();
  });

  test('parcela kind=filiacao participa do FIFO como qualquer outra (é rótulo, não regra)', () => {
    const installments = [
      makeInstallment({ id: 'f', seq: 1, kind: 'filiacao', amount: 50, amount_paid: 0, due_date: new Date('2026-01-31') }),
      makeInstallment({ id: 'a', seq: 2, kind: 'anuidade', amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
    ];
    const result = computeDistribution(installments, 60);

    expect(result.allocations).toHaveLength(2);
    expect(result.allocations[0].installment_id).toBe('f');
    expect(result.allocations[0].kind).toBe('filiacao');
    expect(result.allocations[0].amount_applied).toBe(50);
    expect(result.allocations[0].status_after).toBe('paid');
    expect(result.allocations[1].installment_id).toBe('a');
    expect(result.allocations[1].kind).toBe('anuidade');
    expect(result.allocations[1].amount_applied).toBe(10);
    expect(result.allocations[1].status_after).toBe('partial');
  });
});

// ── applyAnnuityPayment — integração com client mockado ───────────────
describe('applyAnnuityPayment', () => {
  test('validações de entrada não tocam o banco (amount<=0)', async () => {
    await expect(
      applyAnnuityPayment({ federation_id: 'fed-1', annuity_id: 'a1', amount: 0 })
    ).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    await expect(
      applyAnnuityPayment({ federation_id: 'fed-1', annuity_id: 'a1', amount: -5 })
    ).rejects.toMatchObject({ code: 'AMOUNT_INVALID' });
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('annuity_id sem parcelas -> ANNUITY_NOT_FOUND (404)', async () => {
    const { client } = makeMockClient([]);
    db.connect.mockImplementationOnce(async () => client);

    await expect(
      applyAnnuityPayment({ federation_id: 'fed-1', annuity_id: 'nope', amount: 10 })
    ).rejects.toMatchObject({ code: 'ANNUITY_NOT_FOUND', status: 404 });
  });

  test('query trava as parcelas (FOR UPDATE) na ordem FIFO due_date ASC NULLS FIRST, seq ASC', async () => {
    const rows = [makeInstallment({ id: 'a', amount: 50, amount_paid: 0 })];
    const { client } = makeMockClient(rows);
    db.connect.mockImplementationOnce(async () => client);

    await applyAnnuityPayment({ federation_id: 'fed-1', annuity_id: 'annuity-1', amount: 10, dryRun: true });

    const selectCall = client.query.mock.calls.find((c) => /FOR UPDATE/.test(String(c[0])));
    expect(selectCall).toBeTruthy();
    expect(selectCall[0]).toMatch(/ORDER BY due_date ASC NULLS FIRST, seq ASC/);
    expect(selectCall[0]).toMatch(/FOR UPDATE/);
  });

  test('EXCEDENTE é recusado ANTES de qualquer escrita (nenhum UPDATE/INSERT/COMMIT — só ROLLBACK)', async () => {
    const rows = [makeInstallment({ id: 'a', amount: 100, amount_paid: 0 })];
    const { client, calls } = makeMockClient(rows);
    db.connect.mockImplementationOnce(async () => client);

    await expect(
      applyAnnuityPayment({ federation_id: 'fed-1', annuity_id: 'annuity-1', amount: 150.5 })
    ).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_BALANCE', status: 422 });

    expect(calls.update).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
    expect(calls.commit).toBe(0);
    expect(calls.rollback).toBe(1);
    expect(annuitySvc.syncAnnuityHeaderRollup).not.toHaveBeenCalled();
  });

  test('dry-run: distribui em memória, NÃO grava nada (nem parcela, nem ledger, nem rollup) e sempre faz ROLLBACK', async () => {
    const rows = [
      makeInstallment({ id: 'a', seq: 1, amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'b', seq: 2, amount: 100, amount_paid: 0, due_date: new Date('2026-08-31') }),
    ];
    const { client, calls } = makeMockClient(rows);
    db.connect.mockImplementationOnce(async () => client);

    const result = await applyAnnuityPayment({
      federation_id: 'fed-1',
      annuity_id: 'annuity-1',
      amount: 150,
      payment_method: 'pix',
      paid_at: '2026-07-10T12:00:00.000Z',
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.allocations).toHaveLength(2);
    expect(calls.update).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
    expect(calls.commit).toBe(0);
    expect(calls.rollback).toBe(1);
    expect(annuitySvc.syncAnnuityHeaderRollup).not.toHaveBeenCalled();
  });

  test('dry-run e commit produzem EXATAMENTE a mesma distribuição — só o commit grava', async () => {
    const baseRows = () => [
      makeInstallment({ id: 'a', seq: 1, amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'b', seq: 2, amount: 100, amount_paid: 0, due_date: new Date('2026-08-31') }),
    ];

    const dryMock = makeMockClient(baseRows());
    db.connect.mockImplementationOnce(async () => dryMock.client);
    const dryResult = await applyAnnuityPayment({
      federation_id: 'fed-1', annuity_id: 'annuity-1', amount: 150,
      payment_method: 'pix', paid_at: '2026-07-10T12:00:00.000Z', dryRun: true,
    });

    const commitMock = makeMockClient(baseRows()); // mesmo estado inicial das parcelas
    db.connect.mockImplementationOnce(async () => commitMock.client);
    const commitResult = await applyAnnuityPayment({
      federation_id: 'fed-1', annuity_id: 'annuity-1', amount: 150,
      payment_method: 'pix', paid_at: '2026-07-10T12:00:00.000Z', dryRun: false,
    });

    expect(commitResult.allocations).toEqual(dryResult.allocations);
    expect(commitResult.total_applied).toBe(dryResult.total_applied);
    expect(commitResult.balance_before).toBe(dryResult.balance_before);
    expect(commitResult.balance_after).toBe(dryResult.balance_after);

    // só o commit grava e fecha com COMMIT
    expect(commitMock.calls.update).toHaveLength(2);
    expect(commitMock.calls.insert).toHaveLength(2);
    expect(commitMock.calls.commit).toBe(1);
    expect(commitMock.calls.rollback).toBe(0);
    expect(annuitySvc.syncAnnuityHeaderRollup).toHaveBeenCalledTimes(1);
    expect(annuitySvc.syncAnnuityHeaderRollup).toHaveBeenCalledWith(commitMock.client, 'annuity-1');
  });

  test('commit real: grava amount_paid+status por parcela e uma linha de ledger por alocação', async () => {
    const rows = [
      makeInstallment({ id: 'a', seq: 1, amount: 100, amount_paid: 0, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'b', seq: 2, amount: 100, amount_paid: 0, due_date: new Date('2026-08-31') }),
    ];
    const { client, calls } = makeMockClient(rows);
    db.connect.mockImplementationOnce(async () => client);

    const result = await applyAnnuityPayment({
      federation_id: 'fed-1',
      annuity_id: 'annuity-1',
      amount: 150,
      payment_method: 'credito_exame',
      paid_at: '2026-07-10T12:00:00.000Z',
      created_by: 'user-9',
      dryRun: false,
    });

    expect(result.dry_run).toBe(false);
    expect(calls.update).toHaveLength(2);
    expect(calls.insert).toHaveLength(2);

    // parcela "a": quitada (100 aplicado) -> status paid
    const updA = calls.update.find((c) => c.params[c.params.length - 1] === 'a');
    expect(updA.params[0]).toBe(100); // amount_paid
    expect(updA.params[1]).toBe('paid'); // status

    // parcela "b": parcial (50 aplicado) -> status partial
    const updB = calls.update.find((c) => c.params[c.params.length - 1] === 'b');
    expect(updB.params[0]).toBe(50);
    expect(updB.params[1]).toBe('partial');

    // ledger: 2 linhas, uma por alocação, com o payment_method e created_by informados
    const insA = calls.insert.find((c) => c.params[1] === 'a'); // installment_id
    expect(insA.params[3]).toBe(100); // amount aplicado na parcela "a"
    expect(insA.params[5]).toBe('credito_exame');
    expect(insA.params[6]).toBe('user-9');

    const insB = calls.insert.find((c) => c.params[1] === 'b');
    expect(insB.params[3]).toBe(50);

    expect(calls.commit).toBe(1);
    expect(calls.rollback).toBe(0);
    expect(annuitySvc.syncAnnuityHeaderRollup).toHaveBeenCalledTimes(1);
  });
});
