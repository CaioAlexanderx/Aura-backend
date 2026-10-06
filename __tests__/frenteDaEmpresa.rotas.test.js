// ============================================================
// Frente da empresa — rotas (05/10/2026)
//   POST  /auth/register com segment/extras
//   PATCH /admin/clients/:cid/segment  e  /vertical (checagem de plano)
//   GET   /companies/:id/onboarding/first-steps (+ dismiss)
//   POST  /onboarding/cnpj-lookup devolvendo suggested_segment
// Mock por SQL (tests/helpers/fakeSegmentDb.js), nunca fila posicional.
// ============================================================
jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

let app, db, cnpjService;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
  cnpjService = require('../src/services/cnpj');
});
beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

const SECRET = 'aura-test-secret-2026';
const tok = (payload) => 'Bearer ' + jwt.sign(payload, SECRET, { expiresIn: '1h' });
const ADMIN = tok({ id: 'staff-1', role: 'admin', is_staff: true });
const CLIENT = tok({ id: 'u-1', role: 'client', plan: 'negocio', company: 'c1' });

function body(extra) {
  return {
    name: 'Ana', email: 'ana@loja.com', password: 'senha1234',
    company_name: 'Loja da Ana', cnpj: '11222333000181', phone: '11999990000',
    terms_accepted: true, self_serve: true,
    ...(extra || {}),
  };
}
const newCompany = (fake) => Object.values(fake.state.companies).find((c) => c.id.startsWith('c-novo'));

// ── Cadastro ───────────────────────────────────────────────
describe('POST /auth/register — frente no cadastro', () => {
  test.each([
    ['otica', 'otica_enabled'],
    ['matcon', 'matcon_enabled'],
    ['assistencia', 'os_enabled'],
  ])('segment=%s nasce ligado (%s) e grava segment', async (segment, flag) => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ segment, segment_source: 'cnae' }));
    expect(res.status).toBe(201);
    const c = newCompany(fake);
    expect(c.segment).toBe(segment);
    expect(c.segment_source).toBe('cnae');
    expect(c.pdv_settings[flag]).toBe(true);
    expect(res.body.company.segment).toBe(segment);
    expect(res.body.company.segment_flags[flag]).toBe(true);
    // Tudo na MESMA transacao: COMMIT depois do UPDATE da frente.
    const idxSeg = fake.calls.findIndex((x) => /SET segment = \$2/.test(x.text));
    const idxCommit = fake.calls.findIndex((x) => /COMMIT/.test(x.text));
    expect(idxSeg).toBeGreaterThan(-1);
    expect(idxSeg).toBeLessThan(idxCommit);
  });

  test('segment=studio no self-service (negocio) ativa a vertical Studio', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ segment: 'studio' }));
    expect(res.status).toBe(201);
    const c = newCompany(fake);
    expect(c.plan).toBe('negocio');
    expect(c.vertical_active).toBe('studio');
    expect(c.pdv_settings.studio_enabled).toBe(true);
    expect(res.body.company.vertical_active).toBe('studio');
    expect(res.body.company.segment).toBe('studio');
  });

  test('segment=varejo + extras=[os] grava varejo e liga so a OS', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({
      segment: 'varejo', extras: ['os'], cnae_principal: '4781-4/00',
      cnae_descricao: 'Comércio varejista de artigos do vestuário e acessórios', segment_suggested: 'varejo',
    }));
    expect(res.status).toBe(201);
    const c = newCompany(fake);
    expect(c.segment).toBe('varejo');
    expect(c.segment_source).toBe('user');
    expect(c.pdv_settings).toEqual({ os_enabled: true });
    expect(c.cnae_principal).toBe('4781400');
    expect(c.segment_suggested).toBe('varejo');
  });

  test('access_code COMECAR tambem aplica a frente', async () => {
    const fake = fakeSegmentDb({
      accessCode: { id: 'ac1', type: 'trial', plan: 'negocio', discount_pct: 0, trial_days: 7, max_uses: 999, uses: 1, expires_at: null, is_active: true, referrer_id: null },
    });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ self_serve: undefined, access_code: 'comecar', segment: 'matcon' }));
    expect(res.status).toBe(201);
    expect(newCompany(fake).pdv_settings.matcon_enabled).toBe(true);
  });

  test('studio com codigo de plano Essencial -> 409 e ROLLBACK (nada criado)', async () => {
    const fake = fakeSegmentDb({
      accessCode: { id: 'ac2', type: 'trial', plan: 'essencial', discount_pct: 0, trial_days: 7, max_uses: 999, uses: 1, expires_at: null, is_active: true, referrer_id: null },
    });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ self_serve: undefined, access_code: 'COMECAR', segment: 'studio' }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDIO_PLAN_REQUIRED');
    expect(fake.calls.some((x) => /ROLLBACK/.test(x.text))).toBe(true);
    expect(fake.calls.some((x) => /COMMIT/.test(x.text))).toBe(false);
  });

  test('sem segment: nenhuma query nova roda (fluxo de hoje)', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body());
    expect(res.status).toBe(201);
    expect(fake.writesTo(/FOR UPDATE|SET segment|SET vertical_active/)).toHaveLength(0);
    expect(res.body.company.segment).toBeNull();
    expect(res.body.company.segment_flags).toBeNull();
  });

  test('segment invalido -> 400 SEGMENT_INVALID sem abrir transacao', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(body({ segment: 'odonto' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SEGMENT_INVALID');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('extras fora da whitelist -> 400 EXTRAS_INVALID', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(body({ segment: 'varejo', extras: ['studio'] }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXTRAS_INVALID');
  });

  test("segment_source 'staff' vindo do cliente e ignorado (vira 'user')", async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ segment: 'otica', segment_source: 'staff' }));
    expect(res.status).toBe(201);
    expect(newCompany(fake).segment_source).toBe('user');
  });

  test('cadastro que entra em CNPJ existente nao altera a empresa', async () => {
    const fake = fakeSegmentDb({
      existingCnpj: { id: 'c-existente', legal_name: 'Loja', plan: 'negocio', segment: null, vertical_active: null },
    });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ segment: 'matcon', extras: ['os'] }));
    expect(res.status).toBe(201);
    expect(res.body.joined_existing).toBe(true);
    expect(fake.writesTo(/FOR UPDATE|SET segment|pdv_settings|SET vertical_active/)).toHaveLength(0);
  });

  test('cadastro interno (sem self_serve nem COMECAR) ignora a frente', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(body({ self_serve: undefined, segment: 'otica' }));
    expect(res.status).toBe(201);
    expect(fake.writesTo(/SET segment/)).toHaveLength(0);
  });

  test('nenhum campo do corpo escolhe plano', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    await request(app).post('/api/v1/auth/register').send(body({ segment: 'studio', plan: 'expansao' }));
    expect(newCompany(fake).plan).toBe('negocio');
  });
});

// ── Staff ──────────────────────────────────────────────────
describe('PATCH /admin/clients/:cid/segment', () => {
  test('troca a frente, liga extras e grava source staff', async () => {
    const fake = fakeSegmentDb({ companies: { c1: { plan: 'essencial' } } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).patch('/api/v1/admin/clients/c1/segment')
      .set('Authorization', ADMIN).send({ segment: 'otica', extras: ['os'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ segment: 'otica', segment_source: 'staff', flags: { otica_enabled: true, os_enabled: true } });
    expect(fake.state.companies.c1.segment_source).toBe('staff');
  });

  test('disable desliga o que a equipe pediu', async () => {
    const fake = fakeSegmentDb({ companies: { c1: { segment: 'matcon', pdv_settings: { matcon_enabled: true, os_enabled: true } } } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).patch('/api/v1/admin/clients/c1/segment')
      .set('Authorization', ADMIN).send({ segment: 'varejo', disable: ['matcon'] });
    expect(res.status).toBe(200);
    expect(res.body.flags).toMatchObject({ matcon_enabled: false, os_enabled: true });
  });

  test('sair do studio desativa a vertical', async () => {
    const fake = fakeSegmentDb({ companies: { c1: { segment: 'studio', vertical_active: 'studio', pdv_settings: { studio_enabled: true } } } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).patch('/api/v1/admin/clients/c1/segment')
      .set('Authorization', ADMIN).send({ segment: 'varejo' });
    expect(res.status).toBe(200);
    expect(res.body.vertical_active).toBeNull();
    expect(res.body.flags.studio_enabled).toBe(false);
  });

  test('studio em empresa do Essencial -> 409', async () => {
    const fake = fakeSegmentDb({ companies: { c1: { plan: 'essencial' } } });
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).patch('/api/v1/admin/clients/c1/segment')
      .set('Authorization', ADMIN).send({ segment: 'studio' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDIO_PLAN_REQUIRED');
    expect(fake.state.companies.c1.vertical_active).toBeNull();
    expect(fake.calls.some((x) => /ROLLBACK/.test(x.text))).toBe(true);
  });

  test('segment invalido -> 400', async () => {
    const res = await request(app).patch('/api/v1/admin/clients/c1/segment')
      .set('Authorization', ADMIN).send({ segment: 'food' });
    expect(res.status).toBe(400);
  });

  test('empresa inexistente -> 404', async () => {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).patch('/api/v1/admin/clients/nada/segment')
      .set('Authorization', ADMIN).send({ segment: 'varejo' });
    expect(res.status).toBe(404);
  });

  test('nao-admin -> 403', async () => {
    const res = await request(app).patch('/api/v1/admin/clients/c1/segment')
      .set('Authorization', CLIENT).send({ segment: 'varejo' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /admin/clients/:cid/vertical — Studio exige plano', () => {
  test('studio no Essencial -> 409 e nada muda', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c1', plan: 'essencial', trade_name: 'X', vertical_active: null, pdv_settings: {} }] });
    const res = await request(app).patch('/api/v1/admin/clients/c1/vertical')
      .set('Authorization', ADMIN).send({ vertical: 'studio' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDIO_PLAN_REQUIRED');
    expect(db.query.mock.calls.some(([sql]) => /UPDATE companies/.test(sql))).toBe(false);
  });

  test('studio no Negocio segue como antes (vertical + studio_enabled)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1', plan: 'negocio', trade_name: 'X', vertical_active: null, pdv_settings: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', plan: 'negocio', vertical_active: 'studio' }] });
    const res = await request(app).patch('/api/v1/admin/clients/c1/vertical')
      .set('Authorization', ADMIN).send({ vertical: 'studio' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    const sqls = db.query.mock.calls.map(([sql]) => sql);
    expect(sqls.some((s) => /SET vertical_active = \$1/.test(s))).toBe(true);
    expect(sqls.some((s) => /'studio_enabled', true/.test(s))).toBe(true);
  });

  test('outras verticais nao checam plano (odonto no Essencial passa)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1', plan: 'essencial', trade_name: 'X', vertical_active: null, pdv_settings: {} }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', plan: 'essencial', vertical_active: 'odonto' }] });
    const res = await request(app).patch('/api/v1/admin/clients/c1/vertical')
      .set('Authorization', ADMIN).send({ vertical: 'odonto' });
    expect(res.status).toBe(200);
  });
});

// ── Primeiros passos ───────────────────────────────────────
describe('GET /companies/:id/onboarding/first-steps', () => {
  // Acesso (requireCompanyAccess) -> empresa -> EXISTS
  function mockFirstSteps(company, existsRow) {
    db.query.mockImplementation(async (sql) => {
      if (/AS role FROM companies/.test(sql)) return { rows: [{ role: 'owner' }] };
      if (/SELECT segment, onboarding_dismissed_at/.test(sql)) return { rows: company ? [company] : [] };
      if (/^SELECT EXISTS|^SELECT \(/.test(sql.trim())) return { rows: [existsRow] };
      return { rows: [] };
    });
  }

  const KEYS = {
    otica: ['laboratorio_cadastrado', 'primeira_receita', 'primeiro_pedido_de_lente'],
    matcon: ['produtos_cadastrados', 'primeiro_orcamento', 'entrega_configurada'],
    assistencia: ['primeira_os', 'termo_de_garantia_preenchido', 'pecas_ou_servicos_cadastrados'],
    studio: ['catalogo_montado', 'primeiro_orcamento', 'primeiro_item_em_producao'],
    varejo: ['produtos_cadastrados', 'primeira_venda', 'cliente_cadastrado'],
  };

  test.each(Object.keys(KEYS))('%s: tres passos com as chaves estaveis, done do EXISTS', async (segment) => {
    mockFirstSteps({ segment, onboarding_dismissed_at: null }, { s0: true, s1: false, s2: false });
    const res = await request(app).get('/api/v1/companies/c1/onboarding/first-steps').set('Authorization', CLIENT);
    expect(res.status).toBe(200);
    expect(res.body.segment).toBe(segment);
    expect(res.body.dismissed).toBe(false);
    expect(res.body.steps).toEqual([
      { key: KEYS[segment][0], done: true },
      { key: KEYS[segment][1], done: false },
      { key: KEYS[segment][2], done: false },
    ]);
  });

  test('segment NULL e outro caem nos passos de varejo', async () => {
    for (const segment of [null, 'outro']) {
      mockFirstSteps({ segment, onboarding_dismissed_at: null }, { s0: false, s1: false, s2: true });
      const res = await request(app).get('/api/v1/companies/c1/onboarding/first-steps').set('Authorization', CLIENT);
      expect(res.body.segment).toBe(segment);
      expect(res.body.steps.map((s) => s.key)).toEqual(KEYS.varejo);
      expect(res.body.steps[2].done).toBe(true);
    }
  });

  test('o SQL dos passos so recebe o id da empresa e consulta as tabelas reais', async () => {
    mockFirstSteps({ segment: 'otica', onboarding_dismissed_at: '2026-10-05T12:00:00Z' }, { s0: true, s1: true, s2: true });
    const res = await request(app).get('/api/v1/companies/c1/onboarding/first-steps').set('Authorization', CLIENT);
    expect(res.body.dismissed).toBe(true);
    const call = db.query.mock.calls.find(([sql]) => /optical_labs/.test(sql));
    expect(call[1]).toEqual(['c1']);
    expect(call[0]).toMatch(/optical_prescriptions/);
    expect(call[0]).toMatch(/kind = 'otica'/);
  });

  test('sem acesso a empresa -> 403', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/v1/companies/c9/onboarding/first-steps').set('Authorization', CLIENT);
    expect(res.status).toBe(403);
  });

  test('POST dismiss grava onboarding_dismissed_at', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/AS role FROM companies/.test(sql)) return { rows: [{ role: 'owner' }] };
      if (/onboarding_dismissed_at = COALESCE/.test(sql)) return { rows: [{ onboarding_dismissed_at: '2026-10-05T12:00:00Z' }] };
      return { rows: [] };
    });
    const res = await request(app).post('/api/v1/companies/c1/onboarding/first-steps/dismiss').set('Authorization', CLIENT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dismissed: true, dismissed_at: '2026-10-05T12:00:00Z' });
  });
});

// ── Consulta de CNPJ ───────────────────────────────────────
describe('POST /onboarding/cnpj-lookup — suggested_segment', () => {
  test('devolve suggested_segment, cnae_codigo e cnae_descricao mantendo os campos de antes', async () => {
    cnpjService.lookupCNPJ.mockResolvedValueOnce({
      cnpj: '11.222.333/0001-81', legal_name: 'OTICA X LTDA', is_active: true,
      cnae_principal: { code: '4774100', description: 'Comércio varejista de artigos de óptica' },
      cnaes_secundarios: [], suggested_vertical: null, suggested_regime: 'simples_nacional',
    });
    const res = await request(app).post('/api/v1/onboarding/cnpj-lookup').send({ cnpj: '11.222.333/0001-81' });
    expect(res.status).toBe(200);
    expect(res.body.suggested_segment).toBe('otica');
    expect(res.body.cnae_codigo).toBe('4774100');
    expect(res.body.cnae_descricao).toBe('Comércio varejista de artigos de óptica');
    expect(res.body.cnae_principal).toEqual({ code: '4774100', description: 'Comércio varejista de artigos de óptica' });
    expect(res.body).toHaveProperty('suggested_vertical', null);
    expect(res.body.legal_name).toBe('OTICA X LTDA');
  });

  test('CNAE desconhecido -> suggested_segment null', async () => {
    cnpjService.lookupCNPJ.mockResolvedValueOnce({
      is_active: true, cnae_principal: { code: '6201501', description: 'Software' }, cnaes_secundarios: [],
    });
    const res = await request(app).post('/api/v1/onboarding/cnpj-lookup').send({ cnpj: '11222333000181' });
    expect(res.body.suggested_segment).toBeNull();
  });
});
