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
// Segredos do aviso (webhook), só teste. 40 caracteres (mínimo da Asaas: 32).
const AVISO_TOKEN = 'whsec_PRODUCAO_aviso_de_teste_0123456789';
const AVISO_TOKEN_SANDBOX = 'whsec_SANDBOX_aviso_de_teste_9876543210';
const staffUser = 'e0000000-0000-4000-8000-0000000000f1';
// Token POR SUBCONTA: HMAC-SHA256(segredo, company_id), hex.
const tokenDe = (master, cid) => require('crypto').createHmac('sha256', master).update(cid).digest('hex');

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
  if (/SELECT is_staff FROM users/.test(s)) {
    return Promise.resolve({ rows: [{ is_staff: params[0] === staffUser }] });
  }
  if (!s.includes('company_baas_accounts')) return Promise.resolve({ rows: [] });
  tableQueries.push({ sql: s, params });
  if (/WHERE asaas_account_id = \$1/.test(s)) {
    const row = Object.values(store).find((r) => r.asaas_account_id === params[0]);
    return Promise.resolve({ rows: row ? [{ company_id: row.company_id }] : [] });
  }
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
  process.env.RECEBE_ASAAS_WEBHOOK_TOKEN = AVISO_TOKEN;
  logSpies = ['log', 'warn', 'error', 'info'].map((m) => jest.spyOn(console, m));
});
afterEach(() => {
  delete process.env.RECEBE_NA_AURA_ENABLED;
  delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN;
  delete process.env.RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN;
  delete process.env.RECEBE_ASAAS_WEBHOOK_URL;
  delete process.env.RECEBE_ASAAS_WEBHOOK_EMAIL;
  delete process.env.ASAAS_ENV;
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

    // Asaas: POST /accounts com a credencial da conta-mãe, com o aviso
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
    expect(sent.webhooks).toHaveLength(1);
    expect(sent.birthDate).toBeUndefined();
    // o token do aviso vai só para a Asaas: nunca na resposta, no banco nem no log
    for (const t of [AVISO_TOKEN, tokenDe(AVISO_TOKEN, companyA)]) {
      expect(JSON.stringify(res.body)).not.toContain(t);
      expect(JSON.stringify(db.query.mock.calls)).not.toContain(t);
      expect(loggedText()).not.toContain(t);
    }
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

// ── Aviso (webhook) em cada subconta — decisão do Caio de 25/11/2026 ──
describe('Recebe na Aura — aviso cadastrado na criação da subconta', () => {
  beforeEach(() => { process.env.RECEBE_NA_AURA_ENABLED = 'true'; });

  const avisoEnviado = () => JSON.parse(global.fetch.mock.calls[0][1].body).webhooks;
  const aviso = require('../../src/services/recebeAviso');

  test('POST /accounts leva o webhook: URL padrão, token de produção, eventos de pagamento e de conta', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(201);

    const [w] = avisoEnviado();
    expect(w).toMatchObject({
      url: 'https://api.getaura.com.br/api/v1/webhooks/asaas-recebe',
      email: 'contato@getaura.com.br',
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: tokenDe(AVISO_TOKEN, companyA),
      sendType: 'NON_SEQUENTIALLY',
    });
    expect(w.authToken).toMatch(/^[0-9a-f]{64}$/); // dentro de 32–255
    expect(w.authToken).not.toBe(AVISO_TOKEN);     // nunca o mestre puro
    expect(w.name).toContain('Recebe na Aura');
    expect(w.name).toContain(`[${aviso.impressaoDoToken(w.authToken)}]`);
    expect(w.name).not.toContain(w.authToken);
    for (const e of ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED', 'PAYMENT_DELETED',
      'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED', 'ACCOUNT_STATUS_DOCUMENT_PENDING', 'ACCOUNT_STATUS_DOCUMENT_REJECTED']) {
      expect(w.events).toContain(e);
    }
    // os eventos são exatamente os que o recebeWebhookService trata
    const wh = require('../../src/services/recebeWebhookService');
    expect([...w.events].sort()).toEqual([...wh.PAYMENT_EVENTS_OF_INTEREST, ...wh.ACCOUNT_STATUS_EVENTS].sort());
    expect(new Set(w.events).size).toBe(w.events.length);
  });

  test('a rota do aviso confere o token DESTA subconta; o de outra e o mestre puro não valem', async () => {
    global.fetch.mockResolvedValueOnce(asaasAccount(1)).mockResolvedValueOnce(asaasAccount(2));
    await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    await request(app).post(`${base(companyB)}/onboarding`).set(auth(ownerB)).send(validPJ);
    const wh = require('../../src/services/recebeWebhookService');
    const corpoA = { id: 'evt_1', event: 'PAYMENT_RECEIVED', account: { id: 'acc_1' } };
    const tokenA = JSON.parse(global.fetch.mock.calls[0][1].body).webhooks[0].authToken;
    const tokenB = JSON.parse(global.fetch.mock.calls[1][1].body).webhooks[0].authToken;
    expect(tokenA).not.toBe(tokenB);
    await expect(wh.checkToken(tokenA, corpoA)).resolves.toEqual({ ok: true, companyId: companyA });
    await expect(wh.checkToken(tokenB, corpoA)).resolves.toMatchObject({ ok: false, reason: 'token_invalido' });
    await expect(wh.checkToken(AVISO_TOKEN, corpoA)).resolves.toMatchObject({ ok: false, reason: 'token_invalido' });
    await expect(wh.checkToken(tokenA, { account: { id: 'acc_nao_existe' } }))
      .resolves.toMatchObject({ ok: false, reason: 'subconta_desconhecida' });
    await expect(wh.checkToken(tokenA, {})).resolves.toMatchObject({ ok: false, reason: 'sem_conta_no_aviso' });
  });

  test('URL e e-mail vêm da env quando definidos', async () => {
    process.env.RECEBE_ASAAS_WEBHOOK_URL = 'https://api-homolog.exemplo.com.br/api/v1/webhooks/asaas-recebe';
    process.env.RECEBE_ASAAS_WEBHOOK_EMAIL = 'tecnologia@exemplo.com.br';
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(avisoEnviado()[0]).toMatchObject({
      url: 'https://api-homolog.exemplo.com.br/api/v1/webhooks/asaas-recebe',
      email: 'tecnologia@exemplo.com.br',
    });
  });

  test('sandbox: usa o token de sandbox, nunca o de produção', async () => {
    process.env.ASAAS_ENV = 'sandbox';
    process.env.RECEBE_ASAAS_SANDBOX_WEBHOOK_TOKEN = AVISO_TOKEN_SANDBOX;
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(201);
    expect(global.fetch.mock.calls[0][0]).toBe('https://sandbox.asaas.com/api/v3/accounts');
    expect(avisoEnviado()[0].authToken).toBe(tokenDe(AVISO_TOKEN_SANDBOX, companyA));
    expect(global.fetch.mock.calls[0][1].body).not.toContain(tokenDe(AVISO_TOKEN, companyA));
  });

  test('sandbox sem o token de sandbox: 503 (não cai no de produção)', async () => {
    process.env.ASAAS_ENV = 'sandbox';
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('RECEBE_AVISO_NAO_CONFIGURADO');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['sem token', undefined],
    ['token vazio', '   '],
    ['token curto (31)', 'x'.repeat(31)],
    ['token longo (256)', 'x'.repeat(256)],
  ])('%s: 503 RECEBE_AVISO_NAO_CONFIGURADO, sem reservar a linha nem chamar a Asaas', async (_n, tok) => {
    if (tok === undefined) delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN;
    else process.env.RECEBE_ASAAS_WEBHOOK_TOKEN = tok;
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('RECEBE_AVISO_NAO_CONFIGURADO');
    expect(tableQueries).toHaveLength(0);
    expect(store).toEqual({});
    expect(global.fetch).not.toHaveBeenCalled();
    // o log diz qual variável falta, nunca o valor
    expect(loggedText()).toContain('RECEBE_ASAAS_WEBHOOK_TOKEN');
    if (tok && tok.trim()) expect(loggedText()).not.toContain(tok);
  });

  test('token de exatamente 32 caracteres basta', async () => {
    process.env.RECEBE_ASAAS_WEBHOOK_TOKEN = 'y'.repeat(32);
    global.fetch.mockResolvedValueOnce(asaasAccount(1));
    const res = await request(app).post(`${base(companyA)}/onboarding`).set(auth(ownerA)).send(validPJ);
    expect(res.status).toBe(201);
    expect(aviso.resolveSecret()).toMatchObject({ ok: true });
  });
});

describe('Recebe na Aura — aviso numa subconta já criada (staff)', () => {
  const URL_AVISO = '/api/v1/admin/recebe/aviso';
  const RECEBE_URL = 'https://api.getaura.com.br/api/v1/webhooks/asaas-recebe';
  let hooks; // webhooks da subconta na Asaas simulada
  let calls;

  function fakeAsaas(url, opts = {}) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v3/, '');
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path, body, key: opts.headers && opts.headers.access_token });
    if (method === 'GET' && path === '/webhooks') {
      return Promise.resolve(okJson({ data: hooks.map(({ authToken, ...w }) => ({ ...w, hasAuthToken: !!authToken })) }));
    }
    const put = path.match(/^\/webhooks\/([^/]+)$/);
    if (method === 'PUT' && put) {
      const w = hooks.find((h) => h.id === put[1]);
      if (!w) return Promise.resolve(errJson(404, 'não encontrado'));
      Object.assign(w, body);
      const { authToken, ...semToken } = w;
      return Promise.resolve(okJson({ ...semToken, hasAuthToken: !!authToken }));
    }
    if (method === 'POST' && path === '/webhooks') {
      const w = { id: `wh_${hooks.length + 1}`, ...body };
      hooks.push(w);
      const { authToken, ...semToken } = w;
      return Promise.resolve(okJson({ ...semToken, hasAuthToken: !!authToken }));
    }
    return Promise.resolve(errJson(404, 'rota não simulada'));
  }

  function subcontaAntiga(cid, extra = {}) {
    store[cid] = {
      id: `row-${cid}`, company_id: cid, status: 'approved', asaas_account_id: 'acc_antiga',
      api_key_enc: baasCrypto.encrypt(SECRET_KEY), ...extra,
    };
  }

  beforeEach(() => {
    process.env.RECEBE_NA_AURA_ENABLED = 'true';
    hooks = [];
    calls = [];
    global.fetch = jest.fn(fakeAsaas);
  });

  test('cadastra o aviso com a chave DA subconta; 2ª chamada não duplica', async () => {
    subcontaAntiga(companyA);
    const r1 = await request(app).post(URL_AVISO).set(auth(staffUser)).send({ company_id: companyA });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      registered: true, already_registered: false,
      webhook: { id: 'wh_1', url: RECEBE_URL, enabled: true, interrupted: false, has_auth_token: true, send_type: 'NON_SEQUENTIALLY' },
    });
    const post = calls.find((c) => c.method === 'POST');
    expect(post.path).toBe('/webhooks');
    expect(post.body).toMatchObject({ url: RECEBE_URL, authToken: tokenDe(AVISO_TOKEN, companyA), enabled: true, interrupted: false });
    expect(post.body.events).toContain('PAYMENT_RECEIVED');
    for (const c of calls) expect(c.key).toBe(SECRET_KEY); // nunca a chave da conta-mãe

    const r2 = await request(app).post(URL_AVISO).set(auth(staffUser)).send({ company_id: companyA });
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ registered: false, already_registered: true, webhook: { id: 'wh_1' } });
    expect(hooks).toHaveLength(1);

    for (const r of [r1, r2]) {
      expect(JSON.stringify(r.body)).not.toContain(AVISO_TOKEN);
      expect(JSON.stringify(r.body)).not.toContain(tokenDe(AVISO_TOKEN, companyA));
      expect(JSON.stringify(r.body)).not.toContain(SECRET_KEY);
    }
    expect(loggedText()).not.toContain(AVISO_TOKEN);
    expect(loggedText()).not.toContain(SECRET_KEY);
  });

  const avisoMod = require('../../src/services/recebeAviso');
  const hookCerto = (extra = {}) => {
    const cfg = avisoMod.buildWebhookConfig(tokenDe(AVISO_TOKEN, companyA));
    return { id: 'wh_velho', ...cfg, ...extra };
  };

  test('aviso já cadastrado e certo: already_registered, sem PUT nem POST', async () => {
    subcontaAntiga(companyA);
    hooks.push(hookCerto());
    const out = await svc.registerWebhook(companyA);
    expect(out).toMatchObject({ registered: false, updated: false, already_registered: true, webhook: { id: 'wh_velho' } });
    expect(calls.some((c) => c.method === 'POST' || c.method === 'PUT')).toBe(false);
  });

  test.each([
    ['desligado', { enabled: false }, 'desligado'],
    ['fila interrompida', { interrupted: true }, 'fila_interrompida'],
    ['URL com barra no fim', { url: `${RECEBE_URL}/` }, 'url'],
    ['sem um evento', { events: ['PAYMENT_RECEIVED'] }, 'eventos'],
  ])('aviso %s: PUT no MESMO webhook, responde updated', async (_n, extra, motivo) => {
    subcontaAntiga(companyA);
    hooks.push(hookCerto(extra));
    const r = await request(app).post(URL_AVISO).set(auth(staffUser)).send({ company_id: companyA });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ registered: false, updated: true, already_registered: false, webhook: { id: 'wh_velho' } });
    expect(r.body.reasons).toContain(motivo);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.path).toBe('/webhooks/wh_velho');
    expect(put.body).toMatchObject({ url: RECEBE_URL, enabled: true, interrupted: false, authToken: tokenDe(AVISO_TOKEN, companyA) });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ enabled: true, interrupted: false, url: RECEBE_URL });
    // e a próxima chamada já acha tudo certo
    const r2 = await request(app).post(URL_AVISO).set(auth(staffUser)).send({ company_id: companyA });
    expect(r2.body).toMatchObject({ already_registered: true, updated: false });
  });

  test('segredo rotacionado: o token cadastrado é o antigo → PUT com o token novo', async () => {
    subcontaAntiga(companyA);
    const antigo = tokenDe('segredo-antigo-do-recebe-0123456789abcdef', companyA);
    hooks.push({ id: 'wh_velho', ...avisoMod.buildWebhookConfig(antigo) });
    const out = await svc.registerWebhook(companyA);
    expect(out).toMatchObject({ updated: true, reasons: ['token_diferente'] });
    expect(hooks[0].authToken).toBe(tokenDe(AVISO_TOKEN, companyA));
    expect(avisoMod.nomeTemImpressao(hooks[0].name, tokenDe(AVISO_TOKEN, companyA))).toBe(true);
    expect(loggedText()).not.toContain(antigo);
    expect(loggedText()).not.toContain(tokenDe(AVISO_TOKEN, companyA));
  });

  test('listagem falha na Asaas: 502 e não cria (sem saber o que existe, não duplica)', async () => {
    subcontaAntiga(companyA);
    global.fetch = jest.fn(() => Promise.resolve(errJson(503, 'fora')));
    await expect(svc.registerWebhook(companyA)).rejects.toMatchObject({ status: 502, code: 'RECEBE_ASAAS_INDISPONIVEL' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('sem token configurado: 503, sem banco nem Asaas', async () => {
    delete process.env.RECEBE_ASAAS_WEBHOOK_TOKEN;
    subcontaAntiga(companyA);
    await expect(svc.registerWebhook(companyA)).rejects.toMatchObject({ status: 503, code: 'RECEBE_AVISO_NAO_CONFIGURADO' });
    expect(tableQueries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sem subconta: 404; sem chave guardada: 409', async () => {
    await expect(svc.registerWebhook(companyA)).rejects.toMatchObject({ status: 404, code: 'RECEBE_SEM_SUBCONTA' });
    subcontaAntiga(companyA, { api_key_enc: null });
    await expect(svc.registerWebhook(companyA)).rejects.toMatchObject({ status: 409, code: 'RECEBE_EM_CONFERENCIA' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('quem não é staff no banco → 404; sem login → 401; flag desligada → 404 sem banco', async () => {
    subcontaAntiga(companyA);
    const r1 = await request(app).post(URL_AVISO).set(auth(ownerA)).send({ company_id: companyA });
    expect(r1.status).toBe(404);
    const r2 = await request(app).post(URL_AVISO).send({ company_id: companyA });
    expect(r2.status).toBe(401);
    delete process.env.RECEBE_NA_AURA_ENABLED;
    db.query.mockClear();
    const r3 = await request(app).post(URL_AVISO).set(auth(staffUser)).send({ company_id: companyA });
    expect(r3.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('company_id inválido → 422', async () => {
    const r = await request(app).post(URL_AVISO).set(auth(staffUser)).send({ company_id: '123' });
    expect(r.status).toBe(422);
  });
});
