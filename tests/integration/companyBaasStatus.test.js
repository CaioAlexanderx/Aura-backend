// ============================================================
// AURA. — Testes: Recebe na Aura, situação da subconta em 4 blocos (RA-06)
// Cobre:
//   flag OFF → GET status e POST status/atualizar 404, sem banco nem Asaas
//     (lojista comum, dono ou não, não enxerga nada)
//   GET status devolve os 4 blocos na ordem da tela; sem retrato, null
//   atualizar: lê GET /myAccount/status/ com a chave DA SUBCONTA (nunca a da
//     conta-mãe), grava só os 4 campos do enum, nunca loga a chave
//   status resumido só avança; retrato mais velho não sobrescreve
//   sem subconta 404, sem chave 409, Asaas fora 502; só dono/admin;
//     empresa A não atualiza a B
//   migration 447 pendente: GET volta sem blocos, sem quebrar
//
// Banco mockado por SQL (tabela em memória), Asaas simulada (global.fetch).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = 'c'.repeat(64); // 32 bytes hex (só teste)
process.env.ASAAS_API_KEY = 'mother-key-test';
delete process.env.ASAAS_ENV;

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, baasCrypto, svc;
const realFetch = global.fetch;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  baasCrypto = require('../../src/services/dojoBaasCrypto');
  svc = require('../../src/services/companyBaasService');
});
afterAll(() => { global.fetch = realFetch; });

const SECRET = 'aura-test-secret-2026';
const companyA = 'a0000000-0000-4000-8000-00000000000a';
const companyB = 'b0000000-0000-4000-8000-00000000000b';
const ownerA = 'e0000000-0000-4000-8000-0000000000a1';
const ownerB = 'e0000000-0000-4000-8000-0000000000b1';
const sellerA = 'e0000000-0000-4000-8000-0000000000a2';
const SUB_KEY = '$aact_CHAVE_DA_SUBCONTA_DE_TESTE_999';

const MEMBERS = {
  [companyA]: { [ownerA]: 'owner', [sellerA]: 'vendedor' },
  [companyB]: { [ownerB]: 'owner' },
};

let store;
let tableQueries;
let semColunas; // simula a 447 pendente

function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (s.includes("SELECT 'owner' AS role")) {
    const [cid, uid] = params;
    const role = MEMBERS[cid] && MEMBERS[cid][uid];
    return Promise.resolve({ rows: role ? [{ role }] : [] });
  }
  if (!s.includes('company_baas_accounts')) return Promise.resolve({ rows: [] });
  tableQueries.push({ sql: s, params });
  if (semColunas && /account_status/.test(s)) {
    const e = new Error('column "account_status" does not exist');
    e.code = '42703';
    return Promise.reject(e);
  }
  if (/^\s*SELECT/.test(s)) {
    const row = store[params[0]];
    return Promise.resolve({ rows: row ? [{ ...row }] : [] });
  }
  if (/^\s*UPDATE company_baas_accounts\s+SET account_status/.test(s)) {
    const [cid, st, at, status] = params;
    const row = store[cid];
    if (!row) return Promise.resolve({ rows: [] });
    if (row.account_status_at && new Date(row.account_status_at) > new Date(at)) return Promise.resolve({ rows: [] });
    Object.assign(row, { account_status: JSON.parse(st), account_status_at: at, status });
    return Promise.resolve({ rows: [{ status }] });
  }
  return Promise.resolve({ rows: [] });
}

const auth = (userId) => ({
  Authorization: `Bearer ${jwt.sign({ id: userId, email: `${userId}@loja.com.br`, type: 'access' }, SECRET, { expiresIn: '1h' })}`,
});
const base = (cid) => `/api/v1/companies/${cid}/recebe`;
const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });

function contaCriada(cid, extra = {}) {
  store[cid] = {
    id: `row-${cid}`, company_id: cid, status: 'created', holder_type: 'PJ',
    api_key_enc: baasCrypto.encrypt(SUB_KEY), wallet_id: 'wallet-teste-0001',
    agency: '0001', account: '123456', account_digit: '7',
    created_at: '2026-11-10T12:00:00Z', ...extra,
  };
}

let logSpies;
beforeEach(() => {
  store = {};
  tableQueries = [];
  semColunas = false;
  svc._resetCacheDeColunas();
  db.query.mockReset();
  db.query.mockImplementation(fakeQuery);
  global.fetch = jest.fn();
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
});
afterEach(() => {
  delete process.env.RECEBE_NA_AURA_ENABLED;
  logSpies.forEach((sp) => sp.mockRestore());
});
const loggedText = () => logSpies.map((sp) => JSON.stringify(sp.mock.calls)).join('\n');

describe('flag desligada: lojista comum não enxerga nada', () => {
  test.each([
    ['GET', 'status'],
    ['POST', 'status/atualizar'],
  ])('%s %s → 404 RECEBE_INDISPONIVEL, sem banco nem Asaas', async (m, path) => {
    contaCriada(companyA);
    const r = m === 'GET'
      ? await request(app).get(`${base(companyA)}/${path}`).set(auth(ownerA))
      : await request(app).post(`${base(companyA)}/${path}`).set(auth(ownerA));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('RECEBE_INDISPONIVEL');
    expect(tableQueries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('serviço direto também recusa', async () => {
    await expect(svc.refreshStatus(companyA)).rejects.toMatchObject({ status: 404, code: 'RECEBE_INDISPONIVEL' });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('flag ligada', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; });

  test('GET status: 4 blocos na ordem da tela; sem retrato, status null', async () => {
    contaCriada(companyA);
    const r = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(r.status).toBe(200);
    expect(r.body.blocks).toEqual([
      { key: 'dados_comerciais', status: null },
      { key: 'documentos', status: null },
      { key: 'dados_bancarios', status: null },
      { key: 'geral', status: null },
    ]);
    expect(r.body.blocks_updated_at).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(SUB_KEY);
    expect(r.body).not.toHaveProperty('api_key_enc');
  });

  test('sem subconta: blocks null', async () => {
    const r = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('none');
    expect(r.body.blocks).toBeNull();
  });

  test('atualizar lê com a chave da subconta e grava só os 4 campos', async () => {
    contaCriada(companyA);
    global.fetch.mockResolvedValueOnce(okJson({
      id: 'acc_1', commercialInfo: 'APPROVED', documentation: 'AWAITING_APPROVAL',
      bankAccountInfo: 'APPROVED', general: 'AWAITING_APPROVAL', extra: 'nao-entra', cpfCnpj: '00000000000000',
    }));
    const r = await request(app).post(`${base(companyA)}/status/atualizar`).set(auth(ownerA));
    expect(r.status).toBe(200);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/myAccount\/status\/$/);
    expect(opts.method).toBe('GET');
    expect(opts.headers.access_token).toBe(SUB_KEY);
    expect(opts.headers.access_token).not.toBe('mother-key-test');

    expect(store[companyA].account_status).toEqual({
      commercialInfo: 'APPROVED', documentation: 'AWAITING_APPROVAL',
      bankAccountInfo: 'APPROVED', general: 'AWAITING_APPROVAL',
    });
    expect(store[companyA].status).toBe('under_review');
    expect(r.body.blocks.map((b) => b.status)).toEqual(['APPROVED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_APPROVAL']);
    expect(JSON.stringify(r.body)).not.toContain(SUB_KEY);
    expect(loggedText()).not.toContain(SUB_KEY);
  });

  test('valor fora do enum vira null; nada aproveitável não grava', async () => {
    expect(svc.normalizeAccountStatus({ commercialInfo: 'approved', general: 'QUALQUER' }))
      .toEqual({ commercialInfo: 'APPROVED', documentation: null, bankAccountInfo: null, general: null });
    expect(svc.normalizeAccountStatus({ foo: 'APPROVED' })).toBeNull();
    contaCriada(companyA);
    const out = await svc.saveAccountStatus(companyA, { foo: 1 }, new Date());
    expect(out).toEqual({ changed: false, reason: 'sem_blocos' });
    expect(store[companyA].account_status).toBeUndefined();
  });

  test('status resumido: aprovado geral → approved; nunca rebaixa', async () => {
    expect(svc.summaryFromBlocks({ general: 'APPROVED' })).toBe('approved');
    expect(svc.summaryFromBlocks({ general: 'REJECTED' })).toBe('rejected');
    expect(svc.summaryFromBlocks({ general: 'PENDING', documentation: 'PENDING' })).toBe('docs_pending');
    expect(svc.summaryFromBlocks({ general: 'PENDING', documentation: 'APPROVED' })).toBe('under_review');

    contaCriada(companyA, { status: 'approved' });
    await svc.saveAccountStatus(companyA, { general: 'PENDING', documentation: 'PENDING' }, new Date());
    expect(store[companyA].status).toBe('approved');
    // os blocos mostram a verdade de agora mesmo assim
    expect(store[companyA].account_status.documentation).toBe('PENDING');
  });

  test('retrato mais velho não sobrescreve um mais novo', async () => {
    contaCriada(companyA, {
      account_status: { commercialInfo: 'APPROVED', documentation: 'APPROVED', bankAccountInfo: 'APPROVED', general: 'APPROVED' },
      account_status_at: '2026-11-12T15:00:00.000Z', status: 'approved',
    });
    const out = await svc.saveAccountStatus(companyA, { general: 'PENDING' }, new Date('2026-11-12T14:00:00.000Z'));
    expect(out.changed).toBe(false);
    expect(store[companyA].account_status.general).toBe('APPROVED');
  });

  test('sem subconta 404, sem chave 409, Asaas fora 502', async () => {
    let r = await request(app).post(`${base(companyA)}/status/atualizar`).set(auth(ownerA));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('RECEBE_SEM_SUBCONTA');

    contaCriada(companyA, { api_key_enc: null, status: 'creating' });
    r = await request(app).post(`${base(companyA)}/status/atualizar`).set(auth(ownerA));
    expect(r.status).toBe(409);
    expect(global.fetch).not.toHaveBeenCalled();

    contaCriada(companyA);
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ errors: [{ description: 'fora' }] }) });
    r = await request(app).post(`${base(companyA)}/status/atualizar`).set(auth(ownerA));
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('RECEBE_ASAAS_INDISPONIVEL');
    expect(loggedText()).not.toContain(SUB_KEY);
  });

  test('só dono/admin; empresa A não atualiza a B', async () => {
    contaCriada(companyA);
    contaCriada(companyB);
    let r = await request(app).post(`${base(companyA)}/status/atualizar`).set(auth(sellerA));
    expect(r.status).toBe(403);
    r = await request(app).post(`${base(companyB)}/status/atualizar`).set(auth(ownerA));
    expect(r.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('447 pendente: GET volta sem retrato e atualizar responde 503', async () => {
    contaCriada(companyA);
    semColunas = true;
    let r = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(r.status).toBe(200);
    expect(r.body.blocks.every((b) => b.status === null)).toBe(true);

    global.fetch.mockResolvedValueOnce(okJson({ general: 'APPROVED' }));
    r = await request(app).post(`${base(companyA)}/status/atualizar`).set(auth(ownerA));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('SCHEMA_PENDING');
  });
});
