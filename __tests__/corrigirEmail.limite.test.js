// ============================================================
// Limite de "Corrigir meu e-mail" (26/10/2026)
//
// POST /auth/corrigir-email: no maximo 5 tentativas por hora por usuario e
// 5 por hora por IP. O PR #904 (tq-71) mostrou que limitador registrado
// depois da rota nunca roda; este teste prova que os dois rodam ANTES do
// handler: a 6a tentativa leva 429 sem abrir conexao com o banco.
//
// Mesmo jeito do authLimiter.test.js: sobe o app DE VERDADE com
// NODE_ENV=development, porque os limitadores se desligam em NODE_ENV=test.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

const LIMITE = 5;
const SECRET = 'aura-test-secret-2026';

let app;
let query;   // o jest.fn do mock do banco
let connect; // idem
let ambienteOriginal;

beforeAll(() => {
  ambienteOriginal = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  process.env.SUPABASE_DB_URL = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
  // Fora de NODE_ENV=test o observador de erros (services/errosPorMinuto)
  // embrulha db.query; guardamos os jest.fn originais antes de subir o app.
  const db = require('../src/config/database');
  query = db.query;
  connect = db.connect;
  app = require('../src/app');
});

afterAll(() => {
  process.env.NODE_ENV = ambienteOriginal;
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
  connect.mockClear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

function token(userId) {
  return 'Bearer ' + jwt.sign({ id: userId, role: 'client' }, SECRET, { expiresIn: '1h' });
}

/** Railway poe o IP do cliente no fim do X-Forwarded-For (trust proxy 1). */
function corrigir(userId, ip, email) {
  return request(app).post('/api/v1/auth/corrigir-email')
    .set('X-Forwarded-For', ip)
    .set('Host', 'aura-backend-production-f805.up.railway.app')
    .set('Authorization', token(userId))
    .send({ email });
}

describe('POST /auth/corrigir-email — limite', () => {
  test('por usuario: a 6a tentativa na hora leva 429, mesmo trocando de IP, e nao chega na rota', async () => {
    const status = [];
    // E-mail invalido: 400 antes do banco. Conta como tentativa do mesmo jeito.
    for (let i = 0; i < LIMITE; i++) {
      const r = await corrigir('user-limite-1', `198.51.100.${10 + i}`, 'invalido');
      status.push(r.status);
    }
    expect(status).toEqual(Array(LIMITE).fill(400));

    const r = await corrigir('user-limite-1', '198.51.100.99', 'certo@gmail.com');
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('CORRIGIR_EMAIL_LIMITE');
    expect(r.body.error).toMatch(/muitas vezes/);
    expect(connect).not.toHaveBeenCalled();
  });

  test('por IP: a 6a tentativa do mesmo IP leva 429, mesmo com outro usuario', async () => {
    const ip = '198.51.100.200';
    for (let i = 0; i < LIMITE; i++) {
      const r = await corrigir(`user-ip-${i}`, ip, 'invalido');
      expect(r.status).toBe(400);
    }
    const r = await corrigir('user-ip-novo', ip, 'certo@gmail.com');
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('CORRIGIR_EMAIL_LIMITE');
    expect(connect).not.toHaveBeenCalled();
  });

  test('outro usuario em outro IP nao e afetado', async () => {
    const r = await corrigir('user-limpo', '198.51.100.250', 'invalido');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMAIL_INVALIDO');
  });
});
