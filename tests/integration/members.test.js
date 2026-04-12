// ============================================================
// QA - Testes de Integracao: Members / RBAC
// FIX: resetAllMocks (nao clearAllMocks) para limpar queue de
//      mockResolvedValueOnce entre testes. Cada teste fornece
//      o numero EXATO de mocks para a cadeia de DB calls:
//
//   Middleware (TODOS os endpoints /members):
//     1. private.js requireCompanyAccess() ......... 1 DB call
//     2. private.js requirePlan('negocio',...) ..... 0 DB calls (le JWT)
//     3. members.js requireCompanyAccess({roles}) .. 1 DB call
//   Total middleware = 2 DB calls
//
//   Handler varia por endpoint (ver comentarios inline)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const token = jwt.sign({ id:'owner-id', role:'client', plan:'negocio' }, 'aura-test-secret-2026', { expiresIn:'1h' });
const auth  = { Authorization: `Bearer ${token}` };
const cid   = '00000000-0000-0000-0000-000000000001';

// Mocks reutilizaveis
const MW_ACCESS  = { rows: [{ role: 'owner' }] };  // requireCompanyAccess (both)
const CTX_MOCK   = { rows: [{ company_name: 'Empresa Teste', inviter_name: 'Caio' }] };

describe('GET /members', () => {
  beforeEach(() => jest.resetAllMocks());

  // Middleware: 2 | Handler (listMembers): 1 | Total: 3
  test('retorna lista com campos esperados', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)   // 1. requireCompanyAccess (private.js)
      .mockResolvedValueOnce(MW_ACCESS)   // 2. requireCompanyAccess (members.js)
      .mockResolvedValueOnce({ rows: [] }); // 3. listMembers
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('members');
    expect(res.body).toHaveProperty('monthly_cost');
  });

  test('monthly_cost=0 com 1 membro (titular)', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)
      .mockResolvedValueOnce(MW_ACCESS)
      .mockResolvedValueOnce({ rows: [{ id:'m1', status:'active', is_active:true }] });
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.body.monthly_cost).toBe(0);
  });

  test('monthly_cost=19 com 2 membros ativos', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)
      .mockResolvedValueOnce(MW_ACCESS)
      .mockResolvedValueOnce({ rows: [
        { id:'m1', status:'active', is_active:true },
        { id:'m2', status:'active', is_active:true },
      ]});
    const res = await request(app).get(`/api/v1/companies/${cid}/members`).set(auth);
    expect(res.body.monthly_cost).toBe(19);
  });
});

describe('POST /members/invite', () => {
  beforeEach(() => jest.resetAllMocks());

  // SEM email: Middleware 2 + Handler 2 (context + insert) = 4 total
  test('cria convite SEM email (link aberto)', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)   // 1. requireCompanyAccess (private.js)
      .mockResolvedValueOnce(MW_ACCESS)   // 2. requireCompanyAccess (members.js)
      .mockResolvedValueOnce(CTX_MOCK)    // 3. context query
      .mockResolvedValueOnce({ rows: [{ id:'m2', invite_token:'tok-open', invite_email: null, role_label:'colaborador', status:'pending' }] }); // 4. insert
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ role_label: 'colaborador' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invite_url');
  });

  // COM email duplicado: Middleware 2 + Handler 1 (duplicate check encontra) = 3 total
  test('retorna 409 se email ja tem convite', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)   // 1. requireCompanyAccess (private.js)
      .mockResolvedValueOnce(MW_ACCESS)   // 2. requireCompanyAccess (members.js)
      .mockResolvedValueOnce({ rows: [{ id:'m1', status:'pending' }] }); // 3. duplicate check → found
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ invite_email:'joao@teste.com' });
    expect(res.status).toBe(409);
  });

  // COM email novo: Middleware 2 + Handler 4 (dup check + context + user lookup + insert) = 6 total
  test('cria convite com email com sucesso', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)   // 1. requireCompanyAccess (private.js)
      .mockResolvedValueOnce(MW_ACCESS)   // 2. requireCompanyAccess (members.js)
      .mockResolvedValueOnce({ rows: [] })  // 3. duplicate check → empty (sem duplicata)
      .mockResolvedValueOnce(CTX_MOCK)      // 4. context (company_name + inviter_name)
      .mockResolvedValueOnce({ rows: [] })  // 5. user lookup (email nao tem conta)
      .mockResolvedValueOnce({ rows: [{     // 6. insert RETURNING
        id: 'm2', invite_token: 'tok-abc',
        invite_email: 'joao@teste.com', role_label: 'colaborador', status: 'pending',
      }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/members/invite`)
      .set(auth).send({ invite_email:'joao@teste.com', role_label:'colaborador' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('invite_url');
  });
});

describe('GET /members/billing', () => {
  beforeEach(() => jest.resetAllMocks());

  // Middleware 2 + Handler 1 (countActiveMembers) = 3 total
  test('retorna resumo de cobranca', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)   // 1. requireCompanyAccess (private.js)
      .mockResolvedValueOnce(MW_ACCESS)   // 2. requireCompanyAccess (members.js)
      .mockResolvedValueOnce({ rows: [{ total:'3' }] }); // 3. countActiveMembers
    const res = await request(app).get(`/api/v1/companies/${cid}/members/billing`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.price_per_member).toBe(19);
    expect(res.body.monthly_total).toBe(38);
  });
});

describe('GET /members/roles', () => {
  beforeEach(() => jest.resetAllMocks());

  // Middleware 2 + Handler 1 (query role_templates) = 3 total
  test('retorna templates', async () => {
    db.query
      .mockResolvedValueOnce(MW_ACCESS)   // 1. requireCompanyAccess (private.js)
      .mockResolvedValueOnce(MW_ACCESS)   // 2. requireCompanyAccess (members.js)
      .mockResolvedValueOnce({ rows: [{ id:'r1', name:'Vendedor', is_default:true, type:'global' }] }); // 3. role_templates
    const res = await request(app).get(`/api/v1/companies/${cid}/members/roles`).set(auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
  });
});
