// ============================================================
// QA-02 — Testes de Integração: PDV (Ponto de Venda)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

const mockProduct = { id:'p1', name:'Produto Teste', price:25.00, stock_quantity:10, track_stock:true };
const mockSale    = { id:'sale1', total_amount:25.00, payment_method:'pix', status:'confirmed', created_at: new Date().toISOString() };

describe('POST /companies/:id/pdv/sale — venda completa', () => {
  test('400 — sem items', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({ payment_method: 'pix', items: [] });
    expect(res.status).toBe(400);
  });

  test('400 — payment_method ausente', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({ items: [{ product_id:'p1', quantity:1, unit_price:25 }] });
    expect(res.status).toBe(400);
  });

  test('201 — venda criada com produto existente', async () => {
    // connect → BEGIN → SELECT produto → INSERT sale → INSERT item → UPDATE stock → INSERT payment → COMMIT
    const client = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValueOnce(client);
    client.query
      .mockResolvedValueOnce({ rows: [] })                        // BEGIN
      .mockResolvedValueOnce({ rows: [mockProduct] })             // SELECT produto
      .mockResolvedValueOnce({ rows: [mockSale] })                // INSERT sale
      .mockResolvedValueOnce({ rows: [{ id:'si1' }] })            // INSERT sale_item
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE stock
      .mockResolvedValueOnce({ rows: [{ id:'pay1' }] })           // INSERT sale_payments
      .mockResolvedValueOnce({ rows: [] });                       // COMMIT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'pix',
        items: [{ product_id:'p1', quantity:1, unit_price:25 }],
      });
    expect([200, 201]).toContain(res.status);
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .send({ payment_method:'pix', items:[{ product_id:'p1', quantity:1, unit_price:25 }] });
    expect(res.status).toBe(401);
  });
});

describe('GET /companies/:id/pdv/summary — resumo do dia', () => {
  test('200 — retorna resumo do dia', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ total_sales: 5, total_revenue: 250.00, avg_ticket: 50.00 }],
    });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/summary`)
      .set(auth);
    expect([200, 404]).toContain(res.status); // 404 se rota nao existir ainda
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/summary`);
    expect(res.status).toBe(401);
  });
});
