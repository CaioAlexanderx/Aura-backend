// ============================================================
// Datas do atraso no login, no /auth/me e na troca de empresa (tq-86,
// 24/10/2026). Contrato com o app (muro de assinatura), no MESMO objeto em
// que está billing_status:
//   billing_overdue_since    vencimento da cobrança OVERDUE mais antiga
//   billing_pause_screens_on overdue_since + 7
//   billing_pause_caixa_on   overdue_since + 14
// Fora de 'overdue', as três vêm null e o banco não é consultado a mais.
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
const limpo  = (s) => String(s).replace(/\s+/g, ' ').trim();
const token  = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });
const SENHA  = 'senha-de-teste-123';

const NULAS = { billing_overdue_since: null, billing_pause_screens_on: null, billing_pause_caixa_on: null };
const EM_ATRASO = { billing_overdue_since: '2026-10-20', billing_pause_screens_on: '2026-10-27', billing_pause_caixa_on: '2026-11-03' };

let consultas;
function banco(empresa) {
  consultas = [];
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    consultas.push(s);
    if (s.includes('JOIN assinatura_cobrancas o')) return { rows: [{ desde: '2026-10-20' }] };
    if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client' }] };
    if (s.includes('FROM users WHERE email')) {
      return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', password_hash: bcrypt.hashSync(SENHA, 4), role: 'client', is_active: true, is_staff: false, totp_enabled: false }] };
    }
    if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
    if (s.includes('SELECT DISTINCT ON (c.id)')) {
      return { rows: [{ id: cid, legal_name: 'Loja', plan: 'negocio', member_role: 'owner', is_primary: true, created_at: new Date(2026, 0, 1), ...empresa }] };
    }
    if (s.includes('AS member_role')) return { rows: [{ id: cid, legal_name: 'Loja', plan: 'negocio', member_role: 'owner', ...empresa }] };
    if (s.includes('FROM companies c LEFT JOIN company_members cm') && s.includes('LIMIT 1')) {
      return { rows: [{ id: cid, legal_name: 'Loja', trade_name: null, plan: 'negocio', role: 'owner', ...empresa }] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const meAuth = token({ id: 'u1', role: 'client', plan: 'negocio', company: cid });

describe('POST /auth/me', () => {
  test('em atraso: as três datas no objeto company', async () => {
    banco({ billing_status: 'overdue' });
    const res = await request(app).post('/api/v1/auth/me').set(meAuth);
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ billing_status: 'overdue', ...EM_ATRASO });
  });

  test('em dia: as três null, sem consulta a mais', async () => {
    banco({ billing_status: 'active' });
    const res = await request(app).post('/api/v1/auth/me').set(meAuth);
    expect(res.body.company).toMatchObject({ billing_status: 'active', ...NULAS });
    expect(consultas.some((s) => s.includes('assinatura_cobrancas'))).toBe(false);
  });

  test('consulta das datas falha: null, o /me não cai', async () => {
    banco({ billing_status: 'overdue' });
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, p) => {
      if (/assinatura_cobrancas|next_billing_date/.test(sql)) throw new Error('caiu');
      return base(sql, p);
    });
    const res = await request(app).post('/api/v1/auth/me').set(meAuth);
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject(NULAS);
  });
});

describe('POST /auth/login', () => {
  test('em atraso: as três datas no company', async () => {
    banco({ billing_status: 'overdue' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'ana@loja.com', password: SENHA });
    expect(res.status).toBe(200);
    expect(res.body.company).toMatchObject({ billing_status: 'overdue', ...EM_ATRASO });
  });

  test('em dia: null', async () => {
    banco({ billing_status: 'active' });
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'ana@loja.com', password: SENHA });
    expect(res.body.company).toMatchObject(NULAS);
  });
});

describe('POST /auth/switch-company', () => {
  const auth = token({ id: 'u1', role: 'client', plan: 'negocio', company: '00000000-0000-0000-0000-000000000002' });
  test('em atraso: as três datas em current_company', async () => {
    banco({ billing_status: 'overdue' });
    const res = await request(app).post('/api/v1/auth/switch-company').set(auth).send({ company_id: cid });
    expect(res.status).toBe(200);
    expect(res.body.current_company).toMatchObject({ billing_status: 'overdue', ...EM_ATRASO });
  });

  test('em dia: null', async () => {
    banco({ billing_status: 'active' });
    const res = await request(app).post('/api/v1/auth/switch-company').set(auth).send({ company_id: cid });
    expect(res.body.current_company).toMatchObject(NULAS);
  });
});
