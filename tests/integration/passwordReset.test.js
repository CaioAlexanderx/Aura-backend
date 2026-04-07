// ============================================================
// AURA. — Testes: Esqueci minha senha (S1)
// ============================================================
const request = require('supertest');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

beforeEach(() => jest.resetAllMocks());

jest.mock('../../src/services/mailer', () => ({
  sendVerificationEmail: jest.fn(),
  sendPasswordResetEmail: jest.fn().mockResolvedValue({ messageId: 'test-123' }),
}));

const bcrypt = require('bcrypt');

describe('POST /api/v1/auth/forgot-password', () => {
  test('400 — email ausente', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-mail/i);
  });

  test('200 — email existente envia reset e retorna mensagem generica', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u1', full_name: 'Caio' }] }) // SELECT user
      .mockResolvedValueOnce({ rowCount: 0 }) // UPDATE invalidate old tokens
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT new token
    const { sendPasswordResetEmail } = require('../../src/services/mailer');

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'caio@getaura.com.br' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/link/i);
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  test('200 — email inexistente NAO revela que nao existe', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // user not found

    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'naoexiste@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/link/i);
  });
});

describe('POST /api/v1/auth/reset-password', () => {
  test('400 — token ausente', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ password: 'NovaSenha123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  test('400 — senha curta', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'abc123', password: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8/i);
  });

  test('400 — token invalido ou ja usado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-inexistente', password: 'NovaSenha123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalido/i);
  });

  test('400 — token expirado', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'prt1', user_id: 'u1', email: 'caio@test.com',
        expires_at: new Date(Date.now() - 60000).toISOString(), // expirou 1 min atras
      }],
    });
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-expirado', password: 'NovaSenha123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expirado/i);
  });

  test('200 — token valido reseta senha', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'prt1', user_id: 'u1', email: 'caio@test.com',
          expires_at: new Date(Date.now() + 600000).toISOString(), // valido
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE password
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE token used_at

    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'token-valido-abc', password: 'NovaSenha123' });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/sucesso/i);
  });
});
