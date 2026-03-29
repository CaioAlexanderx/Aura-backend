const request = require('supertest');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

describe('GET /health', () => {
  test('retorna status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('timestamp');
  });
});

describe('GET /health/db', () => {
  test('retorna connected quando banco responde', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('connected');
  });

  test('retorna 503 quando banco falha', async () => {
    db.query.mockRejectedValueOnce(new Error('Connection refused'));
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('unavailable');
  });
});

describe('GET /', () => {
  test('retorna info da API', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Aura. API');
    expect(res.body.status).toBe('online');
  });
});

describe('Rotas inexistentes', () => {
  test('retorna 404 para rota inexistente', async () => {
    const res = await request(app).get('/api/v1/rota-inexistente');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});
