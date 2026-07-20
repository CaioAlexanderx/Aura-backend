// ============================================================
// AURA DOJÔ — Testes Integração: F3c gate R$140 do plano Aura Dojô
// Cobre:
//   flag OFF → required:false (mesmo com billing inativo) + valores exibidos
//   flag ON + dojô trial expirado → required:true + total = 140 + seats*19
//   is_staff (conta interna @getaura) → nunca gated (required:false)
//   REGRESSÃO federação → shape antigo intacto (state:'blocked', sem `required`)
//
// Rota: GET /companies/:id/billing/karate-gate (requireAuth +
// requireCompanyAccess do private.js). Token com role:'admin' faz o
// requireCompanyAccess pular a checagem de banco → só a query do SELECT *
// da company é mockada. db.query é 100% mockado (tests/jest.setup.js).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const companyId = 'c0000000-0000-0000-0000-0000000000aa';
const url = `/api/v1/companies/${companyId}/billing/karate-gate`;

// role:'admin' → requireCompanyAccess pula o SELECT de papel (sem query extra).
const adminAuth = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', role: 'admin', type: 'access' },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

afterEach(() => {
  db.query.mockReset();
  delete process.env.DOJO_GATE_ENABLED;
});

describe('F3c — gate R$140 do plano Aura Dojô', () => {
  test('flag OFF: dojô com billing inativo → required:false + valores exibidos', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: companyId, vertical: 'karate_dojo', billing_status: 'inactive', trial_ends_at: '2020-01-01', extra_seats_granted: 0 }],
    });
    const res = await request(app).get(url).set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(false);
    expect(res.body.plan).toBe('dojo');
    expect(res.body.amount).toBe(140);
    expect(res.body.total).toBe(140);
    expect(res.body.seats).toBe(0);
  });

  test('flag ON: dojô trial expirado + inativo → required:true, total 140 + seats*19', async () => {
    process.env.DOJO_GATE_ENABLED = 'true';
    db.query.mockResolvedValueOnce({
      rows: [{ id: companyId, vertical: 'karate_dojo', billing_status: 'inactive', trial_ends_at: '2020-01-01', extra_seats_granted: 2 }],
    });
    const res = await request(app).get(url).set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(true);
    expect(res.body.amount).toBe(140);
    expect(res.body.seats).toBe(2);
    expect(res.body.seat_amount).toBe(19);
    expect(res.body.total).toBe(178); // 140 + 2*19
  });

  test('flag ON: dojô com trial VIGENTE → required:false', async () => {
    process.env.DOJO_GATE_ENABLED = 'true';
    db.query.mockResolvedValueOnce({
      rows: [{ id: companyId, vertical: 'karate_dojo', billing_status: 'trial', trial_ends_at: '2999-01-01', extra_seats_granted: 0 }],
    });
    const res = await request(app).get(url).set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(false);
  });

  test('flag ON: dojô is_staff (@getaura) inativo → NUNCA gated (required:false)', async () => {
    process.env.DOJO_GATE_ENABLED = 'true';
    db.query.mockResolvedValueOnce({
      rows: [{ id: companyId, vertical: 'karate_dojo', is_staff: true, billing_status: 'inactive', trial_ends_at: '2020-01-01', extra_seats_granted: 0 }],
    });
    const res = await request(app).get(url).set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.required).toBe(false);
  });

  test('REGRESSÃO federação: shape antigo intacto (state:blocked, sem `required`)', async () => {
    process.env.DOJO_GATE_ENABLED = 'true'; // não deve afetar federação
    db.query.mockResolvedValueOnce({
      rows: [{ id: companyId, vertical: 'karate_federation', billing_status: 'overdue', trial_ends_at: null, extra_seats_granted: 0, asaas_subscription_id: 'sub_1' }],
    });
    const res = await request(app).get(url).set(adminAuth());
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('blocked');
    expect(res.body.required).toBeUndefined(); // federação não usa o shape dojô
    expect(res.body.plan).toBeUndefined();
    expect(typeof res.body.amount).toBe('number');
    expect(res.body.has_subscription).toBe(true);
  });
});
