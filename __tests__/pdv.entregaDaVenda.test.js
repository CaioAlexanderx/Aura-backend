// ============================================================
// Venda com frete precisa de endereço (09/11/2026, parte 2)
// src/services/entregaDaVenda.js + POST /pdv/sale (src/routes/pdv.js)
//
// O que este arquivo prova:
//   A. A trava: frete + delivery_check e sem o mínimo (nome, rua ou CEP,
//      número, cidade) -> 422 DELIVERY_ADDRESS_REQUIRED, antes de gravar
//      qualquer venda. Vale sem cliente e com cliente sem endereço.
//   B. Compatibilidade: o app antigo (sem delivery_check) vende com frete
//      e sem endereço como sempre (201).
//   C. Retrato: o endereço vai para sales.delivery_address no momento da
//      venda, e para o cadastro de quem ainda não tinha (sem sobrescrever).
//   D. Cadastro inline com endereço (resolveInlineCustomer).
//   E. Venda sem frete e sem delivery_address: nenhuma consulta a mais.
//   F. Banco sem a 435: a venda segue (SAVEPOINT) e para de tentar.
// Mock do banco despachado por conteúdo do SQL (padrão do pdv-connection).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const mockClient = { query: jest.fn(), release: jest.fn() };
db.connect = jest.fn().mockResolvedValue(mockClient);
db.query = jest.fn();

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const pdvRouter = require('../src/routes/pdv');
const entregaDaVenda = require('../src/services/entregaDaVenda');

const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);

const CID = 'comp-1', PROD = 'prod-1', SALE = 'sale-1', CLI = 'cli-1', NOVO = 'cli-novo';

const SEM_ENDERECO = { name: 'Cliente Teste', phone: '11955554321', zip_code: null, street: null, number: null, complement: null, neighborhood: null, city: null, state: null, address_reference: null };
const COM_ENDERECO = { ...SEM_ENDERECO, zip_code: '01310100', street: 'Av. Paulista', number: '1000', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' };

const ENDERECO = {
  zip_code: '04538-132', street: 'Rua Jerônimo da Veiga', number: '45', complement: 'Apto 3',
  neighborhood: 'Itaim Bibi', city: 'São Paulo', state: 'sp', address_reference: 'portão azul',
};

function despachar({ cliente = null, falhaNaColuna = false } = {}) {
  mockClient.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: { caixa_enabled: false } }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies/i.test(s)) return Promise.resolve({ rows: [{ name: 'Vestido', cost_price: 10, stock_qty: 50, stock_company_id: CID }] });
    // findOwnerScopedCustomer (customer_id do body)
    if (/SELECT id FROM customers WHERE id = \$1/i.test(s)) return Promise.resolve({ rows: cliente ? [{ id: CLI }] : [] });
    if (/FROM customers WHERE id = \$1/i.test(s)) return Promise.resolve({ rows: cliente ? [{ ...cliente }] : [] });
    if (/INSERT INTO customers/i.test(s)) return Promise.resolve({ rows: [{ id: NOVO }] });
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: SALE, total_amount: 115, employee_id: null, customer_id: cliente ? CLI : null }] });
    if (falhaNaColuna && /UPDATE sales SET delivery_address/i.test(s)) {
      return Promise.reject(Object.assign(new Error('column "delivery_address" of relation "sales" does not exist'), { code: '42703' }));
    }
    return Promise.resolve({ rows: [] });
  });
  db.query.mockResolvedValue({ rows: [] });
}

const FRETE = { product_id: undefined, quantity: 1, unit_price: 15, product_name_snapshot: 'Frete' };
const PRODUTO = { product_id: PROD, quantity: 1, unit_price: 100 };

const vender = (body, items = [PRODUTO, FRETE]) =>
  request(app).post(`/companies/${CID}/pdv/sale`).send({ items, payment_method: 'pix', ...body });

const chamadas = (re) => mockClient.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

beforeEach(() => {
  jest.clearAllMocks(); mockClient.query.mockReset(); db.query.mockReset();
  entregaDaVenda._resetCache();
});

describe('regras puras', () => {
  test('valorDoFrete: só a linha "Frete" sem produto e com valor', () => {
    expect(entregaDaVenda.valorDoFrete([PRODUTO, FRETE])).toBe(15);
    expect(entregaDaVenda.valorDoFrete([{ ...FRETE, product_name_snapshot: ' frete ' }])).toBe(15);
    expect(entregaDaVenda.valorDoFrete([{ ...FRETE, unit_price: 0 }])).toBe(0);
    expect(entregaDaVenda.valorDoFrete([{ ...FRETE, product_id: 'p-frete' }])).toBe(0);
    expect(entregaDaVenda.valorDoFrete([{ ...FRETE, product_name_snapshot: 'Taxa de serviço' }])).toBe(0);
    expect(entregaDaVenda.valorDoFrete(null)).toBe(0);
  });

  test('faltandoParaEntrega: nome, rua ou CEP, número e cidade', () => {
    expect(entregaDaVenda.faltandoParaEntrega({})).toEqual(['name', 'street', 'number', 'city']);
    expect(entregaDaVenda.faltandoParaEntrega({ name: 'A', zip_code: '01310100', number: '1', city: 'X' })).toEqual([]);
    expect(entregaDaVenda.faltandoParaEntrega({ name: 'A', street: 'Rua', number: ' ', city: 'X' })).toEqual(['number']);
  });
});

describe('A. a trava (app novo, delivery_check)', () => {
  test('frete sem cliente e sem endereço: 422 antes de gravar a venda', async () => {
    despachar();
    const res = await vender({ delivery_check: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DELIVERY_ADDRESS_REQUIRED');
    expect(res.body.missing).toEqual(['name', 'street', 'number', 'city']);
    expect(chamadas(/INSERT INTO sales/i)).toHaveLength(0);
    expect(chamadas(/^ROLLBACK$/)).toHaveLength(1);
  });

  test('frete com cliente sem endereço: 422 (falta rua, número e cidade)', async () => {
    despachar({ cliente: SEM_ENDERECO });
    const res = await vender({ delivery_check: true, customer_id: CLI });
    expect(res.status).toBe(422);
    expect(res.body.missing).toEqual(['street', 'number', 'city']);
    expect(chamadas(/INSERT INTO sales/i)).toHaveLength(0);
  });

  test('endereço sem número: 422 só com o número', async () => {
    despachar({ cliente: SEM_ENDERECO });
    const res = await vender({ delivery_check: true, customer_id: CLI, delivery_address: { ...ENDERECO, number: '' } });
    expect(res.status).toBe(422);
    expect(res.body.missing).toEqual(['number']);
  });

  test('CEP inválido: 422 INVALID_DELIVERY_ADDRESS', async () => {
    despachar({ cliente: SEM_ENDERECO });
    const res = await vender({ delivery_check: true, customer_id: CLI, delivery_address: { ...ENDERECO, zip_code: '123' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_DELIVERY_ADDRESS');
    expect(res.body.field).toBe('zip_code');
  });

  test('frete com cliente que já tem endereço: passa sem mandar nada', async () => {
    despachar({ cliente: COM_ENDERECO });
    const res = await vender({ delivery_check: true, customer_id: CLI });
    expect(res.status).toBe(201);
  });

  test('sem frete a trava não vale (mesmo com delivery_check)', async () => {
    despachar();
    const res = await vender({ delivery_check: true }, [PRODUTO]);
    expect(res.status).toBe(201);
  });
});

describe('B. compatibilidade com o app antigo', () => {
  test('sem delivery_check: frete sem endereço vende como sempre', async () => {
    despachar();
    const res = await vender({});
    expect(res.status).toBe(201);
    expect(chamadas(/UPDATE sales SET delivery_address/i)).toHaveLength(0);
  });

  test('sem delivery_check e cliente com endereço: grava o retrato do cadastro', async () => {
    despachar({ cliente: COM_ENDERECO });
    const res = await vender({ customer_id: CLI });
    expect(res.status).toBe(201);
    const [[, params]] = chamadas(/UPDATE sales SET delivery_address/i);
    expect(JSON.parse(params[0]).street).toBe('Av. Paulista');
  });
});

describe('C. retrato na venda e no cadastro', () => {
  test('cliente sem endereço + endereço da tela: retrato na venda e endereço no cadastro', async () => {
    despachar({ cliente: SEM_ENDERECO });
    const res = await vender({
      delivery_check: true, customer_id: CLI,
      delivery_address: { ...ENDERECO, note: 'Entregar depois das 14h' },
    });
    expect(res.status).toBe(201);

    const upd = chamadas(/UPDATE sales SET delivery_address/i);
    expect(upd).toHaveLength(1);
    const [sql, params] = upd[0];
    expect(sql).toMatch(/\$1::jsonb WHERE id = \$2 AND company_id = \$3/);
    expect(params.slice(1)).toEqual([SALE, CID]);
    const retrato = JSON.parse(params[0]);
    expect(retrato).toEqual({
      name: 'Cliente Teste', phone: '11955554321',
      zip_code: '04538132', street: 'Rua Jerônimo da Veiga', number: '45', complement: 'Apto 3',
      neighborhood: 'Itaim Bibi', city: 'São Paulo', state: 'SP', address_reference: 'portão azul',
      note: 'Entregar depois das 14h',
    });
    expect(res.body.sale.delivery_address).toEqual(retrato);

    const cad = chamadas(/UPDATE customers SET/i);
    expect(cad).toHaveLength(1);
    expect(cad[0][0]).toMatch(/zip_code = \$2, street = \$3, number = \$4, complement = \$5, neighborhood = \$6, city = \$7, state = \$8, address_reference = \$9/);
    expect(cad[0][1]).toEqual([CLI, '04538132', 'Rua Jerônimo da Veiga', '45', 'Apto 3', 'Itaim Bibi', 'São Paulo', 'SP', 'portão azul']);
    // Tudo em SAVEPOINT: erro aqui nunca aborta a transação da venda.
    expect(chamadas(/^SAVEPOINT entrega_venda$/)).toHaveLength(1);
    expect(chamadas(/^SAVEPOINT entrega_cadastro$/)).toHaveLength(1);
  });

  test('o recado não vai para o cadastro (é da venda)', async () => {
    despachar({ cliente: SEM_ENDERECO });
    await vender({ delivery_check: true, customer_id: CLI, delivery_address: { ...ENDERECO, note: 'tocar 2x' } });
    const [[sql]] = chamadas(/UPDATE customers SET/i);
    expect(sql).not.toMatch(/note/);
  });

  test('cliente que já tem endereço: o cadastro não é sobrescrito; a venda leva o da tela', async () => {
    despachar({ cliente: COM_ENDERECO });
    const res = await vender({ delivery_check: true, customer_id: CLI, delivery_address: ENDERECO });
    expect(res.status).toBe(201);
    expect(chamadas(/UPDATE customers SET/i)).toHaveLength(0);
    const [[, params]] = chamadas(/UPDATE sales SET delivery_address/i);
    expect(JSON.parse(params[0]).street).toBe('Rua Jerônimo da Veiga');
  });

  test('nome e telefone de quem recebe, quando a tela manda, valem mais que o cadastro', async () => {
    despachar({ cliente: COM_ENDERECO });
    await vender({ delivery_check: true, customer_id: CLI, delivery_address: { ...ENDERECO, name: 'Portaria', phone: '1133334444' } });
    const [[, params]] = chamadas(/UPDATE sales SET delivery_address/i);
    const r = JSON.parse(params[0]);
    expect([r.name, r.phone]).toEqual(['Portaria', '1133334444']);
  });

  test('banco sem a 435: a venda sai (201), sem retrato, e para de tentar', async () => {
    despachar({ cliente: COM_ENDERECO, falhaNaColuna: true });
    const r1 = await vender({ delivery_check: true, customer_id: CLI });
    expect(r1.status).toBe(201);
    expect(r1.body.sale.delivery_address).toBeUndefined();
    expect(chamadas(/^ROLLBACK TO SAVEPOINT entrega_venda$/)).toHaveLength(1);
    expect(chamadas(/^COMMIT$/)).toHaveLength(1);

    mockClient.query.mockClear();
    const r2 = await vender({ delivery_check: true, customer_id: CLI });
    expect(r2.status).toBe(201);
    expect(chamadas(/UPDATE sales SET delivery_address/i)).toHaveLength(0);
  });

  test('erro qualquer ao gravar o retrato: a venda segue', async () => {
    despachar({ cliente: COM_ENDERECO });
    const original = mockClient.query.getMockImplementation();
    mockClient.query.mockImplementation((sql, p) => (/UPDATE sales SET delivery_address/i.test(String(sql))
      ? Promise.reject(new Error('timeout')) : original(sql, p)));
    const res = await vender({ delivery_check: true, customer_id: CLI });
    expect(res.status).toBe(201);
    expect(chamadas(/^COMMIT$/)).toHaveLength(1);
  });
});

describe('D. sem cliente: cadastro inline com endereço', () => {
  test('nome, telefone e endereço viram cliente novo, vinculado e com o retrato', async () => {
    despachar();
    // o cliente recém-criado é lido de volta para o retrato
    const original = mockClient.query.getMockImplementation();
    mockClient.query.mockImplementation((sql, p) => (/FROM customers WHERE id = \$1/i.test(String(sql))
      ? Promise.resolve({ rows: [{ ...SEM_ENDERECO, name: 'Joana Teste', phone: '21955554321', zip_code: '22041001', street: 'Avenida Atlântica', number: '1702', complement: 'Apto 801', neighborhood: 'Copacabana', city: 'Rio de Janeiro', state: 'RJ' }] })
      : original(sql, p)));

    const customer = { name: 'Joana Teste', phone: '21955554321', zip_code: '22041-001', street: 'Avenida Atlântica', number: '1702', complement: 'Apto 801', neighborhood: 'Copacabana', city: 'Rio de Janeiro', state: 'RJ' };
    const res = await vender({ delivery_check: true, customer, delivery_address: { ...customer, note: 'interfone 32' } });
    expect(res.status).toBe(201);

    const ins = chamadas(/INSERT INTO customers/i);
    expect(ins).toHaveLength(1);
    expect(ins[0][0]).toMatch(/INSERT INTO customers \(company_id, name, phone, cpf_cnpj, zip_code, street, number, complement, neighborhood, city, state\)/);
    expect(ins[0][0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11\)/);
    expect(ins[0][1]).toEqual([CID, 'Joana Teste', '21955554321', null, '22041001', 'Avenida Atlântica', '1702', 'Apto 801', 'Copacabana', 'Rio de Janeiro', 'RJ']);

    const [[sqlVenda, pVenda]] = chamadas(/INSERT INTO sales/i);
    expect(sqlVenda).toBeTruthy();
    expect(pVenda[1]).toBe(NOVO);

    const [[, params]] = chamadas(/UPDATE sales SET delivery_address/i);
    expect(JSON.parse(params[0])).toMatchObject({ name: 'Joana Teste', street: 'Avenida Atlântica', number: '1702', note: 'interfone 32' });
    // Já nasceu com endereço: não precisa preencher de novo.
    expect(chamadas(/UPDATE customers SET/i)).toHaveLength(0);
  });

  test('cliente inline sem endereço: o INSERT é exatamente o de sempre', async () => {
    despachar();
    await vender({ customer: { name: 'Sem Endereço', phone: '11900000000' } }, [PRODUTO]);
    const [[sql, params]] = chamadas(/INSERT INTO customers/i);
    expect(sql).toBe(`INSERT INTO customers (company_id, name, phone, cpf_cnpj)
       VALUES ($1, $2, $3, $4) RETURNING id`);
    expect(params).toEqual([CID, 'Sem Endereço', '11900000000', null]);
  });

  test('cliente inline com CEP inválido: 422 INVALID_DELIVERY_ADDRESS', async () => {
    despachar();
    const res = await vender({ customer: { name: 'X', zip_code: '1' } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_DELIVERY_ADDRESS');
  });
});

describe('E. venda sem frete e sem delivery_address', () => {
  test('nenhuma consulta a mais: sem SAVEPOINT, sem ler cliente, sem UPDATE', async () => {
    despachar({ cliente: COM_ENDERECO });
    const res = await vender({ customer_id: CLI, delivery_check: true }, [PRODUTO]);
    expect(res.status).toBe(201);
    expect(chamadas(/SAVEPOINT/i)).toHaveLength(0);
    expect(chamadas(/address_reference FROM customers/i)).toHaveLength(0);
    expect(chamadas(/delivery_address/i)).toHaveLength(0);
  });

  test('sem frete mas com delivery_address: grava o retrato, sem trava', async () => {
    despachar({ cliente: SEM_ENDERECO });
    const res = await vender({ customer_id: CLI, delivery_address: { street: 'Rua A' } }, [PRODUTO]);
    expect(res.status).toBe(201);
    expect(chamadas(/UPDATE sales SET delivery_address/i)).toHaveLength(1);
  });
});
