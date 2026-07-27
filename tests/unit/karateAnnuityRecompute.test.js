// ============================================================
// AURA KARATÊ — Testes unitários: recomputeAnnuityFromLedger
// (src/services/karateAnnuityLedger.js — F5, editar/remover baixa)
//
// Mesma técnica de tests/unit/karateAnnuityLedger.test.js (client mockado
// interpretando SQL por regex, sem Postgres real, syncAnnuityHeaderRollup
// mockado). O foco aqui é o CONTRATO do rebuild: dado um ledger (já com a
// edição/remoção do caller aplicada), o estado final de cada parcela tem
// que bater com o que computeDistribution (motor real) produziria se as
// mesmas baixas — já corrigidas — tivessem sido aplicadas desde o início,
// em sequência, na ordem cronológica original.
// ============================================================
'use strict';

jest.mock('../../src/services/karateAnnuityService', () => ({
  syncAnnuityHeaderRollup: jest.fn(async (client, annuityId) => ({
    id: annuityId,
    dojo_id: 'dojo-1',
    practitioner_id: null,
    status: 'header-mock',
    amount: 200,
    due_date: '2026-08-31',
    paid_at: null,
  })),
}));

const annuitySvc = require('../../src/services/karateAnnuityService');
const {
  recomputeAnnuityFromLedger,
  computeDistribution,
  AnnuityPaymentError,
} = require('../../src/services/karateAnnuityLedger');

function makeInstallment(overrides) {
  return {
    id: 'inst-a',
    annuity_id: 'annuity-1',
    federation_id: 'fed-1',
    seq: 1,
    amount: 100,
    amount_paid: 0,
    status: 'pending',
    due_date: new Date('2026-05-31T00:00:00.000Z'),
    kind: 'anuidade',
    payment_method: null,
    paid_at: null,
    transaction_id: 'txn-a',
    ...overrides,
  };
}

function makeLedgerRow(overrides) {
  return {
    id: 'pay-1',
    installment_id: 'inst-a',
    amount: 40,
    paid_at: new Date('2026-06-01T15:00:00.000Z'),
    payment_method: 'pix',
    created_by: 'user-1',
    operation_id: null,
    created_at: new Date('2026-06-01T15:00:00.000Z'),
    ...overrides,
  };
}

// Client mockado: intercepta as 6 formas de query que recomputeAnnuityFromLedger
// emite (installments FOR UPDATE, ledger SELECT join, DELETE ledger, INSERT
// ledger, UPDATE installments RETURNING *) e devolve dados coerentes,
// registrando as chamadas pra asserção.
function makeMockClient({ installments, ledgerRows }) {
  const calls = { deletes: [], inserts: [], updates: [] };
  const installmentsById = new Map(installments.map((i) => [String(i.id), i]));

  const query = jest.fn((sql, params) => {
    const text = String(sql).trim();

    if (/FROM karate_annuity_installments[\s\S]*FOR UPDATE/.test(text)) {
      return Promise.resolve({ rows: installments });
    }
    if (/FROM karate_annuity_payments p[\s\S]*JOIN karate_annuity_installments/.test(text)) {
      return Promise.resolve({ rows: ledgerRows });
    }
    if (/^DELETE FROM karate_annuity_payments/.test(text)) {
      calls.deletes.push(params);
      return Promise.resolve({ rows: [] });
    }
    if (/^INSERT INTO karate_annuity_payments/.test(text)) {
      calls.inserts.push(params);
      return Promise.resolve({ rows: [] });
    }
    if (/^UPDATE karate_annuity_installments/.test(text)) {
      calls.updates.push(params);
      const [amount_paid, status, payment_method, paid_at, id] = params;
      const base = installmentsById.get(String(id)) || {};
      return Promise.resolve({
        rows: [{ ...base, amount_paid, status, payment_method, paid_at, id }],
      });
    }
    throw new Error('query inesperada no mock: ' + text);
  });

  return { client: { query }, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('recomputeAnnuityFromLedger — validação básica', () => {
  test('federation_id/annuity_id ausentes -> erro de validação, nenhuma query', async () => {
    await expect(recomputeAnnuityFromLedger({ query: jest.fn() }, { annuity_id: 'a1' }))
      .rejects.toMatchObject({ code: 'FEDERATION_ID_REQUIRED' });
    await expect(recomputeAnnuityFromLedger({ query: jest.fn() }, { federation_id: 'f1' }))
      .rejects.toMatchObject({ code: 'ANNUITY_ID_REQUIRED' });
  });

  test('anuidade sem parcelas -> ANNUITY_NOT_FOUND (404)', async () => {
    const { client } = makeMockClient({ installments: [], ledgerRows: [] });
    await expect(
      recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' })
    ).rejects.toMatchObject({ code: 'ANNUITY_NOT_FOUND', status: 404 });
  });
});

describe('recomputeAnnuityFromLedger — remoção total (ledger vazio)', () => {
  test('sem nenhuma linha de ledger, todas as parcelas voltam a pending/0/null', async () => {
    const installments = [
      makeInstallment({ id: 'inst-a', seq: 1, amount: 100, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'inst-b', seq: 2, amount: 100, due_date: new Date('2026-08-31') }),
    ];
    const { client, calls } = makeMockClient({ installments, ledgerRows: [] });

    const result = await recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' });

    expect(calls.inserts).toHaveLength(0);
    expect(result.installments).toHaveLength(2);
    for (const inst of result.installments) {
      expect(Number(inst.amount_paid)).toBe(0);
      expect(inst.status).toBe('pending');
      expect(inst.payment_method).toBeNull();
      expect(inst.paid_at).toBeNull();
    }
    // A "parcela reabre e reverte a transaction" depende do caller
    // (reconcileInstallmentTransactions, na rota) olhar pra este shape —
    // aqui garantimos que o shape reporta status pending corretamente.
  });
});

describe('recomputeAnnuityFromLedger — consistência com o motor (computeDistribution)', () => {
  test('1 linha de ledger fechando a 1ª parcela: resultado idêntico a computeDistribution', async () => {
    const installments = [
      makeInstallment({ id: 'inst-a', seq: 1, amount: 100, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'inst-b', seq: 2, amount: 100, due_date: new Date('2026-08-31') }),
    ];
    const ledgerRows = [
      makeLedgerRow({ id: 'pay-1', installment_id: 'inst-a', amount: 100, payment_method: 'pix' }),
    ];
    const { client } = makeMockClient({ installments, ledgerRows });

    const result = await recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' });

    // "Ground truth": o que o motor faria aplicando 100 direto via FIFO.
    const dist = computeDistribution(installments, 100);
    const expectedA = dist.allocations.find((a) => a.installment_id === 'inst-a');

    const resA = result.installments.find((i) => i.id === 'inst-a');
    const resB = result.installments.find((i) => i.id === 'inst-b');

    expect(Number(resA.amount_paid)).toBe(expectedA.amount_paid_after);
    expect(resA.status).toBe(expectedA.status_after);
    expect(resA.status).toBe('paid');
    expect(resA.payment_method).toBe('pix');
    expect(new Date(resA.paid_at).toISOString()).toBe(ledgerRows[0].paid_at.toISOString());

    expect(Number(resB.amount_paid)).toBe(0);
    expect(resB.status).toBe('pending');
    expect(resB.paid_at).toBeNull();
  });

  test('2 baixas sequenciais (created_at crescente) reproduzem o MESMO estado que aplicar o motor 2x em sequência', async () => {
    const installments = [
      makeInstallment({ id: 'inst-a', seq: 1, amount: 100, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'inst-b', seq: 2, amount: 100, due_date: new Date('2026-08-31') }),
    ];
    // 1ª baixa: 60 (parcial em A). 2ª baixa: 80 (fecha A com +40, transborda 40 pra B).
    const ledgerRows = [
      makeLedgerRow({
        id: 'pay-1', installment_id: 'inst-a', amount: 60, payment_method: 'pix',
        created_at: new Date('2026-06-01T10:00:00.000Z'), paid_at: new Date('2026-06-01T10:00:00.000Z'),
      }),
      makeLedgerRow({
        id: 'pay-2', installment_id: 'inst-a', amount: 80, payment_method: 'dinheiro',
        created_at: new Date('2026-06-15T10:00:00.000Z'), paid_at: new Date('2026-06-15T10:00:00.000Z'),
      }),
    ];
    const { client, calls } = makeMockClient({ installments, ledgerRows });

    const result = await recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' });

    // Simula o motor real aplicando as 2 baixas em sequência sobre uma
    // cópia mutável dos installments (mesma técnica que applyAnnuityPayment
    // usa internamente).
    let running = installments.map((i) => ({ ...i }));
    function applyStep(amount) {
      const dist = computeDistribution(running, amount);
      for (const a of dist.allocations) {
        const inst = running.find((i) => i.id === a.installment_id);
        inst.amount_paid = a.amount_paid_after;
        inst.status = a.status_after;
      }
      return dist;
    }
    applyStep(60);
    const dist2 = applyStep(80);

    const resA = result.installments.find((i) => i.id === 'inst-a');
    const resB = result.installments.find((i) => i.id === 'inst-b');
    const runningA = running.find((i) => i.id === 'inst-a');
    const runningB = running.find((i) => i.id === 'inst-b');

    expect(Number(resA.amount_paid)).toBe(runningA.amount_paid);
    expect(resA.status).toBe(runningA.status);
    expect(resA.status).toBe('paid');
    // A fecha na 2ª baixa -> paid_at/payment_method vêm da 2ª baixa.
    expect(resA.payment_method).toBe('dinheiro');
    expect(new Date(resA.paid_at).toISOString()).toBe(ledgerRows[1].paid_at.toISOString());

    expect(Number(resB.amount_paid)).toBe(runningB.amount_paid);
    expect(resB.status).toBe(runningB.status);
    expect(resB.status).toBe('partial');
    expect(resB.payment_method).toBe('dinheiro'); // tocada só pelo transbordo da 2ª baixa
    expect(resB.paid_at).toBeNull(); // não fechou

    // O transbordo da 2ª linha (80) tem que ter virado 2 linhas novas de
    // ledger no INSERT (40 pra A fechar, 40 pra B) — split reproduzindo o
    // FIFO puro que o motor faria numa baixa nova de 80.
    const insertsForPay2 = calls.inserts.filter(
      (p) => p[4] /* paid_at */ && new Date(p[4]).toISOString() === ledgerRows[1].paid_at.toISOString()
    );
    expect(insertsForPay2).toHaveLength(2);
    const totalPay2 = insertsForPay2.reduce((s, p) => s + Number(p[3]), 0);
    expect(totalPay2).toBe(80);
    expect(dist2.allocations).toHaveLength(2); // confirma que o motor "de verdade" também split em 2
  });

  test('edição pra CIMA que estoura a parcela original transborda pra próxima (reatribui installment_id)', async () => {
    const installments = [
      makeInstallment({ id: 'inst-a', seq: 1, amount: 100, due_date: new Date('2026-05-31') }),
      makeInstallment({ id: 'inst-b', seq: 2, amount: 100, due_date: new Date('2026-08-31') }),
    ];
    // Linha ORIGINALMENTE era 60 (parcial em A); o caller já editou pra 150
    // (UPDATE feito ANTES de chamar recompute, como a rota PATCH faz).
    const ledgerRows = [
      makeLedgerRow({ id: 'pay-1', installment_id: 'inst-a', amount: 150, payment_method: 'pix' }),
    ];
    const { client, calls } = makeMockClient({ installments, ledgerRows });

    const result = await recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' });

    const resA = result.installments.find((i) => i.id === 'inst-a');
    const resB = result.installments.find((i) => i.id === 'inst-b');
    expect(resA.status).toBe('paid');
    expect(Number(resA.amount_paid)).toBe(100);
    expect(resB.status).toBe('partial');
    expect(Number(resB.amount_paid)).toBe(50);

    // A ÚNICA linha original (150) virou 2 linhas novas: 100 em A, 50 em B —
    // installment_id foi REATRIBUÍDO (era só 'inst-a' antes).
    expect(calls.inserts).toHaveLength(2);
    const byInstallment = Object.fromEntries(calls.inserts.map((p) => [p[1] /* installment_id */, Number(p[3])]));
    expect(byInstallment['inst-a']).toBe(100);
    expect(byInstallment['inst-b']).toBe(50);
  });

  test('payment_method com COALESCE entre toques (2ª linha sem method preserva o da 1ª)', async () => {
    const installments = [
      makeInstallment({ id: 'inst-a', seq: 1, amount: 100, due_date: new Date('2026-05-31') }),
    ];
    const ledgerRows = [
      makeLedgerRow({ id: 'pay-1', installment_id: 'inst-a', amount: 40, payment_method: 'transferencia', created_at: new Date('2026-06-01T10:00:00.000Z') }),
      makeLedgerRow({ id: 'pay-2', installment_id: 'inst-a', amount: 60, payment_method: null, created_at: new Date('2026-06-05T10:00:00.000Z') }),
    ];
    const { client } = makeMockClient({ installments, ledgerRows });

    const result = await recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' });
    const resA = result.installments.find((i) => i.id === 'inst-a');
    expect(resA.status).toBe('paid');
    expect(resA.payment_method).toBe('transferencia'); // 2ª linha (null) não apaga o method da 1ª
  });

  test('AMOUNT_EXCEEDS_BALANCE se o total do ledger ultrapassar o devido', async () => {
    const installments = [
      makeInstallment({ id: 'inst-a', seq: 1, amount: 100, due_date: new Date('2026-05-31') }),
    ];
    const ledgerRows = [
      makeLedgerRow({ id: 'pay-1', installment_id: 'inst-a', amount: 999 }),
    ];
    const { client } = makeMockClient({ installments, ledgerRows });

    await expect(
      recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' })
    ).rejects.toMatchObject({ code: 'AMOUNT_EXCEEDS_BALANCE' });
  });

  test('chama syncAnnuityHeaderRollup (fonte única do rollup do header) e devolve o header', async () => {
    const installments = [makeInstallment({ id: 'inst-a', seq: 1, amount: 100 })];
    const ledgerRows = [makeLedgerRow({ id: 'pay-1', installment_id: 'inst-a', amount: 40 })];
    const { client } = makeMockClient({ installments, ledgerRows });

    const result = await recomputeAnnuityFromLedger(client, { federation_id: 'fed-1', annuity_id: 'annuity-1' });

    expect(annuitySvc.syncAnnuityHeaderRollup).toHaveBeenCalledWith(client, 'annuity-1');
    expect(result.header).toEqual(expect.objectContaining({ id: 'annuity-1' }));
  });
});
