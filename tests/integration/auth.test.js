// ============================================================
// QA — Testes de Integração: Auth (B-04)
// ============================================================
const request = require('supertest');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

describe('POST /api/v1/auth/register', () => {
  test('400 — campos obrigatórios ausentes', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/obrigat/);
  });

  test('400 — senha curta', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'João', email: 'a@b.com', password: '123', company_name: 'Loja' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 caracteres/);
  });

  test('400 — e-mail inválido', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'João', email: 'invalido', password: 'senha1234', company_name: 'Loja' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/E-mail inv/);
  });

  test('400 — plano inválido', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'João', email: 'a@b.com', password: 'senha1234', company_name: 'Loja', plan: 'enterprise' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Plano inv/);
  });

  test('201 — registro bem-sucedido retorna token sem password_hash', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // check email
        .mockResolvedValueOnce({ rows: [{ id: 'u1', name: 'João', email: 'a@b.com', role: 'client', created_at: new Date() }] }) // INSERT user
        .mockResolvedValueOnce({ rows: [{ id: 'c1', legal_name: 'Loja', trade_name: 'Loja', plan: 'essencial', onboarding_step: 'cnpj' }] }) // INSERT company
        .mockResolvedValueOnce({ rows: [] }) // INSERT member
        .mockResolvedValueOnce(undefined), // COMMIT
      release: jest.fn(),
    };
    db.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'João', email: 'a@b.com', password: 'senha1234', company_name: 'Loja' });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.company.id).toBe('c1');
  });

  test('409 — e-mail já cadastrado', async () => {
    const mockClient = {
      query: jest.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'existing' }] }) // e-mail existe
        .mockResolvedValueOnce(undefined), // ROLLBACK
      release: jest.fn(),
    };
    db.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'João', email: 'a@b.com', password: 'senha1234', company_name: 'Loja' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/já cadastrado/);
  });
});

describe('POST /api/v1/auth/login', () => {
  test('400 — campos ausentes', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  test('401 — usuário não encontrado (mensagem genérica)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'naoexiste@ok.com', password: 'qualquer' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Credenciais inválidas');
  });

  test('403 — conta desativada', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'u1', password_hash: '$2b$12$x', role: 'client', is_active: false, company_id: null }]
    });
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'a@b.com', password: 'senha1234' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/desativada/);
  });

  test('401 — sem token em /me retorna 401', async () => {
    const res = await request(app).post('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});
