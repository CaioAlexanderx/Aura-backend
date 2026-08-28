// ============================================================
// AURA DOJÔ — Testes Integração: logo do PRÓPRIO dojô
//
// QA 27/08/2026: a sidebar do dojô mostrava a logo da FPKT acima do nome do
// dojô. A coluna companies.karate_logo_url já existia desde a migration 147
// (a federação escreve nela por karateDojos.js, o portal Canal B já a lê) —
// o que faltava era o /dojo/me DEVOLVER e o dojô poder ESCREVER.
//
// Sob teste:
//   GET    /dojo/me       → logo_url no shape (karate_logo_url na coluna)
//   POST   /dojo/me/logo  → base64 → R2, chave determinística, cache-buster
//   DELETE /dojo/me/logo  → limpa a coluna
//
// ⚠️ MOCK POR SQL (mockImplementation), NUNCA fila posicional de
// mockResolvedValueOnce — mesma disciplina de karateDojoFederativo.test.js:
// o helper getDojoLinkStatus emite uma query própria e uma fila posicional
// desalinha inteira quando qualquer query nova entra na frente.
//
// uploadToR2 é o ÚNICO ponto de saída para o R2 e é mock de módulo: o SDK do
// R2 é responsabilidade de src/utils/r2Storage.js, aqui se testa a ROTA.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(),
}));
const { uploadToR2 } = require('../../src/utils/r2Storage');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const base = `/api/v1/federation/${fedId}/dojo`;
const LINKED_AT = new Date('2026-07-01T12:00:00Z');

// base64 de 1 byte — o conteúdo não importa, uploadToR2 está mockado.
const B64 = 'AA==';

const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const canalB = () => ({
  Authorization: `Bearer ${jwt.sign(
    { type: 'portal', scope: 'dojo_portal', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const matches = (m, s) => (typeof m === 'function' ? Boolean(m(s)) : m.test(s));
const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (m) => sqls().some((s) => matches(m, s));
const findCall = (m) => db.query.mock.calls.find((c) => matches(m, String(c[0])));

// ── matchers ────────────────────────────────────────
const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);
// loadDojo — a âncora `SELECT c.id, c.legal_name` é a mesma de dojoSelectSql.
const isLoadDojo = (s) => /SELECT c\.id, c\.legal_name/.test(s) && /FROM companies c/.test(s);
const isLogoUpdate = (s) => /UPDATE companies SET karate_logo_url/.test(s);

const dojoRow = (over = {}) => ({
  id: dojoId,
  legal_name: 'Dojô Shotokan Belém LTDA',
  trade_name: 'Dojô Shotokan Belém',
  slug: 'shotokan-belem',
  cnpj: '12345678000199',
  email: 'contato@shotokanbelem.com.br',
  phone: '91988887777',
  federation_id: fedId,
  vertical: 'karate_dojo',
  karate_logo_url: null,
  fpkt_affiliation_id: 'FPKT-0042',
  affiliation_model: 'anuidade',
  region: 'Norte',
  affiliated_since: '2024-03-01',
  founded_at: '2010-05-20',
  owner_email: 'sensei@dojo.com.br',
  federation_name: 'FPKT',
  federation_slug: 'fpkt',
  practitioners_count: 37,
  ...over,
});

// `extra(sql)` pode devolver {rows}, um Error (vira rejeição) ou null.
function mockDojo({ linkedAt = LINKED_AT, row = dojoRow(), extra } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    if (extra) {
      const r = extra(s);
      if (r instanceof Error) return Promise.reject(r);
      if (r) return Promise.resolve(r);
    }
    if (isLoadDojo(s)) return Promise.resolve({ rows: row ? [row] : [] });
    if (isLogoUpdate(s)) return Promise.resolve({ rows: [{ id: dojoId }] });
    return Promise.resolve({ rows: [] });
  });
}

afterEach(() => {
  db.query.mockReset();
  if (db.connect && db.connect.mockReset) db.connect.mockReset();
  uploadToR2.mockReset();
});

// ============================================================
// GET /dojo/me — a logo passa a existir no contrato
// ============================================================
describe('GET /dojo/me — logo_url', () => {
  it('devolve logo_url a partir de companies.karate_logo_url', async () => {
    mockDojo({ row: dojoRow({ karate_logo_url: 'https://r2.getaura.com.br/karate/dojos/x/logo.png?v=1' }) });

    const res = await request(app).get(`${base}/me`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.dojo.logo_url).toBe('https://r2.getaura.com.br/karate/dojos/x/logo.png?v=1');
    // A SELEÇÃO precisa pedir a coluna — sem isto o shape devolveria null
    // eternamente e a sidebar continuaria na logo da federação.
    expect(String(findCall(isLoadDojo)[0])).toMatch(/c\.karate_logo_url/);
  });

  it('dojô sem logo devolve logo_url null (nunca undefined — o front testa === null)', async () => {
    mockDojo();
    const res = await request(app).get(`${base}/me`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.dojo.logo_url).toBeNull();
  });

  it('Canal B (portal) também enxerga a logo — é leitura', async () => {
    mockDojo({ row: dojoRow({ karate_logo_url: 'https://r2/x.png' }) });
    const res = await request(app).get(`${base}/me`).set(canalB());
    expect(res.status).toBe(200);
    expect(res.body.dojo.logo_url).toBe('https://r2/x.png');
  });
});

// ============================================================
// POST /dojo/me/logo
// ============================================================
describe('POST /dojo/me/logo', () => {
  it('sobe para o R2 em chave determinística do dojô e grava a URL', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://r2.getaura.com.br/karate/dojos/d/logo.png' });
    mockDojo({ row: dojoRow({ karate_logo_url: 'https://r2.getaura.com.br/karate/dojos/d/logo.png?v=123' }) });

    const res = await request(app)
      .post(`${base}/me/logo`)
      .set(canalA())
      .send({ content: B64, content_type: 'image/png' });

    expect(res.status).toBe(200);

    expect(uploadToR2).toHaveBeenCalledTimes(1);
    const [key, content, mime] = uploadToR2.mock.calls[0];
    // Namespace PRÓPRIO do dojô — nunca o 'karate/practitioners/...' da
    // federação nem o 'karate/dojo-students/...' dos alunos.
    expect(key).toBe(`karate/dojos/${dojoId}/logo.png`);
    expect(content).toBe(B64);
    expect(mime).toBe('image/png');

    // A gravação é escopada pelo TOKEN (dojô + federação), nunca pelo corpo.
    const upd = findCall(isLogoUpdate);
    expect(upd[1][1]).toBe(dojoId);
    expect(upd[1][2]).toBe(fedId);
    expect(String(upd[0])).toMatch(/vertical = 'karate_dojo'/);
  });

  it('a URL gravada leva cache-buster — chave fixa serviria a logo ANTIGA', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://r2/karate/dojos/d/logo.jpg' });
    mockDojo();

    await request(app).post(`${base}/me/logo`).set(canalA()).send({ content: B64 });

    const gravada = findCall(isLogoUpdate)[1][0];
    expect(gravada).toMatch(/^https:\/\/r2\/karate\/dojos\/d\/logo\.jpg\?v=\d+$/);
  });

  it('responde com o MESMO shape do GET /dojo/me (front rehidrata sem 2º GET)', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://r2/logo.jpg' });
    mockDojo({ row: dojoRow({ karate_logo_url: 'https://r2/logo.jpg?v=9' }) });

    const res = await request(app).post(`${base}/me/logo`).set(canalA()).send({ content: B64 });

    expect(res.status).toBe(200);
    expect(res.body.dojo).toMatchObject({
      id: dojoId,
      name: 'Dojô Shotokan Belém',
      logo_url: 'https://r2/logo.jpg?v=9',
      affiliation_status: 'filiado',
    });
    expect(res.body.linked).toBe(true);
  });

  it('default de content_type é image/jpeg (extensão jpg)', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://r2/logo.jpg' });
    mockDojo();

    await request(app).post(`${base}/me/logo`).set(canalA()).send({ content: B64 });

    expect(uploadToR2.mock.calls[0][0]).toBe(`karate/dojos/${dojoId}/logo.jpg`);
    expect(uploadToR2.mock.calls[0][2]).toBe('image/jpeg');
  });

  it('webp é aceito', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://r2/logo.webp' });
    mockDojo();

    const res = await request(app)
      .post(`${base}/me/logo`)
      .set(canalA())
      .send({ content: B64, content_type: 'image/webp' });

    expect(res.status).toBe(200);
    expect(uploadToR2.mock.calls[0][0]).toBe(`karate/dojos/${dojoId}/logo.webp`);
  });

  it('content ausente → 400 sem tocar no R2', async () => {
    mockDojo();
    const res = await request(app).post(`${base}/me/logo`).set(canalA()).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(hitSql(isLogoUpdate)).toBe(false);
  });

  it('tipo não-imagem → 400 sem tocar no R2', async () => {
    mockDojo();
    const res = await request(app)
      .post(`${base}/me/logo`)
      .set(canalA())
      .send({ content: B64, content_type: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CONTENT_TYPE');
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('dojô de outra federação → 404 ANTES de gastar upload no R2', async () => {
    mockDojo({ row: null });

    const res = await request(app).post(`${base}/me/logo`).set(canalA()).send({ content: B64 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DOJO_NOT_FOUND');
    // Valida, DEPOIS sobe — mesma ordem de karateDojoStudents.
    expect(uploadToR2).not.toHaveBeenCalled();
    expect(hitSql(isLogoUpdate)).toBe(false);
  });

  it('falha do R2 → 500 e nada gravado no banco', async () => {
    uploadToR2.mockResolvedValueOnce({ success: false, error: 'boom' });
    mockDojo();

    const res = await request(app).post(`${base}/me/logo`).set(canalA()).send({ content: B64 });

    expect(res.status).toBe(500);
    expect(hitSql(isLogoUpdate)).toBe(false);
  });

  it('Canal B → 403 PORTAL_READ_ONLY sem nenhuma db.query nem upload', async () => {
    mockDojo();
    const res = await request(app).post(`${base}/me/logo`).set(canalB()).send({ content: B64 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('sem token → 401', async () => {
    mockDojo();
    const res = await request(app).post(`${base}/me/logo`).send({ content: B64 });
    expect(res.status).toBe(401);
    expect(uploadToR2).not.toHaveBeenCalled();
  });
});

// ============================================================
// DELETE /dojo/me/logo
// ============================================================
describe('DELETE /dojo/me/logo', () => {
  it('limpa a coluna e devolve o shape do GET com logo_url null', async () => {
    mockDojo();

    const res = await request(app).delete(`${base}/me/logo`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.dojo.logo_url).toBeNull();

    const upd = findCall(isLogoUpdate);
    expect(upd[1][0]).toBeNull();
    expect(upd[1][1]).toBe(dojoId);
    expect(upd[1][2]).toBe(fedId);
    // Remoção não é upload — o R2 não é tocado.
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('Canal B → 403 PORTAL_READ_ONLY', async () => {
    mockDojo();
    const res = await request(app).delete(`${base}/me/logo`).set(canalB());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('dojô de outra federação → 404', async () => {
    mockDojo({ extra: (s) => (isLogoUpdate(s) ? { rows: [] } : null) });
    const res = await request(app).delete(`${base}/me/logo`).set(canalA());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DOJO_NOT_FOUND');
  });
});

// ============================================================
// A logo NÃO é superfície federativa — dojô não conectado ainda
// tem direito à própria marca.
// ============================================================
describe('dojô NÃO conectado', () => {
  it('POST /dojo/me/logo funciona mesmo sem conexão com a federação', async () => {
    uploadToR2.mockResolvedValueOnce({ success: true, url: 'https://r2/logo.jpg' });
    mockDojo({ linkedAt: null });

    const res = await request(app).post(`${base}/me/logo`).set(canalA()).send({ content: B64 });

    // /dojo/me nunca foi gateado por conexão (ver topo de karateDojo.js) e a
    // logo é do DOJÔ, não da federação — gatear aqui seria pedir filiação
    // para o sensei poder usar a própria marca.
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(uploadToR2).toHaveBeenCalledTimes(1);
  });
});
