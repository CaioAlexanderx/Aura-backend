// ============================================================
// AURA. — Testes Integração: Impressão PDV (INF-04)
// _loadSaleData faz 4 queries: company, sale+join, items, sale_payments
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET  = 'aura-test-secret-2026';
const cid     = '00000000-0000-0000-0000-000000000001';
const saleId  = '00000000-0000-0000-0000-000000000099';
const auth    = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'essencial' }, SECRET, { expiresIn:'1h' })}` };

const mockCompany = { legal_name:'Mercado do João', trade_name:'Mercado João', cnpj:'12.345.678/0001-90', phone:'(12)99999-9999', address_street:null, address_city:null };
const mockSale    = { id:saleId, total_amount:85.50, discount_amount:0, payment_method:'Pix', created_at: new Date().toISOString(), seller_name:'Ana', customer_name:'Carlos', cash_tendered:null, pix_payload:null, notes:null };
const mockItems   = [
  { product_name:'Feijão 1kg', quantity:2, unit_price:7.50, total_price:15.00, discount:0, variant_label:null },
  { product_name:'Arroz 5kg',  quantity:1, unit_price:25.00, total_price:25.00, discount:0, variant_label:null },
];
// _loadSaleData faz 4 queries: company, sale, items, payments
function mockSaleQueries(dbInstance) {
  dbInstance.query
    .mockResolvedValueOnce({ rows: [mockCompany] })  // 1: company
    .mockResolvedValueOnce({ rows: [mockSale] })     // 2: sale
    .mockResolvedValueOnce({ rows: mockItems })       // 3: items
    .mockResolvedValueOnce({ rows: [] });             // 4: sale_payments
}

describe('GET /print/receipt/:saleId', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna HTML com Content-Type text/html', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    mockSaleQueries(db);
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('HTML contém nome da empresa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    mockSaleQueries(db);
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}`).set(auth);
    expect(res.text).toContain('Mercado João');
  });

  test('HTML contém total da venda formatado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    mockSaleQueries(db);
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}`).set(auth);
    expect(res.text).toContain('85.50');
  });

  test('HTML contém CNPJ da empresa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    mockSaleQueries(db);
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}`).set(auth);
    expect(res.text).toContain('12.345.678/0001-90');
  });

  test('retorna 404 se venda não encontrada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}`).set(auth);
    expect(res.status).toBe(404);
  });

  test('retorna 401 sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /print/receipt/:saleId/preview', () => {
  beforeEach(() => jest.clearAllMocks());

  test('HTML do preview contém window.print()', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    mockSaleQueries(db);
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}/preview`).set(auth);
    expect(res.status).toBe(200);
    expect(res.text).toContain('window.print()');
  });

  test('HTML do preview contém itens da venda', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    mockSaleQueries(db);
    const res = await request(app).get(`/api/v1/companies/${cid}/print/receipt/${saleId}/preview`).set(auth);
    expect(res.text).toContain('Feijão 1kg');
    expect(res.text).toContain('Arroz 5kg');
  });
});
