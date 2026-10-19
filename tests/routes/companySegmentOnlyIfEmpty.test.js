// ============================================================
// AURA. -- PATCH /companies/:id/segment com only_if_empty (tq-35, 18/10/2026)
//
// O check-in do app manda { segment, only_if_empty: true } para quem esta sem
// frente. A garantia vale SO para essa chamada:
//   1. campo + frente vazia (NULL ou '')  -> grava (applied: true)
//   2. campo + frente ja gravada          -> applied:false, segment atual,
//      nenhuma escrita (segment_source, flags, vertical, audit_log)
//   3. sem o campo                        -> sobrescreve como sempre
//   4. only_if_empty diferente de `true`  -> age como ausente
//
// Banco: fakeSegmentDb guarda o ESTADO das empresas em memoria (o pool e
// mockado globalmente em tests/jest.setup.js; o repo nao tem Postgres real
// nos testes de rota). O acesso e carimbado por um middleware de teste.
// ============================================================
const express = require('express');
const request = require('supertest');
const { fakeSegmentDb } = require('../helpers/fakeSegmentDb');

const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';

let pool;
let fake;

function buildApp(role = 'owner') {
  const router = require('../../src/routes/companySegment');
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use((req, res, next) => { req.companyRole = role; req.user = { id: 'u-dono' }; next(); });
  scoped.use('/', router);
  app.use('/api/v1/companies/:id', scoped);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}

function setup(company) {
  fake = fakeSegmentDb({ companies: { [cid]: company } });
  pool.connect.mockResolvedValue(fake.client);
  pool.query.mockResolvedValue({ rows: [] });
}

const patch = (body, role) => request(buildApp(role)).patch(`/api/v1/companies/${cid}/segment`).send(body);
const escritas = () => fake.writesTo(/UPDATE companies|SET vertical_active|studio_enabled/);
const auditorias = () => pool.query.mock.calls.filter(([sql]) => /INSERT INTO audit_log/.test(String(sql)));
const commits = () => fake.client.query.mock.calls.filter(([sql]) => sql === 'COMMIT');

beforeEach(() => {
  jest.resetModules();
  pool = require('../../src/config/database');
  pool.query.mockReset();
  pool.connect.mockReset();
});

describe('PATCH /companies/:id/segment com only_if_empty', () => {
  test.each([[null], ['']])('frente vazia (%p): grava, segment_source = user e applied:true', async (vazio) => {
    setup({ segment: vazio, segment_source: null });
    const r = await patch({ segment: 'otica', only_if_empty: true });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.segment).toBe('otica');
    expect(r.body.segment_source).toBe('user');
    expect(r.body.flags.otica_enabled).toBe(true);
    expect(fake.state.companies[cid].segment).toBe('otica');
    expect(commits()).toHaveLength(1);
    expect(auditorias()).toHaveLength(1);
  });

  test('frente ja gravada: applied:false, devolve a que estava e nao mexe em nada', async () => {
    setup({ segment: 'matcon', segment_source: 'staff', pdv_settings: { matcon_enabled: true }, vertical_active: null });
    const antes = JSON.stringify(fake.state.companies[cid]);
    const r = await patch({ segment: 'otica', only_if_empty: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ applied: false, segment: 'matcon' });
    expect(JSON.stringify(fake.state.companies[cid])).toBe(antes);
    expect(escritas()).toHaveLength(0);       // nem segment, nem segment_source, nem flags, nem vertical
    expect(auditorias()).toHaveLength(0);     // nem audit_log
    expect(commits()).toHaveLength(0);
    expect(fake.client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(fake.client.release).toHaveBeenCalled();
  });

  test('frente ja gravada como Studio nao e derrubada (vertical continua ativa)', async () => {
    setup({ segment: 'studio', segment_source: 'cnae', vertical_active: 'studio', pdv_settings: { studio_enabled: true } });
    const r = await patch({ segment: 'varejo', only_if_empty: true });
    expect(r.body).toEqual({ applied: false, segment: 'studio' });
    expect(fake.state.companies[cid].vertical_active).toBe('studio');
    expect(fake.state.companies[cid].pdv_settings.studio_enabled).toBe(true);
    expect(escritas()).toHaveLength(0);
  });

  test('sem o campo: sobrescreve como sempre, desliga o que era da frente anterior', async () => {
    setup({ segment: 'matcon', segment_source: 'staff', pdv_settings: { matcon_enabled: true } });
    const r = await patch({ segment: 'otica' });
    expect(r.status).toBe(200);
    expect(r.body.segment).toBe('otica');
    expect(r.body.segment_source).toBe('user');
    expect(r.body.flags.otica_enabled).toBe(true);
    expect(r.body.flags.matcon_enabled).toBe(false);
    expect(r.body).not.toHaveProperty('applied');   // caminho antigo: resposta identica a de hoje
    expect(Object.keys(r.body).sort()).toEqual(['flags', 'segment', 'segment_source', 'vertical_active']);
    expect(fake.state.companies[cid].segment).toBe('otica');
    expect(auditorias()).toHaveLength(1);
  });

  test.each([[false], ['true'], [1], [null]])('only_if_empty = %p (nao e true): age como ausente e sobrescreve', async (valor) => {
    setup({ segment: 'matcon', segment_source: 'staff', pdv_settings: { matcon_enabled: true } });
    const r = await patch({ segment: 'otica', only_if_empty: valor });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('applied');
    expect(fake.state.companies[cid].segment).toBe('otica');
  });

  test('com o campo e frente vazia, as regras de sempre valem (Studio sem plano -> 409, nada gravado)', async () => {
    setup({ segment: null, plan: 'essencial' });
    const r = await patch({ segment: 'studio', only_if_empty: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STUDIO_PLAN_REQUIRED');
    expect(fake.state.companies[cid].segment).toBeNull();
  });

  test('membro comum continua 403 e segment invalido continua 400', async () => {
    setup({ segment: null });
    expect((await patch({ segment: 'otica', only_if_empty: true }, 'member')).status).toBe(403);
    const r = await patch({ segment: 'xyz', only_if_empty: true });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SEGMENT_INVALID');
    expect(fake.state.companies[cid].segment).toBeNull();
  });
});
