// ============================================================
// AURA. — Testes: 1.2 GET /dental/patients/birthdays (contrato de rota)
// A logica de calculo em si (virada de ano, 29/02) ja e coberta em
// __tests__/birthdayCalc.test.js — aqui testamos o contrato HTTP: shape
// da resposta, ordem de registro da rota (nao cair em /:pid), default e
// clamp de `days`.
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => jest.clearAllMocks());

describe('GET /dental/patients/birthdays', () => {
  test('rota registrada ANTES de /:pid — nao cai em "buscar paciente id=birthdays"', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT customers

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/patients/birthdays`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('patients');
    // Se tivesse caido em /:pid, a query seria "SELECT * FROM customers WHERE id = $1..."
    const sql = db.query.mock.calls[1][0];
    expect(sql).not.toMatch(/id = \$1 AND company_id = \$2/);
  });

  test('shape da resposta: { patients: [{ id, full_name, phone, birth_date, days_until }] }', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'Ana Aniversariante', phone: '11999990000', birth_date: '2026-09-20' }],
    });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/patients/birthdays?days=7`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.patients).toHaveLength(1);
    const p = res.body.patients[0];
    expect(p).toEqual({
      id: 'p1',
      full_name: 'Ana Aniversariante',
      phone: '11999990000',
      birth_date: '2026-09-20',
      days_until: expect.any(Number),
    });
  });

  test('sem days, usa default 7 (filtra corretamente quem esta fora da janela)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const farAway = new Date();
    farAway.setDate(farAway.getDate() + 40); // bem fora de qualquer default/clamp razoavel
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'p-longe', name: 'Fora da janela', phone: null, birth_date: farAway.toISOString().slice(0, 10) }],
    });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/patients/birthdays`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.patients).toHaveLength(0);
  });

  test('days > 60 e clampado pra 60', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    const in90days = new Date();
    in90days.setDate(in90days.getDate() + 90);
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'p-90d', name: 'Longe demais', phone: null, birth_date: in90days.toISOString().slice(0, 10) }],
    });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/patients/birthdays?days=999`)
      .set(auth);

    expect(res.status).toBe(200);
    // 90 dias > clamp de 60 -> nao deve aparecer
    expect(res.body.patients).toHaveLength(0);
  });
});
