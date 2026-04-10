// ============================================================
// QA - Testes de Integracao: Members / RBAC
// fix: requireCompanyAccess consome 1 db.query antes do handler
// fix: inviteMember agora tem query de contexto (empresa + convidante)
//      para o email de convite — adicionado mock extra na cadeia
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'owner-id', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';

const OWNER_MOCK    = { rows: [{ role: 'owner' }] };
const CONTEXT_MOCK  = { rows: [{ company_name: 'Empresa Teste', inviter_name: 'Caio' }] };

describe('GET /members', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna lista com campos esperados', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)         // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [] });       // listMembers
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('members');
    expect(res.body).toHaveProperty('monthly_cost');
  });

  test('monthly_cost=0 com 1 membro (titular)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [{ id:'m1', status:'active', is_active:true }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.body.monthly_cost).toBe(0);
  });

  test('monthly_cost=19 com 2 membros ativos', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
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

  test('retorna 400 sem invite_email', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce(OWNER_MOCK);
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ role_label:'vendedor' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invite_email/i);
  });

  test('retorna 409 se email ja tem convite', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)                          // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [{ id:'m1', status:'pending' }] }); // check duplicata
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ invite_email:'joao@teste.com' });
    expect(res.status).toBe(409);
  });

  test('cria convite com sucesso', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess (private router)
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)     // requireCompanyAccess (members route)
      .mockResolvedValueOnce({ rows: [] })   // check duplicata
      // FIX: nova query de contexto adicionada para o email (SELECT company_name, inviter_name)
      .mockResolvedValueOnce(CONTEXT_MOCK)   // busca nome da empresa + convidante para o email
      .mockResolvedValueOnce({ rows: [] })   // busca usuario existente (userId para vincular)
      .mockResolvedValueOnce({ rows: [{     // INSERT company_members
        id: 'm2', invite_token: 'tok-abc',
        invite_email: 'joao@teste.com', role_label: 'vendedor', status: 'pending',
      }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ invite_email:'joao@teste.com', role_label:'vendedor' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invite_url');
  });
});

describe('GET /members/billing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna resumo de cobranca', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)                         // requireCompanyAccess
      .mockResolvedValueOnce({ rows: [{ total:'3' }] });         // countActiveMembers
    const res = await request(app).get(`/api/v1/companies/${cid}/members/billing`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.price_per_member).toBe(19);
    expect(res.body.monthly_total).toBe(38); // (3-1) * 19
  });
});

describe('GET /members/roles', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna templates', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce(OWNER_MOCK)
      .mockResolvedValueOnce({ rows: [{ id:'r1', name:'Vendedor', is_default:true, type:'global' }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members/roles`).set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
  });
});
