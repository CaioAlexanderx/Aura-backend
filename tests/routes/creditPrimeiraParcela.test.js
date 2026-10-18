// ============================================================
// AURA. -- Crediario: primeira parcela em janeiro (13/10/2026)
//
// Plano da temporada: vender em dezembro e a primeira parcela cair em
// janeiro. O campo `first_due_date` ja existia em POST /credit/installments
// (obrigatorio); agora e OPCIONAL, tem janela e a resposta devolve as datas.
//
// tq-20 (18/10/2026): POST /credit/installments foi DESLIGADA (410, ver
// creditRotasSemRazao.test.js) -- criava parcela sem debito no razao. A janela
// e o default da primeira parcela seguem travados em
// tests/unit/creditTermsDueDates.test.js (validateFirstDueDate /
// defaultFirstDueDate). Aqui fica so:
//   - GET /plan-config devolve first_due_date_max_days
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

let db;
let router;
let nowSpy;

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '3000d' })}` };

// "Hoje" fixo: 10/12/2026 12:00 em Brasilia (15:00Z) -- dia de venda de dezembro.
const AGORA = Date.parse('2026-12-10T15:00:00Z');

beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  db.connect.mockReset();
  router = require('../../src/routes/creditInstallments');
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(AGORA);
});
afterEach(() => nowSpy.mockRestore());

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/credit', router);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}

function mockBanco({ config = {} } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/pdv_settings->>'crediario_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    return Promise.resolve({ rows: [] });
  });
  const query = jest.fn().mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/credit_plan_configs/i.test(s)) {
      return Promise.resolve({ rows: [{
        company_id: cid, max_installments: 500, interest_rate: 0, period_unit: 'month', period_count: 1, ...config,
      }] });
    }
    if (/customer_credit_profiles/i.test(s)) {
      return Promise.resolve({ rows: [{ status: 'active', credit_score: 700 }] });
    }
    if (/INSERT INTO credit_installments/i.test(s)) {
      // [companyId, sale_id, customer_id, numero, total, valor, vencimento, account_id]
      return Promise.resolve({ rows: [{
        id: `inst-${params[3]}`, installment_number: params[3], total_installments: params[4],
        amount_due: params[5], due_date: params[6], status: 'pending',
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: jest.fn() };
  db.connect.mockResolvedValue(client);
  return client;
}

describe('GET /credit/plan-config', () => {
  test('devolve first_due_date_max_days junto da configuracao', async () => {
    mockBanco({ config: { max_installments: 12 } });
    const res = await request(buildApp())
      .get(`/api/v1/companies/${cid}/credit/plan-config`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.first_due_date_max_days).toBe(90);
    expect(res.body.max_installments).toBe(12);
  });
});
