// ============================================================
// /billing: Personalizados nao tem Essencial (p-195, 17/11/2026)
//
// D4: Personalizados e do Negocio para cima. O /subscribe recusava o
// Essencial so para vertical_active='studio'; com a casa no Negocio (p-189)
// a empresa sai da vertical e mantem pdv_settings.studio_enabled = true.
// Cobre:
//   - Essencial recusado para a vertical Studio, como hoje (mesmo corpo);
//   - Essencial recusado para quem tem studio_enabled (mesma mensagem/stage);
//   - Essencial aceito para a loja comum;
//   - Negocio aceito para todos;
//   - GET /status: allowed_plans sem o Essencial para os dois casos e com
//     todos os planos para a loja comum.
// ============================================================
jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db, asaas, PLANS;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ({ asaas } = require('../../src/services/asaasClient'));
  ({ PLANS } = require('../../src/services/billingPricing'));
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const companyRow = (extra = {}) => ({
  id: cid, plan: 'negocio', asaas_customer_id: 'cus_1', asaas_subscription_id: null,
  billing_status: 'trial', last_payment_date: null, trial_ends_at: null,
  extra_seats_granted: 0, vertical_active: null, pdv_settings: { studio_enabled: false },
  cnpj: '11222333000181', ...extra,
});

const LOJA_COMUM   = () => companyRow();
const LOJA_SEM_PDV = () => companyRow({ pdv_settings: null });
const VERTICAL     = () => companyRow({ vertical_active: 'studio', pdv_settings: { studio_enabled: true } });
const CASA_NEGOCIO = () => companyRow({ vertical_active: null, pdv_settings: { studio_enabled: true }, studio_settings: { casa_negocio: true } });

function arrangeDb(company) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push({ sql: s, params });
    if (s.includes('AS role')) return { rows: [{ role: 'owner' }] };
    if (s.includes('SELECT * FROM companies WHERE id')) return { rows: [company] };
    if (s.includes('FROM companies c WHERE c.id')) return { rows: [{ ...company, subscription_discount: null }] };
    if (s.includes('SELECT * FROM users WHERE id')) return { rows: [{ id: 'u1', email: 'ana@loja.com', full_name: 'Ana' }] };
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

function arrangeAsaas() {
  asaas.mockImplementation(async (method, path, body) => {
    if (method === 'POST' && path === '/payments') return { id: 'pay_now', status: 'CONFIRMED' };
    if (method === 'POST' && path === '/subscriptions') return { id: 'sub_1', nextDueDate: body.nextDueDate };
    if (method === 'GET' && path.startsWith('/subscriptions/sub_1/payments')) return { data: [{ id: 'pay_1' }] };
    if (method === 'GET' && path.endsWith('/pixQrCode')) return { encodedImage: 'img', payload: 'pix-copia', expirationDate: 'x' };
    if (method === 'PUT' || method === 'DELETE') return {};
    throw new Error('Asaas inesperado: ' + method + ' ' + path);
  });
}

const subscribe = (body) => request(app).post(`/api/v1/companies/${cid}/billing/subscribe`).set(auth).send(body);
const status = () => request(app).get(`/api/v1/companies/${cid}/billing/status`).set(auth);
const updateDaEmpresa = (calls) => calls.find((c) => /UPDATE companies SET plan=/.test(c.sql));
const PIX_MENSAL = { billing_type: 'PIX', cycle: 'monthly' };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /subscribe com Essencial', () => {
  test('vertical Studio: recusado como hoje, sem tocar a Asaas', async () => {
    const calls = arrangeDb(VERTICAL());
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', ...PIX_MENSAL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'O Aura Studio exige o plano Negocio ou superior.',
      stage: 'plan_vertical',
      vertical_active: 'studio',
      allowed_plans: ['negocio', 'expansao'],
    });
    expect(asaas).not.toHaveBeenCalled();
    expect(updateDaEmpresa(calls)).toBeUndefined();
  });

  test('studio_enabled fora da vertical (casa no Negocio): recusado com a mesma mensagem e o mesmo stage', async () => {
    const calls = arrangeDb(CASA_NEGOCIO());
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', ...PIX_MENSAL });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'O Aura Studio exige o plano Negocio ou superior.',
      stage: 'plan_vertical',
      vertical_active: null,
      allowed_plans: ['negocio', 'expansao'],
    });
    expect(asaas).not.toHaveBeenCalled();
    expect(updateDaEmpresa(calls)).toBeUndefined();
  });

  test.each([
    ['loja comum (studio_enabled=false)', LOJA_COMUM],
    ['loja comum sem pdv_settings', LOJA_SEM_PDV],
  ])('%s: aceito', async (_nome, row) => {
    const calls = arrangeDb(row());
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', ...PIX_MENSAL });

    expect(res.status).toBe(201);
    expect(updateDaEmpresa(calls).params[0]).toBe('essencial');
  });
});

describe('POST /subscribe com Negocio: aceito para todos', () => {
  test.each([
    ['vertical Studio', VERTICAL],
    ['casa no Negocio (studio_enabled)', CASA_NEGOCIO],
    ['loja comum', LOJA_COMUM],
  ])('%s', async (_nome, row) => {
    const calls = arrangeDb(row());
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', ...PIX_MENSAL });

    expect(res.status).toBe(201);
    expect(updateDaEmpresa(calls).params[0]).toBe('negocio');
  });
});

describe('GET /status: allowed_plans', () => {
  test('vertical Studio: sem o Essencial (como hoje)', async () => {
    arrangeDb(VERTICAL());
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.vertical_active).toBe('studio');
    expect(res.body.allowed_plans).toEqual(['negocio', 'expansao']);
  });

  test('casa no Negocio (studio_enabled): sem o Essencial', async () => {
    arrangeDb(CASA_NEGOCIO());
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.vertical_active).toBeNull();
    expect(res.body.allowed_plans).toEqual(['negocio', 'expansao']);
  });

  test.each([
    ['loja comum', LOJA_COMUM],
    ['loja comum sem pdv_settings', LOJA_SEM_PDV],
  ])('%s: todos os planos, como hoje', async (_nome, row) => {
    arrangeDb(row());
    const res = await status();
    expect(res.status).toBe(200);
    expect(res.body.allowed_plans).toEqual(Object.keys(PLANS));
  });
});
