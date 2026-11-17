// ============================================================
// AURA — pdv-settings: a chave auto_print_receipt (p-158, 17/11/2026)
//
// Impressao automatica do cupom nao fiscal ao registrar a venda. O PUT so
// grava chaves da lista branca; o backend vai antes do app para a chave
// nao ser descartada em silencio (o caso do frete_enabled em 30/10).
//
//   (1) PUT com auto_print_receipt:true grava true e o GET devolve true.
//   (2) Sem a chave no corpo, o default e false.
//   (3) Valor que nao e boolean leva 400.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const router = require('../src/routes/pdvSettings');

const COMPANY = '45d92b02-165d-44d6-928a-ac8e0183d5bd';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

function mockCompany(row) {
  const state = { ...row, updates: [] };
  db.query.mockImplementation(async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) {
      const out = {};
      if (/pdv_settings/.test(sql)) out.pdv_settings = state.pdv_settings;
      if (/vertical_active/.test(sql)) out.vertical_active = state.vertical_active;
      return { rows: [out] };
    }
    if (/^\s*UPDATE companies SET pdv_settings/i.test(sql)) {
      state.pdv_settings = JSON.parse(params[0]);
      state.updates.push(state.pdv_settings);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  });
  return state;
}

afterEach(() => db.query.mockReset());

describe('pdv-settings — auto_print_receipt', () => {
  test('(1) PUT grava true e o GET devolve true', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: { comanda_enabled: false } });

    const put = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { auto_print_receipt: true } });
    expect(put.status).toBe(200);
    expect(put.body.settings.auto_print_receipt).toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].auto_print_receipt).toBe(true);

    const get = await request(makeApp()).get('/companies/' + COMPANY + '/pdv-settings');
    expect(get.status).toBe(200);
    expect(get.body.settings.auto_print_receipt).toBe(true);
  });

  test('(2) sem a chave, o default e false', async () => {
    mockCompany({ vertical_active: null, pdv_settings: null });
    const get = await request(makeApp()).get('/companies/' + COMPANY + '/pdv-settings');
    expect(get.status).toBe(200);
    expect(get.body.settings.auto_print_receipt).toBe(false);
  });

  test('(3) valor que nao e boolean leva 400', async () => {
    mockCompany({ vertical_active: null, pdv_settings: null });
    const put = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { auto_print_receipt: 'sim' } });
    expect(put.status).toBe(400);
  });
});
