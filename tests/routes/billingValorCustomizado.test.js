// ============================================================
// /billing com VALOR CUSTOMIZADO por empresa (migration 386)
//
// Caso real: empresa dona de 2 lojas fechou o Negocio anual por R$ 211,20/mes
// (R$ 140,83 de tabela + R$ 70,37 da segunda loja). O checkout e' o da Aura
// (PIX/cartao); a equipe grava o valor na Gestao Aura.
//
// Cobre: valor combinado casa/nao casa plano e ciclo, cartao e PIX, cupom
// (desconto e dias gratis), promocao, descricao "(valor combinado)", minimo do
// provedor, GET /billing/quote por empresa (sem a nota interna) e
// /validate-coupon. E a regressao: empresa SEM valor combinado cobra
// exatamente o que cobrava.
// ============================================================
jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db, asaas, promocoes, getTotalValue;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ({ asaas } = require('../../src/services/asaasClient'));
  promocoes = require('../../src/services/promocoes');
  ({ getTotalValue } = require('../../src/services/billingPricing'));
});

const SECRET = 'aura-test-secret-2026';
const cid    = '3a95021d-62e2-417c-8863-b9c4f0a5e155';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

// Empresa com o combinado do caso real: Negocio anual, R$ 211,20.
const companyRow = (extra = {}) => ({
  id: cid, plan: 'essencial', asaas_customer_id: 'cus_1', asaas_subscription_id: null,
  billing_status: 'trial', last_payment_date: null,
  extra_seats_granted: 0, vertical_active: null, cnpj: '11222333000181',
  custom_subscription_value: '211.20', custom_subscription_plan: 'negocio',
  custom_subscription_cycle: 'annual', custom_subscription_note: 'Fechado por telefone em 14/10: 2 lojas',
  ...extra,
});

const semCombinado = (extra = {}) => companyRow({
  custom_subscription_value: null, custom_subscription_plan: null,
  custom_subscription_cycle: null, custom_subscription_note: null, ...extra,
});

const couponRow = (extra = {}) => ({
  id: 'ac-1', code: 'CUPOM10', type: 'promo', plan: 'negocio',
  discount_pct: 10, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 0, max_uses: 10, uses: 0, expires_at: null, is_active: true, referrer_id: null,
  ...extra,
});

function arrangeDb({ company = companyRow(), codes = {} } = {}) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    calls.push({ sql: s, params });
    if (s.includes('AS role')) return { rows: [{ role: 'owner' }] };
    if (s.includes('SELECT * FROM companies WHERE id')) return { rows: [company] };
    if (s.includes('SELECT * FROM users WHERE id')) return { rows: [{ id: 'u1', email: 'luis@loja.com', full_name: 'Luis' }] };
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
const quote = (qs) => request(app).get(`/api/v1/companies/${cid}/billing/quote?${qs}`).set(auth);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  promocoes._resetAvisos();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /billing/subscribe com valor combinado', () => {
  test('PIX anual no plano e ciclo combinados: a assinatura nasce em R$ 211,20 (nao 140,83) e marca a descricao', async () => {
    arrangeDb();
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-14' });

    expect(res.status).toBe(201);
    expect(res.body.value).toBe(211.2);
    expect(res.body.charged_now).toBe(211.2);
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body.value).toBe(211.2);
    expect(body.billingType).toBe('PIX');
    expect(body.endDate).toBe('2027-10-14');
    expect(body.description).toBe('Aura Negocio (Anual) (valor combinado)');
  });

  test('cartao anual: 1a cobranca e recorrencia em R$ 211,20', async () => {
    arrangeDb();
    arrangeAsaas();

    const res = await subscribe({
      plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'annual',
      end_date: '2027-10-14', credit_card_token: 'tok',
    });

    expect(res.status).toBe(201);
    const [, , primeira] = asaasCall('POST', '/payments');
    expect(primeira.value).toBe(211.2);
    expect(primeira.description).toContain('(valor combinado)');
    const [, , assinatura] = asaasCall('POST', '/subscriptions');
    expect(assinatura.value).toBe(211.2);
    expect(assinatura.description).toBe('Aura Negocio (Anual) (valor combinado)');
    expect(res.body.value).toBe(211.2);
  });

  test('o valor combinado ja inclui os acessos extras: com 2 extras segue 211,20 (nao soma 38)', async () => {
    arrangeDb({ company: companyRow({ extra_seats_granted: 2 }) });
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-14' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(211.2);
    // descricao mantem os extras e marca o valor combinado
    expect(asaasCall('POST', '/subscriptions')[2].description).toBe('Aura Negocio (Anual) + 2 acesso(s) extra (valor combinado)');
  });

  test('outro CICLO (mensal) nao usa o combinado: tabela do Negocio mensal', async () => {
    arrangeDb();
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(getTotalValue('negocio', 'monthly', 'PIX', 0));
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(169);
    expect(asaasCall('POST', '/subscriptions')[2].description).toBe('Aura Negocio');
  });

  test('outro PLANO (expansao anual) nao usa o combinado: tabela', async () => {
    arrangeDb({ company: companyRow({ extra_seats_granted: 1 }) });
    arrangeAsaas();

    const res = await subscribe({ plan: 'expansao', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-14' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(getTotalValue('expansao', 'annual', 'PIX', 1));
    expect(asaasCall('POST', '/subscriptions')[2].description).not.toContain('valor combinado');
  });

  test('cupom em % incide sobre o valor combinado: 10% de 211,20 = 190,08 na 1a cobranca; recorrente 211,20', async () => {
    arrangeDb({ codes: { CUPOM10: couponRow() } });
    arrangeAsaas();

    const res = await subscribe({
      plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'annual',
      end_date: '2027-10-14', credit_card_token: 'tok', access_code: 'CUPOM10',
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')[2].value).toBe(190.08);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(211.2);
    expect(res.body.value).toBe(211.2);
    expect(res.body.charged_now).toBe(190.08);
    expect(res.body.coupon.discount_amount).toBe(21.12);
  });

  test('cupom em reais (R$ 50, 1 mes) no Pix: o QR sai com 161,20 e a recorrencia segue 211,20', async () => {
    arrangeDb({ codes: { CUPOM50: couponRow({ code: 'CUPOM50', discount_pct: 0, discount_value: 50 }) } });
    arrangeAsaas();

    const res = await subscribe({
      plan: 'negocio', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-14', access_code: 'CUPOM50',
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(211.2);
    const put = asaasCall('PUT', '/payments/pay_1');
    expect(put[2].value).toBe(161.2);
    expect(res.body.charged_now).toBe(161.2);
  });

  test('cupom de dias gratis no cartao: nada agora, assinatura agendada pelo valor combinado', async () => {
    arrangeDb({ codes: { GRATIS7: couponRow({ code: 'GRATIS7', discount_pct: 0, trial_days: 7 }) } });
    arrangeAsaas();

    const res = await subscribe({
      plan: 'negocio', billing_type: 'CREDIT_CARD', cycle: 'annual',
      end_date: '2027-10-14', credit_card_token: 'tok', access_code: 'GRATIS7',
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')).toBeUndefined();
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body.value).toBe(211.2);
    expect(body.description).toContain('(valor combinado)');
    expect(res.body.charged_now).toBe(0);
  });

  test('valor combinado abaixo do minimo do provedor e recusado antes de tocar a Asaas', async () => {
    arrangeDb({ company: companyRow({ custom_subscription_value: '3.50' }) });
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-14' });

    expect(res.status).toBe(400);
    expect(res.body.stage).toBe('valor_customizado');
    expect(asaas).not.toHaveBeenCalled();
  });

  test('valor combinado invalido (zero/texto) e ignorado: tabela', async () => {
    arrangeDb({ company: companyRow({ custom_subscription_value: '0' }) });
    arrangeAsaas();

    const res = await subscribe({ plan: 'negocio', billing_type: 'PIX', cycle: 'annual', end_date: '2027-10-14' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(140.83);
  });
});

describe('regressao: empresa SEM valor combinado cobra exatamente como antes', () => {
  test.each([
    ['essencial', 'monthly', 'PIX', 0],
    ['negocio', 'annual', 'PIX', 0],
    ['negocio', 'annual', 'PIX', 2],
    ['expansao', 'monthly', 'PIX', 1],
  ])('%s/%s/%s com %i extra(s): valor = getTotalValue', async (plan, cycle, billingType, seats) => {
    arrangeDb({ company: semCombinado({ extra_seats_granted: seats }) });
    arrangeAsaas();

    const res = await subscribe({
      plan, billing_type: billingType, cycle, end_date: cycle === 'annual' ? '2027-10-14' : undefined,
    });

    expect(res.status).toBe(201);
    const [, , body] = asaasCall('POST', '/subscriptions');
    expect(body.value).toBe(getTotalValue(plan, cycle, billingType, seats));
    expect(body.description).not.toContain('valor combinado');
  });

  test('cupom de 50% no cartao: desconto so no plano, acesso extra cheio (74,17 + 19 -> 37,09 + 19)', async () => {
    arrangeDb({
      company: semCombinado({ extra_seats_granted: 1 }),
      codes: { META50: couponRow({ code: 'META50', discount_pct: 50, plan: 'essencial' }) },
    });
    arrangeAsaas();

    const res = await subscribe({
      plan: 'essencial', billing_type: 'CREDIT_CARD', cycle: 'annual',
      end_date: '2027-10-14', credit_card_token: 'tok', access_code: 'META50',
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/payments')[2].value).toBe(56.09);
    expect(asaasCall('POST', '/subscriptions')[2].value).toBe(93.17);
  });
});

describe('GET /billing/quote', () => {
  test('plano e ciclo combinados: devolve o valor combinado, custom=true e o valor de tabela; sem a nota interna', async () => {
    arrangeDb({ company: companyRow({ extra_seats_granted: 1 }) });

    const res = await quote('plan=negocio&cycle=annual&billing_type=PIX');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plan: 'negocio', cycle: 'annual', billing_type: 'PIX',
      value: 211.2, custom: true, table_value: getTotalValue('negocio', 'annual', 'PIX', 1), extra_seats: 1,
    });
    expect(JSON.stringify(res.body)).not.toContain('Fechado por telefone');
    expect(res.body).not.toHaveProperty('note');
  });

  test('outro ciclo: tabela, custom=false', async () => {
    arrangeDb();

    const res = await quote('plan=negocio&cycle=monthly&billing_type=CREDIT_CARD');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ value: 169, custom: false, table_value: 169, cycle: 'monthly', billing_type: 'CREDIT_CARD' });
  });

  test('empresa sem valor combinado: igual a tabela', async () => {
    arrangeDb({ company: semCombinado() });

    const res = await quote('plan=essencial&cycle=annual');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ value: 74.17, custom: false, table_value: 74.17 });
  });

  test('plano invalido: 400; sem token: 401; empresa inexistente: 404', async () => {
    arrangeDb();
    expect((await quote('plan=ouro&cycle=annual')).status).toBe(400);
    expect((await request(app).get(`/api/v1/companies/${cid}/billing/quote?plan=negocio`)).status).toBe(401);

    db.query.mockImplementation(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('AS role')) return { rows: [{ role: 'owner' }] };
      return { rows: [] };
    });
    expect((await quote('plan=negocio&cycle=annual')).status).toBe(404);
  });
});

describe('POST /billing/validate-coupon com valor combinado', () => {
  test('mostra o recorrente combinado e a 1a cobranca com o cupom sobre ele', async () => {
    arrangeDb({ codes: { CUPOM10: couponRow() } });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth)
      .send({ code: 'CUPOM10', plan: 'negocio', cycle: 'annual', billing_type: 'PIX' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.recurring_value).toBe(211.2);
    expect(res.body.discount_amount).toBe(21.12);
    expect(res.body.first_charge_value).toBe(190.08);
  });

  test('sem valor combinado segue a tabela (169 - 10% do plano)', async () => {
    arrangeDb({ company: semCombinado(), codes: { CUPOM10: couponRow() } });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth)
      .send({ code: 'CUPOM10', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });

    expect(res.body.recurring_value).toBe(169);
    expect(res.body.first_charge_value).toBe(152.1);
  });
});
