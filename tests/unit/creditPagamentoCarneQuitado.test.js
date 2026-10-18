// ============================================================
// AURA -- Crediario: pagamento direcionado a um carne ja quitado (t3-08)
//
// Caso real (Valen, 24/09/2026): o carne de R$780 ja tinha sido pago pelo
// recebimento livre; a lojista registrou mais R$780 e R$150 escolhendo esse
// carne na tela. O applyPayment so procurava parcela DENTRO do carne, nao
// achou nenhuma aberta e o dinheiro saiu do razao sem abater parcela: o
// carne do cliente passou a cobrar R$930 que ele ja tinha pago.
//
// Regra nova: a sobra do FIFO do carne segue para as demais parcelas abertas
// do cliente -- so ate onde as parcelas passam do saldo do razao (se o carne
// tem divida sem parcela, a sobra e o pagamento DELA).
// ============================================================
'use strict';

const creditLedger = require('../../src/services/creditLedger');

const LOJA    = 'comp-0000-0000-0000-000000000001';
const CLIENTE = 'cust-0000-0000-0000-000000000001';
const CARNE   = 'acct-0000-0000-0000-00000000000a';

/**
 * Cliente falso que responde pela FORMA da query (nao pela ordem), para o
 * teste nao quebrar se o applyPayment ganhar uma leitura no meio.
 */
function fakeClient({ scoped = [], others = [], excess = 0, balance = 0 }) {
  const query = jest.fn(async (sql) => {
    const s = String(sql);
    if (/INSERT INTO customer_credit_transactions/i.test(s)) {
      return { rows: [{ id: 'tx-pay-1', type: 'payment', amount: '0' }] };
    }
    if (/FROM transactions t\s+JOIN sales s/i.test(s)) return { rows: [] };        // A Receber
    if (/SELECT name FROM customers/i.test(s)) return { rows: [{ name: 'Cliente' }] };
    if (/AS excess/i.test(s)) return { rows: [{ excess: String(excess) }] };
    if (/FROM credit_installments[\s\S]*NOT \(id = ANY/i.test(s)) return { rows: others };
    if (/FROM credit_installments[\s\S]*FOR UPDATE/i.test(s)) return { rows: scoped };
    if (/COUNT\(\*\) FILTER \(WHERE status = 'paid'\)/i.test(s)) {
      return { rows: [{ total_paid_count: '1', total_paid_on_time: '1', avg_days_late: '0', total_purchases: '0' }] };
    }
    if (/AS months/i.test(s)) return { rows: [{ months: '1' }] };
    if (/SELECT balance FROM customer_credit_balances/i.test(s)) return { rows: [{ balance: String(balance) }] };
    return { rows: [] };
  });
  return { query };
}

const coveredUpdates = (client) =>
  client.query.mock.calls
    .filter(([sql]) => /UPDATE credit_installments\s+SET covered_amount/i.test(String(sql)))
    .map(([, p]) => ({ id: p[0], covered: p[2], status: p[3] }));

describe('applyPayment -- sobra de pagamento direcionado a carne', () => {
  test('carne ja quitado: o pagamento abate as parcelas abertas dos OUTROS carnes', async () => {
    const client = fakeClient({
      scoped: [],                                  // nada aberto no carne escolhido
      excess: 780,                                 // parcelas abertas passam do saldo em 780
      others: [
        { id: 'p-1', amount_due: '500.00', covered_amount: '0', status: 'overdue', due_date: '2026-09-25' },
        { id: 'p-2', amount_due: '500.00', covered_amount: '0', status: 'pending', due_date: '2026-10-25' },
      ],
    });

    const r = await creditLedger.applyPayment(client, {
      companyId: LOJA, customerId: CLIENTE, amount: 780, method: 'pix', accountId: CARNE,
    });

    expect(coveredUpdates(client)).toEqual([
      { id: 'p-1', covered: 500, status: 'paid' },
      { id: 'p-2', covered: 280, status: 'pending' },
    ]);
    expect(r.covered_installments.map((c) => c.covered)).toEqual([500, 280]);
  });

  test('carne com divida SEM parcela: a sobra paga essa divida e nao toca parcela de outra compra', async () => {
    // Saldo do razao maior que as parcelas abertas -> excesso <= 0.
    const client = fakeClient({
      scoped: [],
      excess: -100,
      others: [{ id: 'p-1', amount_due: '500.00', covered_amount: '0', status: 'pending', due_date: '2026-10-25' }],
    });

    await creditLedger.applyPayment(client, {
      companyId: LOJA, customerId: CLIENTE, amount: 100, method: 'pix', accountId: CARNE,
    });

    expect(coveredUpdates(client)).toEqual([]);
    const pediuOutras = client.query.mock.calls.some(([sql]) => /NOT \(id = ANY/i.test(String(sql)));
    expect(pediuOutras).toBe(false);
  });

  test('sobra maior que o excesso: so o excesso vai para as outras parcelas', async () => {
    const client = fakeClient({
      scoped: [],
      excess: 150,
      others: [{ id: 'p-1', amount_due: '500.00', covered_amount: '0', status: 'pending', due_date: '2026-10-25' }],
    });

    await creditLedger.applyPayment(client, {
      companyId: LOJA, customerId: CLIENTE, amount: 400, method: 'pix', accountId: CARNE,
    });

    expect(coveredUpdates(client)).toEqual([{ id: 'p-1', covered: 150, status: 'pending' }]);
  });

  test('o carne escolhido continua tendo prioridade; so o que sobra dele segue', async () => {
    const client = fakeClient({
      scoped: [{ id: 'c-1', amount_due: '100.00', covered_amount: '0', status: 'pending', due_date: '2026-11-01' }],
      excess: 50,
      others: [{ id: 'p-1', amount_due: '500.00', covered_amount: '0', status: 'overdue', due_date: '2026-09-01' }],
    });

    await creditLedger.applyPayment(client, {
      companyId: LOJA, customerId: CLIENTE, amount: 150, method: 'pix', accountId: CARNE,
    });

    expect(coveredUpdates(client)).toEqual([
      { id: 'c-1', covered: 100, status: 'paid' },
      { id: 'p-1', covered: 50, status: 'overdue' },
    ]);
    // a busca das outras exclui a parcela do carne ja vista
    const outras = client.query.mock.calls.find(([sql]) => /NOT \(id = ANY/i.test(String(sql)));
    expect(outras[1][2]).toEqual(['c-1']);
  });

  test('sem carne nem encomenda (FIFO global): nenhuma query nova', async () => {
    const client = fakeClient({
      scoped: [{ id: 'p-1', amount_due: '100.00', covered_amount: '0', status: 'pending', due_date: '2026-10-25' }],
    });

    await creditLedger.applyPayment(client, {
      companyId: LOJA, customerId: CLIENTE, amount: 300, method: 'pix',
    });

    const novas = client.query.mock.calls.filter(([sql]) => /AS excess|NOT \(id = ANY/i.test(String(sql)));
    expect(novas).toHaveLength(0);
    expect(coveredUpdates(client)).toEqual([{ id: 'p-1', covered: 100, status: 'paid' }]);
  });

  test('carne que absorve o pagamento inteiro: nenhuma query nova', async () => {
    const client = fakeClient({
      scoped: [{ id: 'c-1', amount_due: '300.00', covered_amount: '0', status: 'pending', due_date: '2026-10-25' }],
    });

    await creditLedger.applyPayment(client, {
      companyId: LOJA, customerId: CLIENTE, amount: 200, method: 'pix', accountId: CARNE,
    });

    const novas = client.query.mock.calls.filter(([sql]) => /AS excess|NOT \(id = ANY/i.test(String(sql)));
    expect(novas).toHaveLength(0);
  });
});
