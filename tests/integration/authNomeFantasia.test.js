// ============================================================
// company.trade_name e company.legal_name no login, no /auth/me e na troca
// de empresa (24/10/2026)
//
// A etiqueta do app (components/PrintLabels.tsx) monta o nome da loja com
// company.trade_name || company.legal_name. O login e o /auth/me moldavam o
// company so com `name` (razao social primeiro), sem os dois campos: o nome
// da loja chegava vazio para todo mundo e a etiqueta nunca imprimia o topo.
//
// Agora os dois campos vem juntos; `name` continua exatamente o de antes.
// A troca de empresa ja devolvia os dois: o teste so trava isso.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const cid2   = '00000000-0000-0000-0000-000000000002';
const limpo  = (s) => String(s).replace(/\s+/g, ' ').trim();
const token  = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });
const SENHA  = 'senha-de-teste-123';

const DOCE = { legal_name: 'Doce Encanto Confeitaria LTDA', trade_name: 'Doce Encanto' };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('POST /auth/me', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio', company: cid });
  const consultas = [];

  function bancoDoMe(empresa) {
    consultas.length = 0;
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      consultas.push(s);
      if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client' }] };
      if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
      if (s.includes('AS member_role')) return { rows: [{ id: cid, plan: 'negocio', member_role: 'owner', ...empresa }] };
      return { rows: [] };
    });
  }

  test('traz trade_name e legal_name; name continua a razao social', async () => {
    bancoDoMe(DOCE);
    const res = await request(app).post('/api/v1/auth/me').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({
      name: 'Doce Encanto Confeitaria LTDA',
      trade_name: 'Doce Encanto',
      legal_name: 'Doce Encanto Confeitaria LTDA',
    });
    expect(consultas.find((s) => s.includes('AS member_role'))).toMatch(/c\.trade_name/);
  });

  test('sem nome fantasia: trade_name null, name igual ao de antes', async () => {
    for (const vazio of [null, '', undefined]) {
      bancoDoMe({ legal_name: 'Loja da Ana ME', trade_name: vazio });
      const res = await request(app).post('/api/v1/auth/me').set(auth);
      expect(res.body.company).toMatchObject({ name: 'Loja da Ana ME', trade_name: null, legal_name: 'Loja da Ana ME' });
    }
  });
});

describe('POST /auth/login', () => {
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
        return { rows: empresas.map((e, i) => ({ plan: 'negocio', member_role: 'owner', is_primary: i === 0, created_at: new Date(2026, 0, 1 + i), ...e })) };
      }
      return { rows: [] };
    });
  }
  const entrar = () => request(app).post('/api/v1/auth/login').send({ email: 'ana@loja.com', password: SENHA });

  test('uma empresa: traz trade_name e legal_name; name continua a razao social', async () => {
    bancoDoLogin([{ id: cid, ...DOCE }]);
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({
      id: cid,
      name: 'Doce Encanto Confeitaria LTDA',
      trade_name: 'Doce Encanto',
      legal_name: 'Doce Encanto Confeitaria LTDA',
    });
    expect(consultas.find((s) => s.includes('SELECT DISTINCT ON (c.id)'))).toMatch(/c\.trade_name/);
  });

  test('varias empresas (consolidado): company continua null', async () => {
    bancoDoLogin([{ id: cid, ...DOCE }, { id: cid2, legal_name: 'Outra', trade_name: 'Outra' }]);
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(res.body.company).toBeNull();
  });
});

describe('POST /auth/switch-company', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio', company: cid2 });

  test('ja devolvia trade_name e legal_name (trava o contrato)', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (s.includes('FROM companies c LEFT JOIN company_members cm') && s.includes('LIMIT 1')) {
        return { rows: [{ id: cid, plan: 'negocio', role: 'owner', ...DOCE }] };
      }
      return { rows: [] };
    });
    const res = await request(app).post('/api/v1/auth/switch-company').set(auth).send({ company_id: cid });
    expect(res.status).toBe(200);
    expect(res.body.current_company).toMatchObject({
      id: cid,
      name: 'Doce Encanto',
      trade_name: 'Doce Encanto',
      legal_name: 'Doce Encanto Confeitaria LTDA',
    });
  });
});
