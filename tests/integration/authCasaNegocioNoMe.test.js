// ============================================================
// POST /auth/me: company.casa_negocio (p-189, 17/11/2026)
//
// O app (trava PERSONALIZADOS_LIBERADO) le a casa no Negocio pelo /me. O
// campo SO aparece quando a casa esta ligada: para toda outra empresa o
// payload e o de sempre, sem chave nova.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio', company: cid }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const consultas = [];
function bancoDoMe(empresa = {}) {
  consultas.length = 0;
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    consultas.push(s);
    if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client' }] };
    if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
    if (s.includes('AS member_role')) {
      return { rows: [{ id: cid, legal_name: 'Loja da Ana', plan: 'negocio', billing_status: 'active', member_role: 'owner', vertical_active: null, ...empresa }] };
    }
    return { rows: [] };
  });
}

describe('POST /auth/me e a casa no Negocio', () => {
  test('a consulta da empresa pede a casa (studio_settings.casa_negocio)', async () => {
    bancoDoMe();
    await request(app).post('/api/v1/auth/me').set(auth);
    expect(consultas.find((s) => s.includes('AS member_role'))).toMatch(/studio_settings->>'casa_negocio'.*AS casa_negocio/);
  });

  test('casa ligada: casa_negocio true', async () => {
    bancoDoMe({ casa_negocio: true });
    const res = await request(app).post('/api/v1/auth/me').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.company.casa_negocio).toBe(true);
    expect(res.body.company.vertical_active).toBeNull();
  });

  test('casa desligada ou ausente: sem a chave (payload de sempre)', async () => {
    for (const empresa of [{ casa_negocio: false }, { casa_negocio: null }, {}, { casa_negocio: 'true' }]) {
      bancoDoMe({ vertical_active: 'studio', ...empresa });
      const res = await request(app).post('/api/v1/auth/me').set(auth);
      expect(res.status).toBe(200);
      expect([JSON.stringify(empresa), Object.prototype.hasOwnProperty.call(res.body.company, 'casa_negocio')])
        .toEqual([JSON.stringify(empresa), false]);
      expect(res.body.company.vertical_active).toBe('studio');
    }
  });
});
