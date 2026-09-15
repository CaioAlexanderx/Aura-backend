// ============================================================
// AURA. -- Testes: /otica/prescriptions (receitas) e /otica/settings
//
// O que estes testes travam:
//   1. eixo fora de 0-180 e grau absurdo sao 400 com code proprio
//   2. grau fora do passo de 0,25 e arredondado, nao rejeitado
//   3. valid_until default = issued_at + validade padrao da loja (no SQL)
//   4. gate otica_enabled so na ESCRITA: GET passa, POST leva 403
//   5. /prescriptions/book agrupa as OS que usaram a receita
//
// Router ISOLADO. Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const oticaRouter = require('../../src/routes/otica');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const rxId = '22222222-3333-4444-5555-666666666666';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess()); // admin bypassa o SELECT no banco
  scoped.use('/otica', oticaRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

const RX = {
  id: rxId, company_id: cid, customer_id: cust,
  od_sph: '-1.75', od_cyl: '-0.50', od_axis: 180, oe_sph: '-1.50',
  prescriber_type: 'medico', prescriber_name: 'Dra. Ana Lima', prescriber_registry: 'CRM 12345/SP',
  issued_at: '2026-08-20', valid_until: '2027-08-20',
  customer_name: 'Maria Souza', customer_phone: '11999990000', measured_by_name: null,
};

function mockDb({ enabled = 'true', settings = {}, customer = true, book = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/pdv_settings->>'otica_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled }] });
    if (/SELECT otica_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ otica_settings: settings }] });
    if (/SELECT id FROM customers/i.test(s)) return Promise.resolve({ rows: customer ? [{ id: cust }] : [] });
    if (/INSERT INTO optical_prescriptions/i.test(s)) return Promise.resolve({ rows: [{ id: rxId }] });
    if (/json_agg\(so\.os_number/i.test(s)) return Promise.resolve({ rows: book });
    if (/FROM optical_prescriptions p/i.test(s)) return Promise.resolve({ rows: [RX] });
    return Promise.resolve({ rows: [] });
  });
}

const callsMatching = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const paramsOf = (re) => (callsMatching(re)[0] || [])[1];

const BODY = {
  customer_id: cust,
  od_sph: -1.75, od_cyl: -0.5, od_axis: 180, od_add: 2,
  oe_sph: -1.5, oe_cyl: null, oe_axis: null,
  od_pd: 31.5, oe_pd: 31, od_height: 20, oe_height: 20,
  prescriber_type: 'medico', prescriber_name: 'Dra. Ana Lima', prescriber_registry: 'CRM 12345/SP',
  issued_at: '2026-08-20',
};
const post = (body) => request(app).post(`/api/v1/companies/${cid}/otica/prescriptions`).set(adminAuth).send(body);

describe('POST /otica/prescriptions -- validacao', () => {
  test('eixo fora de 0-180 -> 400 EIXO_INVALIDO', async () => {
    mockDb();
    const res = await post({ ...BODY, od_axis: 200 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EIXO_INVALIDO');
    expect(callsMatching(/INSERT INTO optical_prescriptions/i)).toHaveLength(0);
  });

  test('eixo nao inteiro -> 400', async () => {
    mockDb();
    const res = await post({ ...BODY, oe_axis: 90.5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EIXO_INVALIDO');
  });

  test('|sph| > 30 ou |cyl| > 10 -> 400 GRAU_INVALIDO', async () => {
    mockDb();
    let res = await post({ ...BODY, od_sph: 35 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GRAU_INVALIDO');

    res = await post({ ...BODY, oe_cyl: -12 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('GRAU_INVALIDO');
  });

  test('prescritor so medico ou optometrista', async () => {
    mockDb();
    const res = await post({ ...BODY, prescriber_type: 'vendedor' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PRESCRITOR_INVALIDO');
  });

  test('valid_until antes de issued_at -> 400 DATA_INVALIDA', async () => {
    mockDb();
    const res = await post({ ...BODY, valid_until: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DATA_INVALIDA');
  });

  test('issued_at obrigatorio', async () => {
    mockDb();
    const res = await post({ ...BODY, issued_at: undefined });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DATA_INVALIDA');
  });

  test('cliente de outra empresa -> 404', async () => {
    mockDb({ customer: false });
    const res = await post(BODY);
    expect(res.status).toBe(404);
  });
});

describe('POST /otica/prescriptions -- gravacao', () => {
  test('201: grau arredondado pra 0,25 e validade default pela configuracao da loja', async () => {
    mockDb({ settings: { prescription_validity_months: 18 } });
    const res = await post({ ...BODY, od_sph: -1.7, od_cyl: -0.6 });
    expect(res.status).toBe(201);
    expect(res.body.prescription).toMatchObject({ id: rxId, customer_name: 'Maria Souza' });

    const [sql, params] = callsMatching(/INSERT INTO optical_prescriptions/i)[0];
    // 2. arredondamento: -1.7 -> -1.75, -0.6 -> -0.5
    expect(params).toContain(-1.75);
    expect(params).toContain(-0.5);
    expect(params).not.toContain(-1.7);
    // 3. valid_until: COALESCE(explicito, issued_at + meses) — meses da loja
    expect(sql).toMatch(/make_interval\(months =>/i);
    expect(params).toContain(18);
    expect(params).toContain('2026-08-20');
  });

  test('valid_until explicito vence o default', async () => {
    mockDb();
    const res = await post({ ...BODY, valid_until: '2027-02-20' });
    expect(res.status).toBe(201);
    expect(paramsOf(/INSERT INTO optical_prescriptions/i)).toContain('2027-02-20');
  });
});

describe('gate otica_enabled -- so na escrita', () => {
  test('POST com otica desligada -> 403 OTICA_DISABLED', async () => {
    mockDb({ enabled: 'false' });
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OTICA_DISABLED');
    expect(callsMatching(/INSERT INTO optical_prescriptions/i)).toHaveLength(0);
  });

  test('GET lista mesmo com otica desligada', async () => {
    mockDb({ enabled: 'false' });
    const res = await request(app).get(`/api/v1/companies/${cid}/otica/prescriptions?customer_id=${cust}`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.prescriptions).toHaveLength(1);
    expect(res.body.prescriptions[0].customer_name).toBe('Maria Souza');
  });

  test('GET /settings devolve defaults mesclados', async () => {
    mockDb({ enabled: 'false', settings: { rt_name: 'Joao' } });
    const res = await request(app).get(`/api/v1/companies/${cid}/otica/settings`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      prescription_validity_months: 12, adaptation_warranty_days: 90, rt_name: 'Joao', wa_ready_auto: false,
    });
  });
});

describe('GET /otica/prescriptions/book -- livro de receitas', () => {
  test('agrupa as OS que usaram cada receita e nao cai no /:rxId', async () => {
    mockDb({
      book: [
        { id: rxId, issued_at: '2026-08-20', customer_name: 'Maria Souza', prescriber_name: 'Dra. Ana Lima', prescriber_registry: 'CRM 12345/SP', os_numbers: [12, 15] },
      ],
    });
    const res = await request(app).get(`/api/v1/companies/${cid}/otica/prescriptions/book?from=2026-08-01&to=2026-08-31`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({ customer_name: 'Maria Souza', os_numbers: [12, 15] });

    const [sql, params] = callsMatching(/json_agg\(so\.os_number/i)[0];
    // Vinculo via snapshot: optical->>'prescription_id'
    expect(sql).toMatch(/optical->>'prescription_id'/);
    expect(params).toEqual([cid, '2026-08-01', '2026-08-31']);
  });

  test('from invalido -> 400', async () => {
    mockDb();
    const res = await request(app).get(`/api/v1/companies/${cid}/otica/prescriptions/book?from=ontem`).set(adminAuth);
    expect(res.status).toBe(400);
  });
});

describe('DELETE /otica/prescriptions/:rxId', () => {
  test('receita usada em OS -> 409 RECEITA_EM_USO', async () => {
    mockDb();
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/pdv_settings->>'otica_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
      if (/FROM optical_prescriptions p/i.test(s)) return Promise.resolve({ rows: [RX] });
      if (/FROM service_orders/i.test(s)) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).delete(`/api/v1/companies/${cid}/otica/prescriptions/${rxId}`).set(adminAuth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECEITA_EM_USO');
    expect(callsMatching(/DELETE FROM optical_prescriptions/i)).toHaveLength(0);
  });
});
