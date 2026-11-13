// ============================================================
// AURA. — Testes: Recebe na Aura, cobrança na subconta com split (RA-08)
// Cobre:
//   split para a carteira da Aura em toda cobrança (Pix 2% do valor; cartão
//     1,01% menos R$ 0,49), como fixedValue sobre o valor bruto
//   notificação da Asaas desligada no cliente da cobrança
//   externalReference apontando para a origem
//   chave DA SUBCONTA em todas as chamadas (nunca a da conta-mãe), nunca no log
//   subconta não aprovada → recusa gentil, sem Asaas; sem carteira → 503
//   erro da Asaas: 4xx → 422, 5xx → 502
//   cobrança em dobro para a mesma origem: reaproveita / 409 se já paga
//   rota de staff: flag desligada → 404; is_staff do BANCO (não o JWT nem o
//     e-mail) → senão 404
//
// Banco mockado por SQL, Asaas simulada (global.fetch). Nenhuma chamada real.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = 'c'.repeat(64); // 32 bytes hex (só teste)
process.env.ASAAS_API_KEY = 'mother-key-test';
delete process.env.ASAAS_ENV;

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, baasCrypto, svc;
const realFetch = global.fetch;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  baasCrypto = require('../../src/services/dojoBaasCrypto');
  svc = require('../../src/services/recebeCobrancaService');
});
afterAll(() => { global.fetch = realFetch; });

const SECRET = 'aura-test-secret-2026';
const WALLET = 'carteira-aura-de-teste';
const SUB_KEY = '$aact_CHAVE_DA_SUBCONTA_DE_TESTE_999';
const companyA = 'a0000000-0000-4000-8000-00000000000a';
const staff = 'e0000000-0000-4000-8000-0000000000f1';
const naoStaff = 'e0000000-0000-4000-8000-0000000000f2';
const pedido = 'd0000000-0000-4000-8000-0000000000d1';
const CPF = '12345678909';

let accounts; // company_baas_accounts por company_id
let users;    // users.is_staff por id
let asaas;    // estado da Asaas simulada
let calls;

function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (/SELECT is_staff FROM users/.test(s)) {
    const u = users[params[0]];
    return Promise.resolve({ rows: u ? [{ is_staff: u.is_staff }] : [] });
  }
  if (/FROM company_baas_accounts/.test(s)) {
    const row = accounts[params[0]];
    return Promise.resolve({ rows: row ? [{ ...row }] : [] });
  }
  return Promise.resolve({ rows: [] });
}

const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });

function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v3/, '');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, key: opts.headers && opts.headers.access_token });
  if (method === 'GET' && path === '/payments') {
    return Promise.resolve(resp(200, { data: asaas.payments.filter((p) => p.externalReference === u.searchParams.get('externalReference')) }));
  }
  if (method === 'GET' && path === '/customers') {
    return Promise.resolve(resp(200, { data: asaas.customers.filter((c) => c.cpfCnpj === u.searchParams.get('cpfCnpj')) }));
  }
  if (method === 'POST' && path === '/customers') {
    const c = { id: `cus_${asaas.customers.length + 1}`, ...body };
    asaas.customers.push(c);
    return Promise.resolve(resp(200, c));
  }
  if (method === 'POST' && path === '/payments') {
    if (asaas.failPayment) return Promise.resolve(resp(asaas.failPayment, { errors: [{ description: 'Valor inválido para a forma de pagamento.' }] }));
    const p = { id: `pay_${asaas.payments.length + 1}`, status: 'PENDING', invoiceUrl: 'https://sandbox.example/i/1', ...body };
    asaas.payments.push(p);
    return Promise.resolve(resp(200, p));
  }
  if (method === 'GET' && /\/payments\/[^/]+\/pixQrCode$/.test(path)) {
    if (asaas.failQr) return Promise.resolve(resp(500, {}));
    return Promise.resolve(resp(200, { payload: '00020126-pix-copia-e-cola', encodedImage: 'iVBOR', expirationDate: '2026-11-14 23:59:59' }));
  }
  return Promise.resolve(resp(404, { errors: [{ description: 'rota não simulada' }] }));
}

function contaAprovada(cid, extra = {}) {
  accounts[cid] = { status: 'approved', api_key_enc: baasCrypto.encrypt(SUB_KEY), ...extra };
}

const input = (extra = {}) => ({
  billing_type: 'PIX', value: 100, due_date: '2026-11-20',
  origin: { type: 'pedido', id: pedido },
  customer: { name: 'Comprador Teste', cpf_cnpj: '123.456.789-09', email: 'comprador@exemplo.com' },
  ...extra,
});

const auth = (userId, claims = {}) => ({
  Authorization: `Bearer ${jwt.sign({ id: userId, email: `${userId}@loja.com.br`, type: 'access', ...claims }, SECRET, { expiresIn: '1h' })}`,
});
const URL_TESTE = '/api/v1/admin/recebe/cobranca-teste';

let logSpies;
beforeEach(() => {
  accounts = {};
  users = { [staff]: { is_staff: true }, [naoStaff]: { is_staff: false } };
  asaas = { payments: [], customers: [], failPayment: 0, failQr: false };
  calls = [];
  db.query.mockReset();
  db.query.mockImplementation(fakeQuery);
  global.fetch = jest.fn(fakeFetch);
  process.env.RECEBE_AURA_WALLET_ID = WALLET;
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
});
afterEach(() => {
  delete process.env.RECEBE_NA_AURA_ENABLED;
  delete process.env.RECEBE_AURA_WALLET_ID;
  logSpies.forEach((sp) => sp.mockRestore());
});
const loggedText = () => logSpies.map((sp) => JSON.stringify(sp.mock.calls)).join('\n');
const postPayment = () => calls.find((c) => c.method === 'POST' && c.path === '/payments');

describe('taxa da plataforma (regra única)', () => {
  test.each([
    ['PIX', 100, 2],
    ['PIX', 161, 3.22],
    ['PIX', 10.55, 0.21],
    ['CREDIT_CARD', 200, 1.53],
    ['CREDIT_CARD', 150, 1.03],
    ['CREDIT_CARD', 49.01, 0.01],
    ['CREDIT_CARD', 49, 0],
    ['CREDIT_CARD', 30, 0],
  ])('%s de R$ %s → R$ %s para a Aura', (bt, v, fee) => {
    expect(svc.auraFeeFor(bt, v)).toBe(fee);
  });

  test('menor valor com taxa: cartão R$ 49,01; Pix R$ 0,01', () => {
    expect(svc.minValueFor('CREDIT_CARD')).toBe(49.01);
    expect(svc.minValueFor('PIX')).toBe(0.01);
  });

  test('a regra está numa constante única e congelada', () => {
    expect(svc.AURA_SPLIT_RULES).toEqual({
      PIX: { percent: 2, minusFixed: 0 },
      CREDIT_CARD: { percent: 1.01, minusFixed: 0.49 },
    });
    expect(Object.isFrozen(svc.AURA_SPLIT_RULES)).toBe(true);
    expect(svc.RECEBE_NA_AURA_NAME).toBe('Recebe na Aura');
  });
});

describe('flag desligada', () => {
  test('serviço recusa sem banco nem Asaas', async () => {
    contaAprovada(companyA);
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 404, code: 'RECEBE_INDISPONIVEL' });
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rota de staff → 404, mesmo para a equipe, sem banco', async () => {
    const r = await request(app).post(URL_TESTE).set(auth(staff, { is_staff: true })).send({ company_id: companyA, ...input() });
    expect(r.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rota de staff sem login → 404 (a rota não aparece)', async () => {
    const r = await request(app).post(URL_TESTE).send({ company_id: companyA, ...input() });
    expect(r.status).toBe(404);
  });
});

describe('flag ligada: serviço', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; contaAprovada(companyA); });

  test('Pix: split de 2% para a carteira da Aura, notificação desligada, referência da origem', async () => {
    const out = await svc.createCharge(companyA, input());
    expect(out).toMatchObject({
      reused: false, payment_id: 'pay_1', status: 'PENDING', billing_type: 'PIX', value: 100, aura_fee: 2,
      external_reference: `recebe:pedido:${pedido}`, product_name: 'Recebe na Aura',
      pix: { payload: '00020126-pix-copia-e-cola', encoded_image: 'iVBOR' },
    });
    const cust = calls.find((c) => c.method === 'POST' && c.path === '/customers');
    expect(cust.body).toMatchObject({ name: 'Comprador Teste', cpfCnpj: CPF, notificationDisabled: true });
    const pay = postPayment();
    expect(pay.body).toMatchObject({
      customer: 'cus_1', billingType: 'PIX', value: 100, dueDate: '2026-11-20',
      externalReference: `recebe:pedido:${pedido}`,
      split: [{ walletId: WALLET, fixedValue: 2, description: 'Taxa da plataforma Recebe na Aura', externalReference: `recebe:pedido:${pedido}` }],
    });
    expect(pay.body.split[0]).not.toHaveProperty('percentualValue');
  });

  test('cartão: 1,01% menos R$ 0,49, sem buscar QR', async () => {
    const out = await svc.createCharge(companyA, input({ billing_type: 'CREDIT_CARD', value: 200 }));
    expect(out.aura_fee).toBe(1.53);
    expect(out.pix).toBeNull();
    expect(postPayment().body.split).toEqual([expect.objectContaining({ walletId: WALLET, fixedValue: 1.53 })]);
    expect(calls.some((c) => /pixQrCode/.test(c.path))).toBe(false);
  });

  test('cartão abaixo do mínimo: recusa gentil, sem Asaas (nunca cobra sem split)', async () => {
    await expect(svc.createCharge(companyA, input({ billing_type: 'CREDIT_CARD', value: 30 })))
      .rejects.toMatchObject({ status: 422, code: 'RECEBE_VALOR_ABAIXO_DO_MINIMO', message: expect.stringContaining('R$ 49,01') });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('todas as chamadas usam a chave DA SUBCONTA; a chave e o CPF nunca vão ao log', async () => {
    asaas.failPayment = 400;
    await expect(svc.createCharge(companyA, input())).rejects.toBeTruthy();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.key).toBe(SUB_KEY);
    const txt = loggedText();
    expect(txt).not.toContain(SUB_KEY);
    expect(txt).not.toContain(CPF);
    expect(txt).not.toContain('mother-key-test');
  });

  test('sem a carteira da Aura configurada: 503, nenhuma chamada à Asaas', async () => {
    delete process.env.RECEBE_AURA_WALLET_ID;
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 503, code: 'RECEBE_SPLIT_NAO_CONFIGURADO' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each(['creating', 'created', 'docs_pending', 'under_review', 'rejected'])(
    'subconta %s: recusa gentil (409), sem Asaas', async (status) => {
      contaAprovada(companyA, { status });
      await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({
        status: 409, code: 'RECEBE_CONTA_NAO_APROVADA', message: expect.stringContaining('em análise'),
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

  test('sem subconta: 404; sem chave guardada: 409 em conferência', async () => {
    delete accounts[companyA];
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 404, code: 'RECEBE_SEM_SUBCONTA' });
    contaAprovada(companyA, { api_key_enc: null });
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 409, code: 'RECEBE_EM_CONFERENCIA' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Asaas recusa (4xx) → 422 com a mensagem dela; Asaas fora (5xx) → 502', async () => {
    asaas.failPayment = 400;
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({
      status: 422, code: 'RECEBE_COBRANCA_RECUSADA', message: expect.stringContaining('Valor inválido'),
    });
    asaas.failPayment = 503;
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 502, code: 'RECEBE_ASAAS_INDISPONIVEL' });
  });

  test('Asaas sem resposta na criação: 502; nova tentativa reaproveita a cobrança se ela nasceu', async () => {
    global.fetch = jest.fn((url, opts) => {
      if (opts && opts.method === 'POST' && /\/payments$/.test(new URL(url).pathname)) {
        fakeFetch(url, opts); // a Asaas criou...
        return Promise.reject(new Error('socket hang up')); // ...mas a resposta se perdeu
      }
      return fakeFetch(url, opts);
    });
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 502 });
    global.fetch = jest.fn(fakeFetch);
    const out = await svc.createCharge(companyA, input());
    expect(out).toMatchObject({ reused: true, payment_id: 'pay_1' });
    expect(asaas.payments).toHaveLength(1);
  });

  test('mesma origem pendente: devolve a mesma cobrança, não cria outra', async () => {
    await svc.createCharge(companyA, input());
    calls = [];
    const out = await svc.createCharge(companyA, input());
    expect(out).toMatchObject({ reused: true, payment_id: 'pay_1' });
    expect(postPayment()).toBeUndefined();
    expect(asaas.payments).toHaveLength(1);
  });

  test('mesma origem já paga: 409, nada criado', async () => {
    asaas.payments.push({ id: 'pay_9', status: 'RECEIVED', billingType: 'PIX', value: 100, externalReference: `recebe:pedido:${pedido}` });
    await expect(svc.createCharge(companyA, input())).rejects.toMatchObject({ status: 409, code: 'RECEBE_ORIGEM_JA_PAGA' });
    expect(postPayment()).toBeUndefined();
  });

  test('cliente já existente com notificação desligada é reaproveitado; com notificação ligada, cria outro', async () => {
    asaas.customers.push({ id: 'cus_avisa', cpfCnpj: CPF, notificationDisabled: false });
    await svc.createCharge(companyA, input());
    expect(postPayment().body.customer).toBe('cus_2');
    expect(asaas.customers[1]).toMatchObject({ notificationDisabled: true });
    expect(asaas.customers[0].notificationDisabled).toBe(false); // nunca altera cliente

    calls = [];
    await svc.createCharge(companyA, input({ origin: { type: 'venda', id: 'd0000000-0000-4000-8000-0000000000d2' } }));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/customers')).toBe(false);
    expect(postPayment().body).toMatchObject({ customer: 'cus_2', externalReference: 'recebe:venda:d0000000-0000-4000-8000-0000000000d2' });
  });

  test('QR do Pix indisponível: a cobrança volta assim mesmo, com pix null', async () => {
    asaas.failQr = true;
    const out = await svc.createCharge(companyA, input());
    expect(out).toMatchObject({ payment_id: 'pay_1', pix: null });
  });

  test.each([
    [{ billing_type: 'BOLETO' }, 'billing_type'],
    [{ value: 0 }, 'value'],
    [{ value: 10.555 }, '2 casas'],
    [{ due_date: '20/11/2026' }, 'due_date'],
    [{ origin: { type: 'teste', id: pedido } }, 'origin.type'],
    [{ origin: { type: 'pedido', id: '123' } }, 'origin.id'],
    [{ customer: { name: '', cpf_cnpj: CPF } }, 'customer.name'],
    [{ customer: { name: 'X', cpf_cnpj: '123' } }, 'customer.cpf_cnpj'],
  ])('entrada inválida %j → 422 (%s), sem Asaas', async (extra, msg) => {
    await expect(svc.createCharge(companyA, input(extra))).rejects.toMatchObject({
      status: 422, code: 'VALIDATION_ERROR', message: expect.stringContaining(msg),
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('flag ligada: rota de staff', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; contaAprovada(companyA); });

  const body = () => ({ company_id: companyA, billing_type: 'PIX', value: 10, customer: { name: 'Teste QA', cpf_cnpj: CPF } });

  test('staff (is_staff no banco) cria a cobrança de teste com origem teste', async () => {
    const r = await request(app).post(URL_TESTE).set(auth(staff)).send(body());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ aura_fee: 0.2, billing_type: 'PIX' });
    expect(r.body.external_reference).toMatch(/^recebe:teste:[0-9a-f-]{36}$/);
    expect(postPayment().body.split[0]).toMatchObject({ walletId: WALLET, fixedValue: 0.2 });
    expect(r.body).not.toHaveProperty('api_key');
    expect(JSON.stringify(r.body)).not.toContain(SUB_KEY);
  });

  test('JWT dizendo is_staff e e-mail da Aura NÃO bastam: vale o banco → 404', async () => {
    const r = await request(app).post(URL_TESTE)
      .set(auth(naoStaff, { is_staff: true, email: 'alguem@getaura.com.br' })).send(body());
    expect(r.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('usuário que não existe no banco → 404', async () => {
    const r = await request(app).post(URL_TESTE).set(auth('e0000000-0000-4000-8000-0000000000ff')).send(body());
    expect(r.status).toBe(404);
  });

  test('sem login → 401', async () => {
    const r = await request(app).post(URL_TESTE).send(body());
    expect(r.status).toBe(401);
  });

  test('subconta não aprovada → 409 gentil pela rota', async () => {
    contaAprovada(companyA, { status: 'under_review' });
    const r = await request(app).post(URL_TESTE).set(auth(staff)).send(body());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RECEBE_CONTA_NAO_APROVADA');
  });
});
