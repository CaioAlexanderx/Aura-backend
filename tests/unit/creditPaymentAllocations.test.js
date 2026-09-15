// ============================================================
// AURA. -- applyPayment grava a distribuicao do pagamento entre parcelas
// 15/09/2026 (feedback de lojista: recibo "sobre o valor, nao sobre a parcela")
//
// A sondagem da tabela (credit_payment_allocations, migration 334) fica em
// cache no modulo, entao cada teste carrega o ledger isolado.
// ============================================================

const COMPANY_ID  = 'comp-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'cust-0000-0000-0000-000000000001';
const SALE_ID     = 'sale-0000-0000-0000-000000000001';

function makeMockClient(responses = []) {
  let call = 0;
  const query = jest.fn().mockImplementation(() => {
    const res = responses[call] ?? { rows: [] };
    call++;
    return Promise.resolve(res);
  });
  return { query };
}

// tableExists: true | false | 'throw'
function loadLedger(tableExists) {
  let ledger, pool;
  jest.isolateModules(() => {
    pool   = require('../../src/config/database');
    ledger = require('../../src/services/credit/ledger');
  });
  pool.query.mockImplementation(async (sql) => {
    if (/credit_payment_allocations/.test(sql)) {
      if (tableExists === 'throw') throw new Error('connection reset');
      return { rows: [{ ok: tableExists === true }] };
    }
    return { rows: [] };
  });
  return { ledger, pool };
}

// Mesmo roteiro do "pagamento total" de creditLedger.test.js: a ordem das
// queries ANTES do saldo nao pode mudar.
function fullPaymentResponses(txId = 'tx-pay-01') {
  return [
    { rows: [{ id: txId, type: 'payment', amount: '100.00' }] },
    { rows: [{ id: 'ar-01', amount: '100.00', idempotency_key: 'pdv-credit-receivable-' + SALE_ID, sale_id: SALE_ID }] },
    { rows: [] },  // UPDATE transactions (confirmed)
    { rows: [] },  // INSERT sale_payments
    { rows: [{ id: 'inst-01', amount_due: '100.00', covered_amount: '0', status: 'pending', due_date: '2026-07-01' }] },
    { rows: [] },  // UPDATE credit_installments covered_amount
    { rows: [{ total_paid_count: '1', total_paid_on_time: '1', avg_days_late: '0', total_purchases: '100' }] },
    { rows: [{ months: '1' }] },
    { rows: [] },  // UPDATE score
    { rows: [] },  // UPDATE credit_used
    { rows: [{ balance: '0.00' }] },
  ];
}

const allocInserts = (client) =>
  client.query.mock.calls.filter(c => /INSERT INTO credit_payment_allocations/.test(c[0]));

describe('buildPaymentAllocations', () => {
  const { ledger } = loadLedger(true);

  test('funde principal e encargos numa linha por parcela', () => {
    const out = ledger.buildPaymentAllocations(
      [
        { id: 'i1', covered: 16.66, status: 'paid' },
        { id: 'i2', covered: 8.34,  status: 'pending' },
      ],
      [
        { installment_id: 'i0', late_fee: 1,    late_interest: 0 },
        { installment_id: 'i1', late_fee: 0.33, late_interest: 0.1 },
      ]
    );
    const by = Object.fromEntries(out.map(a => [a.installment_id, a]));
    expect(out).toHaveLength(3);
    expect(by.i0).toEqual({ installment_id: 'i0', principal_paid: 0,     charges_paid: 1,    status_after: null });
    expect(by.i1).toEqual({ installment_id: 'i1', principal_paid: 16.66, charges_paid: 0.43, status_after: 'paid' });
    expect(by.i2).toEqual({ installment_id: 'i2', principal_paid: 8.34,  charges_paid: 0,    status_after: 'pending' });
  });

  test('descarta parcela que nao recebeu nada', () => {
    const out = ledger.buildPaymentAllocations(
      [{ id: 'i1', covered: 0, status: 'pending' }],
      [{ installment_id: 'i2', late_fee: 0, late_interest: 0 }]
    );
    expect(out).toEqual([]);
  });

  test('sem entrada devolve lista vazia', () => {
    expect(ledger.buildPaymentAllocations()).toEqual([]);
  });
});

describe('applyPayment -- distribuicao gravada', () => {
  test('grava a parcela coberta, num INSERT so, depois do saldo', async () => {
    const { ledger } = loadLedger(true);
    const client = makeMockClient(fullPaymentResponses());

    const result = await ledger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, amount: 100, method: 'pix',
    });

    // o roteiro anterior segue intacto
    expect(result.covered_installments).toHaveLength(1);
    expect(result.new_balance).toBe(0);

    const inserts = allocInserts(client);
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual([COMPANY_ID, 'tx-pay-01', ['inst-01'], [100], [0], ['paid']]);

    // e vem depois da leitura do saldo
    const calls = client.query.mock.calls.map(c => c[0]);
    const balIdx = calls.findIndex(s => /FROM customer_credit_balances/.test(s));
    const insIdx = calls.findIndex(s => /INSERT INTO credit_payment_allocations/.test(s));
    expect(insIdx).toBeGreaterThan(balIdx);
  });

  test('tabela ainda nao criada: nao grava e o pagamento segue', async () => {
    const { ledger } = loadLedger(false);
    const client = makeMockClient(fullPaymentResponses());

    const result = await ledger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, amount: 100, method: 'pix',
    });

    expect(allocInserts(client)).toHaveLength(0);
    expect(result.covered_installments).toHaveLength(1);
    expect(result.new_balance).toBe(0);
  });

  test('sondagem com erro: nao grava e o pagamento segue', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { ledger } = loadLedger('throw');
    const client = makeMockClient(fullPaymentResponses());

    const result = await ledger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, amount: 100, method: 'pix',
    });

    expect(allocInserts(client)).toHaveLength(0);
    expect(result.new_balance).toBe(0);
    warn.mockRestore();
  });

  test('replay idempotente nao grava de novo', async () => {
    const { ledger } = loadLedger(true);
    const txRow = { id: 'tx-pay-01', type: 'payment', amount: '100.00' };
    const client = makeMockClient([
      { rows: [] },        // INSERT ... ON CONFLICT DO NOTHING: ja existia
      { rows: [txRow] },   // SELECT da transacao existente
      { rows: [{ balance: '0.00' }] },
    ]);

    const result = await ledger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, amount: 100, method: 'pix',
      idempotencyKey: 'rfp-1',
    });

    expect(result.replayed).toBe(true);
    expect(allocInserts(client)).toHaveLength(0);
  });

  test('tabela presente fica em cache: um pagamento seguinte nao sonda de novo', async () => {
    const { ledger, pool } = loadLedger(true);
    await ledger.applyPayment(makeMockClient(fullPaymentResponses('tx-a')), {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, amount: 100, method: 'pix',
    });
    await ledger.applyPayment(makeMockClient(fullPaymentResponses('tx-b')), {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID, amount: 100, method: 'pix',
    });
    const probes = pool.query.mock.calls.filter(c => /to_regclass\('public\.credit_payment_allocations'\)/.test(c[0]));
    expect(probes).toHaveLength(1);
  });
});
