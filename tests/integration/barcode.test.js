// ============================================================
// QA-02 — Testes de Integração: Barcode / Scanner PDV
// fix: requireCompanyAccess consome 1 db.query antes do handler
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
const JWT_SECRET = process.env.JWT_SECRET || 'aura-test-secret-2026';
const token = jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

let app, db;
beforeAll(() => { ({ app } = require('../../src/index')); db = require('../../src/config/database'); });
afterEach(() => jest.clearAllMocks());

// helper: mock do requireCompanyAccess
const OWN = { rows: [{ role: 'owner' }] };

describe('POST /companies/:id/products/:pid/barcode', () => {
  // requireCompanyAccess executa ANTES da validação do body
  // todos os testes precisam do mock de ownership como primeiro mock

  test('400 — sem code e format', async () => {
    db.query.mockResolvedValueOnce(OWN); // requireCompanyAccess
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('400 — format inválido', async () => {
    db.query.mockResolvedValueOnce(OWN);
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '123', format: 'INVALIDO' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/format inválido/i);
  });

  test('400 — EAN-13 com dígito verificador errado', async () => {
    db.query.mockResolvedValueOnce(OWN);
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315508', format: 'EAN-13' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido para o formato/i);
  });

  test('404 — produto não encontrado', async () => {
    db.query
      .mockResolvedValueOnce(OWN)           // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [] }); // produto não encontrado
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315507', format: 'EAN-13' });
    expect(res.status).toBe(404);
  });

  test('409 — código duplicado em outro produto', async () => {
    db.query
      .mockResolvedValueOnce(OWN)                         // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [{ id: 'p1' }] })   // produto existe
      .mockResolvedValueOnce({ rows: [{ id: 'p2' }] });  // duplicata encontrada
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315507', format: 'EAN-13' });
    expect(res.status).toBe(409);
  });

  test('200 — EAN-13 válido vinculado com sucesso', async () => {
    db.query
      .mockResolvedValueOnce(OWN)                // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [{ id: 'p1' }] })   // produto existe
      .mockResolvedValueOnce({ rows: [] })                // sem duplicata
      .mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto', barcode: '7891000315507', barcode_format: 'EAN-13' }] }); // UPDATE
    const res = await request(app)
      .post('/api/v1/companies/c1/products/p1/barcode')
      .set(auth).send({ code: '7891000315507', format: 'EAN-13' });
    expect(res.status).toBe(200);
    expect(res.body.product.barcode).toBe('7891000315507');
  });
});

describe('GET /companies/:id/pdv/scan/:code', () => {
  // Scanner (scanner.js) não usa requireCompanyAccess — mocks sem owner prepended

  test('200 match=exact — código encontrado por barcode', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto', barcode: '7891000315507', variants: [] }] });
    const res = await request(app)
      .get('/api/v1/companies/c1/pdv/scan/7891000315507')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('exact');
  });

  test('match=partial — busca textual (4 queries)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })  // query 1: barcode exato
      .mockResolvedValueOnce({ rows: [] })  // query 2: variant barcode
      .mockResolvedValueOnce({ rows: [] })  // query 3: SKU exato
      .mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Camisa Azul' }] }); // query 4: texto
    const res = await request(app)
      .get('/api/v1/companies/c1/pdv/scan/camisa')
      .set(auth);
    expect(res.body.match).toBe('partial');
  });

  test('match=none — nenhum resultado (4 queries vazias)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/v1/companies/c1/pdv/scan/xyz999')
      .set(auth);
    expect(res.body.match).toBe('none');
  });
});
