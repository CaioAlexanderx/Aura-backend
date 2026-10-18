// ============================================================
// companies.is_sandbox no login, no /auth/me e na troca de empresa + a chave
// de módulo black_friday (card f4-12, 18/10/2026)
//
// O app (app#1061) libera a página Black Friday para conta de teste lendo
// `company.is_sandbox` e usa a chave de módulo `black_friday`. Até aqui o
// backend não devolvia o campo (a coluna é da migration 320) e não conhecia a
// chave (PUT de override com "black_friday" voltava 400).
//
// O campo é SEMPRE booleano: true só quando a coluna é true; ausente/null/lixo
// vira false. Consolidado (company null) segue sem empresa.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');

let app, db, modules;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  modules = require('../../src/services/modules');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const cid2   = '00000000-0000-0000-0000-000000000002';
const limpo  = (s) => String(s).replace(/\s+/g, ' ').trim();
const token  = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });
const SENHA  = 'senha-de-teste-123';

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── POST /auth/me ────────────────────────────────────────────
describe('POST /auth/me devolve company.is_sandbox', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio', company: cid });
  const consultas = [];

  function bancoDoMe(empresa = {}) {
    consultas.length = 0;
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      consultas.push(s);
      if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client' }] };
      if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
      if (s.includes('AS member_role')) {
        return { rows: [{ id: cid, legal_name: 'Loja da Ana', plan: 'negocio', billing_status: 'active', member_role: 'owner', ...empresa }] };
      }
      return { rows: [] };
    });
  }

  test('empresa de teste: is_sandbox true', async () => {
    bancoDoMe({ is_sandbox: true });
    const res = await request(app).post('/api/v1/auth/me').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.company.is_sandbox).toBe(true);
  });

  test('empresa comum: false; coluna null ou ausente também vira false (sempre booleano)', async () => {
    for (const empresa of [{ is_sandbox: false }, { is_sandbox: null }, {}, { is_sandbox: 'true' }]) {
      bancoDoMe(empresa);
      const res = await request(app).post('/api/v1/auth/me').set(auth);
      expect([JSON.stringify(empresa), res.body.company.is_sandbox]).toEqual([JSON.stringify(empresa), false]);
    }
  });

  test('a consulta da empresa pede c.is_sandbox e o resto do payload segue igual', async () => {
    bancoDoMe({ is_sandbox: true, vertical_active: 'food', segment: 'varejo' });
    const res = await request(app).post('/api/v1/auth/me').set(auth);
    expect(consultas.find((s) => s.includes('AS member_role'))).toMatch(/c\.is_sandbox/);
    expect(res.body.company).toMatchObject({
      id: cid, name: 'Loja da Ana', plan: 'negocio', vertical_active: 'food', segment: 'varejo', member_role: 'owner',
    });
    expect(res.body.company).toHaveProperty('trial');
  });

  test('visão consolidada: company continua null', async () => {
    const consolidado = token({ id: 'u1', role: 'client', plan: 'negocio', company: null, consolidated_view: true });
    bancoDoMe({ is_sandbox: true });
    const res = await request(app).post('/api/v1/auth/me').set(consolidado);
    expect(res.status).toBe(200);
    expect(res.body.company).toBeNull();
  });
});

// ── POST /auth/login ─────────────────────────────────────────
describe('POST /auth/login devolve company.is_sandbox', () => {
  const hash = bcrypt.hashSync(SENHA, 4);
  const consultas = [];

  function bancoDoLogin(empresas) {
    consultas.length = 0;
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      consultas.push(s);
      if (s.includes('FROM users WHERE email')) {
        return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', password_hash: hash, role: 'client', is_active: true, is_staff: false, totp_enabled: false, email_verified: true }] };
      }
      if (s.includes('SELECT DISTINCT ON (c.id)')) {
        return { rows: empresas.map((e, i) => ({ legal_name: 'Loja', plan: 'negocio', member_role: 'owner', is_primary: i === 0, created_at: new Date(2026, 0, 1 + i), ...e })) };
      }
      return { rows: [] };
    });
  }
  const entrar = () => request(app).post('/api/v1/auth/login').send({ email: 'ana@loja.com', password: SENHA });

  test('uma empresa de teste: is_sandbox true', async () => {
    bancoDoLogin([{ id: cid, is_sandbox: true }]);
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ id: cid, is_sandbox: true });
    expect(consultas.find((s) => s.includes('SELECT DISTINCT ON (c.id)'))).toMatch(/c\.is_sandbox/);
  });

  test('empresa comum, null e ausente: false', async () => {
    for (const e of [{ is_sandbox: false }, { is_sandbox: null }, {}]) {
      bancoDoLogin([{ id: cid, ...e }]);
      const res = await entrar();
      expect(res.body.company.is_sandbox).toBe(false);
    }
  });

  test('várias empresas = consolidado: company null, sem vazar o campo de nenhuma', async () => {
    bancoDoLogin([{ id: cid, is_sandbox: true }, { id: cid2, is_sandbox: false }]);
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(res.body.consolidated_view).toBe(true);
    expect(res.body.company).toBeNull();
  });
});

// ── POST /auth/switch-company ────────────────────────────────
describe('POST /auth/switch-company devolve is_sandbox da empresa escolhida', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio', company: cid2 });

  function bancoDaTroca(empresa) {
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (s.includes('FROM companies c LEFT JOIN company_members cm') && s.includes('LIMIT 1')) {
        return { rows: [{ id: cid, legal_name: 'Loja', trade_name: null, plan: 'negocio', role: 'owner', ...empresa }] };
      }
      return { rows: [] };
    });
  }

  test.each([[true, true], [false, false], [null, false], [undefined, false]])('is_sandbox %p vira %p', async (coluna, esperado) => {
    bancoDaTroca({ is_sandbox: coluna });
    const res = await request(app).post('/api/v1/auth/switch-company').set(auth).send({ company_id: cid });
    expect(res.status).toBe(200);
    expect(res.body.current_company.is_sandbox).toBe(esperado);
    expect(res.body.current_company.id).toBe(cid);
  });
});

// ── chave de módulo black_friday ─────────────────────────────
describe('módulo black_friday no catálogo do backend', () => {
  test('existe, no plano essencial (igual ao app: MODULE_PLAN_MAP.black_friday)', () => {
    expect(modules.MODULE_PLAN_MAP.black_friday).toBe('essencial');
  });

  test('visível em todos os planos, a menos que o admin esconda; override true força', () => {
    for (const plano of ['essencial', 'negocio', 'expansao']) {
      expect(modules.getVisibleModules(plano, {})).toContain('black_friday');
      expect(modules.getVisibleModules(plano, { black_friday: false })).not.toContain('black_friday');
      expect(modules.getModuleMap(plano, {}).black_friday).toEqual({ visible: true, minPlan: 'essencial', reason: 'plan' });
    }
    expect(modules.getModuleMap('essencial', { black_friday: false }).black_friday).toMatchObject({ visible: false, reason: 'admin_hidden' });
  });

  test('não mexe nos módulos que já existiam', () => {
    const antes = ['painel', 'financeiro', 'nfe', 'contabilidade', 'suporte', 'pdv', 'os', 'estoque', 'configuracoes', 'folha', 'agendamento', 'clientes', 'canal', 'whatsapp', 'agentes'];
    for (const m of antes) expect(modules.MODULE_PLAN_MAP).toHaveProperty(m);
    expect(modules.MODULE_PLAN_MAP.agentes).toBe('expansao');
    expect(modules.MODULE_PLAN_MAP.clientes).toBe('negocio');
  });

  test('PUT /admin/clients/:cid/modules aceita o override de black_friday (antes: 400)', async () => {
    const staff = token({ id: 'a1', role: 'admin', is_staff: true, plan: 'expansao', company: cid });
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (s.startsWith('UPDATE companies SET module_overrides')) return { rows: [{ id: cid, plan: 'essencial', module_overrides: { black_friday: true } }] };
      return { rows: [] };
    });
    const res = await request(app).put(`/api/v1/admin/clients/${cid}/modules`).set(staff).send({ overrides: { black_friday: true } });
    expect(res.status).toBe(200);
    expect(res.body.overrides).toEqual({ black_friday: true });
    expect(res.body.visible).toContain('black_friday');

    const lixo = await request(app).put(`/api/v1/admin/clients/${cid}/modules`).set(staff).send({ overrides: { black_friday_x: true } });
    expect(lixo.status).toBe(400);
  });
});
