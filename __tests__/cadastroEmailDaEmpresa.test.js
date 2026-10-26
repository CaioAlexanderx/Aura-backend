// ============================================================
// Cadastro grava o e-mail do dono em companies.email (tq-41, 26/10/2026)
//
// Medido em 19/10: 2 de 3 cadastros desde 28/09 ficavam sem
// companies.email — o INSERT do cadastro nao gravava a coluna. Agora a
// empresa nova nasce com o e-mail do dono (o mesmo de users.email, ja
// normalizado). Vale para o cadastro com CNPJ e com CPF. Convite (sem
// empresa) e entrada numa empresa existente pelo CNPJ nao criam empresa
// e seguem sem INSERT. Contas antigas nao sao preenchidas aqui.
// Banco falso por SQL (tests/helpers/fakeSegmentDb.js).
// ============================================================
jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});

const request = require('supertest');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

const CNPJ_OK = '11222333000181';
const CPF_OK = '52998224725';

let app, db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

function body(extra) {
  return {
    name: 'Ana', email: 'Ana@Loja.COM', password: 'senha1234',
    company_name: 'Loja da Ana', phone: '11999990000',
    terms_accepted: true, self_serve: true,
    ...(extra || {}),
  };
}

// fakeSegmentDb + o UPDATE do CPF do cadastro sem CNPJ.
function fakeComCpf() {
  const fake = fakeSegmentDb();
  const base = fake.client.query;
  fake.client.query = jest.fn(async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : '';
    if (/FROM companies WHERE cpf = \$1/.test(text)) return { rows: [] };
    if (/UPDATE companies SET cpf = \$2 WHERE id = \$1/.test(text)) return { rows: [] };
    return base(sql, params);
  });
  return fake;
}

/** O valor gravado em companies.email, lido pelo nome da coluna no INSERT. */
function emailGravado(fake) {
  const ins = fake.calls.find((c) => /INSERT INTO companies/.test(c.text));
  if (!ins) return undefined;
  const colunas = ins.text.match(/INSERT INTO companies\s*\(([^)]*)\)/)[1].split(',').map((s) => s.trim());
  const valores = ins.text.match(/VALUES\s*\(([\s\S]*?)\)\s*RETURNING/)[1]
    .split(/,(?![^(]*\))/).map((s) => s.trim());
  const valor = valores[colunas.indexOf('email')];
  if (valor === undefined) return undefined;
  const m = valor.match(/^\$(\d+)$/);
  return m ? ins.params[Number(m[1]) - 1] : valor;
}

describe('POST /auth/register — companies.email', () => {
  test('cadastro com CNPJ: a empresa nasce com o e-mail do dono, normalizado como o do usuario', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK }));
    expect(res.status).toBe(201);
    const user = fake.calls.find((c) => /INSERT INTO users/.test(c.text));
    expect(user.params[1]).toBe('ana@loja.com');
    expect(emailGravado(fake)).toBe('ana@loja.com');
  });

  test('cadastro com CPF (sem CNPJ): tambem grava o e-mail do dono', async () => {
    const fake = fakeComCpf();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cpf: CPF_OK }));
    expect(res.status).toBe(201);
    expect(emailGravado(fake)).toBe('ana@loja.com');
  });

  test('convite (sem nome de loja): nao cria empresa', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ company_name: undefined }));
    expect(res.status).toBe(201);
    expect(fake.writesTo(/INSERT INTO companies/)).toHaveLength(0);
  });

  test('CNPJ ja cadastrado: entra como vendedor e nao mexe no e-mail da empresa existente', async () => {
    const fake = fakeSegmentDb({ existingCnpj: { id: 'c-existente', plan: 'negocio', legal_name: 'Loja X' } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ cnpj: CNPJ_OK }));
    expect(res.status).toBe(201);
    expect(fake.writesTo(/INSERT INTO companies/)).toHaveLength(0);
    expect(fake.writesTo(/UPDATE companies SET[^;]*\bemail\b/)).toHaveLength(0);
  });
});
