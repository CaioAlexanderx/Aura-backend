// ============================================================
// AURA. — Teste: D-QA #7 (2026-09-16)
// POST /dental/booking/requests/:rid/convert sem practitioner_id no
// body usa o dentista alocado na primeira cadeira ativa (se houver).
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

const bookingReq = {
  id: 'req1', company_id: cid, status: 'pendente',
  patient_name: 'Maria', patient_phone: '11999998888', patient_email: null,
  preferred_date: '2026-09-17', preferred_time: '11:00:00', chief_complaint: null,
};

describe('POST /dental/booking/requests/:rid/convert — fallback de practitioner_id', () => {
  test('sem practitioner_id no body, usa o dentista alocado na 1a cadeira ativa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({
      rows: [{ dental_settings: { chairs_active: [true, true], chair_practitioner_ids: ['dent-alocada', null] } }],
    }); // SELECT dental_settings (fallback)
    db.query.mockResolvedValueOnce({ rows: [bookingReq] });                  // SELECT request
    db.query.mockResolvedValueOnce({ rows: [] });                           // busca customer por phone -> nao achou
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cust1' }] });            // INSERT customer novo
    db.query.mockResolvedValueOnce({ rows: [{ scheduled_at: new Date('2026-09-17T14:00:00.000Z') }] }); // combine date+time
    db.query.mockResolvedValueOnce({ rows: [{ id: 'appt1', scheduled_at: new Date('2026-09-17T14:00:00.000Z'), duration_min: 60 }] }); // INSERT appointment
    db.query.mockResolvedValueOnce({ rows: [{ id: 'req1' }] });             // UPDATE request status

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/booking/requests/req1/convert`)
      .set(auth)
      .send({});

    expect(res.status).toBe(200);

    const insertApptCall = db.query.mock.calls[6];
    expect(insertApptCall[0]).toMatch(/INSERT INTO dental_appointments/);
    // ultimo param do INSERT e practitioner_id
    expect(insertApptCall[1][insertApptCall[1].length - 1]).toBe('dent-alocada');
  });

  test('sem practitioner_id no body e sem nenhuma cadeira alocada -> fica null (comportamento anterior)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({
      rows: [{ dental_settings: { chairs_active: [true], chair_practitioner_ids: [null] } }],
    });
    db.query.mockResolvedValueOnce({ rows: [bookingReq] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cust1' }] });
    db.query.mockResolvedValueOnce({ rows: [{ scheduled_at: new Date('2026-09-17T14:00:00.000Z') }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'appt1', scheduled_at: new Date('2026-09-17T14:00:00.000Z'), duration_min: 60 }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'req1' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/booking/requests/req1/convert`)
      .set(auth)
      .send({});

    expect(res.status).toBe(200);
    const insertApptCall = db.query.mock.calls[6];
    expect(insertApptCall[1][insertApptCall[1].length - 1]).toBeNull();
  });

  test('com practitioner_id explicito no body, NAO consulta dental_settings e usa o valor do body', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [bookingReq] });        // SELECT request (sem fallback settings)
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cust1' }] });
    db.query.mockResolvedValueOnce({ rows: [{ scheduled_at: new Date('2026-09-17T14:00:00.000Z') }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'appt1', scheduled_at: new Date('2026-09-17T14:00:00.000Z'), duration_min: 60 }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'req1' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/booking/requests/req1/convert`)
      .set(auth)
      .send({ practitioner_id: 'dent-explicito' });

    expect(res.status).toBe(200);
    // Nenhuma query buscando dental_settings avulsa
    for (const call of db.query.mock.calls) {
      expect(call[0]).not.toMatch(/SELECT dental_settings FROM companies/);
    }
    const insertApptCall = db.query.mock.calls[5];
    expect(insertApptCall[0]).toMatch(/INSERT INTO dental_appointments/);
    expect(insertApptCall[1][insertApptCall[1].length - 1]).toBe('dent-explicito');
  });
});
