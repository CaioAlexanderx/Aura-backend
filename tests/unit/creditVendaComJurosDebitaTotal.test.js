// ============================================================
// AURA CREDITO -- tq-22: venda no crediario com juros debita o total (unit)
//
// O teste com Postgres real e __tests__/credito.vendaComJurosDebitaTotal.banco.test.js.
// Aqui:
//   - SEM juros a venda grava EXATAMENTE as mesmas queries de antes, na mesma
//     ordem e com os mesmos parametros (1x, 3x, sinal do Studio com juros 0
//     explicito mesmo com juros na config, 1x sem data com juros na config);
//   - COM juros o debito e acertado para a soma das parcelas, centavo a
//     centavo, e so ele muda (o A Receber continua pelo principal).
// Mock por CONTEUDO do SQL.
// ============================================================
'use strict';

const ledger = require('../../src/services/credit/ledger');

const COMPANY = 'comp-1';
const CUST    = 'cust-1';
const SALE    = 'sale-1';

function recorder({ configRate = '0' } = {}) {
  const calls = [];
  let n = 0;
  const query = jest.fn(async (sql, params = []) => {
    const s = String(sql);
    calls.push({ sql: s.replace(/\s+/g, ' ').trim(), params });
    if (/INSERT INTO customer_credit_profiles/.test(s)) return { rows: [{ id: 'p', status: 'active', credit_score: 700 }] };
    if (/INSERT INTO credit_plan_configs/.test(s)) return { rows: [{ id: 'c', max_installments: 500, interest_rate: configRate }] };
    if (/INSERT INTO customer_credit_transactions/.test(s)) return { rows: [{ id: 'tx-debit', type: 'debit', amount: String(params[3]) }] };
    if (/INSERT INTO credit_installments/.test(s)) { n += 1; return { rows: [{ id: 'inst-' + n }] }; }
    if (/UPDATE customer_credit_transactions/.test(s)) return { rows: [{ id: 'tx-debit', type: 'debit', amount: String(params[2]) }] };
    return { rows: [] };
  });
  return { client: { query }, calls };
}

const kinds = (calls) => calls.map((c) => c.sql.slice(0, 40));
const debitUpdates = (calls) => calls.filter((c) => /^UPDATE customer_credit_transactions/.test(c.sql));
const debitInsert = (calls) => calls.find((c) => /^INSERT INTO customer_credit_transactions/.test(c.sql));
const parcelas = (calls) => calls.filter((c) => /^INSERT INTO credit_installments/.test(c.sql)).map((c) => Number(c.params[5]));
const soma = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

beforeAll(() => {
  // A sonda de reference_* usa o pool (mock global): "sem colunas" -> sem vinculo.
  const db = require('../../src/config/database');
  db.query.mockResolvedValue({ rows: [{ n: 0 }] });
});

describe('sem juros: as mesmas queries de antes', () => {
  test('1x sem data: perfil, config, debito, A Receber, credit_used -- nada mais', async () => {
    const { client, calls } = recorder();
    const r = await ledger.createCreditSale(client, { companyId: COMPANY, customerId: CUST, saleId: SALE, amount: 100 });
    expect(kinds(calls)).toEqual([
      expect.stringMatching(/^INSERT INTO customer_credit_profiles/),
      expect.stringMatching(/^INSERT INTO credit_plan_configs/),
      expect.stringMatching(/^INSERT INTO customer_credit_transactions/),
      expect.stringMatching(/^INSERT INTO transactions/),
      expect.stringMatching(/^UPDATE customer_credit_profiles/),
    ]);
    expect(debitInsert(calls).params[3]).toBe(100);
    expect(r.debited.amount).toBe('100');
  });

  test('3x sem juros: debito pelo valor, 3 parcelas, nenhum acerto de debito', async () => {
    const { client, calls } = recorder();
    await ledger.createCreditSale(client, {
      companyId: COMPANY, customerId: CUST, saleId: SALE, amount: 300, installments: 3, firstDueDate: '2026-12-01',
    });
    expect(calls).toHaveLength(9); // perfil, config, debito, A Receber, 3 parcelas, sales, credit_used
    expect(debitInsert(calls).params[3]).toBe(300);
    expect(parcelas(calls)).toEqual([100, 100, 100]);
    expect(debitUpdates(calls)).toHaveLength(0);
  });

  test('sinal do Studio: juros 0 explicito mesmo com juros na config -- nada muda', async () => {
    const { client, calls } = recorder({ configRate: '0.10' });
    await ledger.createCreditSale(client, {
      companyId: COMPANY, customerId: CUST, saleId: SALE, amount: 250,
      installments: 1, firstDueDate: '2026-12-01', interestRate: 0, enforceCreditBlock: false,
    });
    expect(debitInsert(calls).params[3]).toBe(250);
    expect(parcelas(calls)).toEqual([250]);
    expect(debitUpdates(calls)).toHaveLength(0);
  });

  test('1x sem data com juros na config: sem parcela, sem juros, debito pelo valor (como hoje)', async () => {
    const { client, calls } = recorder({ configRate: '0.10' });
    await ledger.createCreditSale(client, { companyId: COMPANY, customerId: CUST, saleId: SALE, amount: 80 });
    expect(debitInsert(calls).params[3]).toBe(80);
    expect(parcelas(calls)).toEqual([]);
    expect(debitUpdates(calls)).toHaveLength(0);
  });
});

describe('com juros: razao = soma das parcelas', () => {
  test.each([
    ['10% em 3x de R$300', { amount: 300, installments: 3, interestRate: 0.10 }, 330],
    ['10% em 3x de R$100 (centavo na ultima)', { amount: 100, installments: 3, interestRate: 0.10 }, 110],
    ['2% em 2x de R$100', { amount: 100, installments: 2, interestRate: 0.02 }, 102],
    ['30% em 1x com data (caso Kaio Cesar no manual)', { amount: 1000, installments: 1, interestRate: 0.30 }, 1300],
  ])('%s', async (_nome, args, total) => {
    const { client, calls } = recorder();
    const r = await ledger.createCreditSale(client, {
      companyId: COMPANY, customerId: CUST, saleId: SALE, firstDueDate: '2026-12-01', ...args,
    });
    expect(soma(parcelas(calls))).toBe(total);
    const upd = debitUpdates(calls);
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toEqual(['tx-debit', COMPANY, total]);
    expect(upd[0].sql).toMatch(/type = 'debit'/);
    expect(Number(r.debited.amount)).toBe(total);
    // o A Receber continua pelo principal
    const ar = calls.find((c) => /^INSERT INTO transactions/.test(c.sql));
    expect(ar.params[1]).toBe(args.amount);
    // o acerto vem depois das parcelas e antes do UPDATE sales
    const idx = (re) => calls.findIndex((c) => re.test(c.sql));
    const ultimaParcela = calls.map((c) => /^INSERT INTO credit_installments/.test(c.sql)).lastIndexOf(true);
    expect(idx(/^UPDATE customer_credit_transactions/)).toBeGreaterThan(ultimaParcela);
    expect(idx(/^UPDATE customer_credit_transactions/)).toBeLessThan(idx(/^UPDATE sales/));
  });

  test('juros vindos da config da loja (sem taxa no pedido)', async () => {
    const { client, calls } = recorder({ configRate: '0.05' });
    await ledger.createCreditSale(client, {
      companyId: COMPANY, customerId: CUST, saleId: SALE, amount: 101, installments: 2, firstDueDate: '2026-12-01',
    });
    expect(parcelas(calls)).toEqual([53.02, 53.03]);
    expect(debitUpdates(calls)[0].params[2]).toBe(106.05);
  });
});
