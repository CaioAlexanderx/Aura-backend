// ============================================================
// AURA -- Crediario: renegociar com desconto em cima de parcela orfa (t3-08)
//
// Caso real (loja Fernanda, 07/10/2026): o cliente tinha R$2.129,90 em
// parcelas cujo debito tinha sido apagado (nenhuma linha de debito no
// razao). A lojista renegociou para R$1,00. O desconto de R$2.128,90 foi
// gravado como ESTORNO no razao, e o cliente passou a ter -R$2.128,90 de
// "credito" -- dinheiro que nunca existiu.
//
// Regra nova: o desconto so sai do razao na parte que o razao reconhece.
// A parte que era parcela sem lancamento so encolhe o cronograma.
// ============================================================
'use strict';

const { applyReschedule, ledgerBackedDiscount } = require('../../src/services/credit/reschedule');

const LOJA    = 'comp-0000-0000-0000-000000000001';
const CLIENTE = 'cust-0000-0000-0000-000000000001';

function fakeClient({ open = [], excess = 0, balance = 0 }) {
  const query = jest.fn(async (sql) => {
    const s = String(sql);
    if (/AS excess/i.test(s)) return { rows: [{ excess: String(excess) }] };
    if (/SELECT id, amount_due, covered_amount\s+FROM credit_installments/i.test(s)) return { rows: open };
    if (/INSERT INTO credit_installments/i.test(s)) return { rows: [{ id: 'nova-' + query.mock.calls.length }] };
    if (/SELECT balance FROM customer_credit_balances/i.test(s)) return { rows: [{ balance: String(balance) }] };
    return { rows: [] };
  });
  return { query };
}

const ledgerInserts = (client) =>
  client.query.mock.calls
    .filter(([sql]) => /INSERT INTO customer_credit_transactions/i.test(String(sql)))
    .map(([, p]) => ({ type: p[2], amount: p[3] }));

describe('ledgerBackedDiscount (puro)', () => {
  test('sem excesso: o desconto inteiro vai ao razao', () => {
    expect(ledgerBackedDiscount(100, 0)).toBe(100);
  });
  test('excesso maior que o desconto: nada vai ao razao', () => {
    expect(ledgerBackedDiscount(2128.9, 2129.9)).toBe(0);
  });
  test('excesso menor: so a diferenca vai ao razao', () => {
    expect(ledgerBackedDiscount(100, 30)).toBe(70);
  });
  test('excesso negativo (saldo sem parcela) nao aumenta o desconto', () => {
    expect(ledgerBackedDiscount(100, -50)).toBe(100);
  });
});

describe('applyReschedule -- desconto x parcela sem lancamento', () => {
  test('caso Fernanda: parcelas inteiras sem debito -> nenhum estorno no razao', async () => {
    const client = fakeClient({
      open: [
        { id: 'o-1', amount_due: '590.00', covered_amount: '0' },
        { id: 'o-2', amount_due: '660.00', covered_amount: '0' },
        { id: 'o-3', amount_due: '879.90', covered_amount: '0' },
      ],
      excess: 2129.9,
    });

    const r = await applyReschedule(client, {
      companyId: LOJA, customerId: CLIENTE, accountId: null,
      total: 1, installments: 1, firstDueDate: '2026-11-10',
    });

    expect(ledgerInserts(client)).toEqual([]);
    expect(r.delta).toBeCloseTo(-2128.9, 2);
    expect(r.adjustment).toEqual({
      type: 'discount', amount: 2128.9, ledger_amount: 0, absorbed_mismatch: 2128.9,
    });
  });

  test('cliente sem divergencia: estorno do desconto inteiro, formato de sempre', async () => {
    const client = fakeClient({
      open: [{ id: 'a-1', amount_due: '500.00', covered_amount: '0' }],
      excess: 0,
    });

    const r = await applyReschedule(client, {
      companyId: LOJA, customerId: CLIENTE, accountId: null,
      total: 400, installments: 2, firstDueDate: '2026-11-10',
    });

    expect(ledgerInserts(client)).toEqual([{ type: 'refund', amount: 100 }]);
    expect(r.adjustment).toEqual({ type: 'discount', amount: 100 });
  });

  test('parte orfa menor que o desconto: so o resto vira estorno', async () => {
    const client = fakeClient({
      open: [{ id: 'a-1', amount_due: '500.00', covered_amount: '0' }],
      excess: 30,
    });

    const r = await applyReschedule(client, {
      companyId: LOJA, customerId: CLIENTE, accountId: null,
      total: 400, installments: 2, firstDueDate: '2026-11-10',
    });

    expect(ledgerInserts(client)).toEqual([{ type: 'refund', amount: 70 }]);
    expect(r.adjustment).toEqual({ type: 'discount', amount: 100, ledger_amount: 70, absorbed_mismatch: 30 });
  });

  test('acrescimo nao muda: o debito do acrescimo entra inteiro', async () => {
    const client = fakeClient({
      open: [{ id: 'a-1', amount_due: '500.00', covered_amount: '0' }],
      excess: 200,
    });

    await applyReschedule(client, {
      companyId: LOJA, customerId: CLIENTE, accountId: null,
      total: 600, installments: 2, firstDueDate: '2026-11-10',
    });

    expect(ledgerInserts(client)).toEqual([{ type: 'debit', amount: 100 }]);
  });

  test('o excesso e lido ANTES de cancelar as parcelas antigas', async () => {
    const client = fakeClient({
      open: [{ id: 'a-1', amount_due: '500.00', covered_amount: '0' }],
    });
    await applyReschedule(client, {
      companyId: LOJA, customerId: CLIENTE, accountId: null,
      total: 400, installments: 1, firstDueDate: '2026-11-10',
    });
    const sqls = client.query.mock.calls.map(([sql]) => String(sql));
    const iExcess = sqls.findIndex((s) => /AS excess/i.test(s));
    const iCancel = sqls.findIndex((s) => /SET status = 'cancelled'/i.test(s));
    expect(iExcess).toBeGreaterThan(-1);
    expect(iExcess).toBeLessThan(iCancel);
  });
});
