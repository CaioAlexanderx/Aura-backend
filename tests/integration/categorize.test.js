// ============================================================
// QA-03 — Testes de Integração: CORE-04 Categorização via IA
// Haiku é mockado — testes validam rotas, fallback e aplicação
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const txId   = '00000000-0000-0000-0000-000000000099';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

// Sem ANTHROPIC_API_KEY no env de teste → sempre usa fallback gracioso
describe('POST /companies/:id/transactions/categorize — lote', () => {
  test('400 — descriptions ausente', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/categorize`)
      .set(auth).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });

  test('400 — array vazio', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/categorize`)
      .set(auth).send({ descriptions: [] });
    expect(res.status).toBe(400);
  });

  test('400 — mais de 50 descrições', async () => {
    const big = Array.from({ length: 51 }, (_, i) => `desc ${i}`);
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/categorize`)
      .set(auth).send({ descriptions: big });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/50/i);
  });

  test('200 — fallback gracioso sem ANTHROPIC_API_KEY', async () => {
    // Em ambiente de teste, a chave não está configurada
    // categorizeWithHaiku retorna { fallback: true, suggested_category: 'outros' }
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/categorize`)
      .set(auth).send({ descriptions: ['Aluguel sala comercial', 'Energia elétrica CPFL'] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('categorized');
    expect(res.body).toHaveProperty('available_categories');
    expect(res.body.categorized).toHaveLength(2);
    // Fallback retorna 'outros' para todos sem a chave
    expect(res.body.categorized[0].suggested_category).toBe('outros');
    expect(res.body.categorized[0].fallback).toBe(true);
  });

  test('200 — note de revisão presente na resposta', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/categorize`)
      .set(auth).send({ descriptions: ['Pagamento fornecedor'] });
    expect(res.status).toBe(200);
    expect(res.body.note).toBeDefined();
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/categorize`)
      .send({ descriptions: ['teste'] });
    expect(res.status).toBe(401);
  });
});

describe('POST /companies/:id/transactions/:txId/categorize — individual', () => {
  test('404 — lançamento não encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/${txId}/categorize`)
      .set(auth).send({});
    expect(res.status).toBe(404);
  });

  test('200 — categoriza sem aplicar (apply omitido)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id:txId, description:'Aluguel sala comercial', category:null }],
    });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/${txId}/categorize`)
      .set(auth).send({ apply: false });
    expect(res.status).toBe(200);
    expect(res.body.transaction_id).toBe(txId);
    expect(res.body.suggestion).toBeDefined();
    expect(res.body.applied).toBe(false);
  });

  test('200 — categoriza e aplica (apply: true)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id:txId, description:'Energia CPFL', category:null }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] });                                                        // UPDATE
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/${txId}/categorize`)
      .set(auth).send({ apply: true });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    // Deve ter chamado UPDATE (segunda query)
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/transactions/${txId}/categorize`)
      .send({});
    expect(res.status).toBe(401);
  });
});
