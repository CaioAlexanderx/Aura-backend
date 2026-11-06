// ============================================================
// PATCH /transactions/:txId — editar a venda do caixa nao pode sumir com ela
//
// 06/11/2026 (Esquina da Make, venda 527): a venda foi feita as 16:12 e,
// editada as 16:14 so para trocar a forma de pagamento, passou a valer
// 05/11 00:00 — saiu da lista do dia. O modal manda due_date em todo Salvar
// (e, com o fuso errado, um dia antes); o sync regravava sales.created_at.
// O que este arquivo trava:
//   1. trocar so a forma (vencimento igual) nao mexe na data da venda;
//   2. mudar o vencimento de verdade ainda muda a data da venda;
//   3. na venda vai o termo do caixa (dinheiro/debito/cartao), e o
//      pagamento unico em sale_payments acompanha;
//   4. limpar a forma no Financeiro nao apaga a da venda.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const COMPANY = 'company-uuid-esquina';
const TX_ID = 'tx-uuid-527';
const SALE_ID = '3b1f0c2e-6a1d-4c55-9a55-2f0d6c7e5527';
const KEY = 'pdv-sale-' + SALE_ID;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  return app;
}

function mockDb({ vencimento }) {
  const estado = { vendas: [], pagamentos: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    const p = params || [];
    if (/to_char\(due_date, 'YYYY-MM-DD'\) AS due_date FROM transactions/.test(s)) {
      return Promise.resolve({ rows: [{ due_date: vencimento }] });
    }
    if (/^\s*SELECT amount, idempotency_key/.test(s)) {
      return Promise.resolve({ rows: [{ amount: '72', idempotency_key: KEY, category: 'Vendas', status: 'confirmed' }] });
    }
    if (/^\s*UPDATE transactions SET/.test(s)) {
      return Promise.resolve({ rows: [{ id: TX_ID, idempotency_key: KEY }] });
    }
    if (/^\s*UPDATE sales SET/.test(s)) { estado.vendas.push({ sql: s, params: p }); return Promise.resolve({ rows: [] }); }
    if (/^\s*UPDATE sale_payments SET/.test(s)) { estado.pagamentos.push({ sql: s, params: p }); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  return estado;
}

// O corpo que o modal "Editar lancamento" manda ao salvar.
const corpoDoModal = (extra) => Object.assign({
  type: 'income', amount: 72, description: 'Venda PDV - Batom (pix)', category: 'Vendas', due_date: '2026-11-06',
}, extra);

const patch = (body) => request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send(body);

beforeEach(() => { db.query.mockReset(); });

describe('trocar a forma de pagamento da venda do caixa', () => {
  it('vencimento igual ao atual: a venda nao muda de data nem de hora', async () => {
    const estado = mockDb({ vencimento: '2026-11-06' });
    const res = await patch(corpoDoModal({ payment_method: 'debit' }));
    expect(res.status).toBe(200);
    expect(estado.vendas).toHaveLength(1);
    expect(estado.vendas[0].sql).not.toMatch(/created_at/);
    expect(estado.vendas[0].params[0]).toBe('debito');
  });

  it('vencimento com hora (como o banco devolve) igual ao atual tambem nao mexe na data', async () => {
    const estado = mockDb({ vencimento: '2026-11-06' });
    await patch(corpoDoModal({ due_date: '2026-11-06T00:00:00.000Z', payment_method: 'pix' }));
    expect(estado.vendas[0].sql).not.toMatch(/created_at/);
  });

  it('o pagamento unico em sale_payments troca junto, com o termo do caixa', async () => {
    const estado = mockDb({ vencimento: '2026-11-06' });
    await patch(corpoDoModal({ payment_method: 'cash' }));
    expect(estado.pagamentos).toHaveLength(1);
    expect(estado.pagamentos[0].params).toEqual(['dinheiro', SALE_ID, COMPANY]);
    // so quando ha um pagamento, e nunca o do crediario
    expect(estado.pagamentos[0].sql).toMatch(/COUNT\(\*\) FROM sale_payments x WHERE x\.sale_id = \$2\) = 1/);
    expect(estado.pagamentos[0].sql).toMatch(/method <> 'crediario'/);
  });

  it.each([['cash', 'dinheiro'], ['debit', 'debito'], ['credit', 'cartao'], ['pix', 'pix'], ['transfer', 'transfer']])(
    '%s no Financeiro vira %s na venda', async (financeiro, caixa) => {
      const estado = mockDb({ vencimento: '2026-11-06' });
      await patch(corpoDoModal({ payment_method: financeiro }));
      expect(estado.vendas[0].params[0]).toBe(caixa);
    });

  it('limpar a forma no Financeiro nao apaga a da venda', async () => {
    const estado = mockDb({ vencimento: '2026-11-06' });
    await patch(corpoDoModal({ payment_method: null }));
    expect(estado.vendas).toHaveLength(0);
    expect(estado.pagamentos).toHaveLength(0);
  });
});

describe('mudar a data de verdade continua mudando a venda', () => {
  it('vencimento diferente do atual: a venda vai para a meia-noite do novo dia', async () => {
    const estado = mockDb({ vencimento: '2026-11-06' });
    await patch(corpoDoModal({ due_date: '2026-11-04' }));
    expect(estado.vendas).toHaveLength(1);
    expect(estado.vendas[0].sql).toMatch(/created_at = \(\$1::date \+ INTERVAL '3 hours'\)/);
    expect(estado.vendas[0].params[0]).toBe('2026-11-04');
  });

  it('sem due_date no corpo nada de data e sincronizado', async () => {
    const estado = mockDb({ vencimento: '2026-11-06' });
    const corpo = corpoDoModal({ payment_method: 'pix' }); delete corpo.due_date;
    await patch(corpo);
    expect(estado.vendas[0].sql).not.toMatch(/created_at/);
  });
});
