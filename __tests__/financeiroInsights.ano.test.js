// ============================================================
// AURA. — Insights do Financeiro: periodo "ano" (04/11/2026)
//
// O app ganhou o botao "Ano" na barra do Financeiro. O periodo e 1/jan ate
// hoje; o comparativo tem que ser o MESMO trecho do ano passado (1/jan ate
// o mesmo dia). Antes era o ano passado inteiro: em novembro a tela
// comparava 10 meses com 12 e inventava uma queda de receita.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db      = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';

function buildApp() {
  const app = express();
  app.use('/companies/:id/financeiro', require('../src/routes/financeiroInsights').companyRouter);
  return app;
}

const iso = (d) => d.toISOString().slice(0, 10);

afterEach(() => { db.query.mockReset(); });

test('period=year: atual = 1/jan ate hoje; anterior = 1/jan ate o mesmo dia do ano passado', async () => {
  const resumos = [];
  db.query.mockImplementation((sql, params) => {
    if (/income_count/.test(sql) && /tx_count/.test(sql)) {
      resumos.push(params);
      return Promise.resolve({ rows: [{ income: '100', expenses: '40', income_count: '1', tx_count: '2' }] });
    }
    if (/oldest_days/.test(sql)) return Promise.resolve({ rows: [{ total: '0', count: '0', oldest_days: '0' }] });
    return Promise.resolve({ rows: [] });
  });

  const res = await request(app).get(`/companies/${CID}/financeiro/insights?period=year`);
  expect(res.status).toBe(200);

  const hoje = new Date();
  const y = hoje.getFullYear();
  const mesmoDiaAnoPassado = new Date(y - 1, hoje.getMonth(),
    Math.min(hoje.getDate(), new Date(y - 1, hoje.getMonth() + 1, 0).getDate()));

  const atual = resumos.find((p) => p[1] === `${y}-01-01`);
  const anterior = resumos.find((p) => p[1] === `${y - 1}-01-01`);
  expect(atual).toBeTruthy();
  expect(atual[2]).toBe(iso(hoje));
  expect(anterior).toBeTruthy();
  expect(anterior[2]).toBe(iso(mesmoDiaAnoPassado));
  // nunca o ano inteiro
  expect(anterior[2]).not.toBe(`${y - 1}-12-31`);
});

let app;
beforeAll(() => { app = buildApp(); });
