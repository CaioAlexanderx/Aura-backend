// ============================================================
// AURA. -- Testes unitarios: src/services/credit/unify.js
// Item 3 (13/06/2026): motor puro de unificacao de carne.
// ============================================================

const { computeUnifyPlan } = require('../../src/services/credit/unify');

const sumSchedule = (s) => Math.round(s.reduce((a, b) => a + b.amount_due, 0) * 100) / 100;

describe('computeUnifyPlan', () => {
  test('sem juros: soma saldo aberto + nova compra e redivide em N', () => {
    const p = computeUnifyPlan({
      openInstallments: [
        { id: 'a', amount_due: 50, covered_amount: 0 },
        { id: 'b', amount_due: 50, covered_amount: 0 },
      ],
      newAmount: 100,
      installments: 4,
      firstDueDate: '2026-07-01',
    });

    expect(p.open_remaining).toBeCloseTo(100, 2);
    expect(p.new_amount).toBeCloseTo(100, 2);
    expect(p.interest_added).toBe(0);
    expect(p.total).toBeCloseTo(200, 2);
    expect(p.schedule).toHaveLength(4);
    expect(p.schedule.map((s) => s.amount_due)).toEqual([50, 50, 50, 50]);
    expect(sumSchedule(p.schedule)).toBeCloseTo(p.total, 2);
    expect(p.replaced_installment_ids).toEqual(['a', 'b']);
  });

  test('parcela paga em parte: carrega so o restante (amount_due - covered_amount)', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 100, covered_amount: 30 }],
      newAmount: 30,
      installments: 2,
      firstDueDate: '2026-07-10',
    });

    expect(p.open_remaining).toBeCloseTo(70, 2); // 100 - 30
    expect(p.total).toBeCloseTo(100, 2);         // 70 + 30
    expect(p.schedule.map((s) => s.amount_due)).toEqual([50, 50]);
    expect(sumSchedule(p.schedule)).toBeCloseTo(100, 2);
  });

  test('com juros: juros simples SO sobre a nova compra (newAmount * rate * N)', () => {
    const p = computeUnifyPlan({
      openInstallments: [],
      newAmount: 100,
      installments: 3,
      interestRate: 0.02, // 2% a.m.
      firstDueDate: '2026-07-01',
    });

    expect(p.interest_added).toBeCloseTo(6, 2); // 100 * 0.02 * 3
    expect(p.total).toBeCloseTo(106, 2);
    // floor(106/3)=35.33, resto na ultima
    expect(p.schedule.map((s) => s.amount_due)).toEqual([35.33, 35.33, 35.34]);
    expect(sumSchedule(p.schedule)).toBeCloseTo(106, 2);
  });

  test('juros NAO incide sobre o saldo ja parcelado (so sobre a nova compra)', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 200, covered_amount: 0 }],
      newAmount: 100,
      installments: 2,
      interestRate: 0.05,
      firstDueDate: '2026-08-01',
    });
    // saldo 200 entra a face; juros so sobre 100: 100*0.05*2 = 10
    expect(p.interest_added).toBeCloseTo(10, 2);
    expect(p.total).toBeCloseTo(310, 2); // 200 + 100 + 10
    expect(sumSchedule(p.schedule)).toBeCloseTo(310, 2);
  });

  test('reparcelar sem nova compra (newAmount 0) e valido', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 33.33, covered_amount: 0 }],
      newAmount: 0,
      installments: 1,
      firstDueDate: '2026-07-01',
    });
    expect(p.total).toBeCloseTo(33.33, 2);
    expect(p.schedule.map((s) => s.amount_due)).toEqual([33.33]);
  });

  test('N clampado em 1..36', () => {
    expect(computeUnifyPlan({ newAmount: 10, installments: 0 }).installments_count).toBe(1);
    expect(computeUnifyPlan({ newAmount: 10, installments: 999 }).installments_count).toBe(36);
  });

  test('determinismo: soma das parcelas == total em valores quebrados', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 77.77, covered_amount: 11.11 }],
      newAmount: 123.45,
      installments: 7,
      interestRate: 0.013,
      firstDueDate: '2026-09-15',
    });
    expect(sumSchedule(p.schedule)).toBeCloseTo(p.total, 2);
    expect(p.schedule).toHaveLength(7);
  });

  test('datas seguem a periodicidade (semanal)', () => {
    const p = computeUnifyPlan({
      openInstallments: [],
      newAmount: 90,
      installments: 3,
      firstDueDate: '2026-07-01',
      periodUnit: 'week',
      periodCount: 1,
    });
    expect(p.schedule[0].due_date).toBe('2026-07-01');
    expect(p.schedule[1].due_date).toBe('2026-07-08');
    expect(p.schedule[2].due_date).toBe('2026-07-15');
  });
});

// ============================================================
// applyUnify: testa o motor de aplicacao via mock client sequencial.
// Copia o helper makeMockClient de creditLedger.test.js.
// ============================================================

// Importamos applyUnify diretamente do ledger (nao via barrel, para evitar
// dependencia do pool mockado do barrel).
const { applyUnify } = require('../../src/services/credit/ledger');

// Mock do pool (pool.query nao e chamado diretamente por applyUnify, mas
// ledger.js importa pool -- precisamos prevenir erros de conexao no require).
jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

function makeMockClient(responses = []) {
  let call = 0;
  const query = jest.fn().mockImplementation(() => {
    const res = responses[call] ?? { rows: [] };
    call++;
    return Promise.resolve(res);
  });
  return { query };
}

const COMPANY_ID  = 'comp-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'cust-0000-0000-0000-000000000001';
const SALE_ID     = 'sale-0000-0000-0000-000000000001';

describe('applyUnify', () => {
  beforeEach(() => { jest.resetAllMocks(); });

  test('(a) parcelas abertas: cancela substituidas + insere N novas com amount_due do schedule', async () => {
    // Sequencia de queries:
    //  0: SELECT parcelas abertas FOR UPDATE => 2 abertas
    //  1: UPDATE cancelled (replaced_installment_ids)
    //  2..4: INSERT credit_installments x3 (uma por parcela)
    const openRows = [
      { id: 'inst-old-1', amount_due: '50.00', covered_amount: '0.00' },
      { id: 'inst-old-2', amount_due: '50.00', covered_amount: '0.00' },
    ];
    const insertedIds = ['inst-new-1', 'inst-new-2', 'inst-new-3'];
    const client = makeMockClient([
      { rows: openRows },             // 0 SELECT abertos FOR UPDATE
      { rows: [] },                   // 1 UPDATE cancelled
      { rows: [{ id: insertedIds[0] }] }, // 2 INSERT parcela 1
      { rows: [{ id: insertedIds[1] }] }, // 3 INSERT parcela 2
      { rows: [{ id: insertedIds[2] }] }, // 4 INSERT parcela 3
    ]);

    const result = await applyUnify(client, {
      companyId:    COMPANY_ID,
      customerId:   CUSTOMER_ID,
      accountId:    null,
      newAmount:    100,     // saldo 100 + nova 100 = total 200, 4x50
      installments: 4,
      firstDueDate: '2026-07-01',
      interestRate: 0,
      saleId:       SALE_ID,
    });

    // Plano
    expect(result.open_remaining).toBeCloseTo(100, 2);
    expect(result.new_amount).toBeCloseTo(100, 2);
    expect(result.total).toBeCloseTo(200, 2);
    expect(result.installments_count).toBe(4);
    expect(result.schedule).toHaveLength(4);
    expect(result.replaced_installment_ids).toEqual(['inst-old-1', 'inst-old-2']);
    expect(result.applied_installment_ids).toEqual(insertedIds);

    // Query 0: SELECT parcelas
    expect(client.query).toHaveBeenCalledTimes(5);
    const selectCall = client.query.mock.calls[0];
    expect(selectCall[0]).toMatch(/SELECT.*credit_installments/is);
    expect(selectCall[0]).toMatch(/FOR UPDATE/i);
    expect(selectCall[0]).toMatch(/status IN/i);

    // Query 1: UPDATE cancelled
    const updateCall = client.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE credit_installments/i);
    expect(updateCall[0]).toMatch(/cancelled/i);
    expect(updateCall[1][0]).toEqual(['inst-old-1', 'inst-old-2']); // $1 = ids array

    // Query 2: INSERT primeira parcela (amount_due = 50)
    const insertCall = client.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO credit_installments/i);
    expect(insertCall[0]).toMatch(/covered_amount/i);
    const insertParams = insertCall[1];
    expect(parseFloat(insertParams[5])).toBeCloseTo(50, 2); // $6 = amount_due
    expect(insertParams[1]).toBe(SALE_ID);                  // $2 = sale_id
    expect(insertParams[2]).toBe(CUSTOMER_ID);              // $3 = customer_id
    expect(insertParams[3]).toBe(1);                        // $4 = installment_number
    expect(insertParams[4]).toBe(4);                        // $5 = total_installments
  });

  test('(b) sem parcelas abertas (open vazio): so insere as N novas, nao roda UPDATE', async () => {
    const client = makeMockClient([
      { rows: [] },                          // 0 SELECT abertos => vazio
      // nao deve haver UPDATE (replaced_installment_ids vazio)
      { rows: [{ id: 'inst-new-a' }] },      // 1 INSERT parcela 1
      { rows: [{ id: 'inst-new-b' }] },      // 2 INSERT parcela 2
    ]);

    const result = await applyUnify(client, {
      companyId:    COMPANY_ID,
      customerId:   CUSTOMER_ID,
      accountId:    'acc-123',
      newAmount:    60,
      installments: 2,
      firstDueDate: '2026-08-01',
      interestRate: 0,
      saleId:       null,
    });

    expect(result.open_remaining).toBe(0);
    expect(result.total).toBeCloseTo(60, 2);
    expect(result.installments_count).toBe(2);
    expect(result.replaced_installment_ids).toEqual([]);
    expect(result.applied_installment_ids).toEqual(['inst-new-a', 'inst-new-b']);

    // Exatamente 3 queries: 1 SELECT + 2 INSERTs (sem UPDATE)
    expect(client.query).toHaveBeenCalledTimes(3);

    const calls = client.query.mock.calls.map(c => c[0]);
    const hasUpdate = calls.some(q => /UPDATE credit_installments/i.test(q));
    expect(hasUpdate).toBe(false);

    // INSERT usa accountId fornecido
    const insertCall = client.query.mock.calls[1];
    expect(insertCall[1][7]).toBe('acc-123'); // $8 = account_id
  });
});
