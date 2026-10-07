// ============================================================
// AURA CRÉDITO — alarme diário de parcela aberta acima do saldo
// (sem banco, 07/10/2026)
//
// O job só pode falar quando há caso: silêncio é o estado normal, e uma
// linha "[creditIntegrity]" no log tem que significar divergência nova.
// A consulta em si é exercida com Postgres real em
// credito.parcelaAbertaSemSaldo.banco.test.js.
// ============================================================
'use strict';

const { triggerCreditIntegrityCheck } = require('../src/jobs/creditIntegrityJob');
const { summarizeByCompany } = require('../src/services/credit/integrity');

const linha = (company, customer, open, balance) => ({
  company_id: company, company_name: 'Loja ' + company,
  customer_id: customer, customer_name: 'Cliente ' + customer,
  open_installments: String(open), open_count: '1',
  balance: String(balance), gap: String(open - balance),
});

describe('triggerCreditIntegrityCheck', () => {
  test('sem divergência: não escreve nada no log', async () => {
    const log = jest.fn();
    const r = await triggerCreditIntegrityCheck({ db: { query: async () => ({ rows: [] }) }, log });
    expect(r).toEqual({ customers: 0, companies: 0, hidden: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  test('com divergência: um resumo e uma linha por loja, a maior primeiro', async () => {
    const log = jest.fn();
    const db = {
      query: async () => ({
        rows: [
          linha('a', '1', 4770, -140),
          linha('b', '2', 25000, 0),
          linha('a', '3', 734, 500),
        ],
      }),
    };
    const r = await triggerCreditIntegrityCheck({ db, log });

    expect(r).toEqual({ customers: 3, companies: 2, hidden: 2 });
    expect(log).toHaveBeenCalledTimes(3);
    expect(log.mock.calls[0][0]).toContain('3 cliente(s) em 2 loja(s)');
    expect(log.mock.calls[0][0]).toContain('2 com saldo <= 0');
    expect(log.mock.calls[1][0]).toContain('Loja b');
    expect(log.mock.calls[1][0]).toContain('R$25000.00');
    expect(log.mock.calls[2][0]).toContain('Loja a');
    expect(log.mock.calls[2][0]).toContain('2 cliente(s), diferenca R$5144.00');
  });

  test('schema parcial (42P01/42703) não vira erro no log', async () => {
    const log = jest.fn();
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = { query: async () => { const e = new Error('nao existe'); e.code = '42P01'; throw e; } };
      expect(await triggerCreditIntegrityCheck({ db, log })).toBeNull();
      expect(log).not.toHaveBeenCalled();
      expect(erro).not.toHaveBeenCalled();
    } finally {
      erro.mockRestore();
    }
  });
});

describe('summarizeByCompany', () => {
  test('soma por loja sem acumular erro de centavo', () => {
    const lojas = summarizeByCompany([
      { company_id: 'a', company_name: 'A', gap: 0.1, hidden: false },
      { company_id: 'a', company_name: 'A', gap: 0.2, hidden: true },
    ]);
    expect(lojas).toEqual([{ company_id: 'a', company_name: 'A', customers: 2, hidden: 1, gap: 0.3 }]);
  });
});
