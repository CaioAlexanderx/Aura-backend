// ============================================================
// AURA KARATÊ — Testes unitários Track A (backend cadastros)
// Cobertura mínima exigida:
//   1. setup → requirements_seeded = 12
//   2. dojo create → FPKT-NNN gerado
//   3. dojo list → paginação OK
//   4. practitioner create → gera FPKT-A-NNNNN
//
// Estratégia: mock do db (jest.setup.js já mocka src/config/database).
// Usamos supertest apenas para os testes de rota HTTP.
// Testes puramente de lógica usam as funções exportadas diretamente.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

// ── Testes de karateService (lógica pura, sem DB) ────────────
describe('karateService — computeDojoStatus', () => {
  const { computeDojoStatus } = require('../src/services/karateService');

  it('retorna suspended quando is_active=false independente das datas', () => {
    expect(computeDojoStatus('annual', '2020-01-01', false)).toBe('suspended');
  });

  it('retorna active quando afiliação recente (< 60 dias até vencimento)', () => {
    // Afiliação de ontem → anual → vence daqui a ~364 dias
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const iso = yesterday.toISOString().split('T')[0];
    expect(computeDojoStatus('annual', iso, true)).toBe('active');
  });

  it('retorna status vencido quando afiliação muito antiga', () => {
    // Afiliado há 3 anos com modelo quarterly (vence a cada 3 meses)
    const old = new Date();
    old.setFullYear(old.getFullYear() - 3);
    const iso = old.toISOString().split('T')[0];
    const status = computeDojoStatus('quarterly', iso, true);
    // Com quarterly e data antiga suficiente, o dojô está vencido
    expect(['overdue', 'defaulting', 'suspended']).toContain(status);
  });

  it('retorna active quando affiliation_since é null', () => {
    expect(computeDojoStatus('annual', null, true)).toBe('active');
  });
});

describe('karateService — parseCSVLine', () => {
  const { parseCSVLine } = require('../src/services/karateService');

  it('parseia linha simples com vírgula', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('parseia campo com aspas contendo vírgula interna', () => {
    expect(parseCSVLine('"João da Silva",SP,email@test.com')).toEqual([
      'João da Silva', 'SP', 'email@test.com',
    ]);
  });

  it('parseia campo vazio', () => {
    expect(parseCSVLine('nome,,email')).toEqual(['nome', '', 'email']);
  });
});

describe('karateService — suggestPractitionerMapping', () => {
  const { suggestPractitionerMapping } = require('../src/services/karateService');

  it('mapeia cabecalho nome para full_name', () => {
    const map = suggestPractitionerMapping(['nome', 'email', 'cpf']);
    expect(map['nome']).toBe('full_name');
  });

  it('mapeia cabecalho faixa para belt_level', () => {
    const map = suggestPractitionerMapping(['faixa', 'nome']);
    expect(map['faixa']).toBe('belt_level');
  });
});

// ── Testes de rota (HTTP via supertest) ──────────────────────
const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

// Token de teste com role admin (plataforma) para bypassar requireCompanyAccess
const makeToken = (overrides) => jwt.sign(
  Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, overrides || {}),
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const adminToken = makeToken();

// ── App mínimo para os testes das rotas ─────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());

  // Setup de federação (sem param :id)
  const fedRouter = require('../src/routes/karateFederation');
  app.use('/karate', fedRouter);
  // Dashboard + belt-distribution precisam de :id
  app.use('/federation/:id', fedRouter);

  // Dojôs
  const dojoRouter = require('../src/routes/karateDojos');
  app.use('/federation/:id/dojos', dojoRouter);

  // Praticantes
  const practRouter = require('../src/routes/karatePractitioners');
  app.use('/federation/:id/practitioners', practRouter);

  return app;
}

// ── Suite: POST /karate/federation/setup ─────────────────────
describe('POST /karate/federation/setup', () => {
  let app;

  beforeAll(function() { app = buildApp(); });

  beforeEach(function() {
    jest.clearAllMocks();
    // Mock client para transação
    const mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(mockClient);

    // Sequência de queries dentro da transação:
    // 1. BEGIN
    // 2. SELECT slug existente → vazio (sem conflito)
    // 3. INSERT INTO companies RETURNING
    // 4. SELECT karate_seed_fpkt_requirements
    // 5. SELECT COUNT(*) → 12 requisitos
    // 6. COMMIT
    mockClient.query
      .mockResolvedValueOnce({})                          // BEGIN
      .mockResolvedValueOnce({ rows: [] })               // check slug
      .mockResolvedValueOnce({                            // INSERT company
        rows: [{ id: 'fed-uuid-001', name: 'FPKT Teste', slug: 'fpkt-teste', vertical: 'karate_federation' }],
      })
      .mockResolvedValueOnce({ rows: [] })               // karate_seed_fpkt_requirements
      .mockResolvedValueOnce({ rows: [{ cnt: '12' }] }) // COUNT requirements
      .mockResolvedValueOnce({});                        // COMMIT
  });

  it('cria federacao e retorna requirements_seeded = 12', function(done) {
    request(app)
      .post('/karate/federation/setup')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'FPKT Teste', slug: 'fpkt-teste' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.requirements_seeded).toBe(12);
        expect(res.body.vertical).toBe('karate_federation');
        expect(res.body.slug).toBe('fpkt-teste');
        done();
      });
  });

  it('retorna 422 sem name', function(done) {
    request(app)
      .post('/karate/federation/setup')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ slug: 'fpkt' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/name/);
        done();
      });
  });

  it('retorna 422 sem slug', function(done) {
    request(app)
      .post('/karate/federation/setup')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Federação Teste' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/slug/);
        done();
      });
  });
});

// ── Suite: POST /federation/:id/dojos ─────────────────────────
describe('POST /federation/:id/dojos (criar dojô)', () => {
  const FED_ID = 'fed-uuid-001';
  let app;

  beforeAll(function() { app = buildApp(); });

  beforeEach(function() {
    jest.clearAllMocks();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                          // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] }) // verifica federação
      .mockResolvedValueOnce({ rows: [] })               // advisory lock
      .mockResolvedValueOnce({ rows: [] })               // MAX fpkt_affiliation_id (nenhum)
      .mockResolvedValueOnce({                            // INSERT company
        rows: [{
          id: 'dojo-uuid-001',
          name: 'Dojô São Paulo',
          cnpj: null,
          region: 'Capital',
          fpkt_affiliation_id: 'FPKT-001',
          affiliation_model: 'annual',
          affiliation_since: '2025-01-01',
          dojo_founded_year: null,
          address: null,
          phone: null,
          email: null,
          is_active: true,
        }],
      })
      .mockResolvedValueOnce({});                    // COMMIT
  });

  it('cria dojo e retorna FPKT-NNN no formato correto', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/dojos')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Dojô São Paulo', affiliation_model: 'annual' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.fpkt_affiliation_id).toMatch(/^FPKT-\d{3}$/);
        expect(res.body.name).toBe('Dojô São Paulo');
        done();
      });
  });

  it('retorna 422 sem name', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/dojos')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ affiliation_model: 'annual' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('retorna 422 com affiliation_model invalido', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/dojos')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Dojô X', affiliation_model: 'mensal' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── Suite: GET /federation/:id/dojos (listagem) ───────────────
describe('GET /federation/:id/dojos (listar)', () => {
  const FED_ID = 'fed-uuid-001';
  let app;

  beforeAll(function() { app = buildApp(); });

  beforeEach(function() {
    jest.clearAllMocks();
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '3' }] })  // COUNT
      .mockResolvedValueOnce({                             // data
        rows: [
          {
            id: 'dojo-1', name: 'Dojô A', cnpj: null, region: 'Capital',
            fpkt_affiliation_id: 'FPKT-001', affiliation_model: 'annual',
            affiliation_since: '2024-01-01', dojo_founded_year: null,
            address: null, phone: null, email: null, is_active: true,
            karate_logo_url: null, practitioner_count: '5',
          },
          {
            id: 'dojo-2', name: 'Dojô B', cnpj: null, region: 'Interior',
            fpkt_affiliation_id: 'FPKT-002', affiliation_model: 'biannual',
            affiliation_since: '2023-06-01', dojo_founded_year: 2010,
            address: null, phone: null, email: null, is_active: true,
            karate_logo_url: null, practitioner_count: '12',
          },
        ],
      });
  });

  it('retorna lista paginada de dojos', function(done) {
    request(app)
      .get('/federation/' + FED_ID + '/dojos')
      .set('Authorization', 'Bearer ' + adminToken)
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('data');
        expect(res.body).toHaveProperty('total');
        expect(res.body).toHaveProperty('page');
        expect(res.body).toHaveProperty('page_size');
        expect(Array.isArray(res.body.data)).toBe(true);
        done();
      });
  });

  it('cada dojo tem campo status computado', function(done) {
    request(app)
      .get('/federation/' + FED_ID + '/dojos')
      .set('Authorization', 'Bearer ' + adminToken)
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(200);
        res.body.data.forEach(function(d) {
          expect(['active', 'expiring', 'overdue', 'defaulting', 'suspended']).toContain(d.status);
        });
        done();
      });
  });
});

// ── Suite: POST /federation/:id/practitioners ─────────────────
describe('POST /federation/:id/practitioners (criar praticante)', () => {
  const FED_ID = 'fed-uuid-001';
  const DOJO_ID = 'dojo-uuid-001';
  let app;

  beforeAll(function() { app = buildApp(); });

  beforeEach(function() {
    jest.clearAllMocks();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] })   // verifica federação
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID }] })  // verifica dojô
      .mockResolvedValueOnce({ rows: [] })                  // advisory lock pract
      .mockResolvedValueOnce({ rows: [] })                  // MAX registration_number
      .mockResolvedValueOnce({                              // INSERT customer
        rows: [{
          id: 'prac-uuid-001',
          name: 'João Silva',
          cpf_cnpj: '123.456.789-00',
          rg: null,
          birth_date: '1990-05-15',
          email: 'joao@test.com',
          phone: null,
          is_student: true,
          parent_guardian_id: null,
          federation_id: FED_ID,
          dojo_id: DOJO_ID,
          is_arbiter: false,
          is_instructor: false,
          is_examiner: false,
          karate_photo_url: null,
          karate_registration_number: 'FPKT-A-00001',
          is_active: true,
        }],
      })
      .mockResolvedValueOnce({});                           // COMMIT
  });

  it('cria praticante e retorna FPKT-A-NNNNN', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        full_name: 'João Silva',
        cpf: '123.456.789-00',
        birth_date: '1990-05-15',
        email: 'joao@test.com',
        dojo_id: DOJO_ID,
      })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.karate_registration_number).toMatch(/^FPKT-A-\d{5}$/);
        expect(res.body.full_name).toBe('João Silva');
        done();
      });
  });

  it('retorna 422 sem full_name', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ dojo_id: DOJO_ID })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/full_name/);
        done();
      });
  });

  it('retorna 422 sem dojo_id', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ full_name: 'Teste Silva' })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/dojo_id/);
        done();
      });
  });
});
