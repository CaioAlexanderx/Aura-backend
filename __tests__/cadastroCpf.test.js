// ============================================================
// Conta sem CNPJ, com CPF (20/10/2026)
//
// Decisao do Caio: "vamos liberar para os clientes que sinalizarem que nao
// tem CNPJ". Trava:
//   - POST /auth/register com cpf (sem cnpj): valida os digitos, exige o
//     nome da loja, recusa CPF de outra conta (409 CPF_ALREADY_REGISTERED,
//     mesmo padrao do CNPJ), grava em companies.cpf e NAO grava regime
//     vindo do corpo; a conta nasce sem frente (cai na pergunta do check-in)
//   - com cnpj o fluxo e o de sempre: nenhuma query de CPF, mesmo INSERT
//   - Asaas: o cpfCnpj do cliente usa o CPF quando nao ha CNPJ
//   - NFC-e/NF-e: conta sem CNPJ recebe 400 CNPJ_REQUIRED com a explicacao
// Banco falso por SQL (tests/helpers/fakeSegmentDb.js), nunca fila posicional.
// ============================================================
jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});
jest.mock('../src/services/asaasClient', () => ({
  ...jest.requireActual('../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');
const documentoEmpresa = require('../src/services/documentoEmpresa');

const CPF_OK = '52998224725';
const CPF_MASCARADO = '529.982.247-25';
const CPF_DIGITO_ERRADO = '52998224726';
const CNPJ_OK = '11222333000181';

let app, db, asaasClient;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
  asaasClient = require('../src/services/asaasClient');
});
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

function body(extra) {
  return {
    name: 'Ana', email: 'ana@loja.com', password: 'senha1234',
    company_name: 'Loja da Ana', phone: '11999990000',
    terms_accepted: true, self_serve: true,
    ...(extra || {}),
  };
}

// fakeSegmentDb + o que o cadastro com CPF consulta/grava.
function fakeComCpf({ cpfEmUso = false } = {}) {
  const fake = fakeSegmentDb();
  const base = fake.client.query;
  fake.client.query = jest.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : '';
    if (/FROM companies WHERE cpf = \$1/.test(text)) {
      fake.calls.push({ text, params });
      return { rows: cpfEmUso ? [{ id: 'c-outra' }] : [] };
    }
    if (/UPDATE companies SET cpf = \$2 WHERE id = \$1/.test(text)) {
      fake.calls.push({ text, params });
      const c = fake.state.companies[params[0]];
      if (c) c.cpf = params[1];
      return { rows: [] };
    }
    return base(sql, params);
  });
  return fake;
}
const newCompany = (fake) => Object.values(fake.state.companies).find((c) => c.id.startsWith('c-novo'));
const insertCompanies = (fake) => fake.calls.find((c) => /INSERT INTO companies/.test(c.text));

describe('validateCPF', () => {
  test('aceita CPF valido, com ou sem mascara', () => {
    expect(documentoEmpresa.validateCPF(CPF_OK)).toBe(true);
    expect(documentoEmpresa.validateCPF(CPF_MASCARADO)).toBe(true);
  });
  test('recusa digito errado, repetidos e tamanho errado', () => {
    expect(documentoEmpresa.validateCPF(CPF_DIGITO_ERRADO)).toBe(false);
    expect(documentoEmpresa.validateCPF('11111111111')).toBe(false);
    expect(documentoEmpresa.validateCPF('5299822472')).toBe(false);
    expect(documentoEmpresa.validateCPF('')).toBe(false);
  });
});

describe('POST /auth/register — conta com CPF', () => {
  test('CPF valido: 201, grava companies.cpf, nao grava cnpj nem regime do corpo, sem frente', async () => {
    const fake = fakeComCpf();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register')
      .send(body({ cpf: CPF_MASCARADO, tax_regime: 'mei' }));
    expect(res.status).toBe(201);

    const c = newCompany(fake);
    expect(c.cpf).toBe(CPF_OK);
    const ins = insertCompanies(fake);
    expect(ins.params[5]).toBeNull();   // cnpj
    expect(ins.params[9]).toBeNull();   // tax_regime: nada inventado
    expect(c.segment).toBeNull();       // sem CNAE -> pergunta do check-in
    expect(res.body.company.segment).toBeNull();
  });

  test('CPF com digito errado: 400 CPF_INVALID, sem abrir transacao', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(body({ cpf: CPF_DIGITO_ERRADO }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CPF_INVALID');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('CPF sem o nome da loja: 400 COMPANY_NAME_REQUIRED', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(body({ cpf: CPF_OK, company_name: '  ' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('COMPANY_NAME_REQUIRED');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('CPF ja usado por outra conta: 409 CPF_ALREADY_REGISTERED, nada gravado', async () => {
    const fake = fakeComCpf({ cpfEmUso: true });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cpf: CPF_OK }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CPF_ALREADY_REGISTERED');
    expect(res.body.error).toMatch(/Ja existe uma conta Aura com este CPF/);
    expect(fake.writesTo(/INSERT INTO users/)).toHaveLength(0);
    expect(fake.writesTo(/INSERT INTO companies/)).toHaveLength(0);
  });
});

describe('POST /auth/register — fluxo com CNPJ intacto', () => {
  test('com cnpj: grava cnpj e regime, nenhuma query de CPF (mesmo com cpf no corpo)', async () => {
    const fake = fakeComCpf();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register')
      .send(body({ cnpj: CNPJ_OK, tax_regime: 'mei', cpf: CPF_OK }));
    expect(res.status).toBe(201);
    const ins = insertCompanies(fake);
    expect(ins.params[5]).toBe(CNPJ_OK);
    expect(ins.params[9]).toBe('mei');
    expect(fake.writesTo(/cpf/i)).toHaveLength(0);
    expect(newCompany(fake).cpf).toBeUndefined();
  });

  test('com cnpj ja cadastrado: continua entrando como vendedor (como antes)', async () => {
    const fake = fakeSegmentDb({ existingCnpj: { id: 'c-existente', plan: 'negocio', legal_name: 'Loja X' } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK }));
    expect(res.status).toBe(201);
    expect(fake.writesTo(/INSERT INTO companies/)).toHaveLength(0);
  });
});

describe('Asaas — cpfCnpj do cliente', () => {
  const { ensureAsaasCustomer, companyHasTaxId, companyTaxId } = require('../src/services/asaasCustomer');
  const user = { full_name: 'Ana', email: 'ana@loja.com' };

  test('conta sem CNPJ usa o CPF do cadastro', async () => {
    asaasClient.asaas.mockResolvedValueOnce({ id: 'cus_1' });
    const company = { id: 'c1', cnpj: null, cpf: CPF_OK, asaas_customer_id: null, legal_name: 'Loja da Ana' };
    expect(companyHasTaxId(company)).toBe(true);
    expect(companyTaxId(company)).toBe(CPF_OK);
    await ensureAsaasCustomer(company, user, {});
    expect(asaasClient.asaas).toHaveBeenCalledWith('POST', '/customers', expect.objectContaining({ cpfCnpj: CPF_OK }));
  });

  test('com CNPJ, o CNPJ continua na frente', async () => {
    asaasClient.asaas.mockResolvedValueOnce({ id: 'cus_2' });
    const company = { id: 'c2', cnpj: CNPJ_OK, cpf: CPF_OK, asaas_customer_id: null, legal_name: 'Loja' };
    expect(companyTaxId(company)).toBe(CNPJ_OK);
    await ensureAsaasCustomer(company, user, {});
    expect(asaasClient.asaas).toHaveBeenCalledWith('POST', '/customers', expect.objectContaining({ cpfCnpj: CNPJ_OK }));
  });

  test('sem CNPJ e sem CPF: segue pedindo o documento (400 stage cpf_cnpj)', async () => {
    const company = { id: 'c3', cnpj: null, cpf: null, asaas_customer_id: null };
    expect(companyHasTaxId(company)).toBe(false);
    await expect(ensureAsaasCustomer(company, user, {})).rejects.toMatchObject({ status: 400, stage: 'cpf_cnpj' });
    expect(asaasClient.asaas).not.toHaveBeenCalled();
  });
});

describe('NFC-e — conta sem CNPJ (rota, sem o middleware de acesso)', () => {
  const express = require('express');
  let appNota;
  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('../src/middleware/auth', () => ({
        requireAuth: (req, res, next) => { req.user = { id: 'u-1', role: 'client' }; next(); },
        requireRole: () => (req, res, next) => next(),
        requireCompanyAccess: () => (req, res, next) => next(),
        requirePlan: () => (req, res, next) => next(),
      }));
      const nfceRouter = require('../src/routes/nfce');
      appNota = express();
      appNota.use(express.json());
      appNota.use('/companies/:id/nfce', nfceRouter);
    });
  });
  const item = { product_name: 'Camiseta', quantity: 1, unit_price: 50 };

  function arrange({ config, cnpj }) {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql).replace(/\s+/g, ' ');
      if (/FROM nfce_config WHERE company_id/.test(s)) return { rows: config ? [config] : [] };
      if (/SELECT cnpj FROM companies WHERE id/.test(s)) return { rows: [{ cnpj }] };
      if (/FROM companies WHERE id/.test(s)) return { rows: [{ id: 'c1', cnpj, ibge_code: '3550308', inscricao_estadual: '123' }] };
      return { rows: [] };
    });
  }

  test('sem configuracao e sem CNPJ: 400 CNPJ_REQUIRED com a explicacao', async () => {
    arrange({ config: null, cnpj: null });
    const res = await request(appNota).post('/companies/c1/nfce/emit').send({ items: [item] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CNPJ_REQUIRED');
    expect(res.body.error).toBe(documentoEmpresa.CNPJ_REQUIRED_MSG);
  });

  test('configurada mas sem CNPJ: 400 CNPJ_REQUIRED', async () => {
    arrange({ config: { is_active: true, provider: 'sefaz_sp' }, cnpj: null });
    const res = await request(appNota).post('/companies/c1/nfce/emit').send({ items: [item] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CNPJ_REQUIRED');
  });

  test('com CNPJ e sem configuracao: a mensagem de sempre', async () => {
    arrange({ config: null, cnpj: CNPJ_OK });
    const res = await request(appNota).post('/companies/c1/nfce/emit').send({ items: [item] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).toMatch(/nao configurada/);
  });
});
