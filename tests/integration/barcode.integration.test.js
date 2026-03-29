// ============================================================
// QA — Testes de Integração: Barcode (arquivo legado)
// fix: requireCompanyAccess consome 1 db.query antes do handler
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'u1', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';
const pid   = '00000000-0000-0000-0000-000000000002';

// helper: mock do requireCompanyAccess
const OWN = { rows: [{ role: 'owner' }] };

describe('POST /products/:pid/barcode', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem code e format', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce(OWN); // requireCompanyAccess antes do handler
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products/${pid}/barcode`)
      .set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('retorna 400 com format inválido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce(OWN);
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products/${pid}/barcode`)
      .set(auth).send({ code:'123', format:'INVALID' });
    expect(res.status).toBe(400);
  });

  test('retorna 400 com EAN-13 dígito verificador errado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce(OWN);
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products/${pid}/barcode`)
      .set(auth).send({ code:'7891000315508', format:'EAN-13' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido/i);
  });

  test('aceita EAN-13 válido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWN)                // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [{ id:pid }] })           // produto existe
      .mockResolvedValueOnce({ rows: [] })                     // sem duplicata
      .mockResolvedValueOnce({ rows: [{ id:pid, name:'Prod', barcode:'7891000315507', barcode_format:'EAN-13' }] }); // UPDATE
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products/${pid}/barcode`)
      .set(auth).send({ code:'7891000315507', format:'EAN-13' });
    expect(res.status).toBe(200);
    expect(res.body.product.barcode).toBe('7891000315507');
  });

  test('aceita QR Code', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWN)
      .mockResolvedValueOnce({ rows: [{ id:pid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id:pid, name:'P', barcode:'qr-data-123', barcode_format:'QR' }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products/${pid}/barcode`)
      .set(auth).send({ code:'qr-data-123', format:'QR' });
    expect(res.status).toBe(200);
  });
});

describe('GET /pdv/scan/:code', () => {
  // Scanner não usa requireCompanyAccess — mocks sem owner prepended
  beforeEach(() => jest.clearAllMocks());

  test('exact match por barcode', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id:pid, name:'Produto', price:29.90, variants:[] }] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/scan/7891000315507`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('exact');
  });

  test('partial match por nome — 4 queries', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id:pid, name:'Camiseta', price:59.90 }] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/scan/Camiseta`)
      .set(auth);
    expect(res.body.match).toBe('partial');
  });

  test('sem resultado — 4 queries vazias', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/pdv/scan/xxxxxx`)
      .set(auth);
    expect(res.body.match).toBe('none');
  });
});
