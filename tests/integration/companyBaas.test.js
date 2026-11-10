// ============================================================
// AURA. — Testes: Recebe na Aura, subconta Asaas por empresa (RA-05)
// Cobre:
//   flag OFF → rotas 404, serviço não toca banco nem Asaas
//   criação feliz (Asaas mockada) → 201, apiKey cifrada no banco, nunca na
//     resposta nem no log; notificações ao cliente final desligadas
//   idempotência: 2ª chamada (e chamadas simultâneas) não criam outra subconta
//   tipo de titular: PJ por padrão, PF e MEI pelo parâmetro
//   Asaas recusa (4xx) → reserva desfeita; resposta ambígua (5xx) → fica
//     'creating' e não chama a Asaas de novo
//   isolamento: empresa A não lê a subconta da B; só dono/admin
//
// O banco é mockado (tests/jest.setup.js). Aqui o mock responde por SQL,
// com a tabela em memória, para não depender da ordem das queries (o
// requireCompanyAccess dispara um UPDATE de last_active_at sem await).
// Nenhuma chamada real à Asaas: global.fetch é jest.fn em todo teste.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = 'b'.repeat(64); // 32 bytes hex (só teste)
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

const SECRET_KEY = '$aact_SUPER_SECRET_SUBACCOUNT_KEY_123';

// quem é o quê em cada empresa
const MEMBERS = {
  [companyA]: { [ownerA]: 'owner', [sellerA]: 'vendedor' },
  [companyB]: { [ownerB]: 'owner' },
};

let store; // company_id -> linha de company_baas_accounts
let tableQueries; // [{ sql, params }] só das queries em company_baas_accounts

function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (s.includes("SELECT 'owner' AS role")) {
    const [cid, uid] = params;
    const role = MEMBERS[cid] && MEMBERS[cid][uid];
    return Promise.resolve({ rows: role ? [{ role }] : [] });
  }
  if (!s.includes('company_baas_accounts')) return Promise.resolve({ rows: [] });
  tableQueries.push({ sql: s, params });
  if (/^\s*INSERT INTO company_baas_accounts/.test(s)) {
    const [cid, holderType, notifOff, createdBy] = params;
    if (store[cid]) return Promise.resolve({ rows: [] }); // ON CONFLICT DO NOTHING
    const id = `row-${cid}`;
    store[cid] = {
      id, company_id: cid, status: 'creating', holder_type: holderType,
      customer_notifications_disabled: notifOff, created_by: createdBy,
      created_at: '2026-11-10T12:00:00Z',
    };
    return Promise.resolve({ rows: [{ id }] });
  }
  if (/^\s*SELECT/.test(s)) {
    const row = store[params[0]];
    return Promise.resolve({ rows: row ? [{ ...row }] : [] });
  }
  if (/^\s*UPDATE company_baas_accounts/.test(s)) {
    const [id, accId, keyEnc, wallet, agency, account, digit, onboardingUrl, kyc, cid] = params;
    const row = store[cid];
    if (!row || row.id !== id) return Promise.resolve({ rows: [] });
    Object.assign(row, {
      asaas_account_id: accId, api_key_enc: keyEnc, wallet_id: wallet, agency, account,
      account_digit: digit, status: 'created', onboarding_url: onboardingUrl, kyc_snapshot: kyc,
    });
    return Promise.resolve({ rows: [{ ...row }] });
  }
  if (/^\s*DELETE FROM company_baas_accounts/.test(s)) {
    const [id] = params;
    for (const cid of Object.keys(store)) {
      if (store[cid].id === id && store[cid].status === 'creating' && !store[cid].asaas_account_id) delete store[cid];
    }
    return Promise.resolve({ rows: [] });
  }
  return Promise.resolve({ rows: [] });
}

const auth = (userId) => ({
  Authorization: `Bearer ${jwt.sign({ id: userId, email: `${userId}@loja.com.br`, type: 'access' }, SECRET, { expiresIn: '1h' })}`,
});

const validPJ = {
  name: 'Loja da Ana LTDA',
  cpf_cnpj: '12.345.678/0001-99',
  company_type: 'LIMITED',
  email: 'financeiro@lojadaana.com.br',
  mobile_phone: '(11) 99999-8888',
  income_value: 15000,
  address: 'Rua das Flores',
  address_number: '100',
  province: 'Centro',
  postal_code: '01001-000',
};

const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj });
const errJson = (status, desc) => ({ ok: false, status, json: async () => ({ errors: [{ description: desc }] }) });
const asaasAccount = (n = 1) => okJson({
  id: `acc_${n}`,
  apiKey: SECRET_KEY,
  walletId: `wallet-loja-0000-000${n}`,
  accountNumber: { agency: '0001', account: '123456', accountDigit: '7' },
});

let logSpies;
beforeEach(() => {
  store = {};
  tableQueries = [];
  db.query.mockReset();
  db.query.mockImplementation(fakeQuery);
  global.fetch = jest.fn();
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
});
afterEach(() => {
  delete process.env.RECEBE_NA_AURA_ENABLED;
  logSpies.forEach((s) => s.mockRestore());
});

function loggedText() {
  return logSpies.map((s) => JSON.stringify(s.mock.calls)).join('\n');
}

const base = (cid) => `/api/v1/companies/${cid}/recebe`;

describe('Recebe na Aura — flag desligada', () => {
  test('GET status → 404 RECEBE_INDISPONIVEL, sem tocar a tabela nem a Asaas', async () => {
    const res = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RECEBE_INDISPONIVEL');
    expect(tableQueries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POST onboarding → 404, nada criado, Asaas não chamada', async () => {
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RECEBE_INDISPONIVEL');
    expect(tableQueries).toHaveLength(0);
    expect(store).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each(['', 'false', '0', 'off', 'nao'])('valor %p não liga a flag', async (v) => {
    process.env.RECEBE_NA_AURA_ENABLED = v;
    expect(svc.isEnabled()).toBe(false);
  });

  test('serviço chamado direto também recusa, sem banco nem Asaas', async () => {
    await expect(svc.createAccount(companyA, validPJ)).rejects.toMatchObject({ status: 404, code: 'RECEBE_INDISPONIVEL' });
    await expect(svc.getStatus(companyA)).rejects.toMatchObject({ status: 404, code: 'RECEBE_INDISPONIVEL' });
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Recebe na Aura — flag ligada', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; });

  test('nome comercial numa constante única', () => {
    expect(svc.RECEBE_NA_AURA_NAME).toBe('Recebe na Aura');
  });

  test('GET status sem subconta → status none', async () => {
    const res = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, product_name: 'Recebe na Aura', status: 'none', account: null });
  });

  test('criação feliz: 201, chave cifrada no banco, nunca na resposta nem no log', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1));

    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, status: 'created', holder_type: 'PJ' });
    expect(res.body.account).toEqual({
      agency: '0001', account: '123456', account_digit: '7', wallet_id_masked: 'wall••••0001',
    });
    // apiKey nunca na resposta
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(res.body)).not.toContain('wallet-loja-0000-0001');

    // gravada cifrada; decifra para a original
    const row = store[companyA];
    expect(row.api_key_enc).toMatch(/^v1:/);
    expect(row.api_key_enc).not.toContain(SECRET_KEY);
    expect(baasCrypto.decrypt(row.api_key_enc)).toBe(SECRET_KEY);
    // nenhuma query recebeu a chave em texto puro
    expect(JSON.stringify(db.query.mock.calls)).not.toContain(SECRET_KEY);
    // nunca no log
    expect(loggedText()).not.toContain(SECRET_KEY);

    // notificações ao cliente final desligadas desde a criação
    expect(row.customer_notifications_disabled).toBe(true);
    expect(row.created_by).toBe(ownerA);

    // Asaas: POST /accounts com a credencial da conta-mãe, sem webhook
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.asaas.com/v3/accounts');
    expect(opts.method).toBe('POST');
    expect(opts.headers.access_token).toBe('mother-key-test');
    const sent = JSON.parse(opts.body);
    expect(sent).toMatchObject({
      name: 'Loja da Ana LTDA', cpfCnpj: '12345678000199', companyType: 'LIMITED',
      mobilePhone: '11999998888', postalCode: '01001000',
    });
    expect(sent.webhooks).toBeUndefined();
    expect(sent.birthDate).toBeUndefined();
  });

  test('GET status depois da criação: sem chave, wallet mascarada', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);

    const res = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('created');
    expect(res.body.account.wallet_id_masked).toBe('wall••••0001');
    const txt = JSON.stringify(res.body);
    expect(txt).not.toContain(SECRET_KEY);
    expect(txt).not.toContain('api_key');
  });

  test('idempotente: 2ª chamada devolve a existente e não chama a Asaas', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const r1 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    const r2 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ created: false, status: 'created' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(store)).toEqual([companyA]);
  });

  test('idempotente sob concorrência: duas chamadas juntas → uma subconta', async () => {
    global.fetch.mockResolvedValue(asaasAccount(1));
    const [r1, r2] = await Promise.all([
      request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ),
      request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('Asaas recusa (4xx) → 422 e a reserva é desfeita (dá para tentar de novo)', async () => {
    global.fetch
      .mockResolvedValueOnce(errJson(400, 'CEP inválido'))
      .mockResolvedValueOnce(asaasAccount(2));

    const r1 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('RECEBE_DADOS_RECUSADOS');
    expect(store[companyA]).toBeUndefined();

    const r2 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(r2.status).toBe(201);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('resposta ambígua (5xx) → 502, linha fica creating e não chama a Asaas de novo', async () => {
    global.fetch.mockResolvedValueOnce(errJson(503, 'indisponível'));

    const r1 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(r1.status).toBe(502);
    expect(r1.body.code).toBe('RECEBE_EM_CONFERENCIA');
    expect(store[companyA].status).toBe('creating');

    const r2 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ created: false, status: 'creating' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('dados inválidos → 422 sem reservar nem chamar a Asaas', async () => {
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA))
      .send({ ...validPJ, cpf_cnpj: '123' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(tableQueries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Recebe na Aura — tipo de titular', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; });

  const sentBody = () => JSON.parse(global.fetch.mock.calls[0][1].body);

  test('PF pelo body: CPF, data de nascimento, sem companyType', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send({
      ...validPJ, holder_type: 'pf', name: 'Ana Souza', cpf_cnpj: '123.456.789-09', birth_date: '1990-05-20',
    });
    expect(res.status).toBe(201);
    expect(res.body.holder_type).toBe('PF');
    expect(store[companyA].holder_type).toBe('PF');
    const sent = sentBody();
    expect(sent.cpfCnpj).toBe('12345678909');
    expect(sent.birthDate).toBe('1990-05-20');
    expect(sent.companyType).toBeUndefined();
  });

  test('MEI: companyType forçado para MEI', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send({
      ...validPJ, holder_type: 'MEI', company_type: undefined,
    });
    expect(res.status).toBe(201);
    expect(sentBody().companyType).toBe('MEI');
    expect(store[companyA].holder_type).toBe('MEI');
  });

  test('PF sem data de nascimento → 422', async () => {
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send({
      ...validPJ, holder_type: 'PF', cpf_cnpj: '12345678909',
    });
    expect(res.status).toBe(422);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('tipo desconhecido → 422', async () => {
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send({ ...validPJ, holder_type: 'ONG' });
    expect(res.status).toBe(422);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('parâmetro do serviço vence o body; padrão é PJ', async () => {
    expect(svc.DEFAULT_HOLDER_TYPE).toBe('PJ');
    expect(svc.normalizeHolderType(undefined)).toBe('PJ');
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const out = await svc.createAccount(companyA, { ...validPJ, holder_type: 'PJ', company_type: undefined }, { holderType: 'MEI' });
    expect(out.holder_type).toBe('MEI');
    expect(sentBody().companyType).toBe('MEI');
  });

  test('clientes da subconta saem com notificationDisabled', () => {
    expect(svc.buildSubaccountCustomerPayload({ name: 'Cliente', notificationDisabled: false }))
      .toEqual({ name: 'Cliente', notificationDisabled: true });
  });
});

describe('Recebe na Aura — isolamento e permissão', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; });

  test('dono da A não lê a subconta da B (403) e a tabela da B nem é consultada', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(9));
    await request(app).post(`${base(companyB)}/onboarding`).set(auth(ownerB)).send(validPJ);
    tableQueries = [];

    const res = await request(app).get(`${base(companyB)}/status`).set(auth(ownerA));
    expect(res.status).toBe(403);
    expect(tableQueries).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('wall');
  });

  test('dono da A não cria subconta na B', async () => {
    const res = await request(app).post(`${base(companyB)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(403);
    expect(store[companyB]).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('cada empresa vê só a sua (multi-CNPJ: uma subconta por empresa)', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(9));
    await request(app).post(`${base(companyB)}/onboarding`).set(auth(ownerB)).send(validPJ);

    const resA = await request(app).get(`${base(companyA)}/status`).set(auth(ownerA));
    expect(resA.status).toBe(200);
    expect(resA.body.status).toBe('none');
    // toda leitura da tabela foi pela empresa da URL
    const reads = tableQueries.filter((q) => /^\s*SELECT/.test(q.sql));
    expect(reads.at(-1).params).toEqual([companyA]);
  });

  test('membro que não é dono/admin → 403 sem tocar a tabela', async () => {
    const r1 = await request(app).get(`${base(companyA)}/status`).set(auth(sellerA));
    const r2 = await request(app).post(`${base(companyA)}/onboarding`).set(auth(sellerA)).send(validPJ);
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(r1.body.code).toBe('SOMENTE_DONO_OU_ADMIN');
    expect(tableQueries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
