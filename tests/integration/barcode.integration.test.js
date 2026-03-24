const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'u1', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';
const pid   = '00000000-0000-0000-0000-000000000002';

describe('POST /products/:pid/barcode', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem code e format', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/products/${pid}/barcode`).set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('retorna 400 com format inválido', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/products/${pid}/barcode`).set(auth).send({ code:'123', format:'INVALID' });
    expect(res.status).toBe(400);
  });

  test('retorna 400 com EAN-13 dígito verificador errado', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/products/${pid}/barcode`).set(auth).send({ code:'7891000315508', format:'EAN-13' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido/i);
  });

  test('aceita EAN-13 válido', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id:pid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id:pid, name:'Prod', barcode:'7891000315507', barcode_format:'EAN-13' }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/products/${pid}/barcode`).set(auth).send({ code:'7891000315507', format:'EAN-13' });
    expect(res.status).toBe(200);
    expect(res.body.product.barcode).toBe('7891000315507');
  });

  test('aceita QR Code', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id:pid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id:pid, name:'P', barcode:'qr-data', barcode_format:'QR' }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/products/${pid}/barcode`).set(auth).send({ code:'qr-data-123', format:'QR' });
    expect(res.status).toBe(200);
  });
});

describe('GET /pdv/scan/:code', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exact match por barcode', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id:pid, name:'Produto', price:29.90 }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/scan/7891000315507`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('exact');
  });

  test('partial match por nome (207)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id:pid, name:'Camiseta', price:59.90 }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/scan/Camiseta`).set(auth);
    expect(res.status).toBe(207);
    expect(res.body.match).toBe('partial');
  });

  test('retorna 404 quando nada encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/scan/xxxxxx`).set(auth);
    expect(res.status).toBe(404);
    expect(res.body.match).toBe('none');
  });
});
