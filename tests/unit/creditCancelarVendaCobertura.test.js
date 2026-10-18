// ============================================================
// AURA CREDITO -- tq-21: cancelar venda devolve a cobertura ao FIFO (unit)
//
// O teste com Postgres real e __tests__/credito.cancelarVendaDevolveCobertura.banco.test.js.
// Aqui: a regra de returnReleasedCoverage (teto, ordem, distribuicao do
// pagamento) e o cancelCreditSale sem cobertura rodando EXATAMENTE as
// mesmas queries de antes. Mock por CONTEUDO do SQL, com estado em memoria.
// ============================================================
'use strict';

const COMPANY = 'co-1';
const CUST    = 'cu-1';

function fakeDb({ installments, balance, allocations = [] }) {
  const state = {
    inst: installments.map((i) => ({ covered_amount: 0, status: 'pending', ...i })),
    allocations: allocations.map((a) => ({ ...a })),
    balance,
  };
  const calls = [];
  const query = jest.fn(async (sql, params = []) => {
    const s = String(sql);
    calls.push(s);
    if (/AS excess/.test(s)) {
      const open = state.inst.filter((i) => ['pending', 'overdue'].includes(i.status))
        .reduce((a, i) => a + Math.max(0, i.amount_due - i.covered_amount), 0);
      return { rows: [{ excess: String(open - state.balance) }] };
    }
    if (/FROM credit_payment_allocations[\s\S]*installment_id = ANY/.test(s) && /^\s*SELECT/.test(s)) {
      return { rows: state.allocations.filter((a) => params[1].includes(a.installment_id)) };
    }
    if (/SELECT id, amount_due, covered_amount, status[\s\S]*FROM credit_installments/.test(s)) {
      const rows = state.inst
        .filter((i) => ['pending', 'overdue'].includes(i.status))
        .sort((a, b) => a.due.localeCompare(b.due))
        .map((i) => ({ ...i, amount_due: String(i.amount_due), covered_amount: String(i.covered_amount) }));
      return { rows };
    }
    if (/^\s*UPDATE credit_installments/.test(s)) {
      const i = state.inst.find((x) => x.id === params[0]);
      i.covered_amount = params[2];
      i.status = params[3];
      return { rows: [] };
    }
    if (/UPDATE credit_payment_allocations/.test(s)) {
      const [, tx, from, amt] = params;
      tx.forEach((t, k) => {
        const a = state.allocations.find((x) => x.transaction_id === t && x.installment_id === from[k]);
        if (a) a.principal_paid = Math.max(0, a.principal_paid - amt[k]);
      });
      return { rows: [] };
    }
    if (/DELETE FROM credit_payment_allocations/.test(s)) {
      state.allocations = state.allocations.filter((a) =>
        !(params[1].includes(a.installment_id) && a.principal_paid <= 0.005));
      return { rows: [] };
    }
    if (/INSERT INTO credit_payment_allocations/.test(s)) {
      const [, tx, to, amt] = params;
      tx.forEach((t, k) => {
        const a = state.allocations.find((x) => x.transaction_id === t && x.installment_id === to[k]);
        if (a) a.principal_paid += amt[k];
        else state.allocations.push({ transaction_id: t, installment_id: to[k], principal_paid: amt[k] });
      });
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { client: { query }, state, calls };
}

let returnReleasedCoverage;
beforeEach(() => {
  jest.resetModules();
  jest.doMock('../../src/services/credit/score', () => ({ _recalculateScore: jest.fn(async () => {}) }));
  ({ returnReleasedCoverage } = require('../../src/services/credit/releasedCoverage'));
});

describe('returnReleasedCoverage', () => {
  test('cobre as outras parcelas por vencimento e leva a distribuicao do pagamento junto', async () => {
    // venda 1 cancelada (v1a tinha 100 do pagamento P); venda 2 aberta 2 x 100; razao = 100
    const { client, state } = fakeDb({
      balance: 100,
      installments: [
        { id: 'v2b', amount_due: 100, due: '2027-01-15' },
        { id: 'v2a', amount_due: 100, due: '2026-12-15' },
      ],
      allocations: [{ transaction_id: 'P', installment_id: 'v1a', principal_paid: 100 }],
    });
    // antes: abertas 200, razao 100 -> excesso 100
    const r = await returnReleasedCoverage(client, {
      companyId: COMPANY, customerId: CUST, released: [{ installment_id: 'v1a', covered: '100.00' }],
    });
    expect(r).toMatchObject({ released: 100, reallocated: 100, credit_left: 0 });
    expect(state.inst.find((i) => i.id === 'v2a')).toMatchObject({ covered_amount: 100, status: 'paid' });
    expect(state.inst.find((i) => i.id === 'v2b')).toMatchObject({ covered_amount: 0, status: 'pending' });
    expect(state.allocations).toEqual([{ transaction_id: 'P', installment_id: 'v2a', principal_paid: 100 }]);
  });

  test('teto: so ate o excesso das parcelas sobre o saldo; o resto fica de credito', async () => {
    const { client, state } = fakeDb({
      balance: 150, // abertas 200 -> excesso 50
      installments: [{ id: 'x', amount_due: 200, due: '2026-12-01' }],
      allocations: [{ transaction_id: 'P', installment_id: 'v1a', principal_paid: 100 }],
    });
    const r = await returnReleasedCoverage(client, {
      companyId: COMPANY, customerId: CUST, released: [{ installment_id: 'v1a', covered: 100 }],
    });
    expect(r).toMatchObject({ released: 100, reallocated: 50, credit_left: 50 });
    expect(state.inst[0]).toMatchObject({ covered_amount: 50, status: 'pending' });
    // o que nao mudou de parcela continua na linha original (desfazer tira o resto do razao)
    expect(state.allocations).toEqual(expect.arrayContaining([
      { transaction_id: 'P', installment_id: 'v1a', principal_paid: 50 },
      { transaction_id: 'P', installment_id: 'x', principal_paid: 50 },
    ]));
  });

  test('sem excesso (divida sem parcela) nao cobre nada e nao le parcelas', async () => {
    const { client, calls } = fakeDb({
      balance: 300,
      installments: [{ id: 'x', amount_due: 100, due: '2026-12-01' }],
    });
    const r = await returnReleasedCoverage(client, {
      companyId: COMPANY, customerId: CUST, released: [{ installment_id: 'v1a', covered: 100 }],
    });
    expect(r).toMatchObject({ released: 100, reallocated: 0, credit_left: 100 });
    expect(calls).toHaveLength(1); // so a leitura do excesso
  });

  test('cobertura sem distribuicao gravada (anterior a 335) cobre do mesmo jeito, sem linha de recibo', async () => {
    const { client, state } = fakeDb({
      balance: 0,
      installments: [{ id: 'x', amount_due: 60, due: '2026-12-01' }],
    });
    const r = await returnReleasedCoverage(client, {
      companyId: COMPANY, customerId: CUST, released: [{ installment_id: 'v1a', covered: 60 }],
    });
    expect(r.reallocated).toBe(60);
    expect(state.inst[0]).toMatchObject({ covered_amount: 60, status: 'paid' });
    expect(state.allocations).toEqual([]);
  });

  test('dois pagamentos na mesma parcela cancelada: cada um segue para onde o dinheiro dele foi', async () => {
    const { client, state } = fakeDb({
      balance: 0, // abertas 150 -> excesso 150
      installments: [
        { id: 'a', amount_due: 70, due: '2026-12-01' },
        { id: 'b', amount_due: 80, due: '2027-01-01' },
      ],
      allocations: [
        { transaction_id: 'P1', installment_id: 'v1a', principal_paid: 100 },
        { transaction_id: 'P2', installment_id: 'v1a', principal_paid: 50 },
      ],
    });
    const r = await returnReleasedCoverage(client, {
      companyId: COMPANY, customerId: CUST, released: [{ installment_id: 'v1a', covered: 150 }],
    });
    expect(r.reallocated).toBe(150);
    const by = (t, i) => (state.allocations.find((a) => a.transaction_id === t && a.installment_id === i) || {}).principal_paid;
    expect(by('P1', 'a')).toBe(70);
    expect(by('P1', 'b')).toBe(30);
    expect(by('P2', 'b')).toBe(50);
    expect(state.allocations.some((a) => a.installment_id === 'v1a')).toBe(false);
  });

  test('nada liberado ou sem cliente: nenhuma query', async () => {
    const { client } = fakeDb({ balance: 0, installments: [] });
    await returnReleasedCoverage(client, { companyId: COMPANY, customerId: CUST, released: [] });
    await returnReleasedCoverage(client, { companyId: COMPANY, customerId: null, released: [{ installment_id: 'a', covered: 10 }] });
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('cancelCreditSale sem cobertura liberada', () => {
  test('mesmas 6 queries de antes, nenhuma query nova', async () => {
    jest.resetModules();
    const ledger = require('../../src/services/credit/ledger');
    const calls = [];
    const client = {
      query: jest.fn(async (sql) => {
        calls.push(String(sql));
        if (/SELECT customer_id FROM sales/.test(sql)) return { rows: [{ customer_id: CUST }] };
        if (/UPDATE credit_installments/.test(sql)) {
          return { rows: [{ installment_id: 'i1', covered: '0.00' }, { installment_id: 'i2', covered: '0.00' }] };
        }
        return { rows: [] };
      }),
    };
    const r = await ledger.cancelCreditSale(client, { companyId: COMPANY, saleId: 's1' });
    expect(r).toMatchObject({ ok: true, released_coverage: 0, reallocated_amount: 0, credit_left: 0 });
    expect(calls).toHaveLength(6);
    expect(calls.some((s) => /AS excess|credit_payment_allocations/.test(s))).toBe(false);
    // inclui as pagas: parcela paga de venda cancelada nao segura mais o dinheiro
    const upd = calls.find((s) => /UPDATE credit_installments/.test(s));
    expect(upd).toMatch(/'pending', 'overdue', 'paid'/);
    expect(upd).toMatch(/covered_amount = 0/);
  });
});
