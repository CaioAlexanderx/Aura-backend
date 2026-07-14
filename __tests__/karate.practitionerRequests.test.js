// ============================================================
// AURA KARATÊ — H1: solicitação de criação/transferência de praticante
//
// Cobertura pedida na entrega:
//   (a) criar praticante SEM número FPKT falha (422, ficha direta)
//   (b) número duplicado falha (409, ficha direta + aprovação de solicitação)
//   (c) solicitação duplicada é idempotente (mesmo dojô+nome+nascimento)
//   (d) o dojô vem do TOKEN, nunca do body
//   (e) aprovar (criação ou transferência) NÃO gera cobrança
//
// Estilo: supertest + mock sequencial de db.query/db.connect (mesmo padrão
// de __tests__/karate.trackM.routes.test.js / karate.rosterPortalScale.test.js).
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
// (c) + (d) — POST /federation/:id/dojo/practitioner-requests
// ════════════════════════════════════════════════════════════
describe('POST /federation/:id/dojo/practitioner-requests', () => {
  it('201 cria solicitação — dojo_id vem do TOKEN, nunca do body (d)', (done) => {
    const app = buildDojoApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', status: 'pendente', created_at: '2026-07-14T00:00:00Z' }] }) // INSERT ... RETURNING
      .mockResolvedValueOnce({ rows: [] }); // logRosterEventBestEffort INSERT

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send({ full_name: 'Novo Aluno', birth_date: '2012-03-01', dojo_id: OTHER_DOJO_ID, federation_id: 'fed-outra' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.already_pending).toBe(false);

        // O INSERT real precisa ter usado DOJO_ID (do token) — nunca OTHER_DOJO_ID (do body).
        const insertCall = db.query.mock.calls[0];
        expect(insertCall[0]).toMatch(/INSERT INTO karate_practitioner_requests/);
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
    db.query
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING -> 0 rows (colidiu)
      .mockResolvedValueOnce({ rows: [{ id: 'req-existing-001', status: 'pendente', created_at: '2026-07-10T00:00:00Z' }] }); // SELECT existing

    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send({ full_name: 'Aluno Repetido', birth_date: '2011-05-05' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.already_pending).toBe(true);
        expect(res.body.id).toBe('req-existing-001');
        // Não deve haver uma terceira chamada de INSERT — só o conflito + a busca da existente.
        expect(db.query).toHaveBeenCalledTimes(2);
        done();
      });
  });

  it('422 quando full_name está ausente', (done) => {
    const app = buildDojoApp();
    request(app)
      .post(`/federation/${FED_ID}/dojo/practitioner-requests`)
      .set('Authorization', 'Bearer ' + dojoToken)
      .send({ birth_date: '2012-01-01' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce({ rows: [] }); // INSERT roster event (standalone)

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
});

// ════════════════════════════════════════════════════════════
// GET auto-localizar por número FPKT (portal do sensei)
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
