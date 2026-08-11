// ============================================================
// AURA DOJÔ — F11: autocadastro de dojô em POST /auth/register
//
// ⚠️ MOCK POR SQL (regex sobre o texto da query), NUNCA fila posicional.
// tests/integration/auth.test.js (o arquivo irmão, que cobre o caminho de
// varejo) usa mockResolvedValueOnce em fila — funciona lá porque aquele
// caminho não ganhou nenhuma query nova, mas qualquer query a mais no
// handler desalinharia a fila inteira em silêncio. Aqui o dojô adiciona a
// validação da federação, então o mock casa pelo SQL e a ORDEM não importa.
//
// O que este arquivo trava (as três regras da F11):
//   1. karate_dojo_linked_at NUNCA é escrito — conta criada ≠ dojô filiado.
//   2. fpkt_affiliation_id NUNCA é escrito — o número é da federação.
//   3. Varejo (sem `vertical` no body) grava NULL nas três colunas novas.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const FED_ID = '274994b3-6324-4e7b-942e-e6dd19666149';

// ── Mock client por SQL ─────────────────────────────────────
// Cada regra é [regex, resultado]. A primeira que casar responde; o que não
// casa devolve { rows: [] } (bom o bastante para BEGIN/COMMIT/ROLLBACK e
// para o SELECT de e-mail já cadastrado).
function sqlClient(rules) {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, params) => {
      const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
      calls.push({ text, params });
      for (const [re, result] of rules) {
        if (re.test(text)) return Promise.resolve(result);
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
}

const USER_ROW = {
  rows: [{ id: 'u-dojo-1', name: 'Sensei Ana', email: 'ana@dojo.com', role: 'client', is_staff: false, email_verified: false, created_at: new Date() }],
};

function companyRow(overrides) {
  return {
    rows: [{
      id: 'c-dojo-1',
      legal_name: 'Dojô Areikan',
      trade_name: 'Dojô Areikan',
      plan: 'essencial',
      onboarding_step: 'cnpj',
      trial_ends_at: null,
      module_overrides: null,
      access_code_used: null,
      vertical_active: 'karate_dojo',
      vertical: 'karate_dojo',
      ai_enabled: false,
      ai_consent_at: null,
      federation_id: FED_ID,
      ...(overrides || {}),
    }],
  };
}

const FED_FOUND = [/vertical = 'karate_federation'/, { rows: [{ id: FED_ID }] }];
const FED_MISSING = [/vertical = 'karate_federation'/, { rows: [] }];
const NO_CNPJ_MATCH = [/FROM companies WHERE cnpj/, { rows: [] }];
const USER_INSERT = [/INSERT INTO users/, USER_ROW];

function dojoBody(extra) {
  return {
    name: 'Sensei Ana',
    email: 'ana@dojo.com',
    password: 'senha1234',
    company_name: 'Dojô Areikan',
    cnpj: '11222333000181',
    phone: '16999990000',
    terms_accepted: true,
    vertical: 'karate_dojo',
    federation_id: FED_ID,
    ...(extra || {}),
  };
}

function findInsertCompanies(client) {
  return client.calls.find((c) => /INSERT INTO companies/.test(c.text));
}

// ── Validações que NEM abrem transação ──────────────────────
describe('POST /auth/register — F11 validações do ramo', () => {
  test('400 VERTICAL_NOT_SELF_SERVE — vertical fora da lista fechada', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send(dojoBody({ vertical: 'karate_federation' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERTICAL_NOT_SELF_SERVE');
    // Nem chegou a abrir conexão: validação é anterior ao BEGIN.
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('400 VERTICAL_NOT_SELF_SERVE — nenhuma outra vertical entra por aqui', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send(dojoBody({ vertical: 'odonto', federation_id: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VERTICAL_NOT_SELF_SERVE');
  });

  test('400 FEDERATION_REQUIRED — dojô sem federação escolhida', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send(dojoBody({ federation_id: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FEDERATION_REQUIRED');
  });

  test('400 FEDERATION_REQUIRED — federation_id que não é UUID', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send(dojoBody({ federation_id: 'fpkt' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FEDERATION_REQUIRED');
  });

  test('400 DOJO_COMPANY_REQUIRED — dojô sem nome de empresa', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send(dojoBody({ company_name: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DOJO_COMPANY_REQUIRED');
  });
});

// ── Federação inexistente / CNPJ já usado ───────────────────
describe('POST /auth/register — F11 federação e CNPJ', () => {
  test('400 FEDERATION_NOT_FOUND — federação não existe ou está inativa', async () => {
    const client = sqlClient([FED_MISSING, USER_INSERT]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).post('/api/v1/auth/register').send(dojoBody());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FEDERATION_NOT_FOUND');
    // Rollback antes de criar qualquer coisa.
    expect(client.calls.some((c) => /ROLLBACK/.test(c.text))).toBe(true);
    expect(findInsertCompanies(client)).toBeUndefined();
  });

  test('409 CNPJ_ALREADY_REGISTERED — dojô não entra em empresa existente', async () => {
    // O caminho de varejo entraria como vendedor; o dojô precisa PARAR aqui,
    // senão um CNPJ que a federação já cadastrou seria reivindicado sem aceite.
    const client = sqlClient([
      FED_FOUND,
      USER_INSERT,
      [/FROM companies WHERE cnpj/, { rows: [{ id: 'c-existente', plan: 'negocio' }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).post('/api/v1/auth/register').send(dojoBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CNPJ_ALREADY_REGISTERED');
    expect(findInsertCompanies(client)).toBeUndefined();
  });
});

// ── Caminho feliz ───────────────────────────────────────────
describe('POST /auth/register — F11 dojô criado', () => {
  test('201 — company nasce karate_dojo com o federation_id escolhido', async () => {
    const client = sqlClient([FED_FOUND, USER_INSERT, NO_CNPJ_MATCH, [/INSERT INTO companies/, companyRow()]]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).post('/api/v1/auth/register').send(dojoBody());

    expect(res.status).toBe(201);
    expect(res.body.company.vertical).toBe('karate_dojo');
    expect(res.body.company.vertical_active).toBe('karate_dojo');
    expect(res.body.company.federation_id).toBe(FED_ID);
    expect(res.body.company.dojo_id).toBe('c-dojo-1');
    expect(res.body.company.karate_role).toBe('dojo_owner');
  });

  test('201 — o INSERT recebe vertical, vertical_active e federation_id', async () => {
    const client = sqlClient([FED_FOUND, USER_INSERT, NO_CNPJ_MATCH, [/INSERT INTO companies/, companyRow()]]);
    db.connect.mockResolvedValueOnce(client);

    await request(app).post('/api/v1/auth/register').send(dojoBody());

    const insert = findInsertCompanies(client);
    expect(insert).toBeDefined();
    expect(insert.text).toMatch(/vertical/);
    expect(insert.text).toMatch(/vertical_active/);
    expect(insert.text).toMatch(/federation_id/);
    // $8 alimenta vertical E vertical_active; $9 é o federation_id.
    expect(insert.params[7]).toBe('karate_dojo');
    expect(insert.params[8]).toBe(FED_ID);
  });

  test('201 — karate_dojo_linked_at e fpkt_affiliation_id NÃO são escritos', async () => {
    // A regra que não pode ser violada: criar a conta não é estar filiado, e
    // o número FPKT é sempre digitado pela federação.
    const client = sqlClient([FED_FOUND, USER_INSERT, NO_CNPJ_MATCH, [/INSERT INTO companies/, companyRow()]]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).post('/api/v1/auth/register').send(dojoBody());

    const writes = client.calls.filter((c) => /INSERT|UPDATE/i.test(c.text));
    for (const w of writes) {
      expect(w.text).not.toMatch(/karate_dojo_linked_at/);
      expect(w.text).not.toMatch(/fpkt_affiliation_id/);
    }
    expect(res.body.company.karate_dojo_linked_at).toBeNull();
  });

  test('201 — JWT já sai com dojo_id + federation_id (destrava requireDojoAccess)', async () => {
    const client = sqlClient([FED_FOUND, USER_INSERT, NO_CNPJ_MATCH, [/INSERT INTO companies/, companyRow()]]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).post('/api/v1/auth/register').send(dojoBody());
    const decoded = jwt.verify(res.body.token, SECRET);

    expect(decoded.type).toBe('access');
    expect(decoded.dojo_id).toBe('c-dojo-1');
    expect(decoded.federation_id).toBe(FED_ID);
    expect(decoded.karate_role).toBe('dojo_owner');
  });
});

// ── Não-regressão do varejo ─────────────────────────────────
describe('POST /auth/register — F11 não mexe no varejo', () => {
  test('201 — sem `vertical` no body, as três colunas novas vão NULL', async () => {
    const client = sqlClient([
      USER_INSERT,
      NO_CNPJ_MATCH,
      [/INSERT INTO companies/, companyRow({ id: 'c-loja', vertical: null, vertical_active: null, federation_id: null })],
    ]);
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'João', email: 'joao@loja.com', password: 'senha1234',
      company_name: 'Loja', cnpj: '11222333000181', terms_accepted: true,
    });

    expect(res.status).toBe(201);
    const insert = findInsertCompanies(client);
    expect(insert.params[7]).toBeNull();
    expect(insert.params[8]).toBeNull();
    expect(res.body.company.vertical_active).toBeNull();
    expect(res.body.company.federation_id).toBeNull();
    expect(res.body.company.dojo_id).toBeNull();
  });

  test('varejo não roda a query de validação de federação', async () => {
    const client = sqlClient([USER_INSERT, NO_CNPJ_MATCH, [/INSERT INTO companies/, companyRow({ vertical: null, vertical_active: null, federation_id: null })]]);
    db.connect.mockResolvedValueOnce(client);

    await request(app).post('/api/v1/auth/register').send({
      name: 'João', email: 'joao@loja.com', password: 'senha1234',
      company_name: 'Loja', terms_accepted: true,
    });

    expect(client.calls.some((c) => /karate_federation/.test(c.text))).toBe(false);
  });
});
