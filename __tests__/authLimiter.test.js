// ============================================================
// Limitador de tentativas de /auth (tq-71, 26/10/2026)
//
// Medido em 26/10: o limitador de /auth/login, /auth/register e
// /auth/forgot-password era registrado em src/app.js DEPOIS de as rotas
// de /auth estarem montadas no apiRouter. O Express roda as camadas na
// ordem: a rota respondia antes e o limitador nunca rodava. Medido com
// este teste antes da correcao: 21 logins errados seguidos do mesmo IP
// davam 21 x 401, nenhum 429; register e forgot-password idem.
//
// Este teste sobe o app DE VERDADE com NODE_ENV=development, porque os
// limitadores se desligam em NODE_ENV=test.
// ============================================================
'use strict';

const request = require('supertest');

const LIMITE = 20; // 20 tentativas por IP a cada 15 minutos (o limite de sempre)

let app;
let query; // o jest.fn do mock do banco
let ambienteOriginal;

beforeAll(() => {
  ambienteOriginal = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
  // Cada arquivo de teste tem o proprio registro de modulos: o app sobe
  // aqui ja lendo NODE_ENV=development.
  // Fora de NODE_ENV=test o observador de erros (services/errosPorMinuto)
  // embrulha db.query; guardamos o jest.fn original, que ele chama.
  query = require('../src/config/database').query;
  app = require('../src/app');
});

afterAll(() => {
  process.env.NODE_ENV = ambienteOriginal;
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] }); // usuario inexistente
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

/** Cada teste usa um IP proprio (o Railway poe o IP do cliente no fim do X-Forwarded-For). */
function deIp(req, ip) {
  return req.set('X-Forwarded-For', ip).set('Host', 'aura-backend-production-f805.up.railway.app');
}

async function tentarLogin(ip, n) {
  const status = [];
  for (let i = 0; i < n; i++) {
    const r = await deIp(request(app).post('/api/v1/auth/login'), ip)
      .send({ email: 'ninguem@exemplo.com.br', password: 'errada' + i });
    status.push(r.status);
  }
  return status;
}

describe('POST /auth/login', () => {
  test('a tentativa 21 seguida do mesmo IP leva 429', async () => {
    const status = await tentarLogin('203.0.113.10', LIMITE + 1);
    expect(status.slice(0, LIMITE)).toEqual(Array(LIMITE).fill(401));
    expect(status[LIMITE]).toBe(429);
  });

  test('o 429 nao consulta o banco nem chega na rota', async () => {
    await tentarLogin('203.0.113.11', LIMITE);
    query.mockClear();
    const r = await deIp(request(app).post('/api/v1/auth/login'), '203.0.113.11')
      .send({ email: 'ninguem@exemplo.com.br', password: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Muitas tentativas/);
    expect(query).not.toHaveBeenCalled();
  });

  test('outro IP segue entrando (o balde e por cliente, nao pelo proxy)', async () => {
    await tentarLogin('203.0.113.12', LIMITE + 1);
    const outro = await tentarLogin('198.51.100.7', 1);
    expect(outro).toEqual([401]);
  });

  test('login certo nao conta: 25 entradas certas do mesmo IP e a seguinte errada ainda leva 401', async () => {
    const hash = require('bcrypt').hashSync('certa', 4);
    // usuario com 2FA: a rota responde 200 logo depois de conferir a senha
    query.mockResolvedValue({ rows: [{
      id: 'u1', name: 'Loja', email: 'loja@exemplo.com.br', password_hash: hash,
      role: 'owner', is_active: true, is_staff: false, totp_enabled: true, email_verified: true,
    }] });
    for (let i = 0; i < 25; i++) {
      const r = await deIp(request(app).post('/api/v1/auth/login'), '203.0.113.14')
        .send({ email: 'loja@exemplo.com.br', password: 'certa' });
      expect(r.status).toBe(200);
    }
    const errada = await deIp(request(app).post('/api/v1/auth/login'), '203.0.113.14')
      .send({ email: 'loja@exemplo.com.br', password: 'errada' });
    expect(errada.status).toBe(401);
  });

  test('o IP vem do fim do X-Forwarded-For: forjar o comeco nao fura o limite', async () => {
    await tentarLogin('203.0.113.13', LIMITE);
    const r = await request(app).post('/api/v1/auth/login')
      .set('X-Forwarded-For', '10.9.8.7, 203.0.113.13')
      .send({ email: 'ninguem@exemplo.com.br', password: 'x' });
    expect(r.status).toBe(429);
  });
});

describe('POST /auth/register e /auth/forgot-password', () => {
  test('register: a tentativa 21 do mesmo IP leva 429', async () => {
    const status = [];
    for (let i = 0; i <= LIMITE; i++) {
      const r = await deIp(request(app).post('/api/v1/auth/register'), '203.0.113.20').send({});
      status.push(r.status);
    }
    expect(status.slice(0, LIMITE)).not.toContain(429);
    expect(status[LIMITE]).toBe(429);
  });

  test('forgot-password: a tentativa 21 do mesmo IP leva 429', async () => {
    const status = [];
    for (let i = 0; i <= LIMITE; i++) {
      const r = await deIp(request(app).post('/api/v1/auth/forgot-password'), '203.0.113.30')
        .send({ email: 'ninguem@exemplo.com.br' });
      status.push(r.status);
    }
    expect(status.slice(0, LIMITE)).toEqual(Array(LIMITE).fill(200));
    expect(status[LIMITE]).toBe(429);
  });
});
