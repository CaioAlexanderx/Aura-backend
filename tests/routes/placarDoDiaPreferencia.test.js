// ============================================================
// AURA. -- PUT/GET /companies/:id/placar-do-dia (13/10/2026)
//
// Preferencia do placar do dia no WhatsApp do dono.
//   1. GET: default desligado, janela da temporada e o que falta para chegar
//      (WhatsApp, telefone do dono, template)
//   2. PUT { enabled }: dono liga/desliga; nao-boolean => 400; membro => 403
//   3. PUT { enabled, always }: o segundo campo (ano todo) so muda quando vem
//   4. migration 377 pendente (42703) => 503 MIGRATION_PENDING
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let db;
let router;
let requireAuth;
let requireCompanyAccess;

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const donoAuth = { Authorization: `Bearer ${jwt.sign({ id: 'u-dono', role: 'user' }, SECRET, { expiresIn: '1h' })}` };

beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  router = require('../../src/routes/placarDoDia');
  // Depois do resetModules: o middleware tem que enxergar o MESMO mock de db.
  ({ requireAuth, requireCompanyAccess } = require('../../src/middleware/auth'));
});

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/placar-do-dia', router);
  app.use('/api/v1/companies/:id', scoped);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}

// papel: 'owner' | 'vendedor'. loja: linha de placar:loja. updates: UPDATEs vistos.
function mockBanco({ papel = 'owner', loja = {}, rowCount = 1, updateErro = null, wa = {}, template = 'APPROVED' } = {}) {
  const visto = { updates: [], audit: [] };
  const lojaRow = {
    id: cid, loja: 'Loja Exemplo',
    placar_do_dia_enabled: false, placar_do_dia_sempre: false, owner_phone: '11988887777',
    ...loja,
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT 'owner' AS role/i.test(s)) return Promise.resolve({ rows: [{ role: papel }] });
    if (/-- placar:loja/.test(s)) return Promise.resolve({ rows: [lojaRow] });
    if (/UPDATE companies\s+SET placar_do_dia_enabled/i.test(s)) {
      if (updateErro) return Promise.reject(updateErro);
      visto.updates.push(params);
      return Promise.resolve({ rowCount, rows: [] });
    }
    if (/INSERT INTO audit_log/i.test(s)) { visto.audit.push(params); return Promise.resolve({ rows: [] }); }
    if (/-- wa:conn-state-flag/.test(s)) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (/-- wa:conn-state/.test(s)) {
      return Promise.resolve({ rows: [{ wa_phone_number_id: wa.phone ?? '1234', has_token: wa.token ?? true }] });
    }
    if (/-- wa:guard-template/.test(s)) return Promise.resolve({ rows: template ? [{ status: template }] : [] });
    return Promise.resolve({ rows: [] });
  });
  return visto;
}

const url = `/api/v1/companies/${cid}/placar-do-dia`;

describe('GET /placar-do-dia', () => {
  test('default: desligado, janela da temporada e o estado do canal', async () => {
    mockBanco();
    const res = await request(buildApp()).get(url).set(donoAuth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      always: false,
      season: { starts_at: '2026-11-01', ends_at: '2027-01-31' },
      whatsapp_connected: true,
      owner_phone_present: true,
      template_name: 'placar_dia',
      template_approved: true,
    });
    expect(typeof res.body.in_season_today).toBe('boolean');
  });

  test('mostra o que falta: sem WhatsApp, sem telefone, sem template', async () => {
    mockBanco({ loja: { owner_phone: null }, wa: { phone: null, token: false }, template: null });
    const res = await request(buildApp()).get(url).set(donoAuth);
    expect(res.body).toMatchObject({ whatsapp_connected: false, owner_phone_present: false, template_approved: false });
  });

  test('migration 377 pendente: 503 MIGRATION_PENDING', async () => {
    mockBanco();
    const impl = db.query.getMockImplementation();
    db.query.mockImplementation((sql, p) => {
      if (/-- placar:loja/.test(String(sql))) { const e = new Error('x'); e.code = '42703'; return Promise.reject(e); }
      return impl(sql, p);
    });
    const res = await request(buildApp()).get(url).set(donoAuth);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
  });
});

describe('PUT /placar-do-dia', () => {
  test('dono liga: grava enabled e deixa o "sempre" como esta', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(visto.updates).toEqual([[cid, true, null]]); // $3 null => COALESCE mantem o campo
    expect(visto.audit).toHaveLength(1);
    expect(visto.audit[0][2]).toBe('ligado');
  });

  test('dono desliga', async () => {
    const visto = mockBanco({ loja: { placar_do_dia_enabled: true } });
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(visto.updates).toEqual([[cid, false, null]]);
  });

  test('segundo campo: always liga o placar o ano todo', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: true, always: true });
    expect(res.status).toBe(200);
    expect(visto.updates).toEqual([[cid, true, true]]);
  });

  test.each([
    ['sem enabled', {}],
    ['enabled em texto', { enabled: 'true' }],
    ['enabled numerico', { enabled: 1 }],
  ])('%s => 400 PLACAR_ENABLED_INVALID e nada e gravado', async (_n, body) => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(donoAuth).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLACAR_ENABLED_INVALID');
    expect(visto.updates).toHaveLength(0);
  });

  test('always que nao e boolean => 400', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: true, always: 'sim' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLACAR_ALWAYS_INVALID');
    expect(visto.updates).toHaveLength(0);
  });

  test('membro que nao e dono/admin => 403', async () => {
    const visto = mockBanco({ papel: 'vendedor' });
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLACAR_FORBIDDEN');
    expect(visto.updates).toHaveLength(0);
  });

  test('migration 377 pendente: 503 MIGRATION_PENDING', async () => {
    const e = new Error('column "placar_do_dia_enabled" does not exist');
    e.code = '42703';
    mockBanco({ updateErro: e });
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: true });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
  });

  test('falha na trilha de auditoria nao derruba a gravacao', async () => {
    mockBanco();
    const impl = db.query.getMockImplementation();
    db.query.mockImplementation((sql, p) => (/INSERT INTO audit_log/i.test(String(sql))
      ? Promise.reject(new Error('audit fora'))
      : impl(sql, p)));
    const res = await request(buildApp()).put(url).set(donoAuth).send({ enabled: true });
    expect(res.status).toBe(200);
  });
});
