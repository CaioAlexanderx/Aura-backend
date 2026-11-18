// ============================================================
// AURA. — E-mail que volta (18/11/2026): o sinal nas rotas
//
//   POST /auth/me                 user.email_devolvido só para quem não
//                                 confirmou e cujo último e-mail de
//                                 confirmação voltou; confirmado nem consulta
//   POST /auth/send-verification  devolução permanente: nada sai, os códigos
//                                 são apagados e a resposta diz
//                                 {sent:false, reason:'email_devolvido',
//                                  email_devolvido}
//                                 e o e-mail leva user_id e company_id
// ============================================================
'use strict';

jest.mock('../src/services/mailer', () => ({
  ...jest.requireActual('../src/services/mailer'),
  sendVerificationLinkEmail: jest.fn(async () => ({ id: 're_1' })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'aura-test-secret-2026';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
const auth = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });

let app;
let db;
let mailer;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
  mailer = require('../src/services/mailer');
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const BOUNCE = { bounced_at: new Date('2026-11-18T12:00:00Z'), tipo_bounce: 'Permanent' };

function bancoDoMe({ verificado, devolucao }) {
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    if (s.includes('email:verificacao_devolvida')) return { rows: devolucao ? [devolucao] : [] };
    if (s.includes('FROM users WHERE id')) {
      return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@exemplo.com', role: 'client', email_verified: verificado }] };
    }
    if (s.includes('COUNT(DISTINCT c.id)')) return { rows: [{ cnt: 0 }] };
    return { rows: [] };
  });
}
const me = () => request(app).post('/api/v1/auth/me').set(auth({ id: 'u1', role: 'client' }));

describe('POST /auth/me — email_devolvido', () => {
  test('não confirmou e o último e-mail voltou: o sinal vem com o tipo', async () => {
    bancoDoMe({ verificado: false, devolucao: BOUNCE });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.user.email_devolvido).toEqual({ tipo: 'permanente', em: '2026-11-18T12:00:00.000Z' });
    const q = db.query.mock.calls.find(([sql]) => limpo(sql).includes('email:verificacao_devolvida'));
    expect(q[1]).toEqual(['ana@exemplo.com']);
  });

  test('temporária', async () => {
    bancoDoMe({ verificado: false, devolucao: { ...BOUNCE, tipo_bounce: 'Transient' } });
    expect((await me()).body.user.email_devolvido.tipo).toBe('temporaria');
  });

  test('sem devolução: o campo não vem', async () => {
    bancoDoMe({ verificado: false, devolucao: null });
    const res = await me();
    expect(res.body.user).not.toHaveProperty('email_devolvido');
  });

  test('e-mail confirmado: nem consulta, nem campo', async () => {
    bancoDoMe({ verificado: true, devolucao: BOUNCE });
    const res = await me();
    expect(res.body.user).not.toHaveProperty('email_devolvido');
    expect(db.query.mock.calls.some(([sql]) => limpo(sql).includes('email:verificacao_devolvida'))).toBe(false);
  });

  test('a leitura falhou: o /me responde igual, sem o campo', async () => {
    bancoDoMe({ verificado: false, devolucao: null });
    const antes = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, p) => {
      if (limpo(sql).includes('email:verificacao_devolvida')) throw new Error('caiu');
      return antes(sql, p);
    });
    const res = await me();
    expect(res.status).toBe(200);
    expect(res.body.user).not.toHaveProperty('email_devolvido');
  });
});

function bancoDoEnvio({ devolucao = BOUNCE } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    if (s.includes('SELECT email, full_name, email_verified FROM users')) {
      return { rows: [{ email: 'ana@exemplo.com', full_name: 'Ana', email_verified: false }] };
    }
    if (s.includes('COUNT(*)::int AS cnt')) return { rows: [{ cnt: 0, oldest: null }] };
    if (s.startsWith('SELECT id FROM verification_codes')) return { rows: [] };
    if (s.startsWith('INSERT INTO verification_codes')) return { rows: [{ id: 'vc1' }, { id: 'vc2' }] };
    if (s.includes('FROM companies WHERE owner_id')) return { rows: [{ id: 'loja-1' }] };
    if (s.includes('email:verificacao_devolvida')) return { rows: devolucao ? [devolucao] : [] };
    return { rows: [] };
  });
}
const enviar = () => request(app).post('/api/v1/auth/send-verification').set(auth({ id: 'u1', role: 'client' }));

describe('POST /auth/send-verification — devolução permanente', () => {
  test('suprimido: sent:false, reason email_devolvido, o sinal, e os códigos apagados', async () => {
    bancoDoEnvio();
    mailer.sendVerificationLinkEmail.mockResolvedValueOnce({ id: null, suprimido: true });
    const res = await enviar();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sent: false, reason: 'email_devolvido',
      email_devolvido: { tipo: 'permanente', em: '2026-11-18T12:00:00.000Z' },
    });
    const del = db.query.mock.calls.find(([sql]) => limpo(sql).startsWith('DELETE FROM verification_codes'));
    expect(del[1]).toEqual([['vc1', 'vc2']]);
  });

  test('enviado: o e-mail leva user_id e company_id (a loja de que a pessoa é dona)', async () => {
    bancoDoEnvio();
    const res = await enviar();
    expect(res.body.sent).toBe(true);
    expect(res.body).not.toHaveProperty('email_devolvido');
    const args = mailer.sendVerificationLinkEmail.mock.calls[0];
    expect(args[0]).toBe('ana@exemplo.com');
    expect(args[4]).toEqual({ userId: 'u1', companyId: 'loja-1' });
  });

  test('sem empresa (ou consulta falhou): company_id null, o envio segue', async () => {
    bancoDoEnvio();
    const antes = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, p) => {
      if (limpo(sql).includes('FROM companies WHERE owner_id')) throw new Error('caiu');
      return antes(sql, p);
    });
    const res = await enviar();
    expect(res.body.sent).toBe(true);
    expect(mailer.sendVerificationLinkEmail.mock.calls[0][4]).toEqual({ userId: 'u1', companyId: null });
  });
});
