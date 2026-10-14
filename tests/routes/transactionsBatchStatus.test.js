// ============================================================
// POST /companies/:id/transactions/batch — status do lançamento importado
// (14/10/2026, cartão tq-10)
//
// GF Amorim (28/09): boleto com vencimento futuro importado pela planilha
// entrou como PAGO ('confirmed', paid_at = vencimento). Agora:
//   - vencimento futuro e sem indicação de pagamento -> 'pending', paid_at NULL;
//   - data de hoje ou passada, ou linha que diz que foi pago -> como antes.
// Mock do banco por CONTEÚDO DO SQL.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { statusImportado } = require('../../src/routes/transactionsBatch');

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-0000000000aa';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let app, db, client;
beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  client = { query: jest.fn(async () => ({ rows: [], rowCount: 1 })), release: jest.fn() };
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/FROM company_members/i.test(sql)) return { rows: [{ role: 'owner' }] };
    return { rows: [] };
  });
  db.connect.mockReset();
  db.connect.mockImplementation(async () => client);
  app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../../src/routes/transactionsBatch'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// Colunas do INSERT: ..., due_date $6, status $7, ..., paid_at $11, created_at $12
const inseridos = () => client.query.mock.calls
  .filter(([sql]) => /INSERT INTO transactions/i.test(sql))
  .map(([, p]) => ({ descricao: p[3], due_date: p[5], status: p[6], paid_at: p[10], created_at: p[11] }));
const importar = (transactions) => request(app).post(`/companies/${cid}/transactions/batch?partial=true`).set(auth).send({ transactions });

describe('planilha de lançamentos: vencimento futuro entra como a pagar', () => {
  test('boleto com vencimento futuro e sem indicação de pagamento: pending, sem paid_at', async () => {
    const res = await importar([{ tipo: 'despesa', valor: '1.250,00', descricao: 'Boleto fornecedor', data: '15/11/2099' }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ saved: 1, pending: 1 });
    expect(inseridos()).toEqual([
      { descricao: 'Boleto fornecedor', due_date: '2099-11-15', status: 'pending', paid_at: null, created_at: '2099-11-15' },
    ]);
  });

  test('receita com data futura também fica pendente (a receber)', async () => {
    await importar([{ type: 'income', amount: 300, description: 'Repasse cartão', due_date: '2099-01-10' }]);
    expect(inseridos()[0]).toMatchObject({ status: 'pending', paid_at: null });
  });

  test('data passada: exatamente como antes (confirmed, paid_at = vencimento)', async () => {
    const res = await importar([{ tipo: 'despesa', valor: '89,90', descricao: 'Luz', data: '05/09/2020' }]);
    expect(res.body).toMatchObject({ saved: 1, pending: 0 });
    expect(inseridos()).toEqual([
      { descricao: 'Luz', due_date: '2020-09-05', status: 'confirmed', paid_at: '2020-09-05', created_at: '2020-09-05' },
    ]);
  });

  test('data de hoje: como antes (confirmed)', async () => {
    const hoje = hojeSP();
    await importar([{ type: 'expense', amount: 10, description: 'Hoje', due_date: hoje }]);
    expect(inseridos()[0]).toMatchObject({ status: 'confirmed', paid_at: hoje });
  });

  test('lote misto: cada linha pelo seu vencimento', async () => {
    await importar([
      { type: 'expense', amount: 10, description: 'Passado', due_date: '2021-03-01' },
      { type: 'expense', amount: 20, description: 'Futuro', due_date: '2099-03-01' },
      { type: 'expense', amount: 30, description: 'Futuro pago', due_date: '2099-04-01', pago: 'Sim' },
    ]);
    expect(inseridos().map((t) => [t.descricao, t.status, t.paid_at])).toEqual([
      ['Passado', 'confirmed', '2021-03-01'],
      ['Futuro', 'pending', null],
      ['Futuro pago', 'confirmed', '2099-04-01'],
    ]);
  });

  test('status informado na planilha é respeitado como antes, mesmo com data futura', async () => {
    await importar([{ type: 'expense', amount: 10, description: 'X', due_date: '2099-03-01', status: 'confirmed' }]);
    expect(inseridos()[0]).toMatchObject({ status: 'confirmed', paid_at: '2099-03-01' });
  });

  test('dry_run não grava nada', async () => {
    const res = await request(app).post(`/companies/${cid}/transactions/batch?dry_run=true`).set(auth)
      .send({ transactions: [{ type: 'expense', amount: 10, description: 'X', due_date: '2099-03-01' }] });
    expect(res.body.dry_run).toBe(true);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('statusImportado (regra pura)', () => {
  const HOJE = '2026-10-14';
  test.each([
    [{ due_date: '2026-10-15' }, 'pending', null],
    [{ due_date: '2026-10-14' }, 'confirmed', '2026-10-14'],
    [{ due_date: '2026-10-13' }, 'confirmed', '2026-10-13'],
    [{ due_date: '2026-10-15', status: '' }, 'pending', null],
    [{ due_date: '2026-10-15', status: 'confirmed' }, 'confirmed', '2026-10-15'],
    [{ due_date: '2026-10-15', paid_at: '2026-10-01' }, 'confirmed', '2026-10-15'],
    [{ due_date: '2026-10-15', data_pagamento: '01/10/2026' }, 'confirmed', '2026-10-15'],
    [{ due_date: '2026-10-15', pago: 'sim' }, 'confirmed', '2026-10-15'],
    [{ due_date: '2026-10-15', pago: 'não' }, 'pending', null],
    [{ due_date: '2026-10-15', paid: 'true' }, 'confirmed', '2026-10-15'],
    [{ due_date: '2026-10-13', pago: 'não' }, 'confirmed', '2026-10-13'],
  ])('%j -> %s', (tx, status, paidAt) => {
    expect(statusImportado(tx, HOJE)).toEqual({ status, paid_at: paidAt });
  });
});
