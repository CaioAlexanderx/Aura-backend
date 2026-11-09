// ============================================================
// AURA CRÉDITO — DELETE /credit/customers/:cid/accounts/:accountId
// (rota, sem banco, 09/11/2026)
//
// A semântica (o que cancela, o que apaga, quando recusa) vive em
// credito.excluirCarne.banco.test.js, com Postgres real. Aqui: a rota passa
// empresa, cliente e carnê da URL ao serviço, roda numa transação e devolve
// os 409 com o code e os dados que a tela usa (receipts, sale_id).
// ============================================================
'use strict';

jest.mock('../src/services/credit/deleteCarne', () => ({ deleteCarne: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { deleteCarne } = require('../src/services/credit/deleteCarne');

const COMPANY  = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT  = '33333333-3333-4333-8333-333333333333';
const URL = `/companies/${COMPANY}/credit/customers/${CUSTOMER}/accounts/${ACCOUNT}`;

let fakeClient;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/credit', require('../src/routes/credit'));
  return a;
}

function erro(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeClient = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  db.connect.mockImplementation(async () => fakeClient);
});

const sqls = () => fakeClient.query.mock.calls.map((c) => c[0]);

test('exclui: passa empresa, cliente e carnê da URL e faz COMMIT', async () => {
  deleteCarne.mockResolvedValue({
    deleted: true, account_id: ACCOUNT, customer_id: CUSTOMER,
    removed_amount: 300, cancelled_installments: 3, removed_transactions: 1,
    reallocated_amount: 0, new_balance: 200,
  });

  const res = await request(app()).delete(URL);

  expect(res.status).toBe(200);
  expect(res.body.removed_amount).toBe(300);
  expect(deleteCarne).toHaveBeenCalledWith(fakeClient, {
    companyId: COMPANY, customerId: CUSTOMER, accountId: ACCOUNT,
  });
  expect(sqls()).toEqual(['BEGIN', 'COMMIT']);
  expect(fakeClient.release).toHaveBeenCalled();
});

test('com recebimento: 409 CARNE_TEM_RECEBIMENTO com a lista, ROLLBACK', async () => {
  const receipts = [{ id: 'p1', date: '2026-11-01T12:00:00.000Z', amount: 100 }];
  deleteCarne.mockRejectedValue(erro(409, 'CARNE_TEM_RECEBIMENTO', 'tem recebimento', { receipts }));

  const res = await request(app()).delete(URL);

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('CARNE_TEM_RECEBIMENTO');
  expect(res.body.receipts).toEqual(receipts);
  expect(sqls()).toEqual(['BEGIN', 'ROLLBACK']);
});

test('de venda: 409 CARNE_DE_VENDA com o sale_id', async () => {
  deleteCarne.mockRejectedValue(erro(409, 'CARNE_DE_VENDA', 'de venda', { sale_id: 's1', sale_ids: ['s1'] }));

  const res = await request(app()).delete(URL);

  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ code: 'CARNE_DE_VENDA', sale_id: 's1' });
});

test('de outra empresa ou cliente: 404', async () => {
  deleteCarne.mockRejectedValue(erro(404, 'CARNE_NAO_ENCONTRADO', 'nao encontrado'));

  const res = await request(app()).delete(URL);

  expect(res.status).toBe(404);
  expect(res.body.code).toBe('CARNE_NAO_ENCONTRADO');
});

test('erro inesperado: 500 genérico, sem vazar a mensagem do banco', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  deleteCarne.mockRejectedValue(new Error('relation "x" does not exist'));

  const res = await request(app()).delete(URL);

  expect(res.status).toBe(500);
  expect(res.body.error).toBe('Erro ao excluir carne');
  expect(sqls()).toEqual(['BEGIN', 'ROLLBACK']);
});
