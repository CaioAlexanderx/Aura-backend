// ============================================================
// Financeiro consolidado — GET /me/financeiro/comparative e /insights
//
// As duas rotas liam as empresas do usuario de `company_users`, tabela
// que nunca existiu: em producao respondiam 500 com
// "relation company_users does not exist" (log do Railway, 19/09/2026).
// Este teste trava que a busca sai de company_members + owner_id e que
// a rota responde 200, com e sem empresas.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
}));

const db      = require('../src/config/database');
const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use('/me/financeiro', require('../src/routes/financeiroComparative').meRouter);
  app.use('/me/financeiro', require('../src/routes/financeiroInsights').meRouter);
  return app;
}

const isCompanyLookup = (sql) => /FROM companies c/.test(sql) && /company_members/.test(sql);

function mockDb(companyIds) {
  db.query.mockImplementation(async (sql) => {
    if (/company_users/.test(sql)) throw new Error('relation "company_users" does not exist');
    if (isCompanyLookup(sql)) return { rows: companyIds.map((id) => ({ id })) };
    // Agregado sem GROUP BY: no Postgres sempre volta uma linha.
    if (/income_count/.test(sql)) return { rows: [{ income: '0', expenses: '0', income_count: '0', tx_count: '0' }] };
    if (/oldest_days/.test(sql))  return { rows: [{ total: '0', count: '0', oldest_days: '0' }] };
    return { rows: [] };
  });
}

afterEach(() => { db.query.mockReset(); });

describe.each([
  ['comparative', '/me/financeiro/comparative?period=month'],
  ['insights',    '/me/financeiro/insights?period=month'],
])('GET /me/financeiro/%s', (_name, url) => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('busca as empresas do usuario em company_members e responde 200', async () => {
    mockDb(['c1', 'c2']);
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.consolidated).toBe(true);
    expect(res.body.company_count).toBe(2);

    const lookup = db.query.mock.calls.find(([sql]) => isCompanyLookup(sql));
    expect(lookup).toBeDefined();
    expect(lookup[1]).toEqual(['user-1']);
    // Dono OU membro ativo, so empresa ativa: mesma regra do login.
    expect(lookup[0]).toMatch(/c\.owner_id = \$1 OR cm\.user_id = \$1/);
    expect(lookup[0]).toMatch(/c\.is_active = true/);
    expect(db.query.mock.calls.some(([sql]) => /company_users/.test(sql))).toBe(false);
  });

  test('sem empresas devolve o payload vazio com 200', async () => {
    mockDb([]);
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.company_count).toBe(0);
  });
});
