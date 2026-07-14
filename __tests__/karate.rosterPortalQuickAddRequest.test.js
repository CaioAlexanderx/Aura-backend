// ============================================================
// AURA KARATÊ — H2: quick-add do portal do sensei vira SOLICITAÇÃO
//
// Regra fechada com o Caio: o número de matrícula FPKT é emitido SOMENTE
// pela federação, fora do sistema (H1, migration 231). O quick-add do
// portal do sensei (POST /public/roster-update/:token/practitioner) era
// o único caminho que ainda inventava um número via
// nextPractitionerRegistrationNumber (removida de karateService.js).
//
// Esta cobertura prova que:
//   (a) o quick-add NUNCA mais insere direto em `customers` — cria uma
//       linha em karate_practitioner_requests (status pendente, sem
//       número), a MESMA tabela do fluxo novo do sensei (H1)
//   (b) é idempotente (mesma dedup_key = dojô + nome) — reenvio não
//       duplica solicitação pendente
//   (c) token expirado continua bloqueando (410), sem tocar em nenhuma
//       tabela de praticante
//
// Estilo: supertest + mock sequencial de db.connect (mesmo padrão de
// __tests__/karate.rosterPortalScale.test.js).
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

const TOKEN = 'sensei-token-abc123';
const DOJO_ID = 'dojo-uuid-001';
const FED_ID = 'fed-uuid-001';
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/roster-update', require('../src/routes/karateRosterPortalPublic'));
  return app;
}

describe('POST /public/roster-update/:token/practitioner — H2: vira solicitação, não inventa número', () => {
  it('(a) 201 cria solicitação pendente em karate_practitioner_requests — NUNCA insere em customers/belt_history', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // tokRes FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', status: 'pendente', created_at: '2026-07-14T12:00:00Z' }] }) // INSERT karate_practitioner_requests
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT karate_dojo_roster_events
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ name: 'Novo Aluno', phone: '11999998888', belt_level: '5', belt_name: 'Faixa Amarela' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe('req-001');
        expect(res.body.status).toBe('pendente');
        expect(res.body.already_pending).toBe(false);

        const allSql = mockClient.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('\n');
        expect(allSql).toMatch(/INSERT INTO karate_practitioner_requests/);
        expect(allSql).not.toMatch(/INSERT INTO customers/i);
        expect(allSql).not.toMatch(/INSERT INTO karate_belt_history/i);

        // dojo_id/federation_id do INSERT vieram do TOKEN (tokRes), nunca do body
        const insertCall = mockClient.query.mock.calls.find(
          (c) => typeof c[0] === 'string' && /INSERT INTO karate_practitioner_requests/.test(c[0])
        );
        expect(insertCall[1][0]).toBe(FED_ID);
        expect(insertCall[1][1]).toBe(DOJO_ID);
        done();
      });
  });

  it('(b) idempotente: solicitação pendente igual já existe → 200 already_pending, não duplica', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // tokRes
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING → colidiu
      .mockResolvedValueOnce({ rows: [{ id: 'req-existing-1', status: 'pendente', created_at: '2026-07-10T00:00:00Z' }] }) // SELECT existente
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ name: 'Aluno Repetido', email: 'x@x.com', belt_level: '3' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.already_pending).toBe(true);
        expect(res.body.id).toBe('req-existing-1');
        done();
      });
  });

  it('(c) token expirado → 410, nenhuma tabela de praticante é tocada', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: PAST }] }) // tokRes expirado
      .mockResolvedValueOnce({}); // ROLLBACK

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ name: 'Aluno Tarde', phone: '11988887777', belt_level: '1' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(410);
        expect(mockClient.query).toHaveBeenCalledTimes(3); // BEGIN, tokRes, ROLLBACK
        done();
      });
  });
});


// ════════════════════════════════════════════════════════════
// H2b — ficha completa: POST aceita e persiste cpf/rg/sexo/endereço/
// responsável/fpkt_number_claimed (não só nome+telefone+faixa)
// ════════════════════════════════════════════════════════════
describe('POST /public/roster-update/:token/practitioner — H2b: ficha completa', () => {
  it('persiste cpf/rg/sexo/endereço/responsável/fpkt_number_claimed no payload da solicitação', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // tokRes
      .mockResolvedValueOnce({ rows: [{ id: 'req-002', status: 'pendente', created_at: '2026-07-14T12:00:00Z' }] }) // INSERT
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({
        full_name: 'Praticante Ficha Completa',
        birth_date: '2015-04-20',
        sex: 'F',
        cpf: '123.456.789-00',
        rg: 'MG-12.345.678',
        phone: '31999998888',
        email: 'resp@example.com',
        claimed_belt: 'Faixa Amarela',
        street: 'Rua das Flores', number: '100', complement: 'Apto 2',
        neighborhood: 'Centro', city: 'Belo Horizonte', state: 'MG', zip_code: '30000-000',
        guardian_name: 'Responsável Teste', guardian_cpf: '111.222.333-44',
        guardian_phone: '31988887777', guardian_relationship: 'mãe',
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.claimed_belt).toBe('Faixa Amarela');

        const insertCall = mockClient.query.mock.calls.find(
          (c) => typeof c[0] === 'string' && /INSERT INTO karate_practitioner_requests/.test(c[0])
        );
        // ordem: federation_id, dojo_id, full_name, birth_date, cpf, rg, phone, email, claimed_belt, payload, fpkt_number_claimed, dedup_key
        const params = insertCall[1];
        expect(params[0]).toBe(FED_ID);
        expect(params[1]).toBe(DOJO_ID);
        expect(params[2]).toBe('Praticante Ficha Completa');
        expect(params[4]).toBe('123.456.789-00'); // cpf
        expect(params[5]).toBe('MG-12.345.678'); // rg
        expect(params[8]).toBe('Faixa Amarela'); // claimed_belt

        const payload = JSON.parse(params[9]);
        expect(payload.sex).toBe('F');
        expect(payload.street).toBe('Rua das Flores');
        expect(payload.city).toBe('Belo Horizonte');
        expect(payload.guardian_name).toBe('Responsável Teste');
        expect(payload.guardian_relationship).toBe('mãe');
        done();
      });
  });

  it('422 quando full_name está ausente (name/full_name ambos vazios)', (done) => {
    const app = buildApp();
    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ phone: '11999998888' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.connect).not.toHaveBeenCalled();
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// H2b — GET /public/roster-update/:token/fpkt-lookup — token-gated,
// equivalente do lookup-fpkt autenticado (H1), escopado à federação
// ════════════════════════════════════════════════════════════
describe('GET /public/roster-update/:token/fpkt-lookup', () => {
  it('found:true e is_transfer:true quando o número já pertence a alguém NA FEDERAÇÃO — devolve só nome+dojô', (done) => {
    const app = buildApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pendente', token_expires_at: FUTURE, dojo_nome: 'Dojô A' }] }) // resolveToken
      .mockResolvedValueOnce({ rows: [{ id: 'pract-999', name: 'Outro Praticante', dojo_id: 'dojo-uuid-002', dojo_name: 'Dojô B', is_active: true }] }); // lookupByFpktNumber

    request(app)
      .get(`/public/roster-update/${TOKEN}/fpkt-lookup`)
      .query({ number: '12345' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.found).toBe(true);
        expect(res.body.is_transfer).toBe(true);
        expect(res.body.practitioner.name).toBe('Outro Praticante');
        expect(res.body.practitioner.current_dojo_name).toBe('Dojô B');
        // nunca vaza contato/CPF/endereço do terceiro
        expect(res.body.practitioner.phone).toBeUndefined();
        expect(res.body.practitioner.cpf).toBeUndefined();
        done();
      });
  });

  it('found:false quando o número não existe na federação', (done) => {
    const app = buildApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pendente', token_expires_at: FUTURE, dojo_nome: 'Dojô A' }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/public/roster-update/${TOKEN}/fpkt-lookup`)
      .query({ number: '99999' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.found).toBe(false);
        done();
      });
  });

  it('404 quando o token é inválido — nunca vaza se existe ou não', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [] }); // resolveToken não encontra

    request(app)
      .get(`/public/roster-update/token-invalido/fpkt-lookup`)
      .query({ number: '12345' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
        done();
      });
  });

  it('410 quando o token expirou', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pendente', token_expires_at: PAST, dojo_nome: 'Dojô A' }] });

    request(app)
      .get(`/public/roster-update/${TOKEN}/fpkt-lookup`)
      .query({ number: '12345' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(410);
        done();
      });
  });

  it('422 quando number não é enviado', (done) => {
    const app = buildApp();
    request(app)
      .get(`/public/roster-update/${TOKEN}/fpkt-lookup`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });
});

// ════════════════════════════════════════════════════════════
// H2b — GET /public/roster-update/:token/practitioner-requests — status
// das solicitações do dojô, visível no link público sem login
// ════════════════════════════════════════════════════════════
describe('GET /public/roster-update/:token/practitioner-requests', () => {
  it('200 lista as solicitações do dojô do TOKEN (pendente/aprovada/rejeitada + motivo)', (done) => {
    const app = buildApp();
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pendente', token_expires_at: FUTURE, dojo_nome: 'Dojô A' }] }) // resolveToken
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'req-001', status: 'aprovada', resolution: 'criacao', reject_reason: null,
            full_name: 'Aluno Aprovado', birth_date: '2015-01-01', claimed_belt: 'Faixa Amarela',
            fpkt_number_claimed: null, resolved_practitioner_id: 'pract-1',
            created_at: '2026-07-01T00:00:00Z', resolved_at: '2026-07-05T00:00:00Z',
            resolved_fpkt_number: '55555', resolved_practitioner_name: 'Aluno Aprovado',
          },
          {
            id: 'req-002', status: 'rejeitada', resolution: null, reject_reason: 'Documentação incompleta',
            full_name: 'Aluno Rejeitado', birth_date: null, claimed_belt: null,
            fpkt_number_claimed: null, resolved_practitioner_id: null,
            created_at: '2026-07-02T00:00:00Z', resolved_at: '2026-07-06T00:00:00Z',
            resolved_fpkt_number: null, resolved_practitioner_name: null,
          },
        ],
      });

    request(app)
      .get(`/public/roster-update/${TOKEN}/practitioner-requests`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].status).toBe('aprovada');
        expect(res.body.data[0].resolved_fpkt_number).toBe('55555');
        expect(res.body.data[1].status).toBe('rejeitada');
        expect(res.body.data[1].reject_reason).toBe('Documentação incompleta');

        // dojo_id usado no WHERE veio do TOKEN, nunca de query/body
        const listCall = db.query.mock.calls[1];
        expect(listCall[1][0]).toBe(DOJO_ID);
        done();
      });
  });

  it('410 quando o token expirou', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, status: 'pendente', token_expires_at: PAST, dojo_nome: 'Dojô A' }] });

    request(app)
      .get(`/public/roster-update/${TOKEN}/practitioner-requests`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(410);
        done();
      });
  });

  it('404 quando o token é inválido', (done) => {
    const app = buildApp();
    db.query.mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/public/roster-update/token-invalido/practitioner-requests`)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
        done();
      });
  });
});
