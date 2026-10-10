// ============================================================
// AURA. — Testes unitários: src/services/credit/carneSummary.js (10/10/2026)
//
// Resumo por carnê que alimenta a ficha (um cartão por carnê) e a junção.
// Trava: "quanto falta" sai das PARCELAS + saldo sem parcela, não do razão
// por carnê (o pagamento livre fica sem carnê).
// ============================================================

const {
  NO_ACCOUNT_KEY, allocateUnscheduled, summarizeCarnes, isHiddenAccount,
} = require('../../src/services/credit/carneSummary');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4333-8333-cccccccccccc';

const inst = (id, account_id, extra = {}) => ({
  id, account_id, installment_number: 1, total_installments: 1,
  amount_due: '100.00', covered_amount: '0.00', due_date: '2026-12-10',
  status: 'pending', paid_at: null, ...extra,
});
const debit = (id, account_id, amount, created_at, extra = {}) => ({
  id, account_id, sale_id: null, amount: String(amount), notes: null, created_at, ...extra,
});

describe('allocateUnscheduled — repartição do saldo sem parcela', () => {
  test('nada a repartir: mapa vazio', () => {
    expect(allocateUnscheduled({ unscheduled: 0, groups: [{ key: A, live_count: 0, net_debit: 50 }] })).toEqual({});
  });

  test('só concorre carnê SEM parcela viva; do mais novo para o mais antigo', () => {
    const fatias = allocateUnscheduled({
      unscheduled: 120,
      groups: [
        { key: A, live_count: 0, net_debit: 80, created_at: '2026-09-13T12:00:00Z' },
        { key: B, live_count: 0, net_debit: 70, created_at: '2026-09-14T12:00:00Z' },
        { key: C, live_count: 3, net_debit: 300, created_at: '2026-09-15T12:00:00Z' }, // tem parcelas: fora
      ],
    });
    // B (mais novo) leva o débito inteiro; A fica com o resto.
    expect(fatias).toEqual({ [B]: 70, [A]: 50 });
  });

  test('o que sobra vai para o grupo sem carnê, limitado aos débitos dele', () => {
    const fatias = allocateUnscheduled({
      unscheduled: 200,
      groups: [
        { key: A, live_count: 0, net_debit: 60, created_at: '2026-10-01T12:00:00Z' },
        { key: NO_ACCOUNT_KEY, live_count: 5, net_debit: 90, created_at: null },
      ],
    });
    expect(fatias).toEqual({ [A]: 60, [NO_ACCOUNT_KEY]: 90 });
    // A soma das fatias nunca passa do saldo sem parcela do cliente.
    expect(Object.values(fatias).reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(200);
  });

  test('sem grupo sem carnê a sobra não vira dívida fantasma', () => {
    const fatias = allocateUnscheduled({
      unscheduled: 500,
      groups: [{ key: A, live_count: 0, net_debit: 60, created_at: '2026-10-01T12:00:00Z' }],
    });
    expect(fatias).toEqual({ [A]: 60 });
  });
});

describe('summarizeCarnes', () => {
  const itemsBySale = {
    'sale-a': [
      { product_name: 'Vans Hylane', quantity: '1', unit_price: '120.00', total_price: '120.00' },
      { product_name: 'Meia', quantity: '2', unit_price: '15.00', total_price: '30.00' },
    ],
  };

  test('carnê parcelado: N de M pagas, parcelas pagas e quanto falta saem das parcelas', () => {
    const out = summarizeCarnes({
      accounts: [{ id: A, created_at: '2026-09-13T15:00:00Z' }],
      installments: [
        inst('i1', A, { installment_number: 1, total_installments: 3, amount_due: '50.00', covered_amount: '50.00', status: 'paid', paid_at: '2026-10-01T14:00:00Z', due_date: '2026-10-10' }),
        inst('i2', A, { installment_number: 2, total_installments: 3, amount_due: '50.00', covered_amount: '20.00', due_date: '2026-11-10' }),
        inst('i3', A, { installment_number: 3, total_installments: 3, amount_due: '50.00', due_date: '2026-12-10' }),
        inst('ix', A, { status: 'cancelled', amount_due: '999.00' }),
      ],
      debits: [debit('d1', A, 150, '2026-09-13T15:00:00Z', { sale_id: 'sale-a' })],
      itemsBySale,
      // Pagamento livre (sem carnê) de 70: o razão do cliente deve 80.
      ledgerBalance: 80,
    });

    const a = out[A];
    expect(a.total_count).toBe(3);            // cancelada fora
    expect(a.paid_count).toBe(1);
    expect(a.paid_installments).toEqual([{
      id: 'i1', installment_number: 1, total_installments: 3,
      due_date: '2026-10-10', paid_at: '2026-10-01T14:00:00Z', amount: 50,
    }]);
    expect(a.open_remaining).toBe(80);        // 30 + 50
    expect(a.unscheduled).toBe(0);
    expect(a.remaining).toBe(80);
    expect(a.total_amount).toBe(150);
    expect(a.purchases.map(l => l.description)).toEqual(['Vans Hylane', 'Meia']);
    expect(a.purchases_total).toBe(150);
  });

  test('venda 1x/fiado (carnê sem parcela): o que falta vem do saldo sem parcela', () => {
    const out = summarizeCarnes({
      accounts: [
        { id: A, created_at: '2026-09-13T15:00:00Z' },
        { id: B, created_at: '2026-09-20T15:00:00Z' },
      ],
      installments: [],
      debits: [
        debit('d1', A, 100, '2026-09-13T15:00:00Z'),
        debit('d2', B, 60, '2026-09-20T15:00:00Z'),
      ],
      // A cliente pagou 90 no balcão (recebimento livre): deve 70.
      ledgerBalance: 70,
    });
    // O FIFO quita o mais antigo: o carnê novo (B) ainda deve tudo; o antigo, 10.
    expect(out[B].remaining).toBe(60);
    expect(out[A].remaining).toBe(10);
    expect(out[A].total_count).toBe(0);
    expect(out[A].paid_count).toBe(0);
    expect(out[A].open_remaining).toBe(0);
    expect(out[A].unscheduled).toBe(10);
  });

  test('devolução abate o que o carnê fiado ainda pode dever', () => {
    const out = summarizeCarnes({
      accounts: [{ id: A, created_at: '2026-09-13T15:00:00Z' }],
      debits: [debit('d1', A, 100, '2026-09-13T15:00:00Z')],
      refundsByGroup: { [A]: 100 },
      ledgerBalance: 0,
    });
    expect(out[A].refunded_total).toBe(100);
    expect(out[A].remaining).toBe(0);
  });

  test('grupo sem carnê: mesmos campos, e as compras seguem a regra do papel (mais novas até cobrir)', () => {
    const out = summarizeCarnes({
      accounts: [],
      installments: [inst('i1', null, { amount_due: '90.00', covered_amount: '50.00' })],
      debits: [
        debit('velho', null, 500, '2025-01-10T12:00:00Z', { notes: 'Compra antiga quitada' }),
        debit('novo', null, 90, '2026-09-01T12:00:00Z', { notes: 'Saldo do caderno' }),
      ],
      ledgerBalance: 40,
    });
    const sc = out[NO_ACCOUNT_KEY];
    expect(sc.total_count).toBe(1);
    expect(sc.paid_count).toBe(0);
    expect(sc.remaining).toBe(40);
    expect(sc.purchases.map(l => l.description)).toEqual(['Saldo do caderno']);
    expect(sc.purchases[0].manual).toBe(true);
  });

  test('sem nada: o grupo sem carnê existe e vem zerado', () => {
    const out = summarizeCarnes({});
    expect(out[NO_ACCOUNT_KEY]).toMatchObject({
      purchases: [], total_count: 0, paid_count: 0, paid_installments: [], remaining: 0,
    });
  });
});

describe('isHiddenAccount', () => {
  test('cancelado (ficou vazio) e juntado saem da ficha; aberto e fechado ficam', () => {
    expect(isHiddenAccount({ status: 'cancelled' })).toBe(true);
    expect(isHiddenAccount({ status: 'merged' })).toBe(true);
    expect(isHiddenAccount({ status: 'closed', merged_into_account_id: B })).toBe(true);
    expect(isHiddenAccount({ status: 'closed' })).toBe(false);
    expect(isHiddenAccount({ status: 'open' })).toBe(false);
    expect(isHiddenAccount(undefined)).toBe(false);
  });
});
