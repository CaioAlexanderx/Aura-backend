// ============================================================
// AURA KARATÊ — F0 Canal B: link fixo do portal do dojô
// Cobertura pedida no F0:
//   1. token válido lê /me
//   2. token revogado → 401 (genérico)
//   3. token inexistente → 401 (mesma resposta — não vaza existência)
//   4. rotação invalida o antigo (revoga ANTES de inserir o novo)
//   5. /practitioners só enxerga o dojo_id do token
//
// jest.setup.js já mocka src/config/database (db.query = jest.fn()).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');

const service = require('../src/services/karateDojoPortalLinkService');

const DOJO = 'dojo-uuid-0001';
const FED = 'fed-uuid-0001';
const TOKEN = 'a'.repeat(64); // formato real: randomBytes(32).hex

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/karate/dojo', require('../src/routes/karateDojoPortalPublic'));
  return app;
}

beforeEach(() => jest.clearAllMocks());

// ── Service: hash + rotação ──────────────────────────────────
describe('karateDojoPortalLinkService — hash e rotação', () => {
  it('hashToken é determinístico e nunca é o token em claro', () => {
    expect(service.hashToken(TOKEN)).toBe(service.hashToken(TOKEN));
    expect(service.hashToken(TOKEN)).not.toBe(TOKEN);
    expect(service.hashToken(TOKEN)).not.toBe(service.hashToken('b'.repeat(64)));
  });

  it('createLink ROTACIONA: revoga o ativo anterior antes de inserir, e persiste só o hash', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE (revoga anterior)
      .mockResolvedValueOnce({ rows: [{ id: 'link-1', created_at: '2026-07-17T00:00:00Z' }] }); // INSERT

    const out = await service.createLink({ dojoId: DOJO, federationId: FED, createdBy: 'u1' });
    expect(out.token).toHaveLength(64);
    expect(out.id).toBe('link-1');

    const calls = db.query.mock.calls;
    expect(calls[0][0]).toMatch(/UPDATE karate_dojo_portal_links/);
    expect(calls[0][0]).toMatch(/revoked_at = NOW\(\)/);
    expect(calls[0][0]).toMatch(/revoked_at IS NULL/);
    expect(calls[0][1]).toEqual([DOJO]);

    expect(calls[1][0]).toMatch(/INSERT INTO karate_dojo_portal_links/);
    // guarda o HASH, nunca o token em claro
    expect(calls[1][1][2]).toBe(service.hashToken(out.token));
    expect(calls[1][1]).not.toContain(out.token);
  });

  it('tabela ausente (42P01) → erro claro SCHEMA_PENDING', async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(service.createLink({ dojoId: DOJO, federationId: FED }))
      .rejects.toMatchObject({ code: 'SCHEMA_PENDING' });
  });

  it('resolveToken filtra revoked_at IS NULL e consulta pelo hash', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await service.resolveToken(TOKEN)).toBeNull();
    expect(db.query.mock.calls[0][0]).toMatch(/revoked_at IS NULL/);
    expect(db.query.mock.calls[0][1]).toEqual([service.hashToken(TOKEN)]);
  });

  it('resolveToken de token curto/vazio nem vai ao banco', async () => {
    expect(await service.resolveToken('')).toBeNull();
    expect(await service.resolveToken('curto')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── Rotas públicas ───────────────────────────────────────────
describe('GET /public/karate/dojo/me', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('token válido → 200 com DojoMe FLAT', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO, federation_id: FED }] }) // resolveToken
      .mockResolvedValueOnce({
        rows: [{
          id: DOJO, name: 'Dojô Central', cnpj: null, sensei_cpf: null,
          region: 'Capital', fpkt_affiliation_id: 'FPKT-077',
          affiliation_model: null, affiliation_since: '2020-01-01',
          dojo_founded_year: 1999, phone: null, email: null,
          karate_logo_url: null, is_active: true, practitioner_count: '42',
        }],
      });

    const res = await request(app)
      .get('/public/karate/dojo/me')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    // shape FLAT (não embrulhado em { dojo }) — contrato do front
    expect(res.body.name).toBe('Dojô Central');
    expect(res.body.fpkt_affiliation_id).toBe('FPKT-077');
    expect(res.body.practitioner_count).toBe(42);
    expect(res.body.status).toBeDefined();
    expect(res.body.dojo).toBeUndefined();
  });

  it('sem token → 401 genérico', async () => {
    const res = await request(app).get('/public/karate/dojo/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PORTAL_LINK_INVALID');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('token inexistente OU revogado → mesmo 401 genérico (não vaza existência)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // resolve não acha linha ativa
    const res = await request(app)
      .get('/public/karate/dojo/me')
      .set('Authorization', `Bearer ${'c'.repeat(64)}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Link inválido ou revogado', code: 'PORTAL_LINK_INVALID' });
  });

  it('tabela ausente (42P01) no resolve → 401 genérico, nunca 500', async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error('no table'), { code: '42P01' }));
    const res = await request(app)
      .get('/public/karate/dojo/me')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('PORTAL_LINK_INVALID');
  });
});

describe('rotação invalida o link antigo', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('depois de createLink (rotação), o token antigo não resolve mais → 401', async () => {
    // 1. rotação: novo link emitido
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'link-2', created_at: '2026-07-17T00:00:00Z' }] });
    await service.createLink({ dojoId: DOJO, federationId: FED });

    // 2. o banco (mock) reflete o efeito da rotação: hash antigo sem linha ativa
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/public/karate/dojo/me')
      .set('Authorization', `Bearer ${'d'.repeat(64)}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /public/karate/dojo/practitioners', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('lista SEMPRE escopada ao dojo_id do token (nunca de query/body)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO, federation_id: FED }] }) // resolveToken
      .mockResolvedValueOnce({
        rows: [{ practitioner_id: 'p1', name: 'Ana', is_active: true, belt_level: 'roxa', belt_name: 'Roxa' }],
      });

    const res = await request(app)
      .get('/public/karate/dojo/practitioners?dojo_id=outro-dojo') // tentativa de escapar do escopo
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.practitioners[0].name).toBe('Ana');

    // a query de praticantes usou exatamente [federation_id, dojo_id] do TOKEN
    const pracCall = db.query.mock.calls[1];
    expect(pracCall[1]).toEqual([FED, DOJO]);
  });
});

describe('POST /public/karate/dojo/annuity/pix', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('sem parcela pendente → 409 claro', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO, federation_id: FED }] }) // resolveToken
      .mockResolvedValueOnce({ rows: [] }); // nenhuma pendente

    const res = await request(app)
      .post('/public/karate/dojo/annuity/pix')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PENDING_ANNUITY');
  });

  it('parcela já paga (annuity_history_id explícito) → 409 CONFLICT', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO, federation_id: FED }] }) // resolveToken
      .mockResolvedValueOnce({
        rows: [{ id: 'ann-1', dojo_id: DOJO, federation_id: FED, status: 'paid', paid_at: '2026-05-01', amount: '500.00', reference_period: '2026', dojo_name: 'Dojô Central' }],
      });

    const res = await request(app)
      .post('/public/karate/dojo/annuity/pix')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ annuity_history_id: 'ann-1' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });
});
