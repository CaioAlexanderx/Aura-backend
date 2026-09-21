// ============================================================
// QA — /billing com cupom de desconto por varios meses (migration 326)
//
// "R$ 50 de desconto nas 3 primeiras mensalidades do Negocio":
//   - a assinatura no Asaas nasce em R$ 119 (Pix e cartao)
//   - o desconto em andamento e registrado para a rotina devolver o cheio
//   - cupom preso ao Negocio recusa outro plano; recusa o anual
//   - sem a tabela (migration pendente) o cupom e recusado ANTES de cobrar
//   - trocar de plano ou cancelar perde o desconto
//   - cupom de 1 mes segue exatamente como antes
// ============================================================
jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db, asaas, subscriptionDiscount;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ({ asaas } = require('../../src/services/asaasClient'));
  subscriptionDiscount = require('../../src/services/subscriptionDiscount');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

const isoIn = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().split('T')[0]; };

const companyRow = (extra = {}) => ({
  id: cid, plan: 'essencial', asaas_customer_id: 'cus_1', asaas_subscription_id: null,
  extra_seats_granted: 0, vertical_active: null, cnpj: '11222333000181', ...extra,
});

const couponRow = (extra = {}) => ({
  id: 'ac1', code: 'NEGOCIO50', type: 'promo', plan: 'negocio',
  discount_pct: 0, discount_value: 50, discount_months: 3, restrict_to_plan: true,
  trial_days: 0, max_uses: 10, uses: 0, expires_at: null, is_active: true, referrer_id: null,
  ...extra,
});

function arrangeDb({ company = companyRow(), coupon = couponRow(), tableMissing = false, discountRow = null } = {}) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push({ sql: s, params });
    if (s.includes('AS role')) return { rows: [{ role: 'owner' }] };
    if (s.includes('AS subscription_discount')) {
      if (tableMissing) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return { rows: [{ ...company, subscription_discount: discountRow }] };
    }
    if (s.includes('SELECT * FROM companies WHERE id')) return { rows: [company] };
    if (s.includes('SELECT asaas_subscription_id FROM companies')) return { rows: [company] };
    if (s.includes('SELECT * FROM users WHERE id')) return { rows: [{ id: 'u1', email: 'ana@loja.com', full_name: 'Ana' }] };
    if (s.includes('FROM access_codes WHERE code')) return { rows: coupon ? [coupon] : [] };
    if (s.includes('FROM coupon_redemptions WHERE company_id')) return { rows: [] };
    if (s.includes('UPDATE access_codes SET uses = uses + 1')) return { rows: [{ uses: 1 }] };
    if (s.includes('SELECT 1 FROM subscription_discounts LIMIT 0')) {
      if (tableMissing) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return { rows: [] };
    }
    if (s.includes('FROM subscription_discounts WHERE company_id')) return { rows: discountRow ? [discountRow] : [] };
    if (s.includes('INSERT INTO subscription_discounts')) return { rows: [{ id: 'd1' }] };
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

function arrangeAsaas({ firstPaymentStatus = 'CONFIRMED' } = {}) {
  asaas.mockImplementation(async (method, path) => {
    if (method === 'POST' && path === '/payments') return { id: 'pay_now', status: firstPaymentStatus };
    if (method === 'POST' && path === '/subscriptions') return { id: 'sub_1', nextDueDate: isoIn(1) };
    if (method === 'GET' && path.startsWith('/subscriptions/sub_1/payments')) return { data: [{ id: 'pay_1' }] };
    if (method === 'GET' && path.endsWith('/pixQrCode')) return { encodedImage: 'img', payload: 'pix-copia', expirationDate: 'x' };
    if (method === 'PUT' || method === 'DELETE') return {};
    throw new Error('Asaas inesperado: ' + method + ' ' + path);
  });
}

const asaasCall = (method, path) => asaas.mock.calls.find((c) => c[0] === method && c[1] === path);
const subscribe = (body) => request(app).post(`/api/v1/companies/${cid}/billing/subscribe`).set(auth).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  subscriptionDiscount._resetTableReadyCache();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /billing/subscribe — R$ 50 x 3 meses', () => {
  test('Pix: assinatura nasce em 119, sem PUT na 1a, desconto registrado', async () => {
    const calls = arrangeDb();
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'NEGOCIO50' });

    expect(res.status).toBe(201);
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body.value).toBe(119);
    expect(body.description).toBe('Aura Negocio — cupom NEGOCIO50: R$ 50,00 de desconto nas 3 primeiras mensalidades');
    expect(asaas.mock.calls.some((c) => c[0] === 'PUT')).toBe(false);

    const insert = calls.find((c) => c.sql.includes('INSERT INTO subscription_discounts'));
    expect(insert.params).toEqual([cid, 'u1', 'ac1', 'NEGOCIO50', 'sub_1', 'PIX', 50, 3, 0,
      subscriptionDiscount.addMonthsIso(isoIn(1), 3)]);

    const redemption = calls.find((c) => c.sql.includes('INSERT INTO coupon_redemptions'));
    expect(redemption.params.slice(-2)).toEqual([50, 3]);
    expect(redemption.params[10]).toBe(169); // recurring_value = valor cheio
    expect(redemption.params[11]).toBe(119); // charged_value

    expect(res.body.charged_now).toBe(119);
    expect(res.body.coupon).toMatchObject({ discount_value: 50, discount_months: 3, discounted_value: 119 });
    expect(res.body.pix_copy_paste).toBe('pix-copia');
  });

  test('cartao: 1a cobrada na hora a 119, assinatura a 119, a avulsa conta como 1 dos 3 meses', async () => {
    const calls = arrangeDb();
    arrangeAsaas();
    const res = await subscribe({
      plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', access_code: 'NEGOCIO50', credit_card_token: 'tok',
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')[2].value).toBe(119);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(119);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO subscription_discounts'));
    expect(insert.params.slice(5)).toEqual(['CREDIT_CARD', 50, 3, 1, subscriptionDiscount.addMonthsIso(isoIn(0), 3)]);
  });

  test('cupom preso ao Negocio no Essencial: 400 antes de reservar ou cobrar', async () => {
    const calls = arrangeDb();
    arrangeAsaas();
    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly', access_code: 'NEGOCIO50' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Este cupom vale só para o plano Negócio.');
    expect(asaas).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything());
    expect(calls.some((c) => c.sql.includes('UPDATE access_codes'))).toBe(false);
  });

  test('anual: 400', async () => {
    arrangeDb();
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual', access_code: 'NEGOCIO50' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Este cupom vale só no plano mensal.');
  });

  test('migration 326 pendente: recusa sem criar assinatura descontada para sempre', async () => {
    arrangeDb({ tableMissing: true });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'NEGOCIO50' });
    expect(res.status).toBe(503);
    expect(asaasCall('POST', '/subscriptions')).toBeUndefined();
  });

  test('troca de plano com assinatura anterior: perde o desconto antes de apagar a antiga', async () => {
    const calls = arrangeDb({ company: companyRow({ plan: 'negocio', asaas_subscription_id: 'sub_old' }), coupon: null });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual' });
    expect(res.status).toBe(201);
    const lose = calls.find((c) => c.sql.includes("SET status = 'lost'"));
    expect(lose.params).toEqual([cid, 'plan_change']);
    // Desconto concluido (restored com a 1a cheia ja vencida) nao e marcado como perdido.
    expect(lose.sql).toContain("status = 'restored' AND first_full_due_date > CURRENT_DATE");
    expect(asaasCall('DELETE', '/subscriptions/sub_old')).toBeDefined();
  });
});

describe('cupom de 1 mes segue como antes', () => {
  test('50% no Pix: assinatura cheia (169) e a 1a ajustada por PUT', async () => {
    const calls = arrangeDb({ coupon: couponRow({ code: 'SHEID50', discount_pct: 50, discount_value: 0, discount_months: 1, restrict_to_plan: false }) });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'SHEID50' });
    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(169);
    expect(asaasCall('PUT', '/payments/pay_1')[2]).toEqual({ value: 84.5, description: 'Aura Negocio — cupom SHEID50 (-50%)' });
    expect(calls.some((c) => c.sql.includes('INSERT INTO subscription_discounts'))).toBe(false);
  });
});

describe('POST /billing/validate-coupon', () => {
  test('mostra 119 por 3 meses e quando comeca a cheia', async () => {
    arrangeDb();
    const res = await request(app).post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth)
      .send({ code: 'NEGOCIO50', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true, discount_value: 50, discount_months: 3,
      first_charge_value: 119, recurring_value: 169, discounted_value: 119, discounted_months: 3,
      first_full_charge_date: subscriptionDiscount.addMonthsIso(isoIn(1), 3),
    });
  });

  test('plano errado: valid false com a mensagem', async () => {
    arrangeDb();
    const res = await request(app).post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth)
      .send({ code: 'NEGOCIO50', plan: 'expansao', cycle: 'monthly' });
    expect(res.body).toEqual({ valid: false, error: 'Este cupom vale só para o plano Negócio.' });
  });
});

describe('status e cancelamento', () => {
  test('GET /billing/status expoe o desconto em andamento numa ida ao banco', async () => {
    const calls = arrangeDb({
      company: companyRow({ plan: 'negocio', asaas_subscription_id: 'sub_1', billing_status: 'active' }),
      discountRow: { code: 'NEGOCIO50', discount_amount: 50, months: 3, first_full_due_date: '2026-12-16' },
    });
    const res = await request(app).get(`/api/v1/companies/${cid}/billing/status`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.discount).toEqual({ code: 'NEGOCIO50', discount_amount: 50, months: 3, first_full_due_date: '2026-12-16' });
    expect(res.body.plan).toBe('negocio');
    expect(calls.filter((c) => !c.sql.includes('AS role'))).toHaveLength(1);
  });

  test('GET /billing/status antes da migration 326: responde sem desconto', async () => {
    arrangeDb({ company: companyRow({ plan: 'negocio' }), tableMissing: true });
    const res = await request(app).get(`/api/v1/companies/${cid}/billing/status`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.discount).toBeNull();
    expect(res.body.plan).toBe('negocio');
  });

  test('POST /billing/cancel perde o desconto', async () => {
    const calls = arrangeDb({ company: companyRow({ asaas_subscription_id: 'sub_1' }) });
    arrangeAsaas();
    const res = await request(app).post(`/api/v1/companies/${cid}/billing/cancel`).set(auth);
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.sql.includes("SET status = 'lost'")).params).toEqual([cid, 'cancelled']);
  });
});
