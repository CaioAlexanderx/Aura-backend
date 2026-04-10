// ============================================================
// QA - Testes de Integracao: Members / RBAC
// invite_email agora e opcional (link aberto sem email)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'owner-id', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';

const OWNER_MOCK   = { rows: [{ role: 'owner' }] };
const CONTEXT_MOCK = { rows: [{ company_name: 'Empresa Teste', inviter_name: 'Caio' }] };

describe('GET /members', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna lista com campos esperados', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce(OWNER_MOCK).mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('members');
    expect(res.body).toHaveProperty('monthly_cost');
  });

  test('monthly_cost=0 com 1 membro (titular)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [{ id:'m1', status:'active', is_active:true }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.body.monthly_cost).toBe(0);
  });

  test('monthly_cost=19 com 2 membros ativos', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [
        { id:'m1', status:'active', is_active:true },
        { id:'m2', status:'active', is_active:true },
      ]});
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.body.monthly_cost).toBe(19);
  });
});

describe('POST /members/invite', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem invite_email — invite_email agora e opcional, mas route ainda valida body', async () => {
    // Com invite_email vazio, deve funcionar (link aberto)
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce(CONTEXT_MOCK)  // contexto email
      .mockResolvedValueOnce({ rows: [] })  // busca usuario (email null)
      .mockResolvedValueOnce({ rows: [{ id:'m2', invite_token:'tok', invite_email: null, status:'pending' }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ role_label: 'colaborador' }); // sem email
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invite_url');
  });

  test('retorna 409 se email ja tem convite', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [{ id:'m1', status:'pending' }] }); // duplicata
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ invite_email:'joao@teste.com' });
    expect(res.status).toBe(409);
  });

  test('cria convite com email com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [] })   // check duplicata
      .mockResolvedValueOnce(CONTEXT_MOCK)   // contexto email
      .mockResolvedValueOnce({ rows: [] })   // busca usuario existente
      .mockResolvedValueOnce({ rows: [{
        id: 'm2', invite_token: 'tok-abc',
        invite_email: 'joao@teste.com', role_label: 'colaborador', status: 'pending',
      }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ invite_email:'joao@teste.com', role_label:'colaborador' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invite_url');
  });

  test('cria convite SEM email (link aberto)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      // sem check duplicata (email null)
      .mockResolvedValueOnce(CONTEXT_MOCK)  // contexto
      .mockResolvedValueOnce({ rows: [] })  // busca usuario (skip)
      .mockResolvedValueOnce({ rows: [{
        id: 'm3', invite_token: 'tok-open',
        invite_email: null, role_label: 'colaborador', status: 'pending',
      }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ role_label: 'colaborador' }); // sem email
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invite_url');
  });
});

describe('GET /members/billing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna resumo de cobranca', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [{ total:'3' }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members/billing`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.price_per_member).toBe(19);
    expect(res.body.monthly_total).toBe(38);
  });
});

describe('GET /members/roles', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna templates', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [{ id:'r1', name:'Vendedor', is_default:true, type:'global' }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members/roles`).set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
  });
});
