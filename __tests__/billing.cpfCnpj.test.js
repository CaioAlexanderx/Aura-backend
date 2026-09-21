// ============================================================
// AURA. — /billing: CPF/CNPJ de quem paga (21/09/2026)
//
// O Asaas nao gera cobranca para cliente sem CPF/CNPJ. O checkout criava o
// cliente so com company.cnpj — e a maioria das empresas nao tem CNPJ. O
// /subscribe devolvia o erro do Asaas e a tela nao tinha campo para informar
// (no Pix, nenhum). Quase perdemos um cliente.
//
// Trava:
//   - sem documento nenhum → 400 stage='cpf_cnpj' ANTES de tocar no Asaas
//   - cpf_cnpj do checkout vai pro cliente do Asaas (novo: POST; antigo sem
//     documento: PUT)
//   - digito verificador errado nao chega ao Asaas
//   - empresa com CNPJ valido segue exatamente como antes
//   - recusa do proprio Asaas por documento vira 400 tratavel, nao 500
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
db.query = jest.fn();

jest.mock('../src/services/asaasClient', () => ({
  ...jest.requireActual('../src/services/asaasClient'),
  asaas: jest.fn(),
}));
const { asaas } = require('../src/services/asaasClient');

const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const { validateCPF, isValidTaxId } = require('../src/services/asaasCustomer');
const billingRouter = require('../src/routes/billing');

const app = express();
app.use(express.json());
app.use('/companies/:id/billing', billingRouter);

const CID = 'company-sem-cnpj';
const CPF_OK = '52998224725';
const CNPJ_OK = '11222333000181';

const companyRow = (extra = {}) => ({
  id: CID, plan: 'essencial', cnpj: null, asaas_customer_id: null, asaas_subscription_id: null,
  extra_seats_granted: 0, vertical_active: null, trade_name: 'Loja da Ana', ...extra,
});

function arrangeDb(company) {
  db.query.mockImplementation(async (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('AS subscription_discount')) return { rows: [{ ...company, subscription_discount: null }] };
    if (s.includes('SELECT * FROM companies WHERE id')) return { rows: [company] };
    if (s.includes('SELECT * FROM users WHERE id')) return { rows: [{ id: 'user-1', email: 'ana@loja.com', full_name: 'Ana' }] };
    return { rows: [], rowCount: 0 };
  });
}

function arrangeAsaas({ customerOnFile = null, subscriptionError = null } = {}) {
  asaas.mockImplementation(async (method, path) => {
    if (method === 'POST' && path === '/customers') return { id: 'cus_new' };
    if (method === 'GET' && path.startsWith('/customers/')) return { id: 'cus_1', cpfCnpj: customerOnFile };
    if (method === 'PUT' && path.startsWith('/customers/')) return { id: 'cus_1' };
    if (method === 'POST' && path === '/subscriptions') {
      if (subscriptionError) throw new Error(subscriptionError);
      return { id: 'sub_1', nextDueDate: '2026-09-22' };
    }
    if (method === 'GET' && path.startsWith('/subscriptions/sub_1/payments')) return { data: [{ id: 'pay_1' }] };
    if (method === 'GET' && path.endsWith('/pixQrCode')) return { encodedImage: 'img', payload: 'pix-copia', expirationDate: 'x' };
    throw new Error('Asaas inesperado: ' + method + ' ' + path);
  });
}

const asaasCall = (method, path) => asaas.mock.calls.find((c) => c[0] === method && c[1] === path);
const subscribe = (body) => request(app).post(`/companies/${CID}/billing/subscribe`).send(body);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('validacao de CPF/CNPJ', () => {
  it('CPF: digito verificador', () => {
    expect(validateCPF(CPF_OK)).toBe(true);
    expect(validateCPF('529.982.247-25')).toBe(true);
    expect(validateCPF('52998224724')).toBe(false);
    expect(validateCPF('11111111111')).toBe(false);
    expect(validateCPF('')).toBe(false);
  });

  it('isValidTaxId aceita CPF ou CNPJ validos, e so eles', () => {
    expect(isValidTaxId(CPF_OK)).toBe(true);
    expect(isValidTaxId(CNPJ_OK)).toBe(true);
    expect(isValidTaxId('11222333000182')).toBe(false);
    expect(isValidTaxId('123')).toBe(false);
    expect(isValidTaxId(null)).toBe(false);
  });
});

describe('POST /billing/subscribe — Pix em empresa SEM CNPJ', () => {
  it('sem cpf_cnpj: 400 stage=cpf_cnpj e NADA e criado no Asaas', async () => {
    arrangeDb(companyRow());
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(400);
    expect(res.body.stage).toBe('cpf_cnpj');
    expect(res.body.error).toMatch(/CPF ou CNPJ/);
    expect(asaas).not.toHaveBeenCalled();
  });

  it('com CPF valido: cliente nasce no Asaas COM documento e o Pix e gerado', async () => {
    arrangeDb(companyRow());
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly', cpf_cnpj: '529.982.247-25' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/customers')[2].cpfCnpj).toBe(CPF_OK);
    expect(asaasCall('POST', '/subscriptions')[2].customer).toBe('cus_new');
    expect(res.body.pix_copy_paste).toBe('pix-copia');
  });

  it('CPF com digito errado: 400 sem chegar ao Asaas', async () => {
    arrangeDb(companyRow());
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly', cpf_cnpj: '52998224724' });

    expect(res.status).toBe(400);
    expect(res.body.stage).toBe('cpf_cnpj');
    expect(res.body.error).toMatch(/inválido/);
    expect(asaas).not.toHaveBeenCalled();
  });

  it('cliente antigo no Asaas SEM documento: sem cpf_cnpj pede; com cpf_cnpj corrige por PUT', async () => {
    arrangeDb(companyRow({ asaas_customer_id: 'cus_1' }));
    arrangeAsaas({ customerOnFile: null });

    const semDoc = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly' });
    expect(semDoc.status).toBe(400);
    expect(semDoc.body.stage).toBe('cpf_cnpj');
    expect(asaasCall('POST', '/subscriptions')).toBeUndefined();

    const comDoc = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly', cpf_cnpj: CPF_OK });
    expect(comDoc.status).toBe(201);
    expect(asaasCall('PUT', '/customers/cus_1')[2]).toEqual({ cpfCnpj: CPF_OK });
    expect(asaasCall('POST', '/customers')).toBeUndefined();
  });

  it('cliente antigo que JA tem documento no Asaas: nao pede nem reescreve', async () => {
    arrangeDb(companyRow({ asaas_customer_id: 'cus_1' }));
    arrangeAsaas({ customerOnFile: CPF_OK });

    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(201);
    expect(asaas.mock.calls.some((c) => c[0] === 'PUT' && c[1].startsWith('/customers/'))).toBe(false);
  });

  it('recusa do proprio Asaas por documento vira 400 stage=cpf_cnpj, nao 500', async () => {
    arrangeDb(companyRow({ asaas_customer_id: 'cus_1' }));
    arrangeAsaas({ customerOnFile: CPF_OK, subscriptionError: 'Para criar esta cobrança é necessário preencher o CPF ou CNPJ do cliente.' });

    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(400);
    expect(res.body.stage).toBe('cpf_cnpj');
  });
});

describe('quem ja tinha documento segue como antes', () => {
  it('empresa com CNPJ valido: cliente criado com o CNPJ, sem pedir nada', async () => {
    arrangeDb(companyRow({ cnpj: '11.222.333/0001-81' }));
    arrangeAsaas();

    const res = await subscribe({ plan: 'essencial', billing_type: 'PIX', cycle: 'monthly' });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/customers')[2].cpfCnpj).toBe(CNPJ_OK);
  });

  it('cartao em empresa sem CNPJ: o CPF do titular preenche o documento', async () => {
    arrangeDb(companyRow());
    asaas.mockImplementation(async (method, path) => {
      if (method === 'POST' && path === '/customers') return { id: 'cus_new' };
      if (method === 'POST' && path === '/payments') return { id: 'pay_now', status: 'CONFIRMED' };
      if (method === 'POST' && path === '/subscriptions') return { id: 'sub_1', nextDueDate: '2026-10-21' };
      throw new Error('Asaas inesperado: ' + method + ' ' + path);
    });

    const res = await subscribe({
      plan: 'essencial', billing_type: 'CREDIT_CARD', cycle: 'monthly', credit_card_token: 'tok',
      credit_card_holder_name: 'ANA', credit_card_holder_cpf: CPF_OK,
    });

    expect(res.status).toBe(201);
    expect(asaasCall('POST', '/customers')[2].cpfCnpj).toBe(CPF_OK);
  });
});

describe('GET /billing/status — needs_cpf_cnpj', () => {
  it('true sem CNPJ valido; false com CNPJ valido', async () => {
    arrangeDb(companyRow());
    const sem = await request(app).get(`/companies/${CID}/billing/status`);
    expect(sem.status).toBe(200);
    expect(sem.body.needs_cpf_cnpj).toBe(true);

    arrangeDb(companyRow({ cnpj: CNPJ_OK }));
    const com = await request(app).get(`/companies/${CID}/billing/status`);
    expect(com.body.needs_cpf_cnpj).toBe(false);
  });
});
