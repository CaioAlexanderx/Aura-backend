// ============================================================
// QA-02 — Testes de Integração: Onboarding
// Primeiro fluxo do cliente — crítico para o Alpha
// Rota pública: POST /onboarding/cnpj-lookup (sem auth)
// Rotas privadas: GET/POST /companies/:id/onboarding/...
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const uid    = 'user-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: uid, role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

// ─── CNPJ Lookup (público) ──────────────────────────────────
describe('POST /api/v1/onboarding/cnpj-lookup — público', () => {
  test('400 — cnpj ausente', async () => {
    const res = await request(app)
      .post('/api/v1/onboarding/cnpj-lookup')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cnpj/i);
  });

  test('400 — cnpj inválido (dígito verificador errado)', async () => {
    const res = await request(app)
      .post('/api/v1/onboarding/cnpj-lookup')
      .send({ cnpj: '11.222.333/0001-99' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido/i);
  });

  test('400 — cnpj só zeros', async () => {
    const res = await request(app)
      .post('/api/v1/onboarding/cnpj-lookup')
      .send({ cnpj: '00.000.000/0000-00' });
    expect(res.status).toBe(400);
  });

  test('não requer token de autenticação', async () => {
    // Rota pública — sem token deve chegar na validação do CNPJ, não em 401
    const res = await request(app)
      .post('/api/v1/onboarding/cnpj-lookup')
      .send({ cnpj: '00.000.000/0000-00' });
    expect(res.status).not.toBe(401);
  });
});

// ─── Status do Onboarding ───────────────────────────────────
describe('GET /api/v1/companies/:id/onboarding — status', () => {
  test('200 — retorna step e steps_done', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        onboarding_step: 'regime',
        onboarding_completed_at: null,
        tax_regime: 'mei',
        vertical_active: null,
        cnpj: '11.222.333/0001-81',
        legal_name: 'Empresa Teste',
        trade_name: 'Teste',
        cnaes: null, legal_nature: null, company_size: 'MEI',
        rf_situation: 'ATIVA', address_city: 'Jacareí', address_state: 'SP',
        rf_data: null,
        step_cnpj_done: true, step_regime_done: false,
        step_perfil_done: false, step_vertical_done: false,
      }],
    });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/onboarding`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('regime');
    expect(res.body.steps_done.cnpj).toBe(true);
    expect(res.body.steps_done.regime).toBe(false);
    expect(res.body.company).toBeDefined();
  });

  test('404 — empresa não encontrada', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/onboarding`)
      .set(auth);
    expect(res.status).toBe(404);
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/onboarding`);
    expect(res.status).toBe(401);
  });
});

// ─── Step: Regime ───────────────────────────────────────────
describe('POST /companies/:id/onboarding/step/regime', () => {
  test('400 — tax_regime inválido', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/regime`)
      .set(auth).send({ tax_regime: 'invalido' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tax_regime/i);
  });

  test('400 — tax_regime ausente', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/regime`)
      .set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('200 — regime MEI confirmado', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, tax_regime: null }] }) // SELECT company
      .mockResolvedValueOnce({ rows: [] })  // UPDATE companies
      .mockResolvedValueOnce({ rows: [] }); // UPSERT onboarding_sessions
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/regime`)
      .set(auth).send({ tax_regime: 'mei' });
    expect(res.status).toBe(200);
    expect(res.body.next_step).toBe('perfil');
    expect(res.body.tax_regime).toBe('mei');
  });

  test('200 — audit log gerado ao trocar regime', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, tax_regime: 'mei' }] }) // SELECT (regime anterior: mei)
      .mockResolvedValueOnce({ rows: [] })  // UPDATE
      .mockResolvedValueOnce({ rows: [] })  // UPSERT session
      .mockResolvedValueOnce({ rows: [] }); // INSERT audit_log
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/regime`)
      .set(auth).send({ tax_regime: 'simples_nacional' });
    expect(res.status).toBe(200);
    // 4 queries: select, update, session, audit
    expect(db.query).toHaveBeenCalledTimes(4);
  });

  test('403 — empresa de outro usuário', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // empresa não encontrada para este user
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/regime`)
      .set(auth).send({ tax_regime: 'mei' });
    expect(res.status).toBe(403);
  });
});

// ─── Step: Perfil ───────────────────────────────────────────
describe('POST /companies/:id/onboarding/step/perfil', () => {
  test('200 — atualiza nome fantasia e avança', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] })  // SELECT
      .mockResolvedValueOnce({ rows: [] })              // UPDATE
      .mockResolvedValueOnce({ rows: [] });             // UPSERT session
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/perfil`)
      .set(auth).send({ trade_name: 'Minha Loja', phone: '(12)99999-9999' });
    expect(res.status).toBe(200);
    expect(res.body.next_step).toBe('vertical');
  });

  test('200 — sem dados (tudo opcional)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/perfil`)
      .set(auth).send({});
    expect(res.status).toBe(200);
  });
});

// ─── Step: Vertical ─────────────────────────────────────────
describe('POST /companies/:id/onboarding/step/vertical', () => {
  test('200 — sem vertical (null = pular)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/vertical`)
      .set(auth).send({ vertical: null });
    expect(res.status).toBe(200);
    expect(res.body.onboarding_complete).toBe(true);
  });

  test('200 — vertical odonto selecionado', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/vertical`)
      .set(auth).send({ vertical: 'odonto' });
    expect(res.status).toBe(200);
    expect(res.body.vertical_active).toBe('odonto');
    expect(res.body.onboarding_complete).toBe(true);
  });

  test('400 — vertical inválido', async () => {
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/step/vertical`)
      .set(auth).send({ vertical: 'clinica' });
    expect(res.status).toBe(400);
  });
});

// ─── Restart ────────────────────────────────────────────────
describe('POST /companies/:id/onboarding/restart', () => {
  test('200 — reinicia onboarding para step cnpj', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/onboarding/restart`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('cnpj');
  });
});
