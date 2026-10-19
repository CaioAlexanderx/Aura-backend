// ============================================================
// /billing depois da remocao da campanha PRIMEIROMES (19/10/2026)
//
// Decisao do Caio: a promocao "assine ate 31/10 e nao pague novembro" saiu do
// produto. O codigo ja esta desativado no banco (access_codes.is_active=false).
// Cobre, DENTRO do antigo prazo (20/10), para provar que nada sobrou:
//   - /subscribe sem cupom cobra normal, sem consultar o PRIMEIROMES;
//   - /validate-coupon e /subscribe com 'PRIMEIROMES' digitado: cupom desativado;
//   - GET /promocao-ativa (compatibilidade) devolve sempre elegivel:false;
//   - cupom de dias gratis comum continua igual (data D+N, trial fixo).
// O resgate ja existente (webhook nao reescreve trial_ends_at) esta em
// __tests__/webhookAsaas.resgateDiasGratis.test.js.
// ============================================================
jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db, asaas, getTotalValue, trialRegra;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ({ asaas } = require('../../src/services/asaasClient'));
  ({ getTotalValue } = require('../../src/services/billingPricing'));
  trialRegra = require('../../src/services/trialRegra'); // marcarTrialFixo e' jest.fn (jest.setup)
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '3650d' })}` }; // longo: o relogio e' falsificado

// Dentro do prazo da campanha antiga: se algo da promocao tivesse sobrado, apareceria aqui.
const ANTIGO_PRAZO = '2026-10-20T12:00:00-03:00';
const FAKE_ONLY_DATE = ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'];
const setNow = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: FAKE_ONLY_DATE });

const companyRow = (extra = {}) => ({
  id: cid, plan: 'essencial', asaas_customer_id: 'cus_1', asaas_subscription_id: null,
  billing_status: 'trial', last_payment_date: null,
  extra_seats_granted: 0, vertical_active: null, cnpj: '11222333000181', ...extra,
});

// Como esta em producao desde 19/10 12:24 UTC.
const primeiroMesDesativado = () => ({
  id: 'ac-pm', code: 'PRIMEIROMES', type: 'promo', plan: 'negocio',
  discount_pct: 0, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 7, max_uses: 1000000, uses: 1, expires_at: null, is_active: false, referrer_id: null,
});

const diasGratisRow = () => ({
  id: 'ac-30', code: 'INDICA30', type: 'promo', plan: 'negocio',
  discount_pct: 0, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 30, max_uses: 10, uses: 0, expires_at: null, is_active: true, referrer_id: null,
});

function arrangeDb({ company = companyRow(), codes = { PRIMEIROMES: primeiroMesDesativado() } } = {}) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push({ sql: s, params });
    if (s.includes('AS role')) return { rows: [{ role: 'owner' }] };
    if (s.includes('SELECT * FROM companies WHERE id')) return { rows: [company] };
    if (s.includes('SELECT * FROM users WHERE id')) return { rows: [{ id: 'u1', email: 'ana@loja.com', full_name: 'Ana' }] };
    if (s.includes('FROM access_codes WHERE code')) {
      const row = codes[params[0]];
      return { rows: row ? [row] : [] };
    }
    if (s.includes('FROM coupon_redemptions WHERE company_id')) return { rows: [] };
    if (s.includes('UPDATE access_codes SET uses = uses + 1')) return { rows: [{ uses: 1 }] };
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

const asaasCall = (method, path) => asaas.mock.calls.find((c) => c[0] === method && c[1] === path);
const subscribe = (body) => request(app).post(`/api/v1/companies/${cid}/billing/subscribe`).set(auth).send(body);
const validar = (body) => request(app).post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth).send(body);
const redemptionOf = (calls) => calls.find((c) => c.sql.includes('INSERT INTO coupon_redemptions'));
const consultouCodigo = (calls) => calls.some((c) => c.sql.includes('FROM access_codes WHERE code'));
const updateDaEmpresa = (calls) => calls.find((c) => /UPDATE companies SET plan=/.test(c.sql));

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('/subscribe sem cupom: nenhuma promocao', () => {
  test('cartao: cobra a 1a mensalidade cheia agora e nao consulta cupom nenhum', async () => {
    setNow(ANTIGO_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();
    const cheio = getTotalValue('negocio', 'monthly', 'CREDIT_CARD', 0);

    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });

    expect(res.status).toBe(201);
    expect(res.body.coupon).toBeNull();
    expect(res.body.charged_now).toBe(cheio);
    expect(res.body.trial_ends_at).toBeUndefined();
    const [, , primeira] = asaasCall('POST', '/payments');
    expect(primeira.value).toBe(cheio);
    expect(primeira.description).not.toMatch(/PRIMEIROMES|promo/i);
    expect(consultouCodigo(calls)).toBe(false);
    expect(redemptionOf(calls)).toBeUndefined();
    expect(trialRegra.marcarTrialFixo).not.toHaveBeenCalled();
  });

  test('Pix: assinatura com cobranca normal, QR gerado, sem trial_ends_at', async () => {
    setNow(ANTIGO_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();
    const cheio = getTotalValue('negocio', 'monthly', 'PIX', 0);

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(201);
    expect(res.body.coupon).toBeNull();
    expect(res.body.charged_now).toBe(cheio);
    expect(res.body.trial_ends_at).toBeNull();
    expect(res.body.pix_copy_paste).toBe('pix-copia');
    const [, , sub] = asaasCall('POST', '/subscriptions');
    expect(sub.value).toBe(cheio);
    expect(sub.nextDueDate).not.toBe('2026-12-01');
    expect(sub.description).not.toMatch(/PRIMEIROMES|promo/i);
    const upd = updateDaEmpresa(calls);
    expect(upd.params[2]).toBe('pending'); // billing_status
    expect(upd.params[5]).toBeNull();      // trial_ends_at intocado (CASE ... ELSE trial_ends_at)
    expect(consultouCodigo(calls)).toBe(false);
    expect(redemptionOf(calls)).toBeUndefined();
    expect(trialRegra.marcarTrialFixo).not.toHaveBeenCalled();
  });
});

describe('PRIMEIROMES digitado: cupom desativado', () => {
  test('/validate-coupon devolve invalido', async () => {
    setNow(ANTIGO_PRAZO);
    arrangeDb();

    const res = await validar({ code: 'PRIMEIROMES', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, error: 'Cupom desativado.' });
  });

  test('/subscribe recusa com 400 e nao cria nada na Asaas', async () => {
    setNow(ANTIGO_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'PRIMEIROMES' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Cupom desativado.', stage: 'coupon' });
    expect(asaas).not.toHaveBeenCalledWith('POST', '/subscriptions', expect.anything());
    expect(calls.some((c) => c.sql.includes('UPDATE access_codes SET uses = uses + 1'))).toBe(false);
    expect(redemptionOf(calls)).toBeUndefined();
  });

  test('/validate-coupon nao devolve mais o campo campaign', async () => {
    setNow(ANTIGO_PRAZO);
    arrangeDb({ codes: { INDICA30: diasGratisRow() } });

    const res = await validar({ code: 'INDICA30', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });

    expect(res.body.valid).toBe(true);
    expect(res.body).not.toHaveProperty('campaign');
    expect(res.body.first_charge_date).toBe('2026-11-19'); // 20/10 + 30 dias, nao 01/12
  });
});

describe('cupom de dias gratis comum continua igual', () => {
  test('Pix com INDICA30: trial_ends_at = D+30, trial fixo e resgate gravado', async () => {
    setNow(ANTIGO_PRAZO);
    const calls = arrangeDb({ codes: { INDICA30: diasGratisRow() } });
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'INDICA30' });

    expect(res.status).toBe(201);
    expect(res.body.trial_ends_at).toBe('2026-11-19');
    expect(res.body.charged_now).toBe(0);
    expect(res.body.coupon).toMatchObject({ code: 'INDICA30', trial_days: 30, first_charge_date: '2026-11-19' });
    expect(res.body.coupon).not.toHaveProperty('automatic');
    expect(res.body.coupon).not.toHaveProperty('campaign');
    expect(res.body.message).toBe('30 dias gratis ativados! A primeira cobranca sera em 2026-11-19.');
    const [, , sub] = asaasCall('POST', '/subscriptions');
    expect(sub.nextDueDate).toBe('2026-11-19');
    expect(sub.description).toContain('30 dias gratis (INDICA30)');
    expect(updateDaEmpresa(calls).params[5]).toBe('2026-11-19');
    expect(trialRegra.marcarTrialFixo).toHaveBeenCalledWith(cid);
    expect(redemptionOf(calls).params[3]).toBe('INDICA30');
  });

  test('cartao com INDICA30: nenhuma cobranca agora, 1a cobranca em D+30', async () => {
    setNow(ANTIGO_PRAZO);
    arrangeDb({ codes: { INDICA30: diasGratisRow() } });
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok', access_code: 'INDICA30' });

    expect(res.status).toBe(201);
    expect(res.body.charged_now).toBe(0);
    expect(res.body.trial_ends_at).toBe('2026-11-19');
    expect(asaasCall('POST', '/payments')).toBeUndefined();
    expect(res.body.message).toContain('30 dias gratis ativados! Seu cartao ficou salvo');
    expect(trialRegra.marcarTrialFixo).toHaveBeenCalledWith(cid);
  });
});

describe('GET /billing/promocao-ativa (so compatibilidade com o app antigo)', () => {
  const get = () => request(app).get(`/api/v1/companies/${cid}/billing/promocao-ativa`).set(auth);

  test('devolve sempre elegivel:false com os campos nulos, sem ler a empresa', async () => {
    setNow(ANTIGO_PRAZO);
    const calls = arrangeDb();

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      codigo: null,
      titulo: null,
      descricao: null,
      termina_em: null,
      primeira_cobranca_em: null,
      elegivel: false,
    });
    expect(calls.some((c) => c.sql.includes('SELECT * FROM companies WHERE id'))).toBe(false);
    expect(consultouCodigo(calls)).toBe(false);
  });

  test('sem token continua 401', async () => {
    arrangeDb();
    const res = await request(app).get(`/api/v1/companies/${cid}/billing/promocao-ativa`);
    expect(res.status).toBe(401);
  });
});
