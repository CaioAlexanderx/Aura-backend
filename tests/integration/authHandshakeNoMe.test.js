// ============================================================
// Estado do WhatsApp do cadastro no /auth/me (tq-115, 26/10/2026).
//
// O /me devolve `whatsapp_handshake` (mesmo formato do register,
// signupHandshake.moldar) para o DONO da empresa do JWT. O Painel le uma
// vez ao abrir e mostra a faixa quando o estado nao e 'confirmado'.
// null para membro, visao consolidada, conta sem handshake e tabela ausente.
// A consulta nunca derruba o /me.
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
const limpo  = (s) => String(s).replace(/\s+/g, ' ').trim();
const token  = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });

const AGUARDANDO = {
  id: 'h1', codigo: 'AURA-K7MQ', whatsapp: '11987654321', estado: 'aguardando',
  confirmado_em: null, confirmado_via: null, criado_em: '2026-10-26T12:00:00Z',
};

let consultas;
function banco({ papel = 'owner', handshake = AGUARDANDO, erroHandshake = null, empresa = {} } = {}) {
  consultas = [];
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    consultas.push(s);
    if (s.includes('handshake:ficha')) {
      if (erroHandshake) throw erroHandshake;
      return { rows: handshake ? [handshake] : [] };
    }
    if (s.includes('JOIN assinatura_cobrancas o')) return { rows: [{ desde: '2026-10-20' }] };
    if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client' }] };
    if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 1 }] };
    if (s.includes('AS member_role')) {
      return { rows: [{ id: cid, legal_name: 'Loja', plan: 'negocio', billing_status: 'active', member_role: papel, ...empresa }] };
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
const me = () => request(app).post('/api/v1/auth/me').set(meAuth);

describe('POST /auth/me — whatsapp_handshake', () => {
  test('dono com handshake aguardando: estado, código e link wa.me com o código', async () => {
    banco();
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_handshake).toMatchObject({
      codigo: 'AURA-K7MQ', estado: 'aguardando', confirmacao_automatica: false,
    });
    expect(res.body.whatsapp_handshake.link).toMatch(/^https:\/\/wa\.me\/\d+\?text=.*AURA-K7MQ/);
    // a empresa do JWT, não outra
    const q = db.query.mock.calls.find(([sql]) => limpo(sql).includes('handshake:ficha'));
    expect(q[1]).toEqual([cid]);
  });

  test('dono com handshake confirmado: estado confirmado', async () => {
    banco({ handshake: { ...AGUARDANDO, estado: 'confirmado', confirmado_em: '2026-10-26T13:00:00Z', confirmado_via: 'staff' } });
    const res = await me();
    expect(res.body.whatsapp_handshake).toMatchObject({ estado: 'confirmado', confirmado_via: 'staff' });
  });

  test('conta sem handshake (antiga, dojô): null', async () => {
    banco({ handshake: null });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_handshake).toBeNull();
  });

  test('membro da equipe: null, sem consultar o handshake', async () => {
    banco({ papel: 'Vendedor' });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(consultas.some((s) => s.includes('handshake:ficha'))).toBe(false);
  });

  test('visão consolidada: null, sem consultar o handshake', async () => {
    banco();
    const res = await request(app).post('/api/v1/auth/me')
      .set(token({ id: 'u1', role: 'client', plan: 'negocio', consolidated_view: true }));
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(consultas.some((s) => s.includes('handshake:ficha'))).toBe(false);
  });

  test('tabela ausente (42P01): null, o /me não cai', async () => {
    banco({ erroHandshake: Object.assign(new Error('relation does not exist'), { code: '42P01' }) });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(res.body.company).toMatchObject({ id: cid });
  });

  test('qualquer outra falha na consulta: null, o /me não cai', async () => {
    banco({ erroHandshake: new Error('conexão caiu') });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_handshake).toBeNull();
  });

  test('em atraso: as datas do atraso continuam vindo e são consultadas antes do handshake', async () => {
    banco({ empresa: { billing_status: 'overdue' } });
    const res = await me();
    expect(res.body.company).toMatchObject({ billing_overdue_since: '2026-10-20' });
    expect(res.body.whatsapp_handshake).toMatchObject({ estado: 'aguardando' });
    const iAtraso = consultas.findIndex((s) => s.includes('assinatura_cobrancas'));
    const iHandshake = consultas.findIndex((s) => s.includes('handshake:ficha'));
    expect(iAtraso).toBeGreaterThan(-1);
    expect(iHandshake).toBeGreaterThan(iAtraso);
  });
});
