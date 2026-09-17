// ============================================================
// PATCH /transactions/:txId — valor do "A Receber" do crediario
//
// 17/09/2026 (Finesse, venda 2307): a lojista abriu "Editar lancamento",
// removeu um item (a devolucao abateu R$ 159,90 do recebivel: 674,60 ->
// 514,70) e clicou em Salvar. O modal guardava o valor de quando abriu e o
// PATCH regravou 674,60 por cima do abatimento. O recebivel do crediario e
// derivado das parcelas e das devolucoes: valor diferente do atual e recusado,
// valor igual (o modal sempre manda amount) passa sem tocar na coluna.
// Lancamento de venda comum (pdv-sale-*) continua editavel.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');

const COMPANY = 'company-uuid-finesse';
const TX_ID = 'tx-uuid-receber';
const SALE_ID = '558c850b-eca7-44d7-887a-de0a84e65b08';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  return app;
}

function mockDb({ key, amount }) {
  const estado = { amount: amount, updates: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    const p = params || [];
    if (/^\s*SELECT amount, idempotency_key FROM transactions/.test(s)) {
      return Promise.resolve({ rows: [{ amount: String(estado.amount), idempotency_key: key }] });
    }
    if (/^\s*UPDATE transactions SET/.test(s)) {
      estado.updates.push(s);
      const m = s.match(/amount = \$(\d+)/);
      if (m) estado.amount = p[Number(m[1]) - 1];
      return Promise.resolve({ rows: [{ id: TX_ID, amount: estado.amount, idempotency_key: key }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return estado;
}

const CREDIT_KEY = 'pdv-credit-receivable-' + SALE_ID;
const corpoDoModal = (amount) => ({
  type: 'income', amount: amount, description: 'Crediario - venda ' + SALE_ID,
  category: 'Crediario - A Receber', due_date: '2026-09-11',
});

beforeEach(() => { db.query.mockReset(); });

describe('PATCH /transactions/:txId no A Receber do crediario', () => {
  it('recusa o valor antigo por cima do abatimento da devolucao', async () => {
    const estado = mockDb({ key: CREDIT_KEY, amount: 514.7 });

    const res = await request(buildApp())
      .patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send(corpoDoModal(674.6));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_AMOUNT_DERIVED');
    expect(res.body.current_amount).toBe(514.7);
    expect(estado.amount).toBe(514.7);
    expect(estado.updates).toHaveLength(0);
  });

  it('valor igual ao atual salva os outros campos sem mexer no valor', async () => {
    const estado = mockDb({ key: CREDIT_KEY, amount: 514.7 });

    const res = await request(buildApp())
      .patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send(corpoDoModal(514.7));

    expect(res.status).toBe(200);
    expect(estado.updates).toHaveLength(1);
    expect(estado.updates[0]).not.toMatch(/amount =/);
    expect(estado.amount).toBe(514.7);
  });

  it('recebivel do resto de uma renegociacao (-rest-) tambem e protegido', async () => {
    const estado = mockDb({ key: CREDIT_KEY + '-rest-1', amount: 100 });

    const res = await request(buildApp())
      .patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send(corpoDoModal(150));

    expect(res.status).toBe(409);
    expect(estado.amount).toBe(100);
  });

  it('lancamento de venda comum continua com valor editavel', async () => {
    const estado = mockDb({ key: 'pdv-sale-' + SALE_ID, amount: 300 });

    const res = await request(buildApp())
      .patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send(corpoDoModal(250));

    expect(res.status).toBe(200);
    expect(estado.amount).toBe(250);
  });
});
