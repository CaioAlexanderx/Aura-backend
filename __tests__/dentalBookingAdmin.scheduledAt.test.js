// ============================================================
// AURA. — Testes: 1.6 data do agendamento online
//   - GET /booking/requests devolve preferred_date como texto YYYY-MM-DD
//     (nao objeto Date, que serializa em UTC meia-noite e "viaja" um dia
//     pra tras quando exibido em America/Sao_Paulo).
//   - POST /booking/requests/:rid/convert monta scheduled_at combinando
//     preferred_date + preferred_time via SQL (AT TIME ZONE), nao mais
//     via template literal em cima do objeto Date retornado pelo driver.
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

describe('GET /dental/booking/requests — preferred_date como texto', () => {
  test('SQL usa to_char(preferred_date, ...) e a string chega intacta na resposta', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'req1', patient_name: 'Maria', patient_phone: '11999998888', patient_email: null,
        preferred_date: '2026-09-17', preferred_time: '11:00:00', chief_complaint: null,
        status: 'pendente', appointment_id: null, notes: null, created_at: new Date(),
      }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ pending_count: '1', approved_count: '0', rejected_count: '0' }] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dental/booking/requests`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.requests[0].preferred_date).toBe('2026-09-17');

    const listSql = db.query.mock.calls[1][0];
    expect(listSql).toMatch(/to_char\(preferred_date,\s*'YYYY-MM-DD'\)/);
  });
});

describe('POST /dental/booking/requests/:rid/convert — montagem do scheduled_at', () => {
  const bookingReq = {
    id: 'req1', company_id: cid, status: 'pendente',
    patient_name: 'Maria', patient_phone: '11999998888', patient_email: null,
    preferred_date: '2026-09-17', preferred_time: '11:00:00', chief_complaint: null,
  };

  test('sem scheduled_at no body, usa query SQL com AT TIME ZONE America/Sao_Paulo (17/09 11:00 -> 14:00Z)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });          // companyAccess
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

    // Call index 4 (0-based) e a query que combina preferred_date + preferred_time
    const combineCall = db.query.mock.calls[4];
    expect(combineCall[0]).toMatch(/preferred_date \+ preferred_time/);
    expect(combineCall[0]).toMatch(/AT TIME ZONE 'America\/Sao_Paulo'/);
    expect(combineCall[1]).toEqual(['req1']);

    // Resposta reflete o resultado da query SQL (nao um template literal
    // montado em cima do objeto Date bruto).
    expect(new Date(res.body.appointment.scheduled_at).toISOString()).toBe('2026-09-17T14:00:00.000Z');
  });

  test('com scheduled_at explicito no body, NAO chama a query de combinacao', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [bookingReq] });
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'cust1' }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'appt1', scheduled_at: '2026-10-01T12:00:00.000Z', duration_min: 30 }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'req1' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/booking/requests/req1/convert`)
      .set(auth)
      .send({ scheduled_at: '2026-10-01T12:00:00.000Z', duration_min: 30 });

    expect(res.status).toBe(200);
    // So 6 chamadas (sem a query extra de combinacao de data+hora)
    expect(db.query.mock.calls.length).toBe(6);
    for (const call of db.query.mock.calls) {
      expect(call[0]).not.toMatch(/AT TIME ZONE/);
    }
  });
});
