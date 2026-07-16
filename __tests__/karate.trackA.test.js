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
// (Decisão 02/07/2026): computeDojoStatus passou a derivar SÓ de is_active.
// Valores possíveis agora são apenas 'active' | 'inactive' — a escala de
// inadimplência (overdue/defaulting/suspended) saiu desta função e vive só
// em karateFinanceService.computeAnnuityStatus.
describe('karateService — computeDojoStatus', () => {
  const { computeDojoStatus } = require('../src/services/karateService');

  it('retorna inactive quando is_active=false independente das datas', () => {
    expect(computeDojoStatus('annual', '2020-01-01', false)).toBe('inactive');
  });

  it('retorna active quando is_active=true independente das datas', () => {
    // Afiliação de ontem → anual → vence daqui a ~364 dias
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const iso = yesterday.toISOString().split('T')[0];
    expect(computeDojoStatus('annual', iso, true)).toBe('active');
  });

  it('retorna active mesmo com afiliação muito antiga, desde que is_active=true', () => {
    // Afiliado há 3 anos com modelo quarterly (vence a cada 3 meses) — datas
    // vencidas não afetam mais o status do dojô, só is_active importa.
    const old = new Date();
    old.setFullYear(old.getFullYear() - 3);
    const iso = old.toISOString().split('T')[0];
    const status = computeDojoStatus('quarterly', iso, true);
    expect(status).toBe('active');
  });

  it('retorna active quando affiliation_since é null', () => {
    expect(computeDojoStatus('annual', null, true)).toBe('active');
  });

  it('retorna inactive quando is_active=undefined não se aplica (só false desliga)', () => {
    expect(computeDojoStatus('annual', null, undefined)).toBe('active');
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
      .mockResolvedValueOnce({ rows: [{ owner_id: 'sys-owner-uuid' }] }) // resolve owner de sistema (reusa dono de dojô existente)
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
          // (Decisão 02/07/2026) status do dojô agora é só active/inactive.
          expect(['active', 'inactive']).toContain(d.status);
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
      .mockResolvedValueOnce({ rows: [] })                  // dup check karate_registration_number (H1: número agora é sempre informado, nunca gerado)
      .mockResolvedValueOnce({})                            // SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({                              // INSERT customer (com sex/affiliation_since)
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
          sex: null,
          affiliation_since: null,
        }],
      })
      .mockResolvedValueOnce({})                            // RELEASE SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({});                           // COMMIT
  });

  // H1 (14/07/2026): o número FPKT é emitido pela federação FORA do sistema
  // — o backend NUNCA mais gera/inventa número (removido nextPractitionerRegistrationNumber
  // do POST direto). Este teste passou a enviar karate_registration_number
  // explicitamente, como qualquer chamador precisa fazer agora.
  it('cria praticante com karate_registration_number informado (número nunca é gerado pelo backend)', function(done) {
    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        full_name: 'João Silva',
        cpf: '123.456.789-00',
        birth_date: '1990-05-15',
        email: 'joao@test.com',
        dojo_id: DOJO_ID,
        karate_registration_number: 'FPKT-A-00001',
      })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.karate_registration_number).toBe('FPKT-A-00001');
        expect(res.body.full_name).toBe('João Silva');
        done();
      });
  });

  // 16/07/2026: decisão Caio reverte a obrigatoriedade do FPKT (H1,
  // 14/07/2026) — sem número o cadastro segue normal e grava NULL. Mock
  // dedicado (sobrescreve o db.connect do beforeEach) porque o caminho sem
  // número PULA a query de dup check — a fila de mocks é mais curta.
  it('cria praticante SEM karate_registration_number (FPKT é opcional — grava NULL, nunca gera)', function(done) {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] })   // verifica federação
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID }] })  // verifica dojô
      // (sem dup check — regNumber é null, a query é pulada)
      .mockResolvedValueOnce({})                            // SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({                              // INSERT customer
        rows: [{
          id: 'prac-uuid-003',
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
          karate_registration_number: null,
          is_active: true,
          sex: null,
          affiliation_since: null,
        }],
      })
      .mockResolvedValueOnce({})                            // RELEASE SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({});                           // COMMIT

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
        expect(res.body.karate_registration_number).toBeNull();
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

// ── Suite: matrícula manual (opcional) na criação de praticante ─────────
// Contrato: karate_registration_number opcional no payload.
//   - preenchido (trim não-vazio) → usa o valor, valida unicidade antes do
//     INSERT; se já existir, 409 { error: "Número de matrícula já em uso." }
//   - ausente/vazio → mantém geração sequencial automática (NNNNN-D)
describe('POST /federation/:id/practitioners — matrícula manual', () => {
  const FED_ID = 'fed-uuid-001';
  const DOJO_ID = 'dojo-uuid-001';
  let app;

  beforeAll(function() { app = buildApp(); });

  beforeEach(function() {
    jest.clearAllMocks();
  });

  it('aceita karate_registration_number manual quando não há duplicidade', function(done) {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] })   // verifica federação
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID }] })  // verifica dojô
      .mockResolvedValueOnce({ rows: [] })                  // SELECT checagem duplicidade (manual)
      .mockResolvedValueOnce({})                            // SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({                              // INSERT customer
        rows: [{
          id: 'prac-uuid-002',
          name: 'Maria Souza',
          cpf_cnpj: null,
          rg: null,
          birth_date: null,
          email: null,
          phone: null,
          is_student: true,
          parent_guardian_id: null,
          federation_id: FED_ID,
          dojo_id: DOJO_ID,
          is_arbiter: false,
          is_instructor: false,
          is_examiner: false,
          karate_photo_url: null,
          karate_registration_number: '99999-D',
          is_active: true,
          sex: null,
          affiliation_since: null,
        }],
      })
      .mockResolvedValueOnce({})                            // RELEASE SAVEPOINT
      .mockResolvedValueOnce({});                           // COMMIT

    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        full_name: 'Maria Souza',
        dojo_id: DOJO_ID,
        karate_registration_number: '99999-D',
      })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.karate_registration_number).toBe('99999-D');
        done();
      });
  });

  it('retorna 409 quando karate_registration_number manual já está em uso', function(done) {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] })   // verifica federação
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID }] })  // verifica dojô
      .mockResolvedValueOnce({ rows: [{ id: 'outro-prac-id' }] }) // SELECT checagem — já existe
      .mockResolvedValueOnce({});                           // ROLLBACK

    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        full_name: 'Duplicado Silva',
        dojo_id: DOJO_ID,
        karate_registration_number: '12345-D',
      })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('Número de matrícula já em uso.');
        done();
      });
  });
});

// ── Regressão P0 — alinhamento coluna x valor no INSERT com
// sex/affiliation_since/is_assistant (bug: is_assistant boolean caindo na
// coluna affiliation_since DATE, gerando "invalid input syntax for type
// date: false"). Ver src/routes/karatePractitioners.js — bloco
// HAS_SEX_AFFILIATION_COLS + HAS_IS_ASSISTANT_COL. ──────────────
describe('POST /federation/:id/practitioners — alinhamento sex/affiliation_since/is_assistant', () => {
  const FED_ID = 'fed-uuid-001';
  const DOJO_ID = 'dojo-uuid-001';
  let app;

  beforeAll(function() { app = buildApp(); });

  it('não envia o boolean is_assistant na posição da coluna DATE affiliation_since', function(done) {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                            // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: FED_ID }] })    // verifica federação
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID }] })   // verifica dojô
      .mockResolvedValueOnce({ rows: [] })                   // dup check karate_registration_number (H1: número agora é sempre informado, nunca gerado)
      .mockResolvedValueOnce({})                             // SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({                               // INSERT customer
        rows: [{
          id: 'prac-uuid-002',
          name: 'Maria Auxiliar',
          karate_registration_number: 'FPKT-A-00002',
          is_active: true,
          sex: 'feminino',
          affiliation_since: '2024-01-10',
          is_assistant: true,
        }],
      })
      .mockResolvedValueOnce({})                             // RELEASE SAVEPOINT sex_affiliation_insert
      .mockResolvedValueOnce({});                            // COMMIT

    request(app)
      .post('/federation/' + FED_ID + '/practitioners')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        full_name: 'Maria Auxiliar',
        dojo_id: DOJO_ID,
        sex: 'feminino',
        affiliation_since: '2024-01-10',
        is_assistant: true,
        karate_registration_number: 'FPKT-A-00002',
      })
      .end(function(err, res) {
        if (err) return done(err);
        expect(res.status).toBe(201);

        // Localiza a chamada de query que faz o INSERT INTO customers com
        // sex/affiliation_since (a 7a chamada no mock, índice 6).
        const insertCall = mockClient.query.mock.calls.find(function(call) {
          return typeof call[0] === 'string' && call[0].indexOf('INSERT INTO customers') !== -1
            && call[0].indexOf('affiliation_since') !== -1;
        });
        expect(insertCall).toBeDefined();

        const sqlText = insertCall[0];
        const params = insertCall[1];

        // Extrai a lista de colunas entre o primeiro par de parênteses após "customers".
        const colMatch = sqlText.match(/INSERT INTO customers\s*\(([\s\S]*?)\)\s*VALUES/);
        expect(colMatch).toBeTruthy();
        const columns = colMatch[1].split(',').map(function(s) { return s.trim(); });

        const idxAffiliation = columns.indexOf('affiliation_since');
        const idxSex = columns.indexOf('sex');
        const idxIsAssistant = columns.indexOf('is_assistant');

        expect(idxAffiliation).toBeGreaterThanOrEqual(0);
        expect(idxSex).toBeGreaterThanOrEqual(0);
        expect(idxIsAssistant).toBeGreaterThanOrEqual(0);

        // Invariante central da regressão: o valor posicionalmente alinhado
        // com a coluna affiliation_since (DATE) não pode ser um boolean —
        // isso é exatamente o que causava "invalid input syntax for type
        // date: false" no Postgres.
        expect(typeof params[idxAffiliation]).not.toBe('boolean');

        // E o valor alinhado com is_assistant deve ser, de fato, o boolean.
        expect(params[idxIsAssistant]).toBe(true);

        // sex deve ser a string enviada, não o boolean nem a data.
        expect(params[idxSex]).toBe('feminino');
        expect(params[idxAffiliation]).toBe('2024-01-10');

        // Contagem de colunas parametrizadas == contagem de params. A lista
        // "columns" inclui is_active/created_at/updated_at, que na query são
        // literais (true, NOW(), NOW()) e não recebem placeholder — por isso
        // comparamos apenas as colunas que de fato são parametrizadas.
        const literalTrailingCols = ['is_active', 'created_at', 'updated_at'];
        const parameterizedColumns = columns.filter(function(c) {
          return literalTrailingCols.indexOf(c) === -1;
        });
        expect(params.length).toBe(parameterizedColumns.length);

        done();
      });
  });
});
