const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'u1', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';

describe('GET /obligations', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna lista vazia', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/obligations`).set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.obligations)).toBe(true);
  });

  test('retorna obrigações com campos esperados', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id:'ob1', code:'DAS_MEI', description:'DAS-MEI', due_date: new Date(), status:'pending', checkpoint_total:3, checkpoint_done:0, estimated_amount:80.90 }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/obligations`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.obligations[0]).toHaveProperty('code');
    expect(res.body.obligations[0]).toHaveProperty('days_until_due');
    expect(res.body.obligations[0]).toHaveProperty('disclaimer');
    expect(res.body.obligations[0].disclaimer).toMatch(/informativo|transmiss/i);
  });
});

describe('GET /obligations/calendar', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 404 quando empresa não existe', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/obligations/calendar`).set(auth);
    expect(res.status).toBe(404);
  });

  test('filter inválido retorna 400', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/obligations/calendar?filter=invalido`).set(auth);
    expect(res.status).toBe(400);
  });

  test('retorna calendário completo para empresa MEI', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, name: 'João MEI', tax_regime: 'mei', cnae_code: '8650-0/00', annual_revenue: 50000, has_employee: false }] })
      .mockResolvedValueOnce({ rows: [{ code:'DAS_MEI', name_display:'DAS-MEI', frequency:'monthly', due_rule:'day_20', responsible:'aura', filter_label:'aura_resolve', aura_action:'Calcula', checkpoint_total:3 }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/obligations/calendar`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('calendar');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.disclaimer).toMatch(/estimativa|informativo/i);
  });

  test('filter=aura_resolve filtra corretamente', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id:cid, name:'Test', tax_regime:'mei', has_employee:false }] })
      .mockResolvedValueOnce({ rows: [
        { code:'DAS_MEI', name_display:'DAS', frequency:'monthly', due_rule:'day_20', responsible:'aura', filter_label:'aura_resolve', aura_action:'Calcula', checkpoint_total:3 },
        { code:'DASN', name_display:'DASN', frequency:'annual', due_rule:'may_31', responsible:'voce', filter_label:'voce_faz', aura_action:'Prepara', user_action:'Confirma', checkpoint_total:5 },
      ]})
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/obligations/calendar?filter=aura_resolve`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.calendar.every(c => c.filter_label === 'aura_resolve')).toBe(true);
  });
});

describe('POST /obligations/generate', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem reference_month', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/obligations/generate`).set(auth).send({});
    expect(res.status).toBe(400);
  });
});
