// ============================================================
// AURA DOJÔ — Testes Integração: superfícies FEDERATIVAS do dojô só
// existem depois da CONEXÃO (companies.karate_dojo_linked_at, migr. 251)
//
// O PR #420 fechou o lado da FEDERAÇÃO (ela não enxerga dojô não
// conectado). Aqui é o lado INVERSO, achado no QA de produção: o dojô
// não conectado enxergava os exames/cursos REAIS da FPKT em
// GET /dojo/events e uma tela de "filiação à federação" em /dojo/annuity.
//
// Contrato validado:
//   não conectado → /dojo/me      200 linked:false, linked_at:null
//                   /dojo/events  200 vazio + not_linked:true (NUNCA 403)
//                   /dojo/annuity 200 vazio + not_linked:true
//                   POST /dojo/practitioner-requests → 409 DOJO_NAO_CONECTADO
//   conectado     → tudo normal (regressão: shape antigo intacto,
//                   not_linked ausente, POST cria 201)
//
// ⚠️ MOCK POR SQL (mockImplementation), NÃO {rows: []} genérico. Os
// handlers fazem `const { rows } = await db.query(...)` e leem rows[0]
// direto — um mock que devolve rows:[] (ou undefined, que é o default do
// jest.fn de tests/jest.setup.js) para TODAS as queries vira TypeError
// → 500, e o teste passa a medir a coisa errada. Foi exatamente o que
// quebrou o CI no PR #421. Cada query é identificada pela própria SQL.
//
// db.query.mockReset() em afterEach (jest.clearAllMocks NÃO drena filas).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const base = `/api/v1/federation/${fedId}/dojo`;

// Canal A: JWT de acesso padrão com dojo_id (requireDojoAccess → canal 'A')
const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (re) => sqls().some((s) => re.test(s));

// A query do helper karateDojoLinkStatus é a ÚNICA que menciona a coluna.
const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);

const companyRow = {
  id: dojoId,
  legal_name: 'Dojô QA LTDA',
  trade_name: 'Dojô QA',
  phone: '91999990000',
  federation_id: fedId,
  vertical: 'karate_dojo',
  created_at: '2026-07-01T00:00:00Z',
  owner_email: 'sensei@dojo.com.br',
};

// linkedAt = null → dojô NÃO conectado; Date/string → conectado.
// `extra(sql)` devolve o resultado das demais queries (ou null p/ default).
function mockDb(linkedAt, extra) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    // /dojo/me. A âncora é o INÍCIO do SELECT, não o FROM: o contato da
    // federação em /dojo/events também faz `FROM companies c LEFT JOIN
    // users u` e menciona c.legal_name (dentro do COALESCE) — casar pelo
    // FROM devolveria a row do dojô para a query da federação.
    if (/SELECT c\.id, c\.legal_name/.test(s)) {
      return Promise.resolve({ rows: [companyRow] });
    }
    if (extra) {
      const r = extra(s);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [] });
  });
}

// Ficha completa — validatePractitionerRequestPayload exige TODOS estes
// campos (item 6 da revisão de Atualização Cadastral, 15/07/2026).
const fichaCompleta = () => ({
  full_name: 'Praticante Novo',
  birth_date: '1995-04-12',
  sex: 'M',
  cpf: '529.982.247-25',
  rg: '1234567',
  phone: '91999990000',
  email: 'praticante@exemplo.com',
  claimed_belt: 'Branca',
  zip_code: '66000-000',
  street: 'Rua das Palmeiras',
  number: '100',
  neighborhood: 'Centro',
  city: 'Belém',
  state: 'PA',
});

afterEach(() => {
  db.query.mockReset();
});

describe('Aura Dojô — dojô NÃO conectado não vê nem escreve na federação', () => {
  test('sem token → 401', async () => {
    const res = await request(app).get(`${base}/me`);
    expect(res.status).toBe(401);
  });

  test('/dojo/me → linked:false + linked_at:null (shape antigo intacto)', async () => {
    mockDb(null);
    const res = await request(app).get(`${base}/me`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(res.body.linked_at).toBeNull();
    expect(res.body.dojo.linked).toBe(false);
    expect(res.body.dojo.linked_at).toBeNull();
    // ADITIVO: nada do shape que o front já consome foi removido
    expect(res.body.dojo.id).toBe(dojoId);
    expect(res.body.dojo.name).toBe('Dojô QA');
    expect(res.body.dojo.federation_id).toBe(fedId);
    expect(res.body.dojo.auth_channel).toBe('A');
  });

  test('/dojo/events → 200 vazio + not_linked:true, SEM ler os exames da federação', async () => {
    mockDb(null);
    const res = await request(app).get(`${base}/events`).set(canalA());

    expect(res.status).toBe(200); // nunca 403 — o front precisa do estado
    expect(res.body.not_linked).toBe(true);
    expect(res.body.events).toEqual([]);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
    expect(res.body.federation).toBeNull();
    expect(hitSql(/karate_belt_exams/)).toBe(false);
  });

  test('/dojo/annuity → 200 vazio + not_linked:true, SEM ler o histórico de anuidade', async () => {
    mockDb(null);
    const res = await request(app).get(`${base}/annuity`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.not_linked).toBe(true);
    expect(res.body.pending).toBeNull();
    expect(res.body.history).toEqual([]);
    expect(res.body.pix).toBeNull();
    expect(hitSql(/karate_dojo_annuity_history/)).toBe(false);
    expect(hitSql(/digital_channel_config/)).toBe(false);
  });

  test('POST /dojo/practitioner-requests → 409 DOJO_NAO_CONECTADO (nada gravado)', async () => {
    mockDb(null);
    const res = await request(app)
      .post(`${base}/practitioner-requests`)
      .set(canalA())
      .send(fichaCompleta());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOJO_NAO_CONECTADO');
    expect(res.body.error).toMatch(/Conecte seu dojô/i);
    expect(hitSql(/INSERT INTO karate_practitioner_requests/)).toBe(false);
  });

  test('POST /dojo/practitioner-requests com body vazio → 409 (gate ANTES da validação)', async () => {
    mockDb(null);
    const res = await request(app)
      .post(`${base}/practitioner-requests`)
      .set(canalA())
      .send({});

    expect(res.status).toBe(409); // e não 422 — o motivo real é a conexão
    expect(res.body.code).toBe('DOJO_NAO_CONECTADO');
  });
});

describe('REGRESSÃO — dojô CONECTADO continua vendo tudo', () => {
  const linkedAt = new Date('2026-07-01T12:00:00Z');

  test('/dojo/me → linked:true + linked_at ISO', async () => {
    mockDb(linkedAt);
    const res = await request(app).get(`${base}/me`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.linked_at).toBe('2026-07-01T12:00:00.000Z');
    expect(res.body.dojo.linked).toBe(true);
    expect(res.body.dojo.name).toBe('Dojô QA');
  });

  test('/dojo/events → eventos reais da federação + contato, sem not_linked', async () => {
    mockDb(linkedAt, (s) => {
      if (/karate_belt_exams/.test(s)) {
        return {
          rows: [{
            id: 'e1', name: 'Exame de Faixa', exam_type: 'exame',
            event_date: '2026-08-10', location: 'Belém', fee_amount: '80.00', status: 'open',
          }],
        };
      }
      if (/COALESCE\(c\.trade_name, c\.legal_name\) AS name/.test(s)) {
        return { rows: [{ name: 'FPKT', phone: '9130000000', email: 'fpkt@getaura.com.br' }] };
      }
      return null;
    });

    const res = await request(app).get(`${base}/events`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.not_linked).toBeUndefined();
    expect(res.body.count).toBe(1);
    expect(res.body.events[0].id).toBe('e1');
    expect(res.body.events[0].fee_amount).toBe(80);
    expect(res.body.federation.name).toBe('FPKT');
  });

  test('/dojo/annuity → pendente + histórico + pix da federação, sem not_linked', async () => {
    mockDb(linkedAt, (s) => {
      if (/karate_dojo_annuity_history/.test(s)) {
        return {
          rows: [{
            id: 'a1', reference_period: '2026', amount: '500.00',
            status: 'pendente', paid_at: null, due_date: '2026-05-10',
          }],
        };
      }
      if (/digital_channel_config/.test(s)) {
        return { rows: [{ pix_key: 'fpkt@getaura.com.br', pix_key_type: 'email', pix_holder_name: 'FPKT' }] };
      }
      return null;
    });

    const res = await request(app).get(`${base}/annuity`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.not_linked).toBeUndefined();
    expect(res.body.pending.annuity_history_id).toBe('a1');
    expect(res.body.pending.amount).toBe(500);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.pix.key).toBe('fpkt@getaura.com.br');
  });

  test('POST /dojo/practitioner-requests → 201 (gate não atrapalha quem está conectado)', async () => {
    mockDb(linkedAt, (s) => {
      if (/INSERT INTO karate_practitioner_requests/.test(s)) {
        return { rows: [{ id: 'r1', status: 'pendente', created_at: '2026-07-25T00:00:00Z' }] };
      }
      return null;
    });

    const res = await request(app)
      .post(`${base}/practitioner-requests`)
      .set(canalA())
      .send(fichaCompleta());

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('r1');
    expect(res.body.already_pending).toBe(false);
    // escopo: dojo_id do INSERT vem do TOKEN, nunca do body
    const insert = db.query.mock.calls.find((c) => /INSERT INTO karate_practitioner_requests/.test(String(c[0])));
    expect(insert[1][0]).toBe(fedId);
    expect(insert[1][1]).toBe(dojoId);
  });
});
