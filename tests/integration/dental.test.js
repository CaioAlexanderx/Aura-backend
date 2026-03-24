const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'u1', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';
const patId = '00000000-0000-0000-0000-000000000010';

describe('POST /dental/patients — LGPD', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem full_name', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/patients`).set(auth).send({ lgpd_consent: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full_name/i);
  });

  test('retorna 400 sem consentimento LGPD', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/patients`).set(auth).send({ full_name: 'Maria', lgpd_consent: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lgpd/i);
  });

  test('retorna 400 sem lgpd_consent', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/patients`).set(auth).send({ full_name: 'Maria' });
    expect(res.status).toBe(400);
  });

  test('cria paciente com lgpd_consent=true', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id:patId, full_name:'Maria', lgpd_consent:true, lgpd_consent_at: new Date() }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/patients`).set(auth).send({ full_name:'Maria', lgpd_consent:true });
    expect(res.status).toBe(201);
    expect(res.body.patient.lgpd_consent).toBe(true);
  });
});

describe('POST /dental/appointments — validação', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem patient_id', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/appointments`).set(auth).send({ scheduled_at: '2026-04-15T09:00:00Z' });
    expect(res.status).toBe(400);
  });

  test('retorna 400 sem scheduled_at', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/appointments`).set(auth).send({ patient_id: patId });
    expect(res.status).toBe(400);
  });

  test('cria agendamento com dados válidos', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id:'appt-1', patient_id:patId, status:'agendado', scheduled_at: new Date() }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/appointments`).set(auth).send({ patient_id:patId, scheduled_at:'2026-04-15T09:00:00Z' });
    expect(res.status).toBe(201);
    expect(res.body.appointment.status).toBe('agendado');
  });
});

describe('GET /dental/sign/:token', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 410 para token inválido', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/dental/sign/token-inexistente');
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expirado|inválido/i);
  });
});
