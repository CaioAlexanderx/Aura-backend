// ============================================================
// QA-02 — Testes de Integração: Barcode / Scanner PDV
// ============================================================

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(() => ({ query: jest.fn(), release: jest.fn() })),
}));
jest.mock('../../src/config/sentry', () => ({
  Sentry: { Handlers: { requestHandler:()=>(q,r,n)=>n(), tracingHandler:()=>(q,r,n)=>n(), errorHandler:()=>(e,q,r,n)=>n() }},
  initSentry: jest.fn(),
}));
jest.mock('../../src/config/redis', () => ({}));
jest.mock('../../src/services/dentalWs', () => ({ setupDentalWebSocket: jest.fn(), getSessionStatus: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'aura-dev-secret';
const token = jwt.sign({ id: 'u1', role: 'client' }, JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

let app, db;
beforeAll(() => { ({ app } = require('../../src/index')); db = require('../../src/config/database'); });
afterEach(() => jest.clearAllMocks());

describe('POST /companies/:id/products/:pid/barcode', () => {
  test('400 — sem code e format', async () => {
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('400 — format inválido', async () => {
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '123', format: 'INVALIDO' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/format inválido/i);
  });

  test('400 — EAN-13 com dígito verificador errado', async () => {
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315508', format: 'EAN-13' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido para o formato/i);
  });

  test('404 — produto não encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315507', format: 'EAN-13' });
    expect(res.status).toBe(404);
  });

  test('409 — código duplicado em outro produto', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'p1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'p2' }] });
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315507', format: 'EAN-13' });
    expect(res.status).toBe(409);
  });

  test('200 — EAN-13 válido vinculado com sucesso', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'p1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto', barcode: '7891000315507', barcode_format: 'EAN-13' }] });
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315507', format: 'EAN-13' });
    expect(res.status).toBe(200);
    expect(res.body.product.barcode).toBe('7891000315507');
  });
});

describe('GET /companies/:id/pdv/scan/:code', () => {
  test('200 match=exact — código encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto', barcode: '7891000315507' }] });
    const res = await request(app)
      .get('/api/v1/companies/c1/pdv/scan/7891000315507')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('exact');
  });

  test('207 match=partial — busca textual', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Camisa Azul' }] });
    const res = await request(app)
      .get('/api/v1/companies/c1/pdv/scan/camisa')
      .set(auth);
    expect(res.status).toBe(207);
    expect(res.body.match).toBe('partial');
  });

  test('404 — nenhum resultado', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/v1/companies/c1/pdv/scan/xyz999')
      .set(auth);
    expect(res.status).toBe(404);
    expect(res.body.match).toBe('none');
  });
});
