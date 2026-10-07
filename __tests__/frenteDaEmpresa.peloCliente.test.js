// ============================================================
// Frente da empresa — troca pelo proprio cliente (07/10/2026)
//   PATCH /companies/:id/segment  (routes/companySegment.js)
// Mock por SQL (tests/helpers/fakeSegmentDb.js): os testes conferem o
// ESTADO final da empresa, nao a ordem das chamadas.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

let app, db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

const SECRET = 'aura-test-secret-2026';
const tok = (payload) => 'Bearer ' + jwt.sign(payload, SECRET, { expiresIn: '1h' });
const CLIENT = tok({ id: 'u-1', role: 'client', plan: 'negocio', company: 'c1' });

// Varios cenarios param antes de abrir a transacao (403, 400): um
// mockResolvedValueOnce nao consumido vazaria o client para o teste seguinte.
function useClient(fake) {
  db.connect.mockReset();
  db.connect.mockResolvedValue(fake.client);
}

// requireCompanyAccess le o papel pelo pool; a troca roda no client da transacao.
function setup(company, role = 'owner') {
  const fake = fakeSegmentDb({ companies: { c1: company } });
  useClient(fake);
  db.query.mockImplementation(async (sql) => {
    if (/AS role FROM companies/.test(sql)) return { rows: role ? [{ role }] : [] };
    return { rows: [] };
  });
  return fake;
}
const patch = (payload, cid = 'c1') => request(app)
  .patch('/api/v1/companies/' + cid + '/segment').set('Authorization', CLIENT).send(payload);
const auditCalls = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO audit_log/.test(sql));

describe('PATCH /companies/:id/segment — o cliente troca a propria frente', () => {
  test('dono troca otica -> matcon: desliga a flag da frente anterior e grava source user', async () => {
    const fake = setup({ segment: 'otica', segment_source: 'cnae', pdv_settings: { otica_enabled: true, os_enabled: true, caixa_enabled: true } });
    const res = await patch({ segment: 'matcon' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      segment: 'matcon',
      segment_source: 'user',
      vertical_active: null,
      flags: { matcon_enabled: true, otica_enabled: false, os_enabled: true, studio_enabled: false },
    });
    const c = fake.state.companies.c1;
    expect(c.segment).toBe('matcon');
    expect(c.segment_source).toBe('user');
    expect(c.pdv_settings.otica_enabled).toBe(false);
    expect(c.pdv_settings.matcon_enabled).toBe(true);
    // o resto de pdv_settings fica intocado (merge, nunca replace)
    expect(c.pdv_settings.caixa_enabled).toBe(true);
    // tudo dentro da transacao
    const idxSeg = fake.calls.findIndex((x) => /SET segment = \$2/.test(x.text));
    const idxCommit = fake.calls.findIndex((x) => /COMMIT/.test(x.text));
    expect(idxSeg).toBeGreaterThan(-1);
    expect(idxSeg).toBeLessThan(idxCommit);
  });

  test('admin da empresa tambem troca (matcon -> otica desliga matcon_enabled)', async () => {
    const fake = setup({ segment: 'matcon', pdv_settings: { matcon_enabled: true } }, 'admin');
    const res = await patch({ segment: 'otica' });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.pdv_settings).toMatchObject({ matcon_enabled: false, otica_enabled: true });
  });

  test('extras [os] liga a Ordem de Servico', async () => {
    const fake = setup({ segment: 'varejo', pdv_settings: {} });
    const res = await patch({ segment: 'otica', extras: ['os'] });
    expect(res.status).toBe(200);
    expect(res.body.flags).toMatchObject({ otica_enabled: true, os_enabled: true });
    expect(fake.state.companies.c1.pdv_settings.os_enabled).toBe(true);
  });

  test('extras [] explicito desliga a Ordem de Servico', async () => {
    const fake = setup({ segment: 'otica', pdv_settings: { otica_enabled: true, os_enabled: true } });
    const res = await patch({ segment: 'matcon', extras: [] });
    expect(res.status).toBe(200);
    expect(res.body.flags).toMatchObject({ matcon_enabled: true, otica_enabled: false, os_enabled: false });
    expect(fake.state.companies.c1.pdv_settings.os_enabled).toBe(false);
  });

  test('sem extras nao mexe em os_enabled (ligado continua ligado, ausente continua ausente)', async () => {
    let fake = setup({ segment: 'otica', pdv_settings: { otica_enabled: true, os_enabled: true } });
    let res = await patch({ segment: 'varejo' });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.pdv_settings.os_enabled).toBe(true);
    expect(fake.state.companies.c1.pdv_settings.otica_enabled).toBe(false);

    fake = setup({ segment: 'otica', pdv_settings: { otica_enabled: true } });
    res = await patch({ segment: 'varejo' });
    expect(res.status).toBe(200);
    expect('os_enabled' in fake.state.companies.c1.pdv_settings).toBe(false);
  });

  test('assistencia liga os_enabled mesmo com extras [] (a frente manda)', async () => {
    const fake = setup({ segment: 'varejo', pdv_settings: {} });
    const res = await patch({ segment: 'assistencia', extras: [] });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.pdv_settings.os_enabled).toBe(true);
  });

  test('sair de assistencia sem extras nao desliga os_enabled (e o extra, nao flag propria)', async () => {
    const fake = setup({ segment: 'assistencia', pdv_settings: { os_enabled: true } });
    const res = await patch({ segment: 'varejo' });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.pdv_settings.os_enabled).toBe(true);
  });

  test('mesma frente de novo nao desliga a propria flag', async () => {
    const fake = setup({ segment: 'otica', pdv_settings: { otica_enabled: true } });
    const res = await patch({ segment: 'otica' });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.pdv_settings.otica_enabled).toBe(true);
  });

  test('membro comum -> 403 e nada e gravado', async () => {
    const fake = setup({ segment: 'otica', pdv_settings: { otica_enabled: true } }, 'Vendedor');
    const res = await patch({ segment: 'matcon' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEGMENT_FORBIDDEN');
    expect(fake.calls).toHaveLength(0);
    expect(fake.state.companies.c1.segment).toBe('otica');
    expect(auditCalls()).toHaveLength(0);
  });

  test('usuario sem vinculo com a empresa -> 403 (requireCompanyAccess)', async () => {
    const fake = setup({ segment: 'otica' }, null);
    const res = await patch({ segment: 'matcon' });
    expect(res.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  test('sem token -> 401', async () => {
    const res = await request(app).patch('/api/v1/companies/c1/segment').send({ segment: 'matcon' });
    expect(res.status).toBe(401);
  });

  test.each([['food'], [''], [null], [42], [undefined]])('segment invalido (%p) -> 400 SEGMENT_INVALID', async (segment) => {
    const fake = setup({ segment: 'otica' });
    const res = await patch({ segment });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SEGMENT_INVALID');
    expect(fake.calls).toHaveLength(0);
  });

  test.each([[['food']], ['os'], [{ os: true }]])('extras invalido (%p) -> 400', async (extras) => {
    const fake = setup({ segment: 'otica' });
    const res = await patch({ segment: 'matcon', extras });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXTRAS_INVALID');
    expect(fake.calls).toHaveLength(0);
  });

  test('disable no body e ignorado: cliente nao desliga recurso por fora da regra', async () => {
    const fake = setup({ segment: 'varejo', pdv_settings: { os_enabled: true, matcon_enabled: true } });
    const res = await patch({ segment: 'outro', disable: ['os', 'matcon'] });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.pdv_settings).toMatchObject({ os_enabled: true, matcon_enabled: true });
  });

  test('studio no Essencial -> 409 STUDIO_PLAN_REQUIRED, com rollback', async () => {
    const fake = setup({ plan: 'essencial', segment: 'varejo' });
    const res = await patch({ segment: 'studio' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDIO_PLAN_REQUIRED');
    expect(fake.state.companies.c1.segment).toBe('varejo');
    expect(fake.state.companies.c1.vertical_active).toBeNull();
    expect(fake.calls.some((x) => /ROLLBACK/.test(x.text))).toBe(true);
    expect(auditCalls()).toHaveLength(0);
  });

  test('varejo -> studio no Negocio ativa a vertical', async () => {
    const fake = setup({ plan: 'negocio', segment: 'varejo' });
    const res = await patch({ segment: 'studio' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ segment: 'studio', segment_source: 'user', vertical_active: 'studio', flags: { studio_enabled: true } });
    expect(fake.state.companies.c1.vertical_active).toBe('studio');
  });

  test('studio -> varejo desativa a vertical', async () => {
    const fake = setup({ plan: 'negocio', segment: 'studio', vertical_active: 'studio', pdv_settings: { studio_enabled: true } });
    const res = await patch({ segment: 'varejo' });
    expect(res.status).toBe(200);
    expect(res.body.vertical_active).toBeNull();
    expect(res.body.flags.studio_enabled).toBe(false);
    expect(fake.state.companies.c1.vertical_active).toBeNull();
    expect(fake.state.companies.c1.segment).toBe('varejo');
  });

  test('empresa com outra vertical ativa nao entra no Studio por aqui -> 409 VERTICAL_ACTIVE', async () => {
    const fake = setup({ plan: 'negocio', segment: null, vertical_active: 'odonto' });
    const res = await patch({ segment: 'studio' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERTICAL_ACTIVE');
    expect(fake.state.companies.c1.vertical_active).toBe('odonto');
    expect(fake.state.companies.c1.segment).toBeNull();
  });

  test('outra vertical ativa trocando para frente comum: a vertical fica como esta', async () => {
    const fake = setup({ plan: 'negocio', segment: null, vertical_active: 'odonto' });
    const res = await patch({ segment: 'otica' });
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.vertical_active).toBe('odonto');
  });

  test('empresa inexistente -> 404', async () => {
    const fake = fakeSegmentDb();
    useClient(fake);
    db.query.mockImplementation(async (sql) => (/AS role FROM companies/.test(sql) ? { rows: [{ role: 'owner' }] } : { rows: [] }));
    const res = await patch({ segment: 'varejo' }, 'nada');
    expect(res.status).toBe(404);
  });

  test('auditoria: segment_change_by_user em audit_log, so ids e a troca', async () => {
    setup({ segment: 'otica', pdv_settings: { otica_enabled: true } });
    const res = await patch({ segment: 'matcon', extras: ['os'] });
    expect(res.status).toBe(200);
    const calls = auditCalls();
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0];
    expect(sql).not.toMatch(/ip_address|user_agent/);
    expect(params.slice(0, 3)).toEqual(['u-1', 'c1', 'segment_change_by_user']);
    expect(JSON.parse(params[4])).toEqual({ from: 'otica', to: 'matcon', extras: ['os'] });
  });

  test('falha na auditoria nao derruba a troca', async () => {
    const fake = fakeSegmentDb({ companies: { c1: { segment: 'otica' } } });
    useClient(fake);
    db.query.mockImplementation(async (sql) => {
      if (/AS role FROM companies/.test(sql)) return { rows: [{ role: 'owner' }] };
      if (/INSERT INTO audit_log/.test(sql)) throw new Error('boom');
      return { rows: [] };
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await patch({ segment: 'matcon' });
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(fake.state.companies.c1.segment).toBe('matcon');
  });
});
