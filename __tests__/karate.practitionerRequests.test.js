// ============================================================
// AURA KARATÊ — H1: solicitação de criação/transferência de praticante
//
// Cobertura pedida na entrega:
//   (a) criar praticante SEM número FPKT falha (422, ficha direta)
//   (b) número duplicado falha (409, ficha direta + aprovação de solicitação)
//   (c) solicitação duplicada é idempotente (mesmo dojô+nome+nascimento)
//   (d) o dojô vem do TOKEN, nunca do body
//   (e) aprovar (criação ou transferência) NÃO gera cobrança
//   (f) gate de conexão: dojô não conectado não solicita (409) — PR #422
//
// Estilo: supertest + mock sequencial de db.query/db.connect (mesmo padrão
// de __tests__/karate.trackM.routes.test.js / karate.rosterPortalScale.test.js).
//
// ── ATENÇÃO ao bloco POST /dojo/practitioner-requests ───────
// O PR #422 ("superfícies federativas do dojô só após conexão") colocou o
// helper isDojoLinked (src/services/karateDojoLinkStatus.js) como PRIMEIRA
// coisa do handler — antes até da validação da ficha. Isso insere uma
// query (`SELECT karate_dojo_linked_at FROM companies`) na FRENTE de
// qualquer fila posicional de mockResolvedValueOnce, e foi exatamente o
// que quebrou o CI: o helper comeu o mock do INSERT, leu uma row sem a
// coluna (undefined => NÃO conectado) e devolveu 409; os casos seguintes
// herdaram o deslocamento da fila.
// Por isso este bloco mocka POR SQL (mockImplementation), não por posição
// — mesmo padrão de tests/integration/karateDojoNotLinked.test.js. Mock
// genérico `{rows: []}` também não serve: o handler lê `rows[0]` direto em
// vários pontos (foi o que quebrou o CI no PR #421).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const FED_ID = 'fed-uuid-001';
const DOJO_ID = 'dojo-uuid-001';
const OTHER_DOJO_ID = 'dojo-uuid-999'; // dojô falso mandado no BODY — nunca deve ser usado

const dojoToken = jwt.sign(
  { type: 'access', id: 'user-dojo-001', dojo_id: DOJO_ID, federation_id: FED_ID },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const adminToken = jwt.sign(
  { id: 'user-admin-001', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

function buildDojoApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateDojoPractitionerRequests'));
  return app;
}

function buildAdminApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karatePractitionerRequestsAdmin'));
  return app;
}

function buildPractitionersApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/practitioners', require('../src/routes/karatePractitioners'));
  return app;
}

// ── Utilitários do gate de conexão (PR #422) ────────────────
// A query do helper karateDojoLinkStatus é a ÚNICA que traz a coluna
// karate_dojo_linked_at na lista do SELECT.
const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);

const callsMatching = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0])));

// linkedAt: null => dojô NÃO conectado; Date/string => conectado.
// answer(sql) responde as demais queries do handler (null => `{rows: []}`).
// Despacha pela SQL, nunca pela ordem: query nova entrando na frente do
// handler não pode mais desalinhar teste nenhum.
function mockDojoDb(linkedAt, answer) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    if (answer) {
      const r = answer(s);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [] });
  });
}

const LINKED_AT = new Date('2026-07-01T12:00:00Z'); // dojô conectado

// Ficha completa e válida — desde o item 6 (15/07/2026) TODOS os campos
// são obrigatórios, então um payload parcial daria 422 antes do que
// queremos testar.
function fullPayload(extra) {
  return Object.assign({
    full_name: 'Novo Aluno', birth_date: '1990-03-01', sex: 'M', cpf: '11111111111', rg: '123456',
    phone: '11999999999', email: 'novo.aluno@example.com', claimed_belt: 'Branca',
    zip_code: '01000-000', street: 'Rua Teste', number: '100', neighborhood: 'Centro', city: 'São Paulo', state: 'SP',
  }, extra || {});
}

// ════════════════════════════════════════════════════════════
// (a) + (b) — ficha direta (POST /federation/:id/practitioners)
// ════════════════════════════════════════════════════════════
describe('POST /federation/:id/practitioners — H1: número FPKT obrigatório, nunca gerado', () => {
  it('422 FPKT_NUMBER_REQUIRED quando karate_registration_number não é enviado', (done) => {
    const app = buildPractitionersApp();
    request(app)
      .post(`/federation/${FED_ID}/practitioners`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ full_name: 'Aluno Sem Número', dojo_id: DOJO_ID })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FPKT_NUMBER_REQUIRED');
        // Nunca chega a abrir transação/consultar o banco — a validação é antes do BEGIN.
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (c) + (d) + (f) — POST /federation/:id/dojo/practitioner-requests
// Todos os casos abaixo simulam um dojô CONECTADO (exceto o do gate):
// sem isso o handler para no 409 antes de qualquer coisa.
// ════════════════════════════════════════════════════════════
describe('POST /federation/:id/dojo/practitioner-requests', () => {
  it('201 cria solicitação — dojo_id vem do TOKEN, nunca do body (d)', (done) => {
    const app = buildDojoApp();
    mockDojoDb(LINKED_AT, (s) => {
      if (/INSERT INTO karate_practitioner_requests/.test(s)) {
        return { rows: [{ id: 'req-001', status: 'pendente', created_at: '2026-07-14T00:00:00Z' }] };
      }
      return null; // roster event (best-effort) e demais → { rows: [] }
    });

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(fullPayload({ dojo_id: OTHER_DOJO_ID, federation_id: 'fed-outra' }))
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.already_pending).toBe(false);

        // O gate de conexão roda ANTES de tudo (PR #422): a 1ª query do
        // handler é a dele, não mais o INSERT.
        expect(isLinkQuery(String(db.query.mock.calls[0][0]))).toBe(true);

        // O INSERT real precisa ter usado DOJO_ID (do token) — nunca OTHER_DOJO_ID (do body).
        // Localizado pela SQL, não pela posição na fila.
        const insertCall = callsMatching(/INSERT INTO karate_practitioner_requests/)[0];
        expect(insertCall).toBeDefined();
        const params = insertCall[1];
        // Ordem dos params: federationId, dojoId, full_name, ...
        expect(params[0]).toBe(FED_ID);
        expect(params[1]).toBe(DOJO_ID);
        expect(params[1]).not.toBe(OTHER_DOJO_ID);
        done();
      });
  });

  it('200 idempotente quando já existe solicitação PENDENTE igual (mesmo dojô+nome+nascimento) (c)', (done) => {
    const app = buildDojoApp();
    mockDojoDb(LINKED_AT, (s) => {
      // INSERT ... ON CONFLICT DO NOTHING -> 0 rows (colidiu)
      if (/INSERT INTO karate_practitioner_requests/.test(s)) return { rows: [] };
      // SELECT da solicitação pendente existente
      if (/dedup_key = \$2/.test(s)) {
        return { rows: [{ id: 'req-existing-001', status: 'pendente', created_at: '2026-07-10T00:00:00Z' }] };
      }
      return null;
    });

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(fullPayload({
        full_name: 'Aluno Repetido', birth_date: '1991-05-05', sex: 'F', cpf: '22222222222', rg: '654321',
        phone: '11988888888', email: 'aluno.repetido@example.com', number: '200',
      }))
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.already_pending).toBe(true);
        expect(res.body.id).toBe('req-existing-001');
        // Não deve haver uma segunda tentativa de INSERT — só o conflito +
        // a busca da existente. (Contar chamadas por SQL, não o total: o
        // total inclui a query do gate de conexão.)
        expect(callsMatching(/INSERT INTO karate_practitioner_requests/).length).toBe(1);
        expect(callsMatching(/dedup_key = \$2/).length).toBe(1);
        done();
      });
  });

  it('422 quando full_name está ausente', (done) => {
    const app = buildDojoApp();
    mockDojoDb(LINKED_AT);

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send({ birth_date: '2012-01-01' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        // Nada é gravado. A ÚNICA query que roda é a do gate de conexão,
        // que por decisão do #422 vem antes da validação da ficha (não
        // adianta mandar preencher 15 campos para depois dizer que o dojô
        // nem está conectado).
        expect(db.query.mock.calls.every((c) => isLinkQuery(String(c[0])))).toBe(true);
        expect(callsMatching(/INSERT INTO/i).length).toBe(0);
        done();
      });
  });

  // ── Gate de conexão (PR #422) — o caminho novo ────────────
  it('409 DOJO_NAO_CONECTADO quando o dojô ainda não se conectou à federação — nada gravado (f)', (done) => {
    const app = buildDojoApp();
    mockDojoDb(null); // karate_dojo_linked_at NULL = dojô self-serve não conectado

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(fullPayload()) // ficha PERFEITA: o que barra é o estado do dojô, não o payload
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409); // conflito de ESTADO, não 403 de permissão
        expect(res.body.code).toBe('DOJO_NAO_CONECTADO');
        expect(res.body.error).toMatch(/Conecte seu dojô/i);
        // Solicitar praticante é ESCRITA na federação: não pode sobrar nada.
        expect(callsMatching(/INSERT INTO/i).length).toBe(0);
        done();
      });
  });

  it('42703 (migration 251 pendente) → fail-open: o gate NÃO bloqueia quem já usa (f)', (done) => {
    const app = buildDojoApp();
    // Decisão explícita do helper: coluna ausente/erro transitório devolve
    // linked:true. Esconder a solicitação de todo mundo porque a coluna
    // ainda não existe seria pior que deixar passar num caso novo.
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (isLinkQuery(s)) {
        return Promise.reject(Object.assign(new Error('column karate_dojo_linked_at does not exist'), { code: '42703' }));
      }
      if (/INSERT INTO karate_practitioner_requests/.test(s)) {
        return Promise.resolve({ rows: [{ id: 'req-failopen', status: 'pendente', created_at: '2026-07-25T00:00:00Z' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send(fullPayload())
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe('req-failopen');
        expect(callsMatching(/INSERT INTO karate_practitioner_requests/).length).toBe(1);
        done();
      });
  });

  it('401 sem token de dojô', (done) => {
    const app = buildDojoApp();
    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .send({ full_name: 'Sem Token' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(401);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// (e) aprovar NÃO gera cobrança — approve-create / approve-transfer
// ════════════════════════════════════════════════════════════
describe('POST /federation/:id/practitioner-requests/:requestId/approve-create', () => {
  it('422 quando fpkt_number não é enviado (número nunca é gerado pelo backend)', (done) => {
    const app = buildAdminApp();
    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FPKT_NUMBER_REQUIRED');
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });

  it('201 cria o praticante com o número informado, sem tocar em NENHUMA tabela de anuidade/cobrança (e)', (done) => {
    const app = buildAdminApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ // SELECT solicitação FOR UPDATE
        id: 'req-001', federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente',
        full_name: 'Aluno Aprovado', cpf: null, rg: null, birth_date: '2012-01-01',
        email: null, phone: null, claimed_belt: 'faixa branca', payload: {},
      }] })
      .mockResolvedValueOnce({ rows: [] }) // SELECT dup fpkt_number
      .mockResolvedValueOnce({ rows: [{ id: 'prac-new-001', name: 'Aluno Aprovado', karate_registration_number: '54321-D', dojo_id: DOJO_ID }] }) // INSERT customers
      .mockResolvedValueOnce({ rows: [{ id: 'belt-001' }] }) // INSERT karate_belt_history (claimed_belt presente)
      .mockResolvedValueOnce({ rows: [] }) // UPDATE karate_practitioner_requests
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT karate_dojo_roster_events
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fpkt_number: '54321-D' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.resolution).toBe('created');
        expect(res.body.practitioner.karate_registration_number).toBe('54321-D');

        // Nenhuma das queries executadas na transação toca tabela de
        // anuidade/cobrança/pagamento — prova que aprovar não gera cobrança.
        const allSql = mockClient.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('\n');
        expect(allSql).not.toMatch(/annuity/i);
        expect(allSql).not.toMatch(/payment/i);
        expect(allSql).not.toMatch(/charge/i);
        expect(allSql).not.toMatch(/transaction/i);
        done();
      });
  });

  it('409 quando a solicitação já foi resolvida', (done) => {
    const app = buildAdminApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', status: 'aprovada' }] }) // já resolvida
      .mockResolvedValueOnce({}); // ROLLBACK

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fpkt_number: '11111-D' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ALREADY_RESOLVED');
        done();
      });
  });

  it('409 FPKT_NUMBER_TAKEN quando o número já está em uso na federação (b)', (done) => {
    const app = buildAdminApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente', full_name: 'X', payload: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 'someone-else' }] }) // SELECT dup -> já existe
      .mockResolvedValueOnce({}); // ROLLBACK

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fpkt_number: '12345-D' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FPKT_NUMBER_TAKEN');
        done();
      });
  });
});

describe('POST /federation/:id/practitioner-requests/:requestId/approve-transfer — não gera cobrança', () => {
  it('200 vincula praticante existente e move de dojô, sem tocar em anuidade/cobrança (e)', (done) => {
    const app = buildAdminApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'req-002', federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente' }] }) // solicitação
      .mockResolvedValueOnce({ rows: [{ id: 'prac-existing-001', name: 'Fulano', email: null, dojo_id: 'dojo-origem-001' }] }) // praticante FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID, name: 'Dojo Destino', email: null }] }) // dest company
      .mockResolvedValueOnce({ rows: [{ id: 'dojo-origem-001', name: 'Dojo Origem', email: null }] }) // origin company
      .mockResolvedValueOnce({ rows: [] }) // UPDATE customers dojo_id
      .mockResolvedValueOnce({ rows: [{ id: 'transfer-001', transferred_at: '2026-07-14', created_at: '2026-07-14T00:00:00Z' }] }) // INSERT transfers
      .mockResolvedValueOnce({ rows: [] }) // UPDATE karate_practitioner_requests
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-002/approve-transfer`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ practitioner_id: 'prac-existing-001' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.resolution).toBe('transferred');

        const allSql = mockClient.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('\n');
        expect(allSql).not.toMatch(/annuity/i);
        expect(allSql).not.toMatch(/payment/i);
        expect(allSql).not.toMatch(/charge/i);
        done();
      });
  });

  // ════════════════════════════════════════════════════════
  // Item 2 (H3) — REGRA CRÍTICA: transferência NUNCA sobrescreve
  // histórico. Praticante existente tem faixa X (karate_current_belt);
  // a solicitação ALEGA faixa Y != X (o sensei pode ter digitado
  // errado, ou o praticante pode ter subido de faixa sem o dojô
  // anterior ter registrado). Aprovar como transferência PODE MUDAR
  // O DOJÔ, mas NUNCA pode inserir/alterar karate_belt_history a
  // partir da faixa alegada — isso só pode acontecer via edição
  // deliberada e auditada, nunca como efeito colateral do aprovar.
  // ════════════════════════════════════════════════════════
  it('faixa alegada DIVERGENTE nunca escreve em karate_belt_history — histórico preservado, só o dojô muda (item 2)', (done) => {
    const app = buildAdminApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // Praticante existente é FAIXA PRETA de verdade (karate_current_belt,
    // fora do escopo desta query — approve-transfer nem consulta a faixa
    // atual, prova em código de que não decide nada com base nela).
    // A solicitação alega 'faixa branca' (claimed_belt = Y != X) — o
    // handler sequer LÊ reqRow.claimed_belt no fluxo de transferência.
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{
        id: 'req-divergente-001', federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente',
        full_name: 'Praticante Faixa Preta', claimed_belt: 'faixa branca', payload: {},
      }] }) // solicitação FOR UPDATE — claimed_belt DIVERGE da faixa real do praticante
      .mockResolvedValueOnce({ rows: [{ id: 'prac-faixa-preta-001', name: 'Praticante Faixa Preta', email: null, dojo_id: 'dojo-origem-002' }] }) // praticante FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID, name: 'Dojo Destino', email: null }] }) // dest company
      .mockResolvedValueOnce({ rows: [{ id: 'dojo-origem-002', name: 'Dojo Origem', email: null }] }) // origin company
      .mockResolvedValueOnce({ rows: [] }) // UPDATE customers dojo_id (só isto muda no praticante)
      .mockResolvedValueOnce({ rows: [{ id: 'transfer-002', transferred_at: '2026-07-14', created_at: '2026-07-14T00:00:00Z' }] }) // INSERT transfers
      .mockResolvedValueOnce({ rows: [] }) // UPDATE karate_practitioner_requests
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-divergente-001/approve-transfer`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ practitioner_id: 'prac-faixa-preta-001' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.resolution).toBe('transferred');

        const allSql = mockClient.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
        const joined = allSql.join('\n');
        // A prova central do item 2: NENHUMA query da transação toca
        // karate_belt_history, mesmo com claimed_belt divergente no payload.
        expect(joined).not.toMatch(/karate_belt_history/i);
        expect(joined).not.toMatch(/annuity/i);

        // O ÚNICO UPDATE em customers desta transação é o de dojo_id —
        // não deve setar nenhuma coluna de faixa/belt.
        const customersUpdate = allSql.find((sql) => /UPDATE customers/i.test(sql));
        expect(customersUpdate).toMatch(/dojo_id/);
        expect(customersUpdate).not.toMatch(/belt/i);

        done();
      });
  });
});

describe('POST /federation/:id/practitioner-requests/:requestId/reject', () => {
  it('422 quando reason não é enviado (o sensei precisa ver o motivo)', (done) => {
    const app = buildAdminApp();
    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('200 rejeita com motivo', (done) => {
    const app = buildAdminApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', dojo_id: DOJO_ID, full_name: 'X' }] }) // UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event (standalone)
      .mockResolvedValueOnce({ rows: [{ token: 'tok-1', token_expires_at: '2026-08-01T00:00:00Z', self_service_token: 'ss-1', self_service_token_expires_at: '2026-08-01T00:00:00Z' }] }); // reopen dojo access

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'CPF inválido' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('rejeitada');
        expect(res.body.reject_reason).toBe('CPF inválido');
        done();
      });
  });

  // (c) item 4, H3: rejeitar REABRE/ESTENDE o acesso do link público do
  // dojô (karate_dojo_roster_validation) — o token expira quando o sensei
  // "fecha" o quadro; se a rejeição chega depois, ele precisa conseguir
  // voltar para ver o motivo e reenviar.
  it('rejeição reabre o acesso do dojô (estende token_expires_at) — item 4', (done) => {
    const app = buildAdminApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', dojo_id: DOJO_ID, full_name: 'X' }] }) // UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event (standalone)
      .mockResolvedValueOnce({ rows: [{ token: 'tok-1', token_expires_at: '2026-08-01T00:00:00Z', self_service_token: 'ss-1', self_service_token_expires_at: '2026-08-01T00:00:00Z' }] }); // reopen dojo access

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-001/reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'CPF inválido' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojo_access_reopened).toBe(true);

        // A 3ª chamada precisa ser o UPDATE que estende (GREATEST, nunca
        // encurta) o token do dojô rejeitado — usando o dojo_id CORRETO
        // (o da linha resolvida, não um valor arbitrário).
        const reopenCall = db.query.mock.calls[2];
        expect(reopenCall[0]).toMatch(/UPDATE karate_dojo_roster_validation/);
        expect(reopenCall[0]).toMatch(/GREATEST/);
        expect(reopenCall[1]).toEqual([DOJO_ID]);
        done();
      });
  });

  it('dojo_access_reopened:false sem quebrar a rejeição quando o dojô nunca teve link de validação', (done) => {
    const app = buildAdminApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'req-002', dojo_id: DOJO_ID, full_name: 'Y' }] }) // UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event (standalone)
      .mockResolvedValueOnce({ rows: [] }); // reopen dojo access -> nenhuma linha (nunca solicitou quadro)

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/req-002/reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ reason: 'RG ilegível' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojo_access_reopened).toBe(false);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// GET auto-localizar por número FPKT (portal do sensei)
// NÃO gateado por conexão (é leitura/consulta, não escreve nada na
// federação) — segue com fila posicional simples.
// ════════════════════════════════════════════════════════════
describe('GET /federation/:id/dojo/practitioner-requests/lookup-fpkt', () => {
  it('found:true e is_transfer:true quando o número já pertence a alguém', (done) => {
    const app = buildDojoApp();
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'prac-x', name: 'Fulano', dojo_id: 'other-dojo', dojo_name: 'Outro Dojo', is_active: true }],
    });

    request(app)
      .get(`/federation/${FED_ID}/dojo/practitioner-requests/lookup-fpkt?number=12345-D`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.found).toBe(true);
        expect(res.body.is_transfer).toBe(true);
        expect(res.body.practitioner.id).toBe('prac-x');
        done();
      });
  });

  it('found:false quando o número não existe', (done) => {
    const app = buildDojoApp();
    db.query.mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED_ID}/dojo/practitioner-requests/lookup-fpkt?number=00000-X`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.found).toBe(false);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// Deduplicação — service puro (SUGERE, nunca decide)
// ════════════════════════════════════════════════════════════
describe('karatePractitionerDedup — SUGERE, não decide', () => {
  const { normalizeName, buildDedupKey, findPossibleMatches } = require('../src/services/karatePractitionerDedup');

  it('normaliza nome (acento, caixa, espaços) para comparação estável', () => {
    expect(normalizeName('joão   da  Silva')).toBe(normalizeName('JOÃO DA SILVA'));
    expect(normalizeName(' José   António ')).toBe('JOSE ANTONIO');
  });

  it('dedup_key combina nome normalizado + nascimento', () => {
    expect(buildDedupKey('Maria Souza', '2015-06-01')).toBe('MARIA SOUZA|2015-06-01');
  });

  it('sem nenhuma chave forte (fpkt/nascimento/rg/cpf), não busca nada — nome sozinho não basta', async () => {
    const dbMock = { query: jest.fn() };
    const matches = await findPossibleMatches(dbMock, { federationId: FED_ID, fullName: 'Fulano Qualquer' });
    expect(matches).toEqual([]);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('CPF sozinho nunca vira confiança alta (reforço, não chave principal)', async () => {
    const dbMock = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'p1', name: 'Nome Diferente', karate_registration_number: null, birth_date: null, rg: null, cpf_cnpj: '11122233344', dojo_id: DOJO_ID, dojo_name: 'D' }],
      }),
    };
    const matches = await findPossibleMatches(dbMock, { federationId: FED_ID, fullName: 'Nome Diferente', cpf: '111.222.333-44' });
    expect(matches.length).toBe(1);
    expect(matches[0].matched_on).toEqual(['cpf']);
    expect(matches[0].confidence).toBe('low');
  });
});

// ════════════════════════════════════════════════════════════
// Item 5 (H3) — métricas da fila (pendentes, mais antiga, aguardando FPKT)
// ════════════════════════════════════════════════════════════
describe('GET /federation/:id/practitioner-requests/metrics', () => {
  it('rota ESTÁTICA: "/practitioner-requests/metrics" não cai em /:requestId', (done) => {
    const app = buildAdminApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ pendentes: 3, mais_antiga_criada_em: '2026-07-01T00:00:00Z', aguardando_numero_fpkt: 2 }] })
      .mockResolvedValueOnce({ rows: [
        { dojo_id: DOJO_ID, dojo_nome: 'Dojo A', pendentes: 2, mais_antiga_criada_em: '2026-07-01T00:00:00Z' },
        { dojo_id: OTHER_DOJO_ID, dojo_nome: 'Dojo B', pendentes: 1, mais_antiga_criada_em: '2026-07-10T00:00:00Z' },
      ] });

    request(app)
      .get(`/federation/${FED_ID}/practitioner-requests/metrics`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.pendentes).toBe(3);
        expect(res.body.aguardando_numero_fpkt).toBe(2);
        expect(res.body.mais_antiga.criada_em).toBe('2026-07-01T00:00:00Z');
        expect(typeof res.body.mais_antiga.dias).toBe('number');
        expect(res.body.por_dojo.length).toBe(2);
        expect(res.body.por_dojo[0].dojo_id).toBe(DOJO_ID);
        // Prova de que "metrics" não foi engolido pela rota :requestId —
        // se tivesse caído lá, a query seria um SELECT com WHERE r.id = $1.
        const sql = db.query.mock.calls[0][0];
        expect(sql).not.toMatch(/WHERE r\.id = \$1/);
        done();
      });
  });

  it('sem nenhuma pendente: mais_antiga é null, contadores zerados', (done) => {
    const app = buildAdminApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ pendentes: 0, mais_antiga_criada_em: null, aguardando_numero_fpkt: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED_ID}/practitioner-requests/metrics`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.pendentes).toBe(0);
        expect(res.body.mais_antiga).toBeNull();
        expect(res.body.por_dojo).toEqual([]);
        done();
      });
  });

  it('42P01 (migração pendente) degrada para métricas zeradas, sem 500', (done) => {
    const app = buildAdminApp();
    const err42P01 = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    db.query.mockRejectedValueOnce(err42P01);

    request(app)
      .get(`/federation/${FED_ID}/practitioner-requests/metrics`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.pendentes).toBe(0);
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// Lote (24/08/2026) — batch-approve-create / batch-reject
// QA 23/08: "5 passos, um por um". O lote reusa o caminho individual
// (approveCreateOne/rejectOne) item a item, transação POR ITEM: a falha de
// um não desfaz os demais. Aqui cobrimos:
//   (g) validação all-or-nothing ANTES do banco (422 sem tocar db.connect)
//   (h) número FPKT repetido DENTRO do lote é barrado antes de executar
//   (i) resultado misto: item 1 aprova, item 2 falha e volta itemizado
//   (j) lote de aprovação também NUNCA toca anuidade/cobrança (extensão do (e))
//   (k) batch-reject sem reason usa o texto padrão (o sensei sempre vê algo)
//   (l) batch-reject misto: já resolvida vira ok:false ALREADY_RESOLVED
// ════════════════════════════════════════════════════════════
describe('POST /federation/:id/practitioner-requests/batch-approve-create', () => {
  it('422 quando items não é enviado — nada toca o banco (g)', (done) => {
    const app = buildAdminApp();
    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/batch-approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });

  it('422 FPKT_NUMBER_DUPLICATED_IN_BATCH quando o mesmo número aparece em dois itens (h)', (done) => {
    const app = buildAdminApp();
    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/batch-approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ items: [
        { request_id: 'req-001', fpkt_number: '10001-D' },
        { request_id: 'req-002', fpkt_number: '10001-D' },
      ] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('FPKT_NUMBER_DUPLICATED_IN_BATCH');
        expect(res.body.request_id).toBe('req-002');
        // Barrado ANTES de executar — nem o item 1 (que seria válido) roda.
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });

  it('200 com resultado misto: item 1 aprovado, item 2 FPKT_NUMBER_TAKEN — sem desfazer o item 1 (i)(j)', (done) => {
    const app = buildAdminApp();

    // Cada item abre a PRÓPRIA transação (client próprio) — dois clients.
    const client1 = { query: jest.fn(), release: jest.fn() };
    const client2 = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValueOnce(client1).mockResolvedValueOnce(client2);

    client1.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ // SELECT solicitação FOR UPDATE
        id: 'req-001', federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente',
        full_name: 'Primeiro Do Lote', cpf: null, rg: null, birth_date: '2010-05-05',
        email: null, phone: null, claimed_belt: 'faixa branca', payload: {},
      }] })
      .mockResolvedValueOnce({ rows: [] }) // SELECT dup fpkt — livre
      .mockResolvedValueOnce({ rows: [{ id: 'prac-lote-001', name: 'Primeiro Do Lote', karate_registration_number: '20001-D', dojo_id: DOJO_ID }] }) // INSERT customers
      .mockResolvedValueOnce({ rows: [] }) // INSERT karate_belt_history
      .mockResolvedValueOnce({ rows: [] }) // UPDATE karate_practitioner_requests
      .mockResolvedValueOnce({}) // SAVEPOINT (roster event)
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    client2.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'req-002', federation_id: FED_ID, dojo_id: DOJO_ID, status: 'pendente', full_name: 'Segundo Do Lote', payload: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 'alguem' }] }) // dup fpkt — JÁ EM USO
      .mockResolvedValueOnce({}); // ROLLBACK

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/batch-approve-create`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ items: [
        { request_id: 'req-001', fpkt_number: '20001-D' },
        { request_id: 'req-002', fpkt_number: '20002-D' },
      ] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.approved).toBe(1);
        expect(res.body.failed).toBe(1);

        expect(res.body.results[0].request_id).toBe('req-001');
        expect(res.body.results[0].ok).toBe(true);
        expect(res.body.results[0].practitioner.karate_registration_number).toBe('20001-D');

        expect(res.body.results[1].request_id).toBe('req-002');
        expect(res.body.results[1].ok).toBe(false);
        expect(res.body.results[1].code).toBe('FPKT_NUMBER_TAKEN');

        // O item que falhou fez ROLLBACK só da PRÓPRIA transação; o item 1
        // seguiu até o COMMIT — falha não desfaz os demais.
        const sql1 = client1.query.mock.calls.map((c) => String(c[0])).join('\n');
        const sql2 = client2.query.mock.calls.map((c) => String(c[0])).join('\n');
        expect(sql1).toMatch(/COMMIT/);
        expect(sql1).not.toMatch(/ROLLBACK/);
        expect(sql2).toMatch(/ROLLBACK/);
        expect(sql2).not.toMatch(/COMMIT/);

        // (j) extensão do (e): o lote também nunca toca anuidade/cobrança.
        const allSql = sql1 + '\n' + sql2;
        expect(allSql).not.toMatch(/annuity/i);
        expect(allSql).not.toMatch(/payment/i);
        expect(allSql).not.toMatch(/charge/i);
        done();
      });
  });
});

describe('POST /federation/:id/practitioner-requests/batch-reject', () => {
  it('422 quando request_ids não é enviado', (done) => {
    const app = buildAdminApp();
    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/batch-reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        done();
      });
  });

  it('200 sem reason usa o motivo padrão — o sensei sempre vê ALGUM motivo (k)', (done) => {
    const app = buildAdminApp();

    // Despacho por SQL (nunca por posição — lição do PR #422 no topo do
    // arquivo): o UPDATE de rejeição devolve a linha; o resto (evento de
    // roster, reabertura de acesso) responde vazio, best-effort.
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/UPDATE karate_practitioner_requests/.test(s)) {
        return Promise.resolve({ rows: [{ id: params[2], dojo_id: DOJO_ID, full_name: 'Fulano' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/batch-reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ request_ids: ['req-001', 'req-002'] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.rejected).toBe(2);
        expect(res.body.failed).toBe(0);
        expect(res.body.reason).toMatch(/rejeitada pela federação/i);

        // O motivo padrão foi de fato PERSISTIDO ($1 do UPDATE), não só
        // devolvido na resposta.
        const updCalls = db.query.mock.calls.filter((c) => /UPDATE karate_practitioner_requests/.test(String(c[0])));
        expect(updCalls.length).toBe(2);
        for (const call of updCalls) {
          expect(call[1][0]).toMatch(/rejeitada pela federação/i);
        }
        done();
      });
  });

  it('200 misto: já resolvida vira ok:false ALREADY_RESOLVED sem derrubar as demais (l)', (done) => {
    const app = buildAdminApp();

    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/UPDATE karate_practitioner_requests/.test(s)) {
        // req-done já foi resolvida: o UPDATE (status = 'pendente') não pega nada.
        if (params[2] === 'req-done') return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ id: params[2], dojo_id: DOJO_ID, full_name: 'Fulano' }] });
      }
      if (/SELECT id FROM karate_practitioner_requests/.test(s)) {
        return Promise.resolve({ rows: [{ id: params[0] }] }); // existe, logo 409
      }
      return Promise.resolve({ rows: [] });
    });

    request(app)
      .post(`/federation/${FED_ID}/practitioner-requests/batch-reject`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ request_ids: ['req-001', 'req-done'], reason: 'Documentação ilegível' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.rejected).toBe(1);
        expect(res.body.failed).toBe(1);
        expect(res.body.results[0].ok).toBe(true);
        expect(res.body.results[1].ok).toBe(false);
        expect(res.body.results[1].code).toBe('ALREADY_RESOLVED');
        done();
      });
  });
});
