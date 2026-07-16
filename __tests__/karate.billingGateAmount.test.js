// ============================================================
// AURA. — /billing/karate-gate: o valor devolvido tem que ACOMPANHAR
// PLANS.negocio.monthly (services/billingPricing), não uma constante
// própria da rota. É o mesmo bug já visto em vertical × vertical_active,
// affiliation_model × karate_annuity_plan, remoteRows × rows: duas cópias
// da mesma verdade que divergem quando só uma é atualizada.
//
// Também cobre o defeito 2: o gate precisa devolver o MESMO valor que o
// /subscribe vai cobrar (plano + R$19 × extra_seats_granted), e não deve
// quebrar quando a coluna extra_seats_granted ainda não existe
// (pré-migration 110 — SELECT * devolve undefined, não erro 42703).
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
db.query = jest.fn();

const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const { PLANS, getTotalValue } = require('../src/services/billingPricing');
const billingRouter = require('../src/routes/billing');

const app = express();
app.use(express.json());
app.use('/companies/:id/billing', billingRouter);

const CID = 'company-fpkt';
const ORIGINAL_NEGOCIO_MONTHLY = PLANS.negocio.monthly; // 169 hoje

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  PLANS.negocio.monthly = ORIGINAL_NEGOCIO_MONTHLY; // restaura entre testes
});

afterAll(() => {
  PLANS.negocio.monthly = ORIGINAL_NEGOCIO_MONTHLY;
});

describe('GET /billing/karate-gate — valor deriva do pricing', () => {
  it('amount = PLANS.negocio.monthly quando não há acesso extra', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: CID,
        plan: 'negocio',
        billing_status: 'active',
        trial_ends_at: null,
        next_billing_date: '2026-08-01',
        asaas_subscription_id: 'sub_1',
        // extra_seats_granted ausente de propósito (simula coluna pré-migration 110)
      }],
    });

    const res = await request(app).get(`/companies/${CID}/billing/karate-gate`);

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(PLANS.negocio.monthly);
    expect(res.body.extra_seats).toBe(0);
  });

  it('muda junto quando PLANS.negocio.monthly muda — NÃO é uma constante própria da rota', async () => {
    PLANS.negocio.monthly = 249; // simula reprecificação

    db.query.mockResolvedValueOnce({
      rows: [{
        id: CID,
        plan: 'negocio',
        billing_status: 'active',
        trial_ends_at: null,
        next_billing_date: '2026-08-01',
        asaas_subscription_id: 'sub_1',
      }],
    });

    const res = await request(app).get(`/companies/${CID}/billing/karate-gate`);

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(249);
    expect(res.body.amount).not.toBe(169); // trava o valor fixo antigo
  });

  it('soma acesso extra (extra_seats_granted) — mesmo valor que o /subscribe cobraria', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: CID,
        plan: 'negocio',
        billing_status: 'active',
        trial_ends_at: null,
        next_billing_date: '2026-08-01',
        asaas_subscription_id: 'sub_1',
        extra_seats_granted: 2,
      }],
    });

    const res = await request(app).get(`/companies/${CID}/billing/karate-gate`);

    const expected = getTotalValue('negocio', 'monthly', 'PIX', 2);
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(expected);
    expect(res.body.extra_seats).toBe(2);
    expect(res.body.amount).toBeGreaterThan(PLANS.negocio.monthly); // 169 sozinho mentiria
  });

  it('extra_seats_granted não-numérico (string vazia / null) cai pra 0, sem quebrar', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: CID,
        plan: 'negocio',
        billing_status: 'active',
        trial_ends_at: null,
        next_billing_date: '2026-08-01',
        asaas_subscription_id: 'sub_1',
        extra_seats_granted: null,
      }],
    });

    const res = await request(app).get(`/companies/${CID}/billing/karate-gate`);

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(PLANS.negocio.monthly);
    expect(res.body.extra_seats).toBe(0);
  });
});
