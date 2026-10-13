// ============================================================
// QA — /billing com a promocao "primeiro mes pelo calendario" (migration 372)
//
// Quem assina ate 31/10/2026 nao paga novembro: nenhuma cobranca agora e a
// 1a mensalidade em 01/12. Cobre:
//   - aplicacao automatica (cartao, Pix, anual) e o que a resposta diz
//   - registro em coupon_redemptions
//   - cupom informado prevalece (nao acumula)
//   - fora do prazo / assinatura anterior / ja resgatou: cobra normal
//   - GET /billing/promocao-ativa dentro e fora do prazo
// ============================================================
jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db, asaas, promocoes, getTotalValue, trialRegra;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ({ asaas } = require('../../src/services/asaasClient'));
  promocoes = require('../../src/services/promocoes');
  ({ getTotalValue } = require('../../src/services/billingPricing'));
  trialRegra = require('../../src/services/trialRegra'); // marcarTrialFixo e' jest.fn (jest.setup)
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '3650d' })}` }; // longo: o relogio e' falsificado nos testes

const NO_PRAZO  = '2026-10-20T12:00:00-03:00';
const DIAS_NO_PRAZO = 42;                       // 20/10 -> 01/12
const FIM_PRAZO = '2026-10-31T23:59:59.999-03:00';
const APOS_PRAZO = '2026-11-01T00:00:00.000-03:00';

const FAKE_ONLY_DATE = ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'];
const setNow = (iso) => jest.useFakeTimers({ now: new Date(iso), doNotFake: FAKE_ONLY_DATE });

const companyRow = (extra = {}) => ({
  id: cid, plan: 'essencial', asaas_customer_id: 'cus_1', asaas_subscription_id: null,
  billing_status: 'trial', last_payment_date: null,
  extra_seats_granted: 0, vertical_active: null, cnpj: '11222333000181', ...extra,
});

const promoRow = (extra = {}) => ({
  id: 'ac-pm', code: 'PRIMEIROMES', type: 'promo', plan: 'negocio',
  discount_pct: 0, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 7, max_uses: 1000000, uses: 0, expires_at: null, is_active: true, referrer_id: null,
  ...extra,
});

const sheid50Row = () => ({
  id: 'ac-sh', code: 'SHEID50', type: 'promo', plan: 'negocio',
  discount_pct: 50, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 0, max_uses: 10, uses: 0, expires_at: null, is_active: true, referrer_id: null,
});

// codes: { CODIGO: row }. redeemed: ids de access_codes que a empresa ja resgatou.
function arrangeDb({ company = companyRow(), codes = { PRIMEIROMES: promoRow() }, redeemed = [] } = {}) {
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
    if (s.includes('FROM coupon_redemptions WHERE company_id')) {
      return { rows: redeemed.includes(params[1]) ? [{ '?column?': 1 }] : [] };
    }
    if (s.includes('UPDATE access_codes SET uses = uses + 1')) return { rows: [{ uses: 1 }] };
    return { rows: [], rowCount: 0 };
  });
  return calls;
}

function arrangeAsaas({ firstPaymentStatus = 'CONFIRMED' } = {}) {
  asaas.mockImplementation(async (method, path, body) => {
    if (method === 'POST' && path === '/payments') return { id: 'pay_now', status: firstPaymentStatus };
    if (method === 'POST' && path === '/subscriptions') return { id: 'sub_1', nextDueDate: body.nextDueDate };
    if (method === 'GET' && path.startsWith('/subscriptions/sub_1/payments')) return { data: [{ id: 'pay_1' }] };
    if (method === 'GET' && path.endsWith('/pixQrCode')) return { encodedImage: 'img', payload: 'pix-copia', expirationDate: 'x' };
    if (method === 'PUT' || method === 'DELETE') return {};
    throw new Error('Asaas inesperado: ' + method + ' ' + path);
  });
}

const asaasCall = (method, path) => asaas.mock.calls.find((c) => c[0] === method && c[1] === path);
const subscribe = (body) => request(app).post(`/api/v1/companies/${cid}/billing/subscribe`).set(auth).send(body);
const redemptionOf = (calls) => calls.find((c) => c.sql.includes('INSERT INTO coupon_redemptions'));
const queriedCode = (calls, code) => calls.some((c) => c.sql.includes('FROM access_codes WHERE code') && c.params[0] === code);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  promocoes._resetAvisos();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('aplicacao automatica no /subscribe (sem cupom informado)', () => {
  test('cartao: nenhuma cobranca agora, assinatura agendada em 01/12 pelo valor cheio', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();
    const cheio = getTotalValue('negocio', 'monthly', 'CREDIT_CARD', 0);

    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')).toBeUndefined();
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body.value).toBe(cheio);
    expect(body.nextDueDate).toBe('2026-12-01');
    expect(body.description).toBe('Aura Negocio — promoção PRIMEIROMES (1ª cobrança em 01/12/2026)');

    // billing_status='trial' + trial_ends_at = 01/12 (o app segue liberado ate la)
    const upd = calls.find((c) => c.sql.includes("billing_status='trial'"));
    expect(upd.params.slice(0, 4)).toEqual(['negocio', 'sub_1', 'monthly', '2026-12-01']);
    // 13/10: a data da promocao vale como esta — a conta deixa o modo
    // primeira_venda (senao a 1a venda encurtaria 01/12 para venda + 7 dias)
    expect(trialRegra.marcarTrialFixo).toHaveBeenCalledWith(cid);

    // registrado em coupon_redemptions: periodo gratis, nada cobrado agora
    const red = redemptionOf(calls);
    expect(red.params[2]).toBe('ac-pm');            // code_id
    expect(red.params[3]).toBe('PRIMEIROMES');      // code
    expect(red.params[5]).toBe(0);                  // discount_pct
    expect(red.params[6]).toBe(DIAS_NO_PRAZO);      // trial_days efetivos
    expect(red.params[10]).toBe(cheio);             // recurring_value
    expect(red.params[11]).toBeNull();              // charged_value: nada cobrado
    expect(red.params[13]).toBe('sub_1');           // asaas_subscription_id

    // a resposta diz qual cupom e quanto foi o desconto
    expect(res.body.charged_now).toBe(0);
    expect(res.body.trial_ends_at).toBe('2026-12-01');
    expect(res.body.coupon).toMatchObject({
      code: 'PRIMEIROMES', automatic: true, campaign: true,
      discount_amount: cheio, first_charge_date: '2026-12-01', trial_days: DIAS_NO_PRAZO,
    });
    expect(res.body.message).toContain('Promoção PRIMEIROMES aplicada');
    expect(res.body.message).toContain('01/12/2026');
  });

  test('Pix: sem QR, sem PUT, assinatura nasce com nextDueDate 01/12', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();
    const cheio = getTotalValue('negocio', 'monthly', 'PIX', 0);

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(201);
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body).toMatchObject({ value: cheio, nextDueDate: '2026-12-01', billingType: 'PIX' });
    expect(asaas.mock.calls.some((c) => c[0] === 'PUT')).toBe(false);
    expect(asaasCall('GET', '/payments/pay_1/pixQrCode')).toBeUndefined();
    expect(res.body.pix_qr_code).toBeNull();
    expect(res.body.charged_now).toBe(0);
    expect(res.body.coupon).toMatchObject({ code: 'PRIMEIROMES', automatic: true, discount_amount: cheio });
    expect(redemptionOf(calls)).toBeDefined();
    expect(trialRegra.marcarTrialFixo).toHaveBeenCalledWith(cid);
  });

  test('anual: primeira parcela (novembro) some; endDate do anual segue o informado', async () => {
    setNow(NO_PRAZO);
    arrangeDb();
    arrangeAsaas();
    const parcela = getTotalValue('negocio', 'annual', 'PIX', 0);

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-20' });

    expect(res.status).toBe(201);
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body).toMatchObject({ value: parcela, nextDueDate: '2026-12-01', endDate: '2027-10-20' });
    expect(res.body.coupon.discount_amount).toBe(parcela);
  });

  test('ultimo milissegundo do prazo ainda aplica', async () => {
    setNow(FIM_PRAZO);
    arrangeDb();
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.coupon).toMatchObject({ code: 'PRIMEIROMES', trial_days: 31, first_charge_date: '2026-12-01' });
  });

  test('Asaas recusa criar a assinatura: devolve o uso do cupom e nao registra resgate', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb();
    asaas.mockImplementation(async (method, path) => {
      if (method === 'POST' && path === '/subscriptions') throw new Error('cartao recusado');
      return {};
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });

    expect(res.status).toBe(500);
    expect(calls.some((c) => c.sql.includes('SET uses = GREATEST(uses - 1, 0)'))).toBe(true);
    expect(redemptionOf(calls)).toBeUndefined();
  });
});

describe('cupom informado prevalece', () => {
  test('SHEID50 digitado: aplica so ele, PRIMEIROMES nem e consultado', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb({ codes: { PRIMEIROMES: promoRow(), SHEID50: sheid50Row() } });
    arrangeAsaas();
    const cheio = getTotalValue('negocio', 'monthly', 'CREDIT_CARD', 0);

    const res = await subscribe({
      plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', access_code: 'SHEID50', credit_card_token: 'tok',
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')[2].value).toBe(cheio / 2); // cobra com 50%, hoje
    expect(queriedCode(calls, 'PRIMEIROMES')).toBe(false);
    const red = redemptionOf(calls);
    expect(red.params[3]).toBe('SHEID50');
    expect(calls.filter((c) => c.sql.includes('INSERT INTO coupon_redemptions'))).toHaveLength(1);
    expect(res.body.coupon).toMatchObject({ code: 'SHEID50', automatic: false });
    // cupom so de desconto nao escreve trial_ends_at: o modo do trial fica como esta
    expect(trialRegra.marcarTrialFixo).not.toHaveBeenCalled();
  });

  test('cupom de dias gratis (30 dias, cartao): escreve trial_ends_at e a conta vira fixa', async () => {
    setNow(NO_PRAZO);
    const indica30 = { ...sheid50Row(), id: 'ac-30', code: 'INDICA30', discount_pct: 0, trial_days: 30 };
    const calls = arrangeDb({ codes: { PRIMEIROMES: promoRow(), INDICA30: indica30 } });
    arrangeAsaas();

    const res = await subscribe({
      plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', access_code: 'INDICA30', credit_card_token: 'tok',
    });

    expect(res.status).toBe(201);
    expect(res.body.charged_now).toBe(0);
    const upd = calls.find((c) => c.sql.includes("billing_status='trial'"));
    expect(upd.params[3]).toBe(res.body.trial_ends_at);   // trial_ends_at continua escrito como antes
    expect(upd.sql).not.toContain('trial_mode');          // fora do UPDATE da cobranca (42703 nao derruba)
    expect(trialRegra.marcarTrialFixo).toHaveBeenCalledWith(cid);
  });

  test('cupom informado invalido NAO cai na promocao: 400', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb({ codes: { PRIMEIROMES: promoRow() } });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'NAOEXISTE' });
    expect(res.status).toBe(400);
    expect(res.body.stage).toBe('coupon');
    expect(queriedCode(calls, 'PRIMEIROMES')).toBe(false);
    expect(asaasCall('POST', '/subscriptions')).toBeUndefined();
  });

  test('PRIMEIROMES digitado funciona igual ao automatico', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'primeiromes' });
    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].nextDueDate).toBe('2026-12-01');
    expect(res.body.coupon).toMatchObject({ code: 'PRIMEIROMES', automatic: false, campaign: true });
    expect(redemptionOf(calls).params[3]).toBe('PRIMEIROMES');
  });
});

describe('quando NAO aplica: cobra normal', () => {
  test('apos o prazo (01/11 00:00 em Brasilia): cartao cobra a 1a na hora, sem cupom', async () => {
    setNow(APOS_PRAZO);
    const calls = arrangeDb();
    arrangeAsaas();
    const cheio = getTotalValue('negocio', 'monthly', 'CREDIT_CARD', 0);

    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')[2].value).toBe(cheio);
    expect(res.body.coupon).toBeNull();
    expect(redemptionOf(calls)).toBeUndefined();
    expect(queriedCode(calls, 'PRIMEIROMES')).toBe(false);
    expect(trialRegra.marcarTrialFixo).not.toHaveBeenCalled();
  });

  test('empresa com assinatura anterior (ja paga): cobra normal', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb({
      company: companyRow({ billing_status: 'active', asaas_subscription_id: 'sub_old', last_payment_date: '2026-09-10' }),
    });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });
    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')).toBeDefined();
    expect(res.body.coupon).toBeNull();
    expect(redemptionOf(calls)).toBeUndefined();
  });

  test('empresa que cancelou antes: cobra normal', async () => {
    setNow(NO_PRAZO);
    arrangeDb({ company: companyRow({ billing_status: 'cancelled' }) });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly' });
    expect(res.status).toBe(201);
    expect(res.body.coupon).toBeNull();
    expect(asaasCall('POST', '/subscriptions')[2].nextDueDate).not.toBe('2026-12-01');
  });

  test('uma vez por empresa: ja resgatou -> cobra normal', async () => {
    setNow(NO_PRAZO);
    arrangeDb({ redeemed: ['ac-pm'] });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });
    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')).toBeDefined();
    expect(res.body.coupon).toBeNull();
  });

  test('migration 372 pendente (sem a linha do codigo): cobra normal, nao quebra', async () => {
    setNow(NO_PRAZO);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    arrangeDb({ codes: {} });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok' });
    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')).toBeDefined();
  });

  test('PRIMEIROMES digitado fora do prazo: 400 com a mensagem', async () => {
    setNow(APOS_PRAZO);
    arrangeDb();
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'PRIMEIROMES' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Esta promoção já foi encerrada.', stage: 'coupon' });
    expect(asaasCall('POST', '/subscriptions')).toBeUndefined();
  });

  test('PRIMEIROMES digitado por empresa com assinatura anterior: 400 sem reservar uso', async () => {
    setNow(NO_PRAZO);
    const calls = arrangeDb({ company: companyRow({ billing_status: 'overdue' }) });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'PRIMEIROMES' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Esta promoção vale só para quem ainda não assinou o Aura.');
    expect(calls.some((c) => c.sql.includes('UPDATE access_codes'))).toBe(false);
  });

  test('PRIMEIROMES digitado de novo pela mesma empresa: 400 (uma vez por empresa)', async () => {
    setNow(NO_PRAZO);
    arrangeDb({ redeemed: ['ac-pm'] });
    arrangeAsaas();
    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly', access_code: 'PRIMEIROMES' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Esta empresa ja usou este cupom.');
  });
});

describe('GET /billing/promocao-ativa', () => {
  const get = () => request(app).get(`/api/v1/companies/${cid}/billing/promocao-ativa`).set(auth);

  test('dentro do prazo, empresa nova: elegivel', async () => {
    setNow(NO_PRAZO);
    arrangeDb();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      codigo: 'PRIMEIROMES',
      titulo: 'Assine até 31/10 e não pague novembro',
      descricao: expect.stringContaining('01/12/2026'),
      termina_em: '2026-11-01T02:59:59.999Z',
      primeira_cobranca_em: '2026-12-01',
      elegivel: true,
    });
  });

  test('fora do prazo: elegivel false', async () => {
    setNow(APOS_PRAZO);
    arrangeDb();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.elegivel).toBe(false);
    expect(res.body.codigo).toBe('PRIMEIROMES');
  });

  test('empresa com assinatura anterior: elegivel false', async () => {
    setNow(NO_PRAZO);
    arrangeDb({ company: companyRow({ billing_status: 'active', asaas_subscription_id: 'sub_1' }) });
    const res = await get();
    expect(res.body.elegivel).toBe(false);
  });

  test('ja resgatou: elegivel false', async () => {
    setNow(NO_PRAZO);
    arrangeDb({ redeemed: ['ac-pm'] });
    const res = await get();
    expect(res.body.elegivel).toBe(false);
  });

  test('exige login', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/billing/promocao-ativa`);
    expect(res.status).toBe(401);
  });
});

describe('POST /billing/validate-coupon com a campanha', () => {
  test('mostra 0 hoje, quanto deixa de cobrar e a data da 1a cobranca', async () => {
    setNow(NO_PRAZO);
    arrangeDb();
    const cheio = getTotalValue('negocio', 'monthly', 'PIX', 0);
    const res = await request(app).post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth)
      .send({ code: 'PRIMEIROMES', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      valid: true, code: 'PRIMEIROMES', campaign: true,
      first_charge_value: 0, recurring_value: cheio, discount_amount: cheio,
      first_charge_date: '2026-12-01', trial_days: DIAS_NO_PRAZO,
    });
  });

  test('empresa inelegivel: valid false com a mensagem', async () => {
    setNow(NO_PRAZO);
    arrangeDb({ company: companyRow({ billing_status: 'active' }) });
    const res = await request(app).post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth)
      .send({ code: 'PRIMEIROMES', plan: 'negocio', cycle: 'monthly' });
    expect(res.body).toEqual({ valid: false, error: 'Esta promoção vale só para quem ainda não assinou o Aura.' });
  });
});
