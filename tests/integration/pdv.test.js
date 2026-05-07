// ============================================================
// QA-02 — Testes de Integração: PDV (Ponto de Venda)
// PDV usa db.connect() (transação atômica) — mock precisa de connect
//
// 07/05/2026: /summary virou Promise.all com 2 queries (vendas + trocas)
// via pdv-summary-patch.js. Teste atualizado pra mockar ambas.
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

const mockProduct = { id:'p1', name:'Produto Teste', price:25.00, stock_qty:10, cost_price:10 };
const mockSale    = { id:'sale1', total_amount:25.00, payment_method:'pix', status:'confirmed', created_at: new Date().toISOString() };

// Helper: monta cliente transacional mockado
function mockClient(queryResults = []) {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };
  // Cada chamada a client.query retorna o resultado correspondente
  queryResults.forEach(result => client.query.mockResolvedValueOnce(result));
  // Fallback para chamadas extras (ROLLBACK, etc)
  client.query.mockResolvedValue({ rows: [] });
  return client;
}

describe('POST /companies/:id/pdv/sale — validações de entrada', () => {
  test('400 — items vazio', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({ payment_method: 'pix', items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/items/i);
  });

  test('400 — items ausente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({ payment_method: 'pix' });
    expect(res.status).toBe(400);
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .send({ payment_method:'pix', items:[{ product_id:'p1', quantity:1, unit_price:25 }] });
    expect(res.status).toBe(401);
  });
});

describe('POST /companies/:id/pdv/sale — venda atômica', () => {
  test('201 — venda criada (produto sem rastrear estoque)', async () => {
    // Produto sem product_id — não faz query de produto, só BEGIN, INSERT sale, INSERT item, COMMIT
    const client = mockClient([
      { rows: [] },                           // BEGIN
      { rows: [mockSale] },                   // INSERT sale
      { rows: [{ id:'si1' }] },               // INSERT sale_item
      { rows: [] },                           // COMMIT
    ]);
    db.connect.mockResolvedValueOnce(client);
    // db.query extra após COMMIT (busca itens)
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'pix',
        items: [{
          product_name_snapshot: 'Produto Avulso',
          quantity: 1,
          unit_price: 25,
        }],
      });
    expect([200, 201]).toContain(res.status);
  });

  test('409 — estoque insuficiente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const client = mockClient([
      { rows: [] },                                                           // BEGIN
      { rows: [{ name:'Produto', cost_price:10, stock_qty: '0' }] },         // SELECT produto (estoque 0)
      { rows: [] },                                                           // ROLLBACK
    ]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`)
      .set(auth).send({
        payment_method: 'pix',
        items: [{ product_id:'p1', quantity:5, unit_price:25 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/estoque/i);
  });
});

describe('GET /companies/:id/pdv/summary — resumo do dia', () => {
  test('200 — retorna resumo', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    // pdv-summary-patch.js faz Promise.all com 2 queries:
    //   (1) vendas regulares (type IS NULL ou 'sale')
    //   (2) trocas do dia (type='troca' + transactions netAmount)
    db.query.mockResolvedValueOnce({
      rows: [{ total_sales:'5', gross_revenue:'250.00', total_discounts:'0', avg_ticket:'50.00', by_payment_method:null }],
    });
    db.query.mockResolvedValueOnce({
      rows: [{ trocas_count: 0, trocas_net_received: 0 }],
    });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/summary`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_sales');
    expect(res.body).toHaveProperty('gross_revenue');
    expect(res.body).toHaveProperty('trocas_count');
    expect(res.body).toHaveProperty('trocas_net_received');
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/summary`);
    expect(res.status).toBe(401);
  });
});
