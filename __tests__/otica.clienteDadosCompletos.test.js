// ============================================================
// AURA ÓTICA — Cadastro completo do cliente (p-204, 23/11/2026)
//
// O que este arquivo trava:
//   1. regras de rg / gender / occupation (vazio apaga, limite, gender fechado)
//   2. POST valida o CPF como o PATCH (400 field cpf_cnpj; grava só dígitos)
//      e grava rg/gender/occupation
//   3. PATCH aceita os três; gender fora da lista -> 400 field gender; chave
//      ausente não mexe
//   4. sem a migration 463: occupation cai em ignored_fields, o resto grava,
//      e customer_fields deixa de anunciar occupation
//   5. a LISTA (per-company e /me) devolve CPF e RG mascarados, com
//      customer_fields no topo; o GET /:cid devolve inteiro (owner-scope)
//   6. GET /:cid deixa /ranking, /birthdays e /retention passarem
//   7. Sentry mascara rg e a receita (od_*/oe_*)
//   8. a migration 463 é só aditiva
//
// Banco mockado (tests/jest.setup.js), inspecionando o SQL por regex.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.user || { id: 'u1', plan: 'negocio' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));
jest.mock('../src/services/matconProfessionals', () => ({
  attachProfessionalsToCustomers: jest.fn(async () => {}),
}));

const db = require('../src/config/database');
const customersRouter = require('../src/routes/customers');
const {
  parseDadosCompletos, mascararDocumento, customerFieldsAceitos, ocupacao,
} = require('../src/services/customerDadosCompletos');
const { maskSensitive } = require('../src/middleware/sentryContext');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CUST = '33333333-3333-4333-8333-333333333333';
const CPF_OK = '52998224725';

const app = express();
app.use(express.json());
app.use('/companies/:id/customers', (req, res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
app.use('/companies/:id/customers', customersRouter);
// Depois do customers.js, como em private.js: crm/retention no mesmo prefixo.
app.get('/companies/:id/customers/birthdays', (req, res) => res.json({ rota: 'crm' }));

function pgError(code, msg) {
  const e = new Error(msg || `pg ${code}`);
  e.code = code;
  return e;
}
const ownerScope = (sql) => /owner_id = \(SELECT owner_id FROM companies WHERE id = \$1\)/.test(sql);

function linha(over) {
  return {
    id: CUST, company_id: CO_B, name: 'Maria Souza', phone: '11988881234',
    email: null, cpf_cnpj: CPF_OK, birth_date: null, instagram_handle: null, notes: null,
    total_purchases: 0, total_spent: 0, last_purchase_at: null, first_purchase_at: null,
    is_active: true, created_at: new Date('2026-11-01T12:00:00Z'),
    company_trade: 'Loja B', company_legal: null, credit_balance: 0,
    zip_code: null, street: null, number: null, complement: null, neighborhood: null,
    city: null, state: null, address_reference: null,
    rg: '12.345.678-9', gender: 'F', occupation: 'Professora',
    ...over,
  };
}

function mockInsert(captura, { semOcupacao = false } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
    if (/SELECT COUNT\(\*\) AS total FROM customers/.test(sql)) return { rows: [{ total: '3' }] };
    if (/INSERT INTO customers/.test(sql)) {
      if (semOcupacao && /occupation/.test(sql)) throw pgError('42703', 'column "occupation" of relation "customers" does not exist');
      captura.push({ sql, params });
      const m = /INSERT INTO customers \(([^)]+)\)/.exec(sql);
      const row = {};
      m[1].split(',').map(c => c.trim()).forEach((c, i) => { row[c] = params[i]; });
      return { rows: [{ id: CUST, ...row }] };
    }
    throw new Error('inesperada: ' + sql);
  });
}

function mockUpdate(captura, { semOcupacao = false } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
    if (/UPDATE customers SET/.test(sql)) {
      if (semOcupacao && /occupation/.test(sql)) throw pgError('42703', 'column "occupation" of relation "customers" does not exist');
      captura.push({ sql, params });
      return { rows: [{ id: CUST, name: 'Maria Souza' }] };
    }
    throw new Error('inesperada: ' + sql);
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  customersRouter._resetProfileColumnsCache();
});

// ── 1. regras ──────────────────────────────────────────────
describe('parseDadosCompletos', () => {
  it('só as chaves presentes; texto aparado', () => {
    expect(parseDadosCompletos({ name: 'X' })).toEqual({ ok: true, values: {} });
    expect(parseDadosCompletos({ rg: ' 12.345.678-9 ', gender: 'F', occupation: '  Professora ' }))
      .toEqual({ ok: true, values: { rg: '12.345.678-9', gender: 'F', occupation: 'Professora' } });
  });

  it('vazio ou null apaga', () => {
    expect(parseDadosCompletos({ rg: '', gender: null, occupation: '   ' }).values)
      .toEqual({ rg: null, gender: null, occupation: null });
  });

  it.each([['X'], ['f'], ['masculino'], [1]])('gender %p recusado', (g) => {
    expect(parseDadosCompletos({ gender: g })).toMatchObject({ ok: false, field: 'gender' });
  });

  it('limites: rg 20, occupation 80', () => {
    expect(parseDadosCompletos({ rg: 'x'.repeat(20) }).ok).toBe(true);
    expect(parseDadosCompletos({ rg: 'x'.repeat(21) })).toMatchObject({ ok: false, field: 'rg' });
    expect(parseDadosCompletos({ occupation: 'x'.repeat(80) }).ok).toBe(true);
    expect(parseDadosCompletos({ occupation: 'x'.repeat(81) })).toMatchObject({ ok: false, field: 'occupation' });
    expect(parseDadosCompletos({ rg: 123 })).toMatchObject({ ok: false, field: 'rg' });
  });

  it('mascararDocumento', () => {
    expect(mascararDocumento('52998224725')).toBe('***.***.247-25');
    expect(mascararDocumento('529.982.247-25')).toBe('***.***.247-25');
    expect(mascararDocumento('11222333000181')).toBe('**.***.***/0001-81');
    expect(mascararDocumento('12.345.678-9')).toBe('***8-9');
    expect(mascararDocumento('123')).toBe('***');
    expect(mascararDocumento('')).toBe('');
    expect(mascararDocumento(null)).toBe('');
  });
});

// ── 2. POST ────────────────────────────────────────────────
describe('POST / — CPF validado e cadastro completo', () => {
  it('CPF inválido -> 400 field cpf_cnpj, nada gravado', async () => {
    const cap = [];
    mockInsert(cap);
    const r = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'Maria', cpf_cnpj: '52998224700' });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('cpf_cnpj');
    expect(cap).toHaveLength(0);
  });

  it('CPF com máscara grava só dígitos; vazio grava null', async () => {
    const cap = [];
    mockInsert(cap);
    let r = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'Maria', cpf_cnpj: '529.982.247-25' });
    expect(r.status).toBe(201);
    expect(r.body.cpf_cnpj).toBe(CPF_OK);
    r = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'João', cpf_cnpj: '' });
    expect(r.status).toBe(201);
    expect(r.body.cpf_cnpj).toBeNull();
  });

  it('grava rg, gender e occupation', async () => {
    const cap = [];
    mockInsert(cap);
    const r = await request(app).post(`/companies/${CO_A}/customers`)
      .send({ name: 'Maria', rg: '12.345.678-9', gender: 'F', occupation: 'Professora' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ rg: '12.345.678-9', gender: 'F', occupation: 'Professora' });
    expect(r.body.ignored_fields).toBeUndefined();
  });

  it('gender inválido -> 400 field gender', async () => {
    mockInsert([]);
    const r = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'Maria', gender: 'X' });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('gender');
  });

  it('sem a 463: occupation em ignored_fields e o resto grava', async () => {
    const cap = [];
    mockInsert(cap, { semOcupacao: true });
    const r = await request(app).post(`/companies/${CO_A}/customers`)
      .send({ name: 'Maria', rg: '1234', occupation: 'Professora' });
    expect(r.status).toBe(201);
    expect(r.body.ignored_fields).toEqual(['occupation']);
    expect(r.body.rg).toBe('1234');
    expect(cap[0].sql).not.toMatch(/occupation/);
    expect(customerFieldsAceitos()).toEqual(['rg', 'gender']);
  });

  it('body sem os campos novos: INSERT igual ao de antes (sem rg/gender/occupation)', async () => {
    const cap = [];
    mockInsert(cap);
    await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'Maria' });
    expect(cap[0].sql).not.toMatch(/\brg\b|gender|occupation/);
  });
});

// ── 3. PATCH ───────────────────────────────────────────────
describe('PATCH /:cid — cadastro completo', () => {
  it('aceita os três, owner-scope', async () => {
    const cap = [];
    mockUpdate(cap);
    const r = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`)
      .send({ rg: '1234', gender: 'outro', occupation: 'Pedreiro' });
    expect(r.status).toBe(200);
    expect(cap[0].sql).toMatch(/rg = \$1, occupation = \$2, gender = \$3/);
    expect(cap[0].sql).toMatch(/company_id = ANY/);
    expect(cap[0].params.slice(0, 3)).toEqual(['1234', 'Pedreiro', 'outro']);
  });

  it('gender X -> 400 field gender', async () => {
    mockUpdate([]);
    const r = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`).send({ gender: 'X' });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('gender');
  });

  it('vazio apaga; chave ausente não mexe', async () => {
    const cap = [];
    mockUpdate(cap);
    await request(app).patch(`/companies/${CO_A}/customers/${CUST}`).send({ name: 'Maria', gender: '' });
    expect(cap[0].sql).toMatch(/gender = \$2/);
    expect(cap[0].params[1]).toBeNull();
    expect(cap[0].sql).not.toMatch(/\brg\b|occupation/);
  });

  it('sem a 463: occupation em ignored_fields e o resto grava', async () => {
    const cap = [];
    mockUpdate(cap, { semOcupacao: true });
    const r = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`)
      .send({ rg: '1234', occupation: 'Pedreiro' });
    expect(r.status).toBe(200);
    expect(r.body.ignored_fields).toEqual(['occupation']);
    expect(cap).toHaveLength(1);
    expect(cap[0].sql).not.toMatch(/occupation/);
  });
});

// ── 4/5. GET lista e ficha ─────────────────────────────────
describe('GET / — lista mascarada + customer_fields', () => {
  function mockLista({ semOcupacao = false } = {}) {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (/SELECT COUNT\(\*\) AS total FROM customers/.test(sql)) return { rows: [{ total: '1' }] };
      if (/FROM customers c/.test(sql)) {
        if (semOcupacao && /c\.occupation/.test(sql)) throw pgError('42703', 'column c.occupation does not exist');
        return { rows: [linha(semOcupacao ? { occupation: null } : {})] };
      }
      throw new Error('inesperada: ' + sql);
    });
  }

  it('CPF e RG mascarados, sexo e profissão inteiros, aviso no topo', async () => {
    mockLista();
    const r = await request(app).get(`/companies/${CO_A}/customers`);
    expect(r.status).toBe(200);
    const c = r.body.customers[0];
    expect(c.cpf_cnpj).toBe('***.***.247-25');
    expect(c.rg).toBe('***8-9');
    expect(c).toMatchObject({ gender: 'F', occupation: 'Professora', docs_masked: true });
    expect(JSON.stringify(r.body)).not.toContain(CPF_OK);
    expect(r.body.customer_fields).toEqual(['rg', 'gender', 'occupation']);
  });

  it('sem a 463: lista segue e o aviso não traz occupation', async () => {
    mockLista({ semOcupacao: true });
    const r = await request(app).get(`/companies/${CO_A}/customers`);
    expect(r.status).toBe(200);
    expect(r.body.customers).toHaveLength(1);
    expect(r.body.customer_fields).toEqual(['rg', 'gender']);
  });
});

describe('GET /:cid — ficha com documento inteiro', () => {
  it('cliente de outra loja do mesmo dono abre com CPF e RG inteiros', async () => {
    const vistos = [];
    db.query.mockImplementation(async (sql, params) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (/FROM customers c/.test(sql)) {
        vistos.push({ sql, params });
        return { rows: [linha()] };
      }
      throw new Error('inesperada: ' + sql);
    });
    const r = await request(app).get(`/companies/${CO_A}/customers/${CUST}`);
    expect(r.status).toBe(200);
    expect(r.body.customer).toMatchObject({
      id: CUST, cpf_cnpj: CPF_OK, rg: '12.345.678-9', gender: 'F', occupation: 'Professora',
      docs_masked: false, company_id: CO_B, company_name: 'Loja B',
    });
    expect(r.body.customer_fields).toEqual(['rg', 'gender', 'occupation']);
    expect(vistos[0].sql).toMatch(/c\.company_id = ANY\(\$2\)/);
    expect(vistos[0].params).toEqual([CUST, [CO_A, CO_B]]);
  });

  it('fora do dono -> 404', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/FROM customers c/.test(sql)) return { rows: [] };
      throw new Error('inesperada: ' + sql);
    });
    const r = await request(app).get(`/companies/${CO_A}/customers/${CUST}`);
    expect(r.status).toBe(404);
  });

  it('/birthdays (não uuid) segue para o router seguinte', async () => {
    const r = await request(app).get(`/companies/${CO_A}/customers/birthdays`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ rota: 'crm' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('GET /me/customers — mesmo contrato', () => {
  it('mascara e anuncia customer_fields', async () => {
    const meRouter = require('../src/routes/meAggregates');
    const meApp = express();
    meApp.use((req, res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
    meApp.use('/me', meRouter);
    db.query.mockImplementation(async (sql) => {
      if (/FROM companies/.test(sql) && !/FROM customers/.test(sql)) {
        return { rows: [{ id: CO_A, trade_name: 'Loja A', legal_name: null }] };
      }
      if (/SELECT COUNT\(\*\) AS total FROM customers/.test(sql)) return { rows: [{ total: '1' }] };
      if (/FROM customers/.test(sql)) return { rows: [linha({ company_id: CO_A })] };
      return { rows: [] };
    });
    const r = await request(meApp).get('/me/customers');
    if (r.status !== 200) throw new Error(`status ${r.status}: ${JSON.stringify(r.body)}`);
    const c = r.body.customers[0];
    expect(c.cpf_cnpj).toBe('***.***.247-25');
    expect(c.rg).toBe('***8-9');
    expect(c).toMatchObject({ gender: 'F', occupation: 'Professora', docs_masked: true });
    expect(r.body.customer_fields).toEqual(['rg', 'gender', 'occupation']);
  });
});

// ── 7. Sentry ──────────────────────────────────────────────
describe('Sentry: rg e receita mascarados', () => {
  it('rg exato, od_/oe_ por prefixo; charge/target intactos', () => {
    expect(maskSensitive({
      rg: '1234', cpf_cnpj: CPF_OK, od_sph: -1.5, oe_axis: 90, charge: 'x', target: 'y', name: 'Maria',
    })).toEqual({
      rg: '***', cpf_cnpj: '***', od_sph: '***', oe_axis: '***', charge: 'x', target: 'y', name: 'Maria',
    });
  });
});

// ── 8. migration ───────────────────────────────────────────
describe('migration 463', () => {
  it('só ADD COLUMN IF NOT EXISTS', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '463_customers_occupation.sql'), 'utf8')
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/ALTER TABLE customers ADD COLUMN IF NOT EXISTS occupation TEXT;/);
    expect(sql).not.toMatch(/DROP|ALTER COLUMN|UPDATE|DELETE/i);
  });
});

afterAll(() => { ocupacao.reset(); });
