// ============================================================
// AURA CLIENTES — Endereco do cliente para entrega (09/11/2026, parte 1)
//
// O que este arquivo cobre:
//   1. regras leves do endereco (CEP 8 digitos, UF 2 letras, vazio apaga)
//   2. POST aceita, grava nas colunas canonicas (number, zip_code) e valida
//   3. PATCH aceita, apaga com '' e nao mexe no que nao veio
//   4. cliente de outra loja do mesmo dono: o PATCH alcanca (owner-scope)
//   5. GET devolve o endereco e has_address (selo "sem endereco" do Caixa)
//   6. sem a migration 433, address_reference cai fora e o resto grava
//   7. a entrega da Matcon le `number` (address_number so de reserva)
//   8. a migration 433 e so aditiva
//
// Banco mockado (tests/jest.setup.js), inspecionando o SQL por regex.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const customersRouter = require('../src/routes/customers');
const {
  parseCustomerAddress, hasDeliveryAddress, addressFromRow,
} = require('../src/services/customerAddress');
const { enderecoDoCliente } = require('../src/services/matconSaleHooks');

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CUST = '33333333-3333-4333-8333-333333333333';

const app = express();
app.use(express.json());
app.use('/companies/:id/customers', (req, res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
app.use('/companies/:id/customers', customersRouter);

function pgError(code, msg) {
  const e = new Error(msg || `pg ${code}`);
  e.code = code;
  return e;
}
function ownerScope(sql) {
  return /owner_id = \(SELECT owner_id FROM companies WHERE id = \$1\)/.test(sql);
}
function linha(over) {
  return {
    id: CUST, company_id: CO_B, name: 'Cliente Teste', phone: '(11) 98888-1234',
    email: null, cpf_cnpj: null, birth_date: null, instagram_handle: null, notes: null,
    total_purchases: 0, total_spent: 0, last_purchase_at: null, first_purchase_at: null,
    is_active: true, created_at: new Date('2026-11-01T12:00:00Z'),
    company_trade: 'Loja B', company_legal: null, credit_balance: 0,
    zip_code: null, street: null, number: null, complement: null, neighborhood: null,
    city: null, state: null, address_reference: null,
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  customersRouter._resetProfileColumnsCache();
});

// ── 1. regras ──────────────────────────────────────────────
describe('parseCustomerAddress — validacao leve', () => {
  it('CEP vira so digitos; UF maiuscula; texto aparado', () => {
    const r = parseCustomerAddress({
      zip_code: '01310-100', state: 'sp', street: '  Avenida   Paulista ', number: ' 1000 ',
      city: 'São Paulo', neighborhood: 'Bela Vista', complement: '', address_reference: 'portão azul',
    });
    expect(r).toEqual({
      ok: true,
      values: {
        zip_code: '01310100', state: 'SP', street: 'Avenida Paulista', number: '1000',
        city: 'São Paulo', neighborhood: 'Bela Vista', complement: null, address_reference: 'portão azul',
      },
    });
  });

  it('tudo opcional: body sem endereco nao gera campo nenhum', () => {
    expect(parseCustomerAddress({ name: 'X' })).toEqual({ ok: true, values: {} });
  });

  it('vazio ou null apaga', () => {
    expect(parseCustomerAddress({ zip_code: '', state: null, city: '   ' }).values)
      .toEqual({ zip_code: null, state: null, city: null });
  });

  it.each([['0131010'], ['013101000'], ['abc']])('CEP %s recusado', (cep) => {
    expect(parseCustomerAddress({ zip_code: cep })).toMatchObject({ ok: false, field: 'zip_code' });
  });

  it.each([['S'], ['SPX'], ['S1'], ['São']])('UF %s recusada', (uf) => {
    expect(parseCustomerAddress({ state: uf })).toMatchObject({ ok: false, field: 'state' });
  });

  it('texto longo demais e recusado', () => {
    expect(parseCustomerAddress({ number: 'x'.repeat(21) })).toMatchObject({ ok: false, field: 'number' });
  });

  it('has_address: rua ou CEP + numero + cidade', () => {
    expect(hasDeliveryAddress({ street: 'Rua A', number: '1', city: 'X' })).toBe(true);
    expect(hasDeliveryAddress({ zip_code: '01310100', number: '1', city: 'X' })).toBe(true);
    expect(hasDeliveryAddress({ street: 'Rua A', city: 'X' })).toBe(false);
    expect(hasDeliveryAddress({ street: 'Rua A', number: '1' })).toBe(false);
    expect(hasDeliveryAddress({ number: '1', city: 'X' })).toBe(false);
    // address_number (073) nao conta: o canonico e number.
    expect(hasDeliveryAddress({ street: 'Rua A', address_number: '1', city: 'X' })).toBe(false);
    expect(hasDeliveryAddress(null)).toBe(false);
  });

  it('addressFromRow devolve string vazia, nunca null', () => {
    expect(addressFromRow({ state: 'SP' })).toEqual({
      zip_code: '', street: '', number: '', complement: '', neighborhood: '', city: '',
      state: 'SP', address_reference: '', has_address: false,
    });
  });
});

// ── 2. POST ────────────────────────────────────────────────
describe('POST / — cadastro com endereco', () => {
  function mockPost(captura) {
    db.query.mockImplementation(async (sql, params) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (/SELECT COUNT\(\*\) AS total FROM customers/.test(sql)) return { rows: [{ total: '3' }] };
      if (/INSERT INTO customers/.test(sql)) {
        captura.push({ sql, params });
        const m = /INSERT INTO customers \(([^)]+)\)/.exec(sql);
        const cols = m[1].split(',').map(c => c.trim());
        const row = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        return { rows: [{ id: CUST, ...row }] };
      }
      throw new Error('inesperada: ' + sql);
    });
  }

  it('grava o endereco nas colunas canonicas e devolve has_address', async () => {
    const cap = [];
    mockPost(cap);
    const res = await request(app).post(`/companies/${CO_A}/customers`).send({
      name: 'Cliente Teste', phone: '(11) 98888-1234',
      zip_code: '01310-100', street: 'Avenida Paulista', number: '1000', complement: 'Apto 52',
      neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP', address_reference: 'portão azul',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      zip_code: '01310100', street: 'Avenida Paulista', number: '1000', complement: 'Apto 52',
      neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP', address_reference: 'portão azul',
      has_address: true,
    });
    const { sql } = cap[0];
    expect(sql).toMatch(/\bnumber\b/);
    expect(sql).toMatch(/\bzip_code\b/);
    expect(sql).not.toMatch(/address_number|postal_code/);
  });

  it('sem endereco o INSERT e o de sempre (nada de colunas de endereco)', async () => {
    const cap = [];
    mockPost(cap);
    const res = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'Sem Endereco' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('has_address');
    expect(cap[0].sql).not.toMatch(/zip_code|street|neighborhood|address_reference/);
  });

  it('CEP com 7 digitos: 400 e nada gravado', async () => {
    const cap = [];
    mockPost(cap);
    const res = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'X', zip_code: '1234567' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('zip_code');
    expect(cap).toHaveLength(0);
  });

  it('UF com 3 letras: 400', async () => {
    mockPost([]);
    const res = await request(app).post(`/companies/${CO_A}/customers`).send({ name: 'X', state: 'SPA' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('state');
  });

  it('sem a 433: grava o resto e avisa ignored_fields', async () => {
    const cap = [];
    db.query.mockImplementation(async (sql, params) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/SELECT COUNT/.test(sql)) return { rows: [{ total: '0' }] };
      if (/INSERT INTO customers/.test(sql)) {
        cap.push(sql);
        if (/address_reference/.test(sql)) {
          throw pgError('42703', 'column "address_reference" of relation "customers" does not exist');
        }
        return { rows: [{ id: CUST, name: 'X', street: 'Rua A', number: '1', city: 'Y' }] };
      }
      throw new Error('inesperada: ' + sql);
    });
    const res = await request(app).post(`/companies/${CO_A}/customers`)
      .send({ name: 'X', street: 'Rua A', number: '1', city: 'Y', address_reference: 'perto da praça' });
    expect(res.status).toBe(201);
    expect(res.body.ignored_fields).toEqual(['address_reference']);
    expect(res.body.has_address).toBe(true);
    expect(cap).toHaveLength(2);
    // phone_e164 (341) continua na segunda tentativa: o 42703 era da 433.
    expect(cap[1]).toMatch(/phone_e164/);
    expect(cap[1]).not.toMatch(/address_reference/);
  });
});

// ── 3 e 4. PATCH ───────────────────────────────────────────
describe('PATCH /:cid — editar o endereco', () => {
  function mockPatch(captura, rowOver) {
    db.query.mockImplementation(async (sql, params) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (/UPDATE customers SET/.test(sql)) {
        captura.push({ sql, params });
        return { rows: [linha(rowOver)] };
      }
      throw new Error('inesperada: ' + sql);
    });
  }

  it('cliente cadastrado na loja B, editado pela loja A: o endereco e do cliente', async () => {
    const cap = [];
    mockPatch(cap, { street: 'Rua das Flores', number: '45', city: 'Campinas', neighborhood: 'Centro' });
    const res = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`).send({
      street: 'Rua das Flores', number: '45', city: 'Campinas', neighborhood: 'Centro',
    });
    expect(res.status).toBe(200);
    expect(res.body.has_address).toBe(true);
    const { sql, params } = cap[0];
    // WHERE id = $n AND company_id = ANY($m) com as DUAS lojas do dono.
    expect(sql).toMatch(/company_id = ANY\(\$\d+\)/);
    expect(params[params.length - 1]).toEqual([CO_A, CO_B]);
    expect(params[params.length - 2]).toBe(CUST);
    // Uma linha so: nao existe copia do endereco por loja.
    expect(sql).toMatch(/WHERE id = \$\d+/);
  });

  it('so mexe no que veio; vazio apaga', async () => {
    const cap = [];
    mockPatch(cap);
    const res = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`)
      .send({ complement: '', zip_code: '04538-132' });
    expect(res.status).toBe(200);
    const { sql, params } = cap[0];
    expect(sql).toMatch(/zip_code = \$1/);
    expect(sql).toMatch(/complement = \$2/);
    expect(params.slice(0, 2)).toEqual(['04538132', null]);
    expect(sql).not.toMatch(/street|city|number =/);
  });

  it('CEP invalido: 400 antes de tocar no banco', async () => {
    const cap = [];
    mockPatch(cap);
    const res = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`).send({ zip_code: '123' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('zip_code');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('cliente de outro dono: 404', async () => {
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/UPDATE customers SET/.test(sql)) return { rows: [] };
      throw new Error('inesperada: ' + sql);
    });
    const res = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`).send({ city: 'X' });
    expect(res.status).toBe(404);
  });

  it('sem a 433: o ponto de referencia cai fora e o resto grava', async () => {
    const cap = [];
    db.query.mockImplementation(async (sql, params) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }] };
      if (/UPDATE customers SET/.test(sql)) {
        cap.push(sql);
        if (/address_reference/.test(sql)) {
          throw pgError('42703', 'column "address_reference" of relation "customers" does not exist');
        }
        return { rows: [linha({ city: 'X' })] };
      }
      throw new Error('inesperada: ' + sql);
    });
    const res = await request(app).patch(`/companies/${CO_A}/customers/${CUST}`)
      .send({ city: 'X', address_reference: 'portão azul' });
    expect(res.status).toBe(200);
    expect(res.body.ignored_fields).toEqual(['address_reference']);
    expect(cap[1]).toMatch(/city = \$1/);
    expect(cap[1]).not.toMatch(/address_reference/);
  });
});

// ── 5. GET ─────────────────────────────────────────────────
describe('GET / — o seletor do Caixa sabe quem tem endereco', () => {
  function mockList(rows, opts = {}) {
    const sqls = [];
    db.query.mockImplementation(async (sql) => {
      if (ownerScope(sql)) return { rows: [{ id: CO_A }, { id: CO_B }] };
      if (/SELECT COUNT\(\*\) AS total FROM customers/.test(sql)) return { rows: [{ total: String(rows.length) }] };
      if (/FROM customers c/.test(sql)) {
        sqls.push(sql);
        if (opts.semReferencia && /c\.address_reference/.test(sql)) {
          throw pgError('42703', 'column c.address_reference does not exist');
        }
        return { rows };
      }
      // matcon_settings etc. (attachProfessionalsToCustomers): sem modulo
      return { rows: [] };
    });
    return sqls;
  }

  it('devolve bairro, endereco e has_address', async () => {
    mockList([
      linha({ street: 'Avenida Paulista', number: '1000', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP', zip_code: '01310100' }),
      linha({ id: 'outro', name: 'Sem Endereco' }),
    ]);
    const res = await request(app).get(`/companies/${CO_A}/customers?sort=recent&search=a`);
    expect(res.status).toBe(200);
    const [com, sem] = res.body.customers;
    expect(com).toMatchObject({
      neighborhood: 'Bela Vista', street: 'Avenida Paulista', number: '1000',
      city: 'São Paulo', state: 'SP', zip_code: '01310100', has_address: true,
    });
    expect(sem).toMatchObject({ neighborhood: '', street: '', has_address: false });
  });

  it('sem a 433, a lista segue (sem o ponto de referencia)', async () => {
    const sqls = mockList([linha({ street: 'R', number: '1', city: 'C' })], { semReferencia: true });
    const res = await request(app).get(`/companies/${CO_A}/customers`);
    expect(res.status).toBe(200);
    expect(res.body.customers[0]).toMatchObject({ has_address: true, address_reference: '' });
    expect(sqls[sqls.length - 1]).toMatch(/NULL::text AS address_reference/);
  });
});

// ── 7. Matcon ──────────────────────────────────────────────
describe('entrega da Matcon — numero do endereco', () => {
  it('le `number`, o que o cadastro grava', () => {
    expect(enderecoDoCliente({ street: 'Rua das Acácias', number: '233', neighborhood: 'Centro', city: 'Campinas' }))
      .toBe('Rua das Acácias, 233 - Centro - Campinas');
  });

  it('address_number fica so de reserva', () => {
    expect(enderecoDoCliente({ street: 'Rua A', address_number: '9', city: 'X' })).toBe('Rua A, 9 - X');
    expect(enderecoDoCliente({ street: 'Rua A', number: '1', address_number: '9', city: 'X' })).toBe('Rua A, 1 - X');
  });

  it('sem numero, sem virgula solta', () => {
    expect(enderecoDoCliente({ street: 'Rua A', number: '  ', city: 'X' })).toBe('Rua A - X');
    expect(enderecoDoCliente({})).toBeNull();
  });
});

// ── 8. migration ───────────────────────────────────────────
describe('migration 433', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '433_customers_address_reference.sql'), 'utf8')
    .replace(/--.*$/gm, '');

  it('so adiciona a coluna, idempotente', () => {
    expect(sql).toMatch(/ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_reference text/);
    expect(sql).not.toMatch(/DROP|UPDATE|DELETE|NOT NULL|DEFAULT|RENAME/i);
  });
});

// /me/customers (visao consolidada) devolve o mesmo contrato.
describe('GET /me/customers — mesmo contrato', () => {
  it('seleciona as colunas de endereco e espalha addressFromRow', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'meAggregates.js'), 'utf8');
    expect(src).toMatch(/zip_code, street, number, complement, neighborhood, city, state/);
    expect(src).toMatch(/\.\.\.addressFromRow\(r\)/);
  });
});
