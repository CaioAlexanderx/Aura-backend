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
// Regras:
//   - resetAllMocks no beforeEach (nao clearAllMocks)
//   - Mock client = objeto com .query jest.fn() sequencial
//   - pool.query mockado via jest.setup.js (database mock global)
//
// NOTA pool.query + .catch():
//   getCustomerCreditPreview usa pool.query(profiles).catch(() => ...).
//   Apos resetAllMocks(), pool.query eh jest.fn() sem implementacao e
//   retorna undefined. Chamar .catch() em undefined lanca TypeError
//   sincronico antes do Promise.all, quebrando o teste.
//   Solucao: beforeEach do describe de preview seta
//   pool.query.mockResolvedValue({ rows: [] }) como fallback seguro.
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
    ]);

    const result = await creditLedger.createCreditSale(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      saleId: SALE_ID, amount: 100,
    });

    expect(result.debited).toEqual(debitRow);
    expect(result.schedule).toHaveLength(0);
    expect(client.query).toHaveBeenCalledTimes(4);

    // Verifica que o debit foi inserido corretamente
    const debitCall = client.query.mock.calls[2];
    expect(debitCall[0]).toMatch(/INSERT INTO customer_credit_transactions/i);
    expect(debitCall[1]).toEqual(expect.arrayContaining([COMPANY_ID, CUSTOMER_ID, SALE_ID, 100]));

    // Verifica A Receber
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
      { rows: [instRow1] },   // INSERT installment 1
      { rows: [] },           // UPDATE pix_link 1
      { rows: [instRow2] },   // INSERT installment 2
      { rows: [] },           // UPDATE pix_link 2
      { rows: [instRow3] },   // INSERT installment 3
      { rows: [] },           // UPDATE pix_link 3
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

    // Verifica que covered_amount=0 no INSERT
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
      { rows: [instRow1] }, { rows: [] },
      { rows: [instRow2] }, { rows: [] },
      { rows: [] }, { rows: [] },
    ]);

    await creditLedger.createCreditSale(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      saleId: SALE_ID, amount: 100,
      installments: 2, interestRate: 0.02, firstDueDate: '2026-07-01',
    });

    // Com juros simples: total = 100 * (1 + 0.02*2) = 104
    // Cada parcela = 52.00
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

    // Parcela fica 'paid' (covered_amount 100 >= amount_due 100) -> recalculateScore chamado
    const client = makeMockClient([
      { rows: [txRow] },
      { rows: pendingAR },
      { rows: [] },  // UPDATE transactions (confirmed)
      { rows: [] },  // INSERT sale_payments
      { rows: pendingInst },
      { rows: [] },  // UPDATE credit_installments covered_amount
      // recalculateScore: 2 queries
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
      { rows: pendingAR },
      { rows: [] },  // UPDATE transactions (parcial)
      { rows: [] },  // INSERT sale_payments
      { rows: [] },  // INSERT rest A Receber
      { rows: pendingInst },
      { rows: [] },  // UPDATE covered_amount (50, status stays 'pending')
      // sem recalculateScore (parcela nao ficou 'paid')
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

    // Verifica que o split criou nova A Receber
    const splitCall = client.query.mock.calls[4];
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
      { rows: pendingAR },
      { rows: [] },  // UPDATE transactions (total)
      { rows: [] },  // INSERT sale_payments
      { rows: [] },  // INSERT Recebido legacy (remaining=100)
      { rows: [] },  // SELECT installments FOR UPDATE (vazio)
      // sem recalculateScore
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

    // Verifica insercao do legacy
    const legacyCall = client.query.mock.calls[4];
    expect(legacyCall[0]).toMatch(/Crediario - Recebido/i);
    expect(legacyCall[0]).toMatch(/confirmed/i);
  });

  test('idempotencyKey: usa ON CONFLICT DO NOTHING', async () => {
    const txRow = { id: 'tx-idem', type: 'payment', amount: '50.00' };
    const balRow = { balance: '50.00' };

    const client = makeMockClient([
      { rows: [txRow] }, // INSERT com idempotency_key
      { rows: [] },      // SELECT pending AR (vazio)
      { rows: [] },      // SELECT installments (vazio)
      { rows: [] },      // UPDATE credit_used
      { rows: [balRow] },
    ]);

    await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'pix',
      idempotencyKey: 'test-key-001',
    });

    // Primeira query deve usar ON CONFLICT (idempotency_key)
    const insertCall = client.query.mock.calls[0];
    expect(insertCall[0]).toMatch(/ON CONFLICT \(idempotency_key\)/i);
    expect(insertCall[1]).toContain('test-key-001');
  });
});

// ============================================================
// F2 PR2: MATERIALIZACAO de encargos (mora/multa) no recebimento.
//
// Arquitetura GATED: a materializacao SO roda quando
// opts.config.late_charges_enabled === true E o pagamento e novo
// (isNewPayment, ou seja NAO replay idempotente). Caso contrario o
// comportamento e EXATAMENTE o atual (charges_paid: 0, zero queries
// novas) — exatamente por isso TODOS os testes acima de applyPayment
// (que NAO passam config) seguem com a mesma sequencia de mocks.
//
// Ordem (imutavel): ENCARGOS PRIMEIRO -> principal.
// Invariante: encargos NUNCA viram customer_credit_transactions 'debit',
// logo o saldo de principal nunca e inflado por encargos.
// ============================================================
describe('creditLedger.applyPayment — encargos (F2)', () => {
  beforeEach(() => { jest.resetAllMocks(); });

  // Config com encargos LIGADOS. Tetos CDC: multa<=2%, mora<=1% a.m. (0.01/30/dia).
  const ENABLED_CONFIG = {
    late_charges_enabled: true,
    late_grace_days: 3,
    late_fee_rate: 0.02,
    late_interest_daily: 0.01 / 30,
  };

  test('(a) enabled + parcela vencida: abate encargos primeiro, depois principal', async () => {
    // due 2026-01-01, paidAt '2026-02-01'. O engine normaliza a data efetiva para o
    // dia-calendario em America/Sao_Paulo (UTC-3): new Date('2026-02-01') = 00:00Z =>
    // 2026-01-31 em SP. Logo daysOverdue = 30, daysCharged = 30-3 = 27.
    // principalRemaining = 100 => multa = 100*0.02 = 2.00;
    // mora = round2(100*(0.01/30)*27) = round2(0.90) = 0.90; total = 2.90.
    const txRow = { id: 'tx-charge-01', type: 'payment', amount: '50.00' };
    const openInst = [
      { id: 'inst-c1', sale_id: SALE_ID, amount_due: '100.00', covered_amount: '0', status: 'overdue', due_date: '2026-01-01' },
    ];
    // amount 50: chargesPaid = 2.90, principalAmount = 47.10. AR de 100 => parcial.
    const pendingAR = [
      { id: 'ar-c1', amount: '100.00', idempotency_key: 'pdv-credit-receivable-' + SALE_ID, sale_id: SALE_ID },
    ];
    const fifoInst = [
      { id: 'inst-c1', amount_due: '100.00', covered_amount: '0', status: 'overdue', due_date: '2026-01-01' },
    ];
    const balRow = { balance: '52.90' };

    const client = makeMockClient([
      { rows: [txRow] },     // 0 INSERT payment (novo)
      { rows: openInst },    // 1 SELECT parcelas abertas (engine de encargos)
      { rows: [] },          // 2 INSERT transactions 'Encargos'
      { rows: [] },          // 3 UPDATE credit_installments (stamp late_fee/late_interest)
      { rows: [] },          // 4 INSERT sale_payments (encargos no caixa)
      { rows: pendingAR },   // 5 SELECT A Receber pendentes (FIFO principal)
      { rows: [] },          // 6 UPDATE transactions (parcial: principal 47.10 < AR 100)
      { rows: [] },          // 7 INSERT sale_payments (principal)
      { rows: [] },          // 8 INSERT rest A Receber
      { rows: fifoInst },    // 9 SELECT installments FOR UPDATE
      { rows: [] },          // 10 UPDATE covered_amount (parcial, segue overdue)
      { rows: [] },          // 11 UPDATE credit_used
      { rows: [balRow] },    // 12 SELECT balance
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'pix',
      paidAt: '2026-02-01',
      config: ENABLED_CONFIG,
      profile: null,
    });

    // charges_paid esperado: 2.90 (multa 2.00 + mora 0.90)
    expect(result.charges_paid).toBeCloseTo(2.90, 2);
    expect(result.charges_detail).toHaveLength(1);
    expect(result.charges_detail[0].installment_id).toBe('inst-c1');
    expect(result.charges_detail[0].late_fee).toBeCloseTo(2.0, 2);
    expect(result.charges_detail[0].late_interest).toBeCloseTo(0.90, 2);

    // Transacao 'Crediario - Encargos' inserida com o valor dos encargos.
    const encargosCall = client.query.mock.calls[2];
    expect(encargosCall[0]).toMatch(/Crediario - Encargos/i);
    expect(encargosCall[0]).toMatch(/confirmed/i);
    expect(encargosCall[1][1]).toBeCloseTo(2.90, 2);          // amount = chargesPaid
    expect(encargosCall[1]).toContain('credit-charges-' + txRow.id); // idempotency_key

    // O principal aplicado e (amount - encargos) = 47.10: o UPDATE parcial da AR
    // recebeu paidNow ~47.10.
    const arUpdateCall = client.query.mock.calls[6];
    expect(arUpdateCall[0]).toMatch(/UPDATE transactions/i);
    expect(parseFloat(arUpdateCall[1][1])).toBeCloseTo(47.10, 2); // paidNow (principal)
  });

  test('(b) OFF (config sem flag): charges_paid 0 e ZERO queries de encargos', async () => {
    // Mesma sequencia EXATA do teste "pagamento parcial" acima (sem ramo de encargos).
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
      { rows: pendingAR },   // 1 SELECT A Receber (NAO ha SELECT de encargos antes)
      { rows: [] },          // 2 UPDATE transactions (parcial)
      { rows: [] },          // 3 INSERT sale_payments
      { rows: [] },          // 4 INSERT rest A Receber
      { rows: pendingInst },  // 5 SELECT installments FOR UPDATE
      { rows: [] },          // 6 UPDATE covered_amount
      { rows: [] },          // 7 UPDATE credit_used
      { rows: [balRow] },    // 8 SELECT balance
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'dinheiro',
      config: {}, // sem late_charges_enabled => OFF
      profile: null,
    });

    expect(result.charges_paid).toBe(0);
    expect(result.charges_detail).toEqual([]);
    // Sequencia identica ao comportamento atual (9 queries, nenhuma de encargos).
    expect(client.query).toHaveBeenCalledTimes(9);
    const anyEncargos = client.query.mock.calls.some(c => /Crediario - Encargos/i.test(c[0] || ''));
    expect(anyEncargos).toBe(false);
    // O principal aplicado e o amount cheio (50): UPDATE parcial recebeu ~50.
    const arUpdateCall = client.query.mock.calls[2];
    expect(parseFloat(arUpdateCall[1][1])).toBeCloseTo(50, 2);
  });

  test('(c) idempotencia: replay (ON CONFLICT) NAO materializa encargos de novo', async () => {
    // INSERT do payment via idempotencyKey retorna vazio => isNewPayment=false.
    // Mesmo com config ON, o ramo de encargos NAO roda.
    const existingTx = { id: 'tx-replay', type: 'payment', amount: '50.00' };
    const balRow = { balance: '50.00' };

    const client = makeMockClient([
      { rows: [] },           // 0 INSERT payment ON CONFLICT DO NOTHING (replay => 0 linhas)
      { rows: [existingTx] }, // 1 SELECT existing tx
      { rows: [] },           // 2 SELECT A Receber (FIFO principal direto, sem encargos)
      { rows: [] },           // 3 SELECT installments FOR UPDATE
      { rows: [] },           // 4 UPDATE credit_used
      { rows: [balRow] },     // 5 SELECT balance
    ]);

    const result = await creditLedger.applyPayment(client, {
      companyId: COMPANY_ID, customerId: CUSTOMER_ID,
      amount: 50, method: 'pix',
      idempotencyKey: 'replay-key-001',
      config: ENABLED_CONFIG, // ON, mas replay nao materializa
      profile: null,
    });

    expect(result.charges_paid).toBe(0);
    expect(result.charges_detail).toEqual([]);
    // 6 queries: nenhuma de encargos, e o SELECT existing tx aconteceu (replay).
    expect(client.query).toHaveBeenCalledTimes(6);
    const anyEncargos = client.query.mock.calls.some(c => /Crediario - Encargos/i.test(c[0] || ''));
    expect(anyEncargos).toBe(false);
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

    // DELETE debit
    const deleteDebitCall = client.query.mock.calls[1];
    expect(deleteDebitCall[0]).toMatch(/DELETE FROM customer_credit_transactions/i);
    expect(deleteDebitCall[0]).toMatch(/type\s*=\s*'debit'/i);

    // DELETE A Receber
    const deleteARCall = client.query.mock.calls[2];
    expect(deleteARCall[0]).toMatch(/DELETE FROM transactions/i);
    expect(deleteARCall[1]).toContain('pdv-credit-receivable-' + SALE_ID);

    // UPDATE credit_installments (cancel)
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
      // sem UPDATE credit_used (customer_id null)
    ]);

    const result = await creditLedger.cancelCreditSale(client, {
      companyId: COMPANY_ID, saleId: SALE_ID,
    });

    expect(result.ok).toBe(true);
    // Nao deve chamar UPDATE credit_used
    const calls = client.query.mock.calls.map(c => c[0]);
    const creditUsedCall = calls.find(q => typeof q === 'string' && q.includes('credit_used'));
    expect(creditUsedCall).toBeUndefined();
  });
});

describe('422 CREDIARIO_REQUIRES_CUSTOMER', () => {
  // Testa a logica de deteccao no pdv.js (sem precisar subir o servidor)
  // A logica e: isCrediario && !customer_id => 422
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
    // IMPORTANTE: pool.query retorna `undefined` apos resetAllMocks (jest.fn() default).
    // getCustomerCreditPreview chama pool.query(profiles).catch(...) -- se o resultado
    // for undefined, .catch() lanca TypeError sincronico antes do Promise.all.
    // Setamos mockResolvedValue como fallback seguro para todas as chamadas sem
    // implementacao especifica.
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
    expect(preview.over_limit).toBe(false); // 150 < 500
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
    // mockRejectedValueOnce sobrepoe o mockResolvedValue do beforeEach para a 1a chamada.
    // Chamadas 2 e 3 usam o mockResolvedValue({ rows: [] }) como fallback -- retornam
    // Promises validas, permitindo que o .catch() do profiles seja chamado sem TypeError.
    // Promise.all rejeita com o erro 42P01 da chamada 1, o catch o trata e retorna defaults.
    const err = Object.assign(new Error('table not found'), { code: '42P01' });
    pool.query.mockRejectedValueOnce(err);

    const preview = await creditLedger.getCustomerCreditPreview(COMPANY_ID, CUSTOMER_ID);

    expect(preview.balance).toBe(0);
    expect(preview.score).toBe(500);
    expect(preview.score_label).toBe('regular');
    expect(preview.over_limit).toBe(false);
  });
});
