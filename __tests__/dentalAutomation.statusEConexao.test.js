// ============================================================
// AURA. — Testes: 1.7 automacoes odonto
//   - confirm_24h considera so status 'agendado'
//   - remind_2h considera 'agendado' e 'confirmado'
//   - GET /automation/config inclui whatsapp_connected: false
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
const authClient = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => jest.clearAllMocks());

describe('GET /dental/automation/config', () => {
  test('resposta inclui whatsapp_connected: false', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ company_id: cid, confirm_enabled: true }] }); // config existente

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/automation/config`)
      .set(authClient);

    expect(res.status).toBe(200);
    expect(res.body.config.whatsapp_connected).toBe(false);
  });
});

describe('POST /dental/automation/trigger', () => {
  test('confirm_24h filtra so status agendado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT appointments

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/automation/trigger`)
      .set(authClient)
      .send({ type: 'confirm_24h' });

    expect(res.status).toBe(200);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/a\.status::text IN \('agendado'\)/);
    expect(sql).not.toMatch(/confirmado/);
  });

  test('remind_2h filtra status agendado E confirmado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT appointments

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/automation/trigger`)
      .set(authClient)
      .send({ type: 'remind_2h' });

    expect(res.status).toBe(200);
    const sql = db.query.mock.calls[1][0];
    expect(sql).toMatch(/a\.status::text IN \('agendado', 'confirmado'\)/);
  });
});
