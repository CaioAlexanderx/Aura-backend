// ============================================================
// AURA — Funil do trial: chegada ao checkout (12/10/2026)
//
// Não existia sinal de "viu o checkout". A tela de checkout chama
// GET /companies/:id/billing/status toda vez que abre; a rota agora grava
// audit_log action='checkout.viewed' quando a empresa está sem cobrança ativa
// e sem trial valendo — no máximo uma linha por empresa a cada 24h, sem
// aguardar o banco. A resposta do status não muda.
// ============================================================
'use strict';

jest.unmock('../src/services/trialFunnel');

const db = require('../src/config/database');

let mockCurrentUser = { id: 'user-1' };
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = mockCurrentUser; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const trialFunnel = require('../src/services/trialFunnel');
const billingRouter = require('../src/routes/billing');

const app = express();
app.use(express.json());
app.use('/companies/:id/billing', billingRouter);

const CID = 'company-vencida';
const DAY = 86400000;

const company = (extra = {}) => ({
  id: CID, plan: 'negocio', cnpj: '11222333000181', billing_status: 'trial',
  trial_ends_at: new Date(Date.now() - 3 * DAY).toISOString(),
  asaas_subscription_id: null, vertical_active: null, ...extra,
});

// audit_log em memória: o SELECT das últimas 24h enxerga o que o INSERT gravou.
function arrangeDb(row, { auditError = null } = {}) {
  const audit = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('AS subscription_discount')) return { rows: [{ ...row, subscription_discount: null }] };
    // 17/10/2026: checagem das 24h e INSERT numa instrução só (atômico).
    if (s.startsWith('INSERT INTO audit_log') && s.includes('WHERE NOT EXISTS')) {
      if (auditError) throw auditError;
      const since = Date.now() - DAY;
      const recent = audit.filter((a) => a.company_id === params[1] && a.created_at > since);
      if (recent.length) return { rows: [], rowCount: 0 };
      audit.push({ user_id: params[0], company_id: params[1], action: 'checkout.viewed', detail: params[2], metadata: JSON.parse(params[3]), created_at: Date.now() });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT id, plan, billing_status, trial_ends_at FROM companies')) return { rows: [row] };
    throw new Error('SQL inesperado: ' + s);
  });
  return audit;
}

const flush = () => new Promise((r) => setImmediate(r));
async function openCheckout() {
  const res = await request(app).get(`/companies/${CID}/billing/status`);
  await flush(); await flush();
  return res;
}

let warn;
beforeEach(() => {
  trialFunnel._resetForTests();
  db.query.mockReset();
  mockCurrentUser = { id: 'user-1' };
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('GET /billing/status registra checkout.viewed', () => {
  test('primeira abertura com trial vencido insere uma linha', async () => {
    const audit = arrangeDb(company());
    const res = await openCheckout();
    expect(res.status).toBe(200);
    expect(res.body.trial_active).toBe(false);
    expect(res.body).not.toHaveProperty('checkout_viewed');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: 'user-1', company_id: CID, action: 'checkout.viewed' });
    expect(audit[0].metadata).toMatchObject({ plan: 'negocio', billing_status: 'trial' });
  });

  test('segunda abertura no mesmo dia não insere de novo', async () => {
    const audit = arrangeDb(company());
    await openCheckout();
    const res = await openCheckout();
    expect(res.status).toBe(200);
    expect(audit).toHaveLength(1);
  });

  test('sem trial_ends_at (nunca teve trial) também conta', async () => {
    const audit = arrangeDb(company({ trial_ends_at: null, billing_status: null }));
    await openCheckout();
    expect(audit).toHaveLength(1);
  });

  test('com cobrança ativa não insere', async () => {
    const audit = arrangeDb(company({ billing_status: 'active', asaas_subscription_id: 'sub_1' }));
    const res = await openCheckout();
    expect(res.status).toBe(200);
    expect(audit).toHaveLength(0);
    expect(db.query.mock.calls.some(([sql]) => /FROM audit_log/.test(sql))).toBe(false);
  });

  test('com trial valendo não insere', async () => {
    const audit = arrangeDb(company({ trial_ends_at: new Date(Date.now() + 5 * DAY).toISOString() }));
    const res = await openCheckout();
    expect(res.body.trial_active).toBe(true);
    expect(audit).toHaveLength(0);
  });

  test('staff em modo admin não conta', async () => {
    mockCurrentUser = { id: 'staff-1', role: 'admin' };
    const audit = arrangeDb(company());
    await openCheckout();
    expect(audit).toHaveLength(0);
  });

  test('membro com role_label admin (cliente) não é tratado como staff', async () => {
    // requireCompanyAccess põe companyRole='admin' para membro admin da empresa;
    // staff de verdade é req.user.role === 'admin'. Aqui o usuário é comum.
    mockCurrentUser = { id: 'membro-1', role: 'user' };
    const audit = arrangeDb(company());
    await openCheckout();
    expect(audit).toHaveLength(1);
  });

  test('falha no audit_log não muda a resposta do status', async () => {
    arrangeDb(company(), { auditError: Object.assign(new Error('relation "audit_log" does not exist'), { code: '42P01' }) });
    const res = await openCheckout();
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('negocio');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// ── POST /billing/checkout-viewed (17/10/2026, t2-04) ─────────────────────
// A tela de checkout avisa que abriu. Conta também quem ainda está no trial —
// o degrau "Viram checkout" do painel é justamente esse público.
async function telaAbriu() {
  const res = await request(app).post(`/companies/${CID}/billing/checkout-viewed`).send({});
  await flush();
  return res;
}

describe('POST /billing/checkout-viewed registra checkout.viewed', () => {
  test('conta em trial valendo grava a linha (o caso dos 30 cadastros sem evento)', async () => {
    const audit = arrangeDb(company({ trial_ends_at: new Date(Date.now() + 5 * DAY).toISOString() }));
    const res = await telaAbriu();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: true });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: 'user-1', company_id: CID, action: 'checkout.viewed' });
    expect(audit[0].metadata).toMatchObject({ trial_ativo: true, origem: 'tela', plan: 'negocio' });
  });

  test('trial vencido também grava', async () => {
    const audit = arrangeDb(company());
    const res = await telaAbriu();
    expect(res.body).toEqual({ registrado: true });
    expect(audit[0].metadata).toMatchObject({ trial_ativo: false, origem: 'tela' });
  });

  test('abrir de novo no mesmo dia não duplica', async () => {
    const audit = arrangeDb(company());
    await telaAbriu();
    const res = await telaAbriu();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: false });
    expect(audit).toHaveLength(1);
  });

  test('o GET /status e o POST juntos geram uma linha só', async () => {
    const audit = arrangeDb(company());
    await Promise.all([
      request(app).get(`/companies/${CID}/billing/status`),
      request(app).post(`/companies/${CID}/billing/checkout-viewed`).send({}),
    ]);
    await flush(); await flush();
    expect(audit).toHaveLength(1);
  });

  test('com cobrança ativa não grava', async () => {
    const audit = arrangeDb(company({ billing_status: 'active', asaas_subscription_id: 'sub_1' }));
    const res = await telaAbriu();
    expect(res.body).toEqual({ registrado: false });
    expect(audit).toHaveLength(0);
  });

  test('staff em modo admin não conta', async () => {
    mockCurrentUser = { id: 'staff-1', role: 'admin' };
    const audit = arrangeDb(company());
    const res = await telaAbriu();
    expect(res.body).toEqual({ registrado: false });
    expect(audit).toHaveLength(0);
  });

  test('empresa inexistente responde 404', async () => {
    db.query.mockImplementation(async () => ({ rows: [] }));
    const res = await telaAbriu();
    expect(res.status).toBe(404);
  });

  test('falha no audit_log não derruba: responde registrado false', async () => {
    arrangeDb(company(), { auditError: Object.assign(new Error('relation "audit_log" does not exist'), { code: '42P01' }) });
    const res = await telaAbriu();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: false });
  });
});