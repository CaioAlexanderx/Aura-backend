// ============================================================
// AURA. — Testes: GET /auth/my-permissions (Multi-CNPJ)
//
// O que estes testes travam:
//
//   1. A empresa vem do JWT. Dono de A (mais antiga) e so membro em B: com o
//      token de B, recebe o papel e as permissoes de B — nao vira owner.
//   2. Com o token de A, continua dono (o fix nao inverte o bug).
//   3. Dono por companies.owner_id sem member row continua dono.
//   4. Token de empresa sem acesso (membro removido) e fail-closed.
//   5. "Todas as empresas" = intersecao: modulo so aparece se liberado em
//      todas; dono de todas = is_owner.
//   6. Sem empresa no token = acesso total (historico).
//
// O banco e uma tabelinha em memoria que responde pelo CONTEUDO do SQL
// (filtro por empresa, ORDER BY created_at LIMIT 1), nunca fila posicional —
// assim a query antiga tambem recebe resposta realista e reprova pelo motivo
// certo.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const myPermissionsRouter = require('../../src/routes/myPermissions');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const SECRET = 'aura-test-secret-2026';
const USER = 'u-1';
const A = 'company-a';
const B = 'company-b';
const C = 'company-c';

// Linhas "companies LEFT JOIN company_members" do USER, ja filtradas por ativo.
let table;
function linha({ company_id, created_at, is_company_owner, role_label, permissions }) {
  return { company_id, plan: 'negocio', created_at, is_company_owner, role_label, permissions };
}

function fakeQuery(sql, params) {
  let rows = table.slice();
  if (/c\.id\s*=\s*\$2/.test(sql)) rows = rows.filter((r) => r.company_id === params[1]);
  if (/ORDER BY c\.created_at ASC/i.test(sql)) {
    rows = rows
      .filter((r) => r.role_label != null) // query antiga era JOIN estrito em company_members
      .sort((x, y) => x.created_at.localeCompare(y.created_at));
  }
  if (/LIMIT 1/i.test(sql)) rows = rows.slice(0, 1);
  return Promise.resolve({ rows });
}

function tokenPara(payload) {
  return `Bearer ${jwt.sign({ id: USER, role: 'user', ...payload }, SECRET, { expiresIn: '1h' })}`;
}

function get(payload) {
  return request(app).get('/api/v1/auth/my-permissions').set('Authorization', tokenPara(payload));
}

const app = express();
app.use('/api/v1/auth', myPermissionsRouter);

beforeEach(() => {
  jest.resetAllMocks();
  db.query.mockImplementation(fakeQuery);
  table = [
    linha({ company_id: A, created_at: '2026-01-01', is_company_owner: true, role_label: 'owner', permissions: null }),
    linha({
      company_id: B, created_at: '2026-05-01', is_company_owner: false, role_label: 'vendedor',
      permissions: JSON.stringify({ pdv: true, vendas: true, financeiro: false }),
    }),
  ];
});

describe('GET /auth/my-permissions — empresa do JWT', () => {
  test('dono de A e membro em B: com o token de B recebe o papel de B', async () => {
    const res = await get({ company: B, consolidated_view: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      role: 'vendedor',
      is_owner: false,
      company_id: B,
      permissions: { pdv: true, vendas: true, financeiro: false },
    });
  });

  test('com o token de A continua dono', async () => {
    const res = await get({ company: A, consolidated_view: false });
    expect(res.body).toMatchObject({ role: 'owner', is_owner: true, permissions: null, company_id: A });
  });

  test('dono por companies.owner_id sem member row e dono', async () => {
    table.push(linha({ company_id: C, created_at: '2026-06-01', is_company_owner: true, role_label: null, permissions: null }));
    const res = await get({ company: C, consolidated_view: false });
    expect(res.body).toMatchObject({ role: 'owner', is_owner: true, permissions: null, company_id: C });
  });

  test('member row com role owner (sem owner_id) e dono', async () => {
    table[1] = { ...table[1], role_label: 'owner' };
    const res = await get({ company: B, consolidated_view: false });
    expect(res.body).toMatchObject({ role: 'owner', is_owner: true, permissions: null });
  });

  test('permissions ja em objeto (jsonb) passa direto', async () => {
    table[1] = { ...table[1], permissions: { pdv: true } };
    const res = await get({ company: B, consolidated_view: false });
    expect(res.body.permissions).toEqual({ pdv: true });
  });

  test('empresa do token sem acesso e fail-closed, nao acesso total', async () => {
    const res = await get({ company: C, consolidated_view: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ is_owner: false, permissions: {}, no_access: true, company_id: C });
  });

  test('admin da plataforma sem member row mantem acesso total', async () => {
    const res = await get({ company: C, consolidated_view: false, role: 'admin' });
    expect(res.body).toMatchObject({ is_owner: true, permissions: null });
  });
});

describe('GET /auth/my-permissions — "Todas as empresas"', () => {
  test('intersecao: so o que B libera aparece; painel segue o default', async () => {
    const res = await get({ company: null, consolidated_view: true });
    expect(res.body).toMatchObject({ role: 'member', is_owner: false, company_id: null, consolidated_view: true, companies_count: 2 });
    expect(res.body.permissions).toEqual({ painel: true, pdv: true, vendas: true, financeiro: false });
  });

  test('membro em duas empresas: chave precisa estar liberada nas duas', async () => {
    table[0] = { ...table[0], is_company_owner: false, role_label: 'gerente', permissions: { pdv: true, financeiro: true, painel: false } };
    const res = await get({ company: null, consolidated_view: true });
    expect(res.body.permissions).toEqual({ painel: false, pdv: true, vendas: false, financeiro: false });
  });

  test('dono de todas = is_owner, permissions null', async () => {
    table[1] = { ...table[1], is_company_owner: true };
    const res = await get({ company: null, consolidated_view: true });
    expect(res.body).toMatchObject({ role: 'owner', is_owner: true, permissions: null });
  });

  test('membro sem restricao gravada nao restringe o consolidado', async () => {
    table[1] = { ...table[1], permissions: null };
    const res = await get({ company: null, consolidated_view: true });
    expect(res.body).toMatchObject({ is_owner: false, permissions: null });
  });
});

describe('GET /auth/my-permissions — sem empresa', () => {
  test('token sem empresa = acesso total', async () => {
    table = [];
    const res = await get({ company: null, consolidated_view: false });
    expect(res.body).toEqual({ role: 'owner', permissions: null, is_owner: true });
  });

  test('erro do banco = 500', async () => {
    db.query.mockRejectedValue(new Error('boom'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get({ company: A, consolidated_view: false });
    expect(res.status).toBe(500);
  });
});
