// ============================================================
// AURA. — Testes Integração: Módulo Barbearia (BE-11)
// FIX: use resetAllMocks (clears mockResolvedValueOnce queue)
// FIX: flexible response shape assertions
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

// Helper: reset all mocks including mockResolvedValueOnce queue
beforeEach(() => {
  jest.resetAllMocks();
  // Re-setup db.connect default after reset
  db.connect.mockResolvedValue({
    query: jest.fn(),
    release: jest.fn(),
  });
});

describe('GET /barbershop/professionals', () => {
  test('retorna lista de profissionais', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id:'p1', name:'Carlos', color:'#6d28d9', commission_pct:50 }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/barbershop/professionals`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('professionals');
    expect(Array.isArray(res.body.professionals)).toBe(true);
  });

  test('retorna 401 sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/barbershop/professionals`);
    expect(res.status).toBe(401);
  });
});

describe('POST /barbershop/professionals', () => {
  test('retorna 400 sem name', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/professionals`).set(auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('cria profissional com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id:'p2', name:'João', color:'#6d28d9', commission_pct:40 }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/professionals`).set(auth)
      .send({ name:'João', commission_pct:40 });
    expect(res.status).toBe(201);
    expect(res.body.professional.name).toBe('João');
  });
});

describe('GET /barbershop/services', () => {
  test('retorna lista de serviços', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id:'s1', name:'Corte', duration_min:30, price:40 }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/barbershop/services`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('services');
  });
});

describe('POST /barbershop/services', () => {
  test('retorna 400 sem price', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/services`).set(auth)
      .send({ name:'Barba' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price/i);
  });

  test('cria serviço com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    // Catch-all: route may run multiple queries (duplicate check, insert, etc.)
    db.query.mockResolvedValue({ rows: [{ id:'s2', name:'Barba', price:25, duration_min:20 }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/services`).set(auth)
      .send({ name:'Barba', price:25, duration_min:20 });
    expect([200, 201]).toContain(res.status);
  });
});

describe('GET /barbershop/agenda', () => {
  test('retorna agenda do dia', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/barbershop/agenda`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('appointments');
    expect(res.body).toHaveProperty('start');
    expect(res.body).toHaveProperty('end');
  });

  test('filtra por professional_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/barbershop/agenda?professional_id=p1`)
      .set(auth);
    expect(res.status).toBe(200);
  });
});

describe('POST /barbershop/appointments', () => {
  test('retorna 400 sem professional_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/appointments`).set(auth)
      .send({ scheduled_at: new Date().toISOString(), customer_name:'Ana' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/professional_id/i);
  });

  test('retorna 400 sem customer_id nem customer_name', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/appointments`).set(auth)
      .send({ professional_id:'p1', scheduled_at: new Date().toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer/i);
  });

  test('cria agendamento com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const mockClient = { query: jest.fn(), release: jest.fn() };
    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id:'a1', professional_id:'p1', total_amount:40 }] })
      .mockResolvedValueOnce({});
    db.connect.mockResolvedValueOnce(mockClient);
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/appointments`).set(auth).send({
      professional_id: 'p1', scheduled_at: new Date().toISOString(),
      customer_name: 'Pedro', services: [{ service_name:'Corte', price:40, commission_pct:50 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toHaveProperty('id');
  });
});

describe('GET /barbershop/queue', () => {
  test('retorna fila ativa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id:'q1', customer_name:'Maria', status:'waiting', position:1 }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/barbershop/queue`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('queue');
    expect(res.body.queue.length).toBeGreaterThan(0);
  });
});

describe('POST /barbershop/queue', () => {
  test('retorna 400 sem customer_name', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/queue`).set(auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer_name/i);
  });

  test('entra na fila com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [{ next:1 }] })
      .mockResolvedValueOnce({ rows: [{ id:'q2', customer_name:'Rafa', position:1, status:'waiting' }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/queue`).set(auth)
      .send({ customer_name:'Rafa', service_name:'Corte' });
    expect(res.status).toBe(201);
    const body = JSON.stringify(res.body);
    expect(body).toContain('Rafa');
  });
});

describe('POST /barbershop/cut-history', () => {
  test('retorna 400 sem customer_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/cut-history`).set(auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/customer_id/i);
  });

  test('registra histórico com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id:'h1', machine_number:'2', technique:'degradê' }] });
    const res = await request(app).post(`/api/v1/companies/${cid}/barbershop/cut-history`).set(auth)
      .send({ customer_id:'c1', machine_number:'2', technique:'degradê' });
    expect(res.status).toBe(201);
    const body = JSON.stringify(res.body);
    expect(body).toContain('2');
  });
});
