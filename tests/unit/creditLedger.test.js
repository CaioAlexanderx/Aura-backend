// ============================================================
// AURA. -- Testes unitarios: src/services/creditLedger.js
// F6 (29/05/2026)
//
// Cobertura:
//   createCreditSale   -- simples + parcelado
//   applyPayment       -- total, parcial, split, > A Receber (legacy)
//   applyPayment (F2)  -- encargos materializados (gated, OFF, idempotencia)
//   cancelCreditSale   -- reverte debit + AR + installments
//
// Item 5 (16/06/2026): applyPayment faz 1 SELECT name FROM customers (logo apos
//   o INSERT do pagamento, so quando isNewPayment) p/ as descricoes claras no
//   Financeiro (nome do cliente em vez de uuid+"saldo legado"). Os mocks dos
//   testes do applyPayment incluem essa query na posicao 1.
// ============================================================

const pool = require('../../src/config/database');

// Re-importar apos o mock do setup
const creditLedger = require('../../src/services/creditLedger');

// Helper: cria mock client com query sequencial
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

// Resposta do SELECT name FROM customers (descricao clara — Item 5, 16/06).
// applyPayment resolve o nome do cliente logo apos o INSERT do pagamento.
const CUSTOMER_NAME_ROW = { rows: [{ name: 'Cliente Teste' }] };

describe('creditLedger.createCreditSale', () => {
  beforeEach(() => { jest.resetAllMocks(); });

  test('venda simples (1 parcela): insere debit + A Receber', async () => {
    const debitRow = {
      id: 'tx-01', type: 'debit', amount: '100.00',
      company_id: COMPANY_ID, customer_id: CUSTOMER_ID, sale_id: SALE_ID,
    };
    const client = makeMockClient([
      { rows: [{ id: 'prof-00', status: 'active' }] }, // _getOrCreateProfile (topo)
      { rows: [{ id: 'conf-00', max_installments: 12 }] }, // _getOrCreatePlanConfig (topo)
      { rows: [debitRow] }, // INSERT customer_credit_transactions debit
      { rows: [] },         // INSERT transactions A Receber
      { rows: [] },         // UPDATE customer_credit_profiles (credit_used) -- M1 12/06: 1x tambem atualiza
    ]);

    const result = await creditLedger.createCreditSale(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      saleId: SALE_ID, amount: 100,
    });

    expect(result.debited).toEqual(debitRow);
    expect(result.schedule).toHaveLength(0);
    expect(client.query).toHaveBeenCalledTimes(5);

    const debitCall = client.query.mock.calls[2];
    expect(debitCall[0]).toMatch(/INSERT INTO customer_credit_transactions/i);
    expect(debitCall[1]).toEqual(expect.arrayContaining([COMPANY_ID, CUSTOMER_ID, SALE_ID, 100]));

    const arCall = client.query.mock.calls[3];
    expect(arCall[0]).toMatch(/Crediario - A Receber/i);
    expect(arCall[1]).toEqual(expect.arrayContaining(['pdv-credit-receivable-' + SALE_ID]));
  });

  test('venda parcelada (3x): cria 3 credit_installments', async () => {
    const debitRow = { id: 'tx-02', type: 'debit', amount: '300.00' };
    const profileRow = { id: 'prof-01', company_id: COMPANY_ID, customer_id: CUSTOMER_ID, status: 'active' };
    const configRow  = { id: 'conf-01', company_id: COMPANY_ID, max_installments: 12, interest_rate: '0' };
    const instRow1   = { id: 'inst-01' };
    const instRow2   = { id: 'inst-02' };
    const instRow3   = { id: 'inst-03' };

    const client = makeMockClient([
      { rows: [profileRow] }, // _getOrCreateProfile (topo)
      { rows: [configRow] },  // _getOrCreatePlanConfig (topo)
      { rows: [debitRow] },   // INSERT debit
      { rows: [] },           // INSERT A Receber
      { rows: [instRow1] },   // INSERT installment 1 (B2: sem UPDATE pix_link)
      { rows: [instRow2] },   // INSERT installment 2
      { rows: [instRow3] },   // INSERT installment 3
      { rows: [] },           // UPDATE sales (is_installment)
      { rows: [] },           // UPDATE customer_credit_profiles (credit_used)
    ]);

    const result = await creditLedger.createCreditSale(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      saleId: SALE_ID, amount: 300,
      installments: 3,
      firstDueDate: '2026-07-01',
    });

    expect(result.schedule).toHaveLength(3);
    expect(result.schedule[0].installment_number).toBe(1);
    expect(result.schedule[2].installment_number).toBe(3);

    const inst1Call = client.query.mock.calls[4];
    expect(inst1Call[0]).toMatch(/INSERT INTO credit_installments/i);
    expect(inst1Call[0]).toMatch(/covered_amount/i);
  });

  test('juros simples aplicados quando interest_rate > 0', async () => {
    const debitRow  = { id: 'tx-03', amount: '100.00' };
    const profileRow = { id: 'prof-01', status: 'active' };
    const configRow  = { id: 'conf-01', max_installments: 12, interest_rate: '0.02' }; // 2%
    const instRow1   = { id: 'inst-a' };
    const instRow2   = { id: 'inst-b' };

    const client = makeMockClient([
      { rows: [profileRow] },
      { rows: [configRow] },
      { rows: [debitRow] },
      { rows: [] },
      { rows: [instRow1] }, // (B2: sem UPDATE pix_link)
      { rows: [instRow2] },
      { rows: [] }, { rows: [] },
    ]);

    await creditLedger.createCreditSale(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      saleId: SALE_ID, amount: 100,
      installments: 2, interestRate: 0.02, firstDueDate: '2026-07-01',
    });

    const inst1Insert = client.query.mock.calls[4];
    const amt = inst1Insert[1][5]; // 6o parametro = amount_due
    expect(parseFloat(amt)).toBeCloseTo(52, 1);
  });
});

describe('creditLedger.applyPayment', () => {
  beforeEach(() => { jest.resetAllMocks(); });

  test('pagamento total: liquida A Receber + atualiza covered_amount', async () => {
    const txRow = { id: 'tx-pay-01', type: 'payment', amount: '100.00' };
    const pendingAR = [
      { id: 'ar-01', amount: '100.00', idempotency_key: 'pdv-credit-receivable-' + SALE_ID, sale_id: SALE_ID },
    ];
    const pendingInst = [
      { id: 'inst-01', amount_due: '100.00', covered_amount: '0', status: 'pending', due_date: '2026-07-01' },
    ];
    const balRow = { balance: '0.00' };

    const client = makeMockClient([
      { rows: [txRow] },
      CUSTOMER_NAME_ROW, // SELECT name FROM customers (descricao clara)
      { rows: pendingAR },
      { rows: [] },  // UPDATE transactions (confirmed)
      { rows: [] },  // INSERT sale_payments
      { rows: pendingInst },
      { rows: [] },  // UPDATE credit_installments covered_amount
      { rows: [{ total_paid_count: '1', total_paid_on_time: '1', avg_days_late: '0', total_purchases: '100' }] },
      { rows: [{ months: '1' }] },
      { rows: [] }, // UPDATE score
      { rows: [] }, // UPDATE credit_used
      { rows: [balRow] },
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 100, method: 'pix',
    });

    expect(result.settled_receivables).toHaveLength(1);
    expect(result.settled_receivables[0].partial).toBe(false);
    expect(result.settled_receivables[0].amount).toBe(100);
    expect(result.covered_installments).toHaveLength(1);
    expect(result.covered_installments[0].status).toBe('paid');
    expect(result.new_balance).toBe(0);
  });

  test('pagamento parcial: split da A Receber + covered_amount parcial', async () => {
    const txRow = { id: 'tx-pay-02', type: 'payment', amount: '50.00' };
    const pendingAR = [
      { id: 'ar-02', amount: '100.00', idempotency_key: 'pdv-credit-receivable-abc', sale_id: 'sale-abc' },
    ];
    const pendingInst = [
      { id: 'inst-02', amount_due: '100.00', covered_amount: '0', status: 'pending', due_date: '2026-07-01' },
    ];
    const balRow = { balance: '50.00' };

    const client = makeMockClient([
      { rows: [txRow] },
      CUSTOMER_NAME_ROW, // SELECT name FROM customers (descricao clara)
      { rows: pendingAR },
      { rows: [] },  // UPDATE transactions (parcial)
      { rows: [] },  // INSERT sale_payments
      { rows: [] },  // INSERT rest A Receber
      { rows: pendingInst },
      { rows: [] },  // UPDATE covered_amount (50, status stays 'pending')
      { rows: [] },  // UPDATE credit_used
      { rows: [balRow] },
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'dinheiro',
    });

    expect(result.settled_receivables).toHaveLength(1);
    expect(result.settled_receivables[0].partial).toBe(true);
    expect(result.settled_receivables[0].amount).toBe(50);
    expect(result.settled_receivables[0].rest).toBe(50);
    expect(result.covered_installments[0].status).toBe('pending');
    expect(result.new_balance).toBe(50);

    // calls[5] = INSERT rest A Receber (shift +1 pelo SELECT name na posicao 1).
    const splitCall = client.query.mock.calls[5];
    expect(splitCall[0]).toMatch(/Crediario - A Receber/i);
    expect(splitCall[1][1]).toBeCloseTo(50, 2);
  });

  test('pagamento > A Receber: cria legacy Recebido generico', async () => {
    const txRow = { id: 'tx-pay-03', type: 'payment', amount: '200.00' };
    const pendingAR = [
      { id: 'ar-03', amount: '100.00', idempotency_key: 'pdv-credit-receivable-xyz', sale_id: 'sale-xyz' },
    ];
    const balRow = { balance: '0.00' };

    const client = makeMockClient([
      { rows: [txRow] },
      CUSTOMER_NAME_ROW, // SELECT name FROM customers (descricao clara)
      { rows: pendingAR },
      { rows: [] },  // UPDATE transactions (total)
      { rows: [] },  // INSERT sale_payments
      { rows: [] },  // INSERT Recebido legacy (remaining=100)
      { rows: [] },  // SELECT installments FOR UPDATE (vazio)
      { rows: [] },  // UPDATE credit_used
      { rows: [balRow] },
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 200, method: 'pix',
    });

    expect(result.settled_receivables).toHaveLength(1);
    expect(result.settled_receivables[0].partial).toBe(false);
    expect(result.legacy_amount).toBe(100);

    // calls[5] = INSERT Recebido legacy (shift +1 pelo SELECT name na posicao 1).
    const legacyCall = client.query.mock.calls[5];
    expect(legacyCall[0]).toMatch(/Crediario - Recebido/i);
    expect(legacyCall[0]).toMatch(/confirmed/i);
  });

  test('idempotencyKey: usa ON CONFLICT DO NOTHING', async () => {
    const txRow = { id: 'tx-idem', type: 'payment', amount: '50.00' };
    const balRow = { balance: '50.00' };

    const client = makeMockClient([
      { rows: [txRow] }, // INSERT com idempotency_key
      CUSTOMER_NAME_ROW, // SELECT name FROM customers (descricao clara)
      { rows: [] },      // SELECT pending AR (vazio)
      { rows: [] },      // INSERT Recebido legacy (remaining=50, sem AR)
      { rows: [] },      // SELECT installments (vazio)
      { rows: [] },      // UPDATE credit_used
      { rows: [balRow] },
    ]);

    await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'pix',
      idempotencyKey: 'test-key-001',
    });

    const insertCall = client.query.mock.calls[0];
    expect(insertCall[0]).toMatch(/ON CONFLICT \(idempotency_key\)/i);
    expect(insertCall[1]).toContain('test-key-001');
  });
});

// ============================================================
// F2 PR2: MATERIALIZACAO de encargos (mora/multa) no recebimento.
// ============================================================
describe('creditLedger.applyPayment — encargos (F2)', () => {
  beforeEach(() => { jest.resetAllMocks(); });

  const ENABLED_CONFIG = {
    late_charges_enabled: true,
    late_grace_days: 3,
    late_fee_rate: 0.02,
    late_interest_daily: 0.01 / 30,
  };

  test('(a) enabled + parcela vencida: abate encargos primeiro, depois principal', async () => {
    const txRow = { id: 'tx-charge-01', type: 'payment', amount: '50.00' };
    const openInst = [
      { id: 'inst-c1', sale_id: SALE_ID, amount_due: '100.00', covered_amount: '0', status: 'overdue', due_date: '2026-01-01' },
    ];
    const pendingAR = [
      { id: 'ar-c1', amount: '100.00', idempotency_key: 'pdv-credit-receivable-' + SALE_ID, sale_id: SALE_ID },
    ];
    const fifoInst = [
      { id: 'inst-c1', amount_due: '100.00', covered_amount: '0', status: 'overdue', due_date: '2026-01-01' },
    ];
    const balRow = { balance: '52.93' };

    const client = makeMockClient([
      { rows: [txRow] },     // 0 INSERT payment (novo)
      CUSTOMER_NAME_ROW,     // 1 SELECT name FROM customers (descricao clara)
      { rows: openInst },    // 2 SELECT parcelas abertas (engine de encargos)
      { rows: [] },          // 3 INSERT transactions 'Encargos'
      { rows: [] },          // 4 UPDATE credit_installments (stamp late_fee/late_interest)
      { rows: [] },          // 5 INSERT sale_payments (encargos no caixa)
      { rows: pendingAR },   // 6 SELECT A Receber pendentes (FIFO principal)
      { rows: [] },          // 7 UPDATE transactions (parcial)
      { rows: [] },          // 8 INSERT sale_payments (principal)
      { rows: [] },          // 9 INSERT rest A Receber
      { rows: fifoInst },    // 10 SELECT installments FOR UPDATE
      { rows: [] },          // 11 UPDATE covered_amount
      { rows: [] },          // 12 UPDATE credit_used
      { rows: [balRow] },    // 13 SELECT balance
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'pix',
      paidAt: '2026-02-01',
      config: ENABLED_CONFIG,
      profile: null,
    });

    // A2 (auditoria 12/06): paidAt -> meio-dia local evita o off-by-one de TZ.
    // 01/02 vs vencimento 01/01 = 31 dias corridos; 28 cobrados apos carencia 3.
    // late_fee = 100 * 2% = 2.00 ; late_interest = 100 * (0.01/30) * 28 = 0.93.
    expect(result.charges_paid).toBeCloseTo(2.93, 2);
    expect(result.charges_detail).toHaveLength(1);
    expect(result.charges_detail[0].installment_id).toBe('inst-c1');
    expect(result.charges_detail[0].late_fee).toBeCloseTo(2.0, 2);
    expect(result.charges_detail[0].late_interest).toBeCloseTo(0.93, 2);

    // calls[3] = INSERT 'Encargos' (shift +1 pelo SELECT name na posicao 1).
    const encargosCall = client.query.mock.calls[3];
    expect(encargosCall[0]).toMatch(/Crediario - Encargos/i);
    expect(encargosCall[0]).toMatch(/confirmed/i);
    expect(encargosCall[1][1]).toBeCloseTo(2.93, 2);
    expect(encargosCall[1]).toContain('credit-charges-' + txRow.id);

    // calls[7] = UPDATE transactions (parcial) do principal (shift +1).
    const arUpdateCall = client.query.mock.calls[7];
    expect(arUpdateCall[0]).toMatch(/UPDATE transactions/i);
    expect(parseFloat(arUpdateCall[1][1])).toBeCloseTo(47.07, 2);
  });

  test('(b) OFF (config sem flag): charges_paid 0 e ZERO queries de encargos', async () => {
    const txRow = { id: 'tx-off-01', type: 'payment', amount: '50.00' };
    const pendingAR = [
      { id: 'ar-off', amount: '100.00', idempotency_key: 'pdv-credit-receivable-off', sale_id: 'sale-off' },
    ];
    const pendingInst = [
      { id: 'inst-off', amount_due: '100.00', covered_amount: '0', status: 'pending', due_date: '2026-07-01' },
    ];
    const balRow = { balance: '50.00' };

    const client = makeMockClient([
      { rows: [txRow] },     // 0 INSERT payment
      CUSTOMER_NAME_ROW,     // 1 SELECT name FROM customers (descricao clara)
      { rows: pendingAR },   // 2 SELECT A Receber
      { rows: [] },          // 3 UPDATE transactions (parcial)
      { rows: [] },          // 4 INSERT sale_payments
      { rows: [] },          // 5 INSERT rest A Receber
      { rows: pendingInst },  // 6 SELECT installments FOR UPDATE
      { rows: [] },          // 7 UPDATE covered_amount
      { rows: [] },          // 8 UPDATE credit_used
      { rows: [balRow] },    // 9 SELECT balance
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'dinheiro',
      config: {},
      profile: null,
    });

    expect(result.charges_paid).toBe(0);
    expect(result.charges_detail).toEqual([]);
    // 10 = 9 originais + 1 SELECT name (descricao clara, 16/06).
    expect(client.query).toHaveBeenCalledTimes(10);
    const anyEncargos = client.query.mock.calls.some(c => /Crediario - Encargos/i.test(c[0] || ''));
    expect(anyEncargos).toBe(false);
    // calls[3] = UPDATE transactions (parcial) (shift +1 pelo SELECT name).
    const arUpdateCall = client.query.mock.calls[3];
    expect(parseFloat(arUpdateCall[1][1])).toBeCloseTo(50, 2);
  });

  test('(c) idempotencia: replay (ON CONFLICT) e NO-OP — nao materializa encargos nem re-roda o FIFO', async () => {
    // C1-BE (auditoria 11/06): no replay idempotente o INSERT do payment retorna
    // vazio (isNewPayment=false). A funcao agora retorna um resultado NO-OP
    // reconstruido ANTES do FIFO — antes ela re-executava todo o FIFO (covered_amount
    // dobrado, sale_payments duplicado, receita 2x). Sequencia: INSERT(0) +
    // SELECT existing(1) + SELECT balance(2) e RETORNA. Nenhuma escrita.
    // O SELECT name (Item 5) roda DEPOIS do early-return, entao NAO entra aqui.
    const existingTx = { id: 'tx-replay', type: 'payment', amount: '50.00' };
    const balRow = { balance: '50.00' };

    const client = makeMockClient([
      { rows: [] },           // 0 INSERT payment ON CONFLICT DO NOTHING (replay => 0 linhas)
      { rows: [existingTx] }, // 1 SELECT existing tx
      { rows: [balRow] },     // 2 SELECT balance (early return no-op)
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'pix',
      idempotencyKey: 'replay-key-001',
      config: ENABLED_CONFIG, // ON, mas replay e no-op
      profile: null,
    });

    expect(result.charges_paid).toBe(0);
    expect(result.charges_detail).toEqual([]);
    expect(result.replayed).toBe(true);
    expect(result.settled_receivables).toEqual([]);
    expect(result.covered_installments).toEqual([]);
    expect(result.new_balance).toBe(50);

    // NO-OP: exatamente 3 queries (INSERT + SELECT existing + SELECT balance).
    expect(client.query).toHaveBeenCalledTimes(3);
    const anyEncargos = client.query.mock.calls.some(c => /Crediario - Encargos/i.test(c[0] || ''));
    expect(anyEncargos).toBe(false);
    const anyFifoWrite = client.query.mock.calls.some(c =>
      /UPDATE credit_installments|INSERT INTO sale_payments|UPDATE transactions|INSERT INTO transactions/i.test(c[0] || '')
    );
    expect(anyFifoWrite).toBe(false);
    const selectedExisting = client.query.mock.calls.some(c => /SELECT \* FROM customer_credit_transactions WHERE idempotency_key/i.test(c[0] || ''));
    expect(selectedExisting).toBe(true);
  });
});

describe('creditLedger.cancelCreditSale', () => {
  beforeEach(() => { jest.resetAllMocks(); });

  test('cancela debit + A Receber principal + splits + installments + credit_used', async () => {
    const saleRow = { customer_id: CUSTOMER_ID };
    const client = makeMockClient([
      { rows: [saleRow] }, // SELECT customer_id FROM sales
      { rows: [] },        // DELETE customer_credit_transactions
      { rows: [] },        // DELETE transactions (A Receber principal)
      { rows: [] },        // DELETE transactions (splits LIKE)
      { rows: [] },        // UPDATE credit_installments (cancel)
      { rows: [] },        // UPDATE customer_credit_profiles (credit_used)
    ]);

    const result = await creditLedger.cancelCreditSale(client, {
      companyId: COMPANY_ID, saleId: SALE_ID,
    });

    expect(result.ok).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(6);

    const deleteDebitCall = client.query.mock.calls[1];
    expect(deleteDebitCall[0]).toMatch(/DELETE FROM customer_credit_transactions/i);
    expect(deleteDebitCall[0]).toMatch(/type\s*=\s*'debit'/i);

    const deleteARCall = client.query.mock.calls[2];
    expect(deleteARCall[0]).toMatch(/DELETE FROM transactions/i);
    expect(deleteARCall[1]).toContain('pdv-credit-receivable-' + SALE_ID);

    const cancelInstCall = client.query.mock.calls[4];
    expect(cancelInstCall[0]).toMatch(/UPDATE credit_installments/i);
    expect(cancelInstCall[0]).toMatch(/cancelled/i);
    expect(cancelInstCall[0]).toMatch(/covered_amount\s*=\s*0/i);
  });

  test('funciona sem customer_id (venda sem cliente)', async () => {
    const client = makeMockClient([
      { rows: [{ customer_id: null }] }, // sale sem customer
      { rows: [] }, // DELETE debit
      { rows: [] }, // DELETE AR
      { rows: [] }, // DELETE splits
      { rows: [] }, // UPDATE installments
    ]);

    const result = await creditLedger.cancelCreditSale(client, {
      companyId: COMPANY_ID, saleId: SALE_ID,
    });

    expect(result.ok).toBe(true);
    const calls = client.query.mock.calls.map(c => c[0]);
    const creditUsedCall = calls.find(q => typeof q === 'string' && q.includes('credit_used'));
    expect(creditUsedCall).toBeUndefined();
  });
});

describe('422 CREDIARIO_REQUIRES_CUSTOMER', () => {
  test('detecta crediario em payment_method', () => {
    const payment_method = 'crediario';
    const customer_id = null;
    const payments = undefined;
    const hasCreditInPayments = Array.isArray(payments) &&
      payments.some(p => (p.method || '').toLowerCase() === 'crediario');
    const isCrediario = (payment_method || '').toLowerCase() === 'crediario' || hasCreditInPayments;
    expect(isCrediario && !customer_id).toBe(true);
  });

  test('detecta crediario em payments[]', () => {
    const payment_method = 'misto';
    const customer_id = null;
    const payments = [{ method: 'dinheiro', value: 50 }, { method: 'crediario', value: 50 }];
    const hasCreditInPayments = Array.isArray(payments) &&
      payments.some(p => (p.method || '').toLowerCase() === 'crediario');
    const isCrediario = (payment_method || '').toLowerCase() === 'crediario' || hasCreditInPayments;
    expect(isCrediario && !customer_id).toBe(true);
  });

  test('nao bloqueia crediario COM cliente', () => {
    const payment_method = 'crediario';
    const customer_id = CUSTOMER_ID;
    const payments = undefined;
    const hasCreditInPayments = Array.isArray(payments) &&
      payments.some(p => (p.method || '').toLowerCase() === 'crediario');
    const isCrediario = (payment_method || '').toLowerCase() === 'crediario' || hasCreditInPayments;
    expect(isCrediario && !customer_id).toBe(false);
  });

  test('nao bloqueia venda dinheiro sem cliente', () => {
    const payment_method = 'dinheiro';
    const customer_id = null;
    const payments = undefined;
    const hasCreditInPayments = Array.isArray(payments) &&
      payments.some(p => (p.method || '').toLowerCase() === 'crediario');
    const isCrediario = (payment_method || '').toLowerCase() === 'crediario' || hasCreditInPayments;
    expect(isCrediario && !customer_id).toBe(false);
  });
});

describe('creditLedger.getCustomerCreditPreview', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    pool.query.mockResolvedValue({ rows: [] });
  });

  test('retorna preview com dados do cliente', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ balance: '150.00' }] })
      .mockResolvedValueOnce({ rows: [{ credit_score: 720, credit_limit: 500, credit_used: 150, status: 'active', blocked_reason: null }] })
      .mockResolvedValueOnce({ rows: [{ open_count: '2', next_due_date: '2026-07-01', overdue_count: '0' }] });

    const preview = await creditLedger.getCustomerCreditPreview(COMPANY_ID, CUSTOMER_ID);

    expect(preview.balance).toBe(150);
    expect(preview.score).toBe(720);
    expect(preview.score_label).toBe('bom');
    expect(preview.open_installments_count).toBe(2);
    expect(preview.over_limit).toBe(false);
    expect(preview.status).toBe('active');
  });

  test('over_limit = true quando balance >= credit_limit', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ balance: '500.00' }] })
      .mockResolvedValueOnce({ rows: [{ credit_score: 600, credit_limit: 500, credit_used: 500, status: 'active', blocked_reason: null }] })
      .mockResolvedValueOnce({ rows: [{ open_count: '1', next_due_date: null, overdue_count: '0' }] });

    const preview = await creditLedger.getCustomerCreditPreview(COMPANY_ID, CUSTOMER_ID);

    expect(preview.over_limit).toBe(true);
  });

  test('retorna defaults quando tabelas nao existem (42P01)', async () => {
    const err = Object.assign(new Error('table not found'), { code: '42P01' });
    pool.query.mockRejectedValueOnce(err);

    const preview = await creditLedger.getCustomerCreditPreview(COMPANY_ID, CUSTOMER_ID);

    expect(preview.balance).toBe(0);
    expect(preview.score).toBe(500);
    expect(preview.score_label).toBe('regular');
    expect(preview.over_limit).toBe(false);
  });
});
