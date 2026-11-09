// ============================================================
// POST /auth/refresh mantém a empresa escolhida (09/11/2026)
//
// Trava a ligação da rota: req.body.company_id chega ao serviço e passa pela
// checagem de acesso do switch-company antes de ir para o token. A lógica em
// si está em __tests__/refreshMantemEmpresa.test.js.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const cid2   = '00000000-0000-0000-0000-000000000002';
const limpo  = (s) => String(s).replace(/\s+/g, ' ').trim();
const refreshToken = () => jwt.sign({ id: 'u1', type: 'refresh', jti: 'j1' }, SECRET, { expiresIn: '7d' });

let consultas;
beforeEach(() => {
  jest.clearAllMocks();
  consultas = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = limpo(sql);
    consultas.push({ s, params });
    if (s.includes('FROM refresh_tokens')) return { rows: [] };
    if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', role: 'client', is_staff: false }] };
    // checagem do switch-company: só tem acesso a cid2
    if (s.includes('WHERE c.id = $1') && s.includes('AS member_role')) {
      return { rows: params[0] === cid2 ? [{ id: cid2, plan: 'expansao', role: 'owner', member_role: 'owner' }] : [] };
    }
    // resolveDefaultContext: 2 empresas = consolidado
    if (s.includes('DISTINCT ON (c.id)')) {
      return { rows: [
        { id: cid, plan: 'negocio', is_primary: true, created_at: '2026-01-01', member_role: 'owner' },
        { id: cid2, plan: 'expansao', is_primary: false, created_at: '2026-02-01', member_role: 'owner' },
      ] };
    }
    return { rows: [] };
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const acesso = (res) => jwt.verify(res.body.token, SECRET);

test('company_id com acesso: o token novo fica nela', async () => {
  const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: refreshToken(), company_id: cid2 });
  expect(res.status).toBe(200);
  expect(acesso(res)).toMatchObject({ company: cid2, consolidated_view: false, plan: 'expansao' });
  expect(res.body.current_company_id).toBe(cid2);
});

test('company_id sem acesso: contexto padrão (consolidado), nunca a empresa pedida', async () => {
  const outra = '00000000-0000-0000-0000-000000000099';
  const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: refreshToken(), company_id: outra });
  expect(res.status).toBe(200);
  expect(acesso(res)).toMatchObject({ company: null, consolidated_view: true });
  expect(consultas.some((q) => q.s.includes('WHERE c.id = $1') && q.params[0] === outra && q.params[1] === 'u1')).toBe(true);
});

test("'all' e sem o campo: consolidado, como antes", async () => {
  for (const corpo of [{ company_id: 'all' }, {}]) {
    const res = await request(app).post('/api/v1/auth/refresh').send({ refresh_token: refreshToken(), ...corpo });
    expect(res.status).toBe(200);
    expect(acesso(res)).toMatchObject({ company: null, consolidated_view: true });
  }
  expect(consultas.some((q) => q.s.includes('WHERE c.id = $1'))).toBe(false);
});
