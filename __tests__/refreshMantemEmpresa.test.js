// ============================================================
// AURA. — POST /auth/refresh mantém a empresa escolhida
//
// Defeito 09/11/2026: depois de 1 h (vida do access token) a empresa
// escolhida no seletor voltava sozinha para a principal ou o consolidado,
// porque o /refresh sempre assinava com o contexto padrão.
//
// Este teste usa a checagem de acesso DE VERDADE (services/empresaComAcesso)
// sobre um banco falso que imita o WHERE da consulta: empresa ativa e a
// pessoa é dona ou membro ativo.
// ============================================================
'use strict';

const jwt = require('jsonwebtoken');
const s = require('../src/services/refreshDeSessao');
const { buscarEmpresaComAcesso, SQL_EMPRESA_COM_ACESSO } = require('../src/services/empresaComAcesso');

const SECRET = 'segredo-de-teste';
const ANA = '11111111-1111-4111-8111-111111111111';   // dona de A e B; membro de C
const BETO = '22222222-2222-4222-8222-222222222222';  // dono de X (outra conta)
const STAFF = '33333333-3333-4333-8333-333333333333'; // staff, membro só de C

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // principal da Ana
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // segunda empresa da Ana
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // dojô; Ana é membro
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // de outra conta

function criarMundo() {
  return {
    users: {
      [ANA]: { id: ANA, role: 'user', is_staff: false },
      [BETO]: { id: BETO, role: 'user', is_staff: false },
      [STAFF]: { id: STAFF, role: 'user', is_staff: true },
    },
    companies: [
      { id: A, owner_id: ANA, is_active: true, is_primary: true, plan: 'essencial', created_at: '2026-01-01' },
      { id: B, owner_id: ANA, is_active: true, is_primary: false, plan: 'negocio', created_at: '2026-02-01' },
      { id: C, owner_id: BETO, is_active: true, is_primary: true, plan: 'expansao', vertical: 'karate_dojo', federation_id: X, created_at: '2026-03-01' },
      { id: X, owner_id: BETO, is_active: true, is_primary: false, plan: 'negocio', created_at: '2026-01-15' },
    ],
    members: [
      { company_id: C, user_id: ANA, status: 'active', is_active: true, role_label: 'vendedor' },
      { company_id: C, user_id: STAFF, status: 'active', is_active: true, role_label: 'gerente' },
    ],
  };
}

// A regra do WHERE de SQL_EMPRESA_COM_ACESSO, em memória.
function acessoA(m, userId, c) {
  if (!c.is_active) return null;
  if (c.owner_id === userId) return 'owner';
  const mb = m.members.find((x) => x.company_id === c.id && x.user_id === userId && x.status === 'active' && x.is_active);
  return mb ? (mb.role_label || 'member') : null;
}

function criarDb(m, { falharEmpresa = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (/FROM refresh_tokens/.test(sql)) return { rows: [] };
      if (/FROM users/.test(sql)) return { rows: m.users[params[0]] ? [m.users[params[0]]] : [] };
      if (sql === SQL_EMPRESA_COM_ACESSO) {
        if (falharEmpresa) throw new Error('timeout do pooler');
        const [companyId, userId] = params;
        const c = m.companies.find((x) => x.id === companyId);
        const papel = c ? acessoA(m, userId, c) : null;
        return { rows: papel ? [{ ...c, role: papel, member_role: papel }] : [] };
      }
      throw new Error('sql inesperado: ' + sql);
    },
  };
}

// O resolveDefaultContext de sempre: 1 empresa = ela; 2+ = consolidado.
function contextoPadrao(m) {
  return async (userId) => {
    const minhas = m.companies.filter((c) => acessoA(m, userId, c))
      .sort((a, b) => (b.is_primary - a.is_primary) || a.created_at.localeCompare(b.created_at));
    if (!minhas.length) return { count: 0, primary: null, consolidated: false, effectivePlan: 'essencial' };
    if (minhas.length === 1) return { count: 1, primary: minhas[0], consolidated: false, effectivePlan: minhas[0].plan };
    return { count: minhas.length, primary: minhas[0], consolidated: true, effectivePlan: 'negocio' };
  };
}

const karate = (c) => (c && c.vertical === 'karate_dojo'
  ? { federation_id: c.federation_id, karate_role: c.member_role, dojo_id: c.id }
  : { federation_id: null, karate_role: null, dojo_id: null });

async function refresh(m, userId, empresaPedida, { db } = {}) {
  const conn = db || criarDb(m);
  const token = s.assinarRefresh({ id: userId }, SECRET, { deslizante: false }).token;
  const r = await s.processarRefresh({
    token,
    req: { headers: { 'user-agent': 'teste' }, ip: '127.0.0.1' },
    db: conn,
    secret: SECRET,
    resolveDefaultContext: contextoPadrao(m),
    resolveKarateContext: karate,
    signAccessToken: (p) => jwt.sign({ ...p, type: 'access' }, SECRET, { expiresIn: '1h' }),
    empresaPedida,
    buscarEmpresaComAcesso: (u, cid) => buscarEmpresaComAcesso(conn, u, cid),
  });
  return { r, access: r.body && r.body.token ? jwt.verify(r.body.token, SECRET) : null, conn };
}

describe('refresh com a empresa escolhida', () => {
  test('empresa com acesso: o token novo continua nela, com o plano dela', async () => {
    const m = criarMundo();
    const { r, access } = await refresh(m, ANA, B);
    expect(r.status).toBe(200);
    expect(access.company).toBe(B);
    expect(access.consolidated_view).toBe(false);
    expect(access.plan).toBe('negocio');
    expect(r.body.consolidated_view).toBe(false);
    expect(r.body.current_company_id).toBe(B);
  });

  test('empresa em que é membro (dojô): mantém, com o contexto do karatê dela', async () => {
    const m = criarMundo();
    const { access } = await refresh(m, ANA, C);
    expect(access.company).toBe(C);
    expect(access.plan).toBe('expansao');
    expect(access.dojo_id).toBe(C);
    expect(access.federation_id).toBe(X);
    expect(access.karate_role).toBe('vendedor');
  });

  test('removida da empresa: cai no padrão de hoje', async () => {
    const m = criarMundo();
    m.members.find((x) => x.company_id === C && x.user_id === ANA).status = 'removed';
    const { access, r } = await refresh(m, ANA, C);
    expect(access.company).toBeNull(); // Ana tem A e B: padrão é o consolidado
    expect(access.consolidated_view).toBe(true);
    expect(r.body.current_company_id).toBeNull();
  });

  test('membro desativado (is_active=false) e empresa inativa: caem no padrão', async () => {
    const m = criarMundo();
    m.members.find((x) => x.company_id === C && x.user_id === ANA).is_active = false;
    expect((await refresh(m, ANA, C)).access.company).toBeNull();
    const m2 = criarMundo();
    m2.companies.find((c) => c.id === B).is_active = false;
    m2.members = m2.members.filter((x) => x.user_id !== ANA);
    const { access } = await refresh(m2, ANA, B);
    expect(access.company).toBe(A); // sobra só A: padrão é ela
  });

  test('empresa de outra conta: recusada, nunca assinada', async () => {
    const m = criarMundo();
    const { access, r } = await refresh(m, ANA, X);
    expect(access.company).not.toBe(X);
    expect(access.consolidated_view).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(X);
  });

  test('id estranho no corpo: padrão, sem ir ao banco com ele', async () => {
    const m = criarMundo();
    for (const lixo of ['1 OR 1=1', 'nao-e-uuid', 42, { id: B }, '']) {
      const { access, conn } = await refresh(m, ANA, lixo);
      expect(access.consolidated_view).toBe(true);
      expect(conn.chamadas.some((q) => q.sql === SQL_EMPRESA_COM_ACESSO)).toBe(false);
    }
  });

  test('erro de banco ao conferir a empresa: 503, não pula de empresa', async () => {
    const m = criarMundo();
    const { r } = await refresh(m, ANA, B, { db: criarDb(m, { falharEmpresa: true }) });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('REFRESH_UNAVAILABLE');
    expect(r.limparCookie).toBeFalsy();
  });
});

describe('consolidado', () => {
  test("'all' com 2+ empresas: continua consolidado", async () => {
    const m = criarMundo();
    const { access, r } = await refresh(m, ANA, 'all');
    expect(access.company).toBeNull();
    expect(access.consolidated_view).toBe(true);
    expect(r.body.consolidated_view).toBe(true);
    expect(r.body.current_company_id).toBeNull();
    expect(access.dojo_id).toBeNull();
  });

  test("'all' com 1 empresa só: a empresa (consolidado exige 2+, como no switch)", async () => {
    const m = criarMundo();
    m.companies.find((c) => c.id === B).is_active = false;
    m.members = m.members.filter((x) => x.user_id !== ANA);
    const { access } = await refresh(m, ANA, 'all');
    expect(access.company).toBe(A);
    expect(access.consolidated_view).toBe(false);
  });
});

describe('sem o campo (app antigo): igual a hoje', () => {
  test.each([[undefined], [null]])('company_id=%p usa o contexto padrão', async (vazio) => {
    const m = criarMundo();
    const comCampo = await refresh(m, ANA, vazio);
    expect(comCampo.access.consolidated_view).toBe(true);
    expect(comCampo.access.company).toBeNull();
    expect(comCampo.conn.chamadas.some((q) => q.sql === SQL_EMPRESA_COM_ACESSO)).toBe(false);
  });

  test('sem buscarEmpresaComAcesso injetado: ignora o campo', async () => {
    const m = criarMundo();
    const token = s.assinarRefresh({ id: ANA }, SECRET, { deslizante: false }).token;
    const r = await s.processarRefresh({
      token, req: { headers: {}, ip: '127.0.0.1' }, db: criarDb(m), secret: SECRET,
      resolveDefaultContext: contextoPadrao(m), resolveKarateContext: karate,
      signAccessToken: (p) => jwt.sign({ ...p, type: 'access' }, SECRET, { expiresIn: '1h' }),
      empresaPedida: B,
    });
    expect(jwt.verify(r.body.token, SECRET).consolidated_view).toBe(true);
  });
});

describe('staff: a mesma regra do switch-company (sem atalho)', () => {
  test('staff membro da empresa: mantém, e o token segue staff', async () => {
    const m = criarMundo();
    const { access } = await refresh(m, STAFF, C);
    expect(access.company).toBe(C);
    expect(access.is_staff).toBe(true);
  });

  test('staff pedindo empresa em que não é membro: padrão, nunca assina', async () => {
    const m = criarMundo();
    const { access } = await refresh(m, STAFF, A);
    expect(access.company).toBe(C); // a única dele
    expect(access.is_staff).toBe(true);
  });
});

describe('empresaComAcesso', () => {
  test('consulta com [company_id, user_id], e a regra está no SQL', async () => {
    const chamadas = [];
    const db = { async query(sql, params) { chamadas.push(params); return { rows: [] }; } };
    expect(await buscarEmpresaComAcesso(db, ANA, B)).toBeNull();
    expect(chamadas).toEqual([[B, ANA]]);
    expect(SQL_EMPRESA_COM_ACESSO).toMatch(/c\.is_active = true/);
    expect(SQL_EMPRESA_COM_ACESSO).toMatch(/c\.owner_id = \$2 OR cm\.user_id = \$2/);
    expect(SQL_EMPRESA_COM_ACESSO).toMatch(/cm\.status = 'active' AND cm\.is_active = true/);
  });

  test('lerEmpresaPedida', () => {
    expect(s.lerEmpresaPedida('all')).toBe('all');
    expect(s.lerEmpresaPedida('*')).toBe('all');
    expect(s.lerEmpresaPedida(` ${B} `)).toBe(B);
    expect(s.lerEmpresaPedida('')).toBeNull();
    expect(s.lerEmpresaPedida(undefined)).toBeNull();
    expect(s.lerEmpresaPedida(7)).toBeNull();
  });
});
