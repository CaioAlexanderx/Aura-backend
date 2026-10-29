// ============================================================
// AURA. — Mercado Pago por OAuth (tq-94)
//
// Nenhuma chamada real ao Mercado Pago: `fetch` é substituído em cada teste.
// Banco mockado (tests/jest.setup.js); o que se testa é o contrato das
// rotas, do state assinado, da cifra dos tokens e da renovação.
// ============================================================
'use strict';

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

const ENV_ORIGINAL = { ...process.env };
const CHAVE = crypto.randomBytes(32).toString('hex');

function ligarEnv() {
  process.env.MP_CLIENT_ID = '1234567890';
  process.env.MP_CLIENT_SECRET = 'segredo-da-aplicacao-de-teste';
  process.env.CERT_MASTER_KEY = CHAVE;
  process.env.STOREFRONT_API_BASE_URL = 'https://api.exemplo.test';
  process.env.APP_URL = 'https://app.exemplo.test';
  delete process.env.MP_REDIRECT_URI;
}
function desligarEnv() {
  delete process.env.MP_CLIENT_ID;
  delete process.env.MP_CLIENT_SECRET;
}

let db, mpOAuth, mpGateway, secretCrypto;
beforeAll(() => {
  db = require('../src/config/database');
  mpOAuth = require('../src/services/mpOAuth');
  mpGateway = require('../src/services/mpGateway');
  secretCrypto = require('../src/utils/secretCrypto');
});
beforeEach(() => {
  jest.resetAllMocks();
  ligarEnv();
  mpGateway._resetCache();
  global.fetch = jest.fn();
});
afterAll(() => { process.env = ENV_ORIGINAL; delete global.fetch; });

function resposta(status, json) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(json) });
}

const EMPRESA = '11111111-1111-1111-1111-111111111111';
const DONO = '22222222-2222-2222-2222-222222222222';

// ── state ────────────────────────────────────────────────────────────────
describe('state assinado', () => {
  test('ida e volta preserva empresa, usuário, testes e caminho', () => {
    const st = mpOAuth.signState({ companyId: EMPRESA, userId: DONO, sandbox: true, returnPath: '/studio/vendas/loja-digital' });
    expect(mpOAuth.verifyState(st)).toEqual({
      companyId: EMPRESA, userId: DONO, sandbox: true, returnPath: '/studio/vendas/loja-digital',
    });
  });

  test('empresa trocada no corpo invalida a assinatura', () => {
    const st = mpOAuth.signState({ companyId: EMPRESA, userId: DONO });
    const [body, sig] = st.split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    p.c = '99999999-9999-9999-9999-999999999999';
    const forjado = Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig;
    expect(() => mpOAuth.verifyState(forjado)).toThrow(expect.objectContaining({ code: 'assinatura' }));
  });

  test('vence em 10 minutos', () => {
    const agora = Date.now();
    const st = mpOAuth.signState({ companyId: EMPRESA, userId: DONO, now: agora });
    expect(() => mpOAuth.verifyState(st, { now: agora + 9 * 60 * 1000 })).not.toThrow();
    expect(() => mpOAuth.verifyState(st, { now: agora + 11 * 60 * 1000 })).toThrow(expect.objectContaining({ code: 'expirado' }));
  });

  test('caminho de volta só relativo ao app', () => {
    expect(mpOAuth.caminhoSeguro('/canal?tab=site')).toBe('/canal?tab=site');
    expect(mpOAuth.caminhoSeguro('//evil.test/x')).toBeNull();
    expect(mpOAuth.caminhoSeguro('https://evil.test')).toBeNull();
    expect(mpOAuth.caminhoSeguro('/\\evil.test')).toBeNull();
  });

  test('URL de autorização usa client_id, redirect_uri e state', () => {
    const url = new URL(mpOAuth.buildAuthUrl({ state: 'abc.def' }));
    expect(url.origin).toBe('https://auth.mercadopago.com.br');
    expect(url.searchParams.get('client_id')).toBe('1234567890');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.exemplo.test/api/v1/mp/oauth/callback');
    expect(url.searchParams.get('state')).toBe('abc.def');
  });

  test('sem MP_CLIENT_ID ou sem chave de cifra o OAuth fica desligado', () => {
    expect(mpOAuth.oauthDisponivel()).toBe(true);
    desligarEnv();
    expect(mpOAuth.oauthDisponivel()).toBe(false);
    ligarEnv();
    delete process.env.CERT_MASTER_KEY;
    expect(mpOAuth.oauthDisponivel()).toBe(false);
  });
});

// ── início (rota autenticada) ───────────────────────────────────────────
describe('GET /payment-gateways/mercadopago/oauth/start', () => {
  function app({ role = 'client', companyRole = 'owner', is_staff = false } = {}) {
    const a = express();
    a.use((req, _res, next) => { req.user = { id: DONO, role, is_staff }; req.companyRole = companyRole; next(); });
    a.use('/companies/:id/payment-gateways', require('../src/routes/paymentGateways'));
    return a;
  }
  const colunas = () => db.query.mockImplementation((sql) =>
    Promise.resolve({ rows: /information_schema/.test(sql) ? [{ '?column?': 1 }] : [] }));

  test('sem env responde 503 e não monta URL', async () => {
    desligarEnv();
    colunas();
    const res = await request(app()).get(`/companies/${EMPRESA}/payment-gateways/mercadopago/oauth/start`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MP_OAUTH_INDISPONIVEL');
  });

  test('funcionário não conecta', async () => {
    colunas();
    const res = await request(app({ companyRole: 'manager' })).get(`/companies/${EMPRESA}/payment-gateways/mercadopago/oauth/start`);
    expect(res.status).toBe(403);
  });

  test('modo de testes só para a equipe Aura', async () => {
    colunas();
    const r1 = await request(app()).get(`/companies/${EMPRESA}/payment-gateways/mercadopago/oauth/start?sandbox=1`);
    expect(r1.status).toBe(403);
    const r2 = await request(app({ is_staff: true })).get(`/companies/${EMPRESA}/payment-gateways/mercadopago/oauth/start?sandbox=1`);
    expect(r2.status).toBe(200);
    const st = new URL(r2.body.url).searchParams.get('state');
    expect(mpOAuth.verifyState(st).sandbox).toBe(true);
  });

  test('dono recebe a URL com state da empresa ativa', async () => {
    colunas();
    const res = await request(app())
      .get(`/companies/${EMPRESA}/payment-gateways/mercadopago/oauth/start`)
      .query({ volta: '/canal?tab=site' });
    expect(res.status).toBe(200);
    const st = mpOAuth.verifyState(new URL(res.body.url).searchParams.get('state'));
    expect(st).toMatchObject({ companyId: EMPRESA, userId: DONO, sandbox: false, returnPath: '/canal?tab=site' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── GET da lista: token do OAuth não sai ────────────────────────────────
describe('GET /payment-gateways com conexão por OAuth', () => {
  test('mostra o nome da conta e nenhum token, nem mascarado', async () => {
    db.query.mockImplementation((sql) => {
      if (/information_schema/.test(sql)) return Promise.resolve({ rows: [{ x: 1 }] });
      if (/COUNT\(\*\)/.test(sql)) return Promise.resolve({ rows: [{ n: 2 }] });
      if (/SELECT gateway, access_token/.test(sql)) return Promise.resolve({ rows: [{ gateway: 'mercadopago', access_token: 'v1:a:b:c' }] });
      return Promise.resolve({ rows: [{
        id: 'g1', gateway: 'mercadopago', public_key: 'APP_USR-chave-publica', sandbox: false, webhook_secret: null,
        auth_method: 'oauth', mp_nickname: 'LOJA TESTE', connection_status: 'ok', connection_lost_at: null,
        created_at: '2026-10-29', updated_at: '2026-10-29',
      }] });
    });
    const a = express();
    a.use((req, _res, next) => { req.user = { id: DONO, role: 'client' }; req.companyRole = 'owner'; next(); });
    a.use('/companies/:id/payment-gateways', require('../src/routes/paymentGateways'));
    const res = await request(a).get(`/companies/${EMPRESA}/payment-gateways`);
    expect(res.status).toBe(200);
    const g = res.body.gateways[0];
    expect(g).toMatchObject({ auth_method: 'oauth', account_name: 'LOJA TESTE', connection_status: 'ok' });
    expect(g.access_token_masked).toBeNull();
    expect(g.public_key_masked).toBeNull();
    expect(res.body).toMatchObject({ oauth_disponivel: true, pode_conectar: true, pedidos_em_andamento: 2 });
    expect(JSON.stringify(res.body)).not.toContain('v1:');
  });
});

// ── retorno (rota pública) ──────────────────────────────────────────────
describe('GET /mp/oauth/callback', () => {
  function app() {
    const a = express();
    a.use('/mp/oauth', require('../src/routes/mpOAuthCallback'));
    return a;
  }
  const destino = (res) => new URL(res.headers.location);

  test('sem env responde 503', async () => {
    desligarEnv();
    const res = await request(app()).get('/mp/oauth/callback?code=x&state=y');
    expect(res.status).toBe(503);
  });

  test('state inválido volta com erro e não chama o Mercado Pago', async () => {
    const res = await request(app()).get('/mp/oauth/callback?code=abc&state=forjado.assinatura');
    expect(res.status).toBe(302);
    expect(destino(res).searchParams.get('mp')).toBe('erro');
    expect(destino(res).searchParams.get('empresa')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('não autorizou: volta com negado e não grava nada', async () => {
    const state = mpOAuth.signState({ companyId: EMPRESA, userId: DONO });
    const res = await request(app()).get('/mp/oauth/callback').query({ error: 'access_denied', state });
    expect(res.status).toBe(302);
    const u = destino(res);
    expect(u.origin + u.pathname).toBe('https://app.exemplo.test/canal');
    expect(u.searchParams.get('tab')).toBe('site');
    expect(u.searchParams.get('mp')).toBe('negado');
    expect(u.searchParams.get('empresa')).toBe(EMPRESA);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('autorizou: troca o code, grava cifrado e volta conectado', async () => {
    const state = mpOAuth.signState({ companyId: EMPRESA, userId: DONO, returnPath: '/studio/vendas/loja-digital' });
    global.fetch
      .mockImplementationOnce((url, opts) => {
        expect(url).toBe('https://api.mercadopago.com/oauth/token');
        const body = JSON.parse(opts.body);
        expect(body).toMatchObject({
          client_id: '1234567890', client_secret: 'segredo-da-aplicacao-de-teste',
          grant_type: 'authorization_code', code: 'TG-codigo',
          redirect_uri: 'https://api.exemplo.test/api/v1/mp/oauth/callback',
        });
        expect(body.test_token).toBeUndefined();
        return resposta(200, {
          access_token: 'APP_USR-token-de-acesso', refresh_token: 'TG-refresh', public_key: 'APP_USR-publica',
          user_id: 987654, expires_in: 15552000, live_mode: true,
        });
      })
      .mockImplementationOnce((url, opts) => {
        expect(url).toBe('https://api.mercadopago.com/users/me');
        expect(opts.headers.authorization).toBe('Bearer APP_USR-token-de-acesso');
        return resposta(200, { id: 987654, nickname: 'LOJATESTE' });
      });
    let insert = null;
    db.query.mockImplementation((sql, params) => {
      if (/FROM companies c/.test(sql)) return Promise.resolve({ rows: [{ x: 1 }] });
      if (/INSERT INTO companies_payment_gateways/.test(sql)) { insert = params; return Promise.resolve({ rows: [{ id: 'g1' }] }); }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app()).get('/mp/oauth/callback').query({ code: 'TG-codigo', state });
    expect(res.status).toBe(302);
    const u = destino(res);
    expect(u.pathname).toBe('/studio/vendas/loja-digital');
    expect(u.searchParams.get('mp')).toBe('conectado');
    expect(u.searchParams.get('empresa')).toBe(EMPRESA);

    expect(insert).not.toBeNull();
    const [cid, accessEnc, publicKey, sandbox, refreshEnc, expiresAt, mpUserId, nickname, connectedBy] = insert;
    expect(cid).toBe(EMPRESA);
    expect(accessEnc).toMatch(/^v1:/);
    expect(refreshEnc).toMatch(/^v1:/);
    expect(secretCrypto.decryptString(accessEnc)).toBe('APP_USR-token-de-acesso');
    expect(secretCrypto.decryptString(refreshEnc)).toBe('TG-refresh');
    expect(JSON.stringify(insert)).not.toContain('APP_USR-token-de-acesso');
    expect(publicKey).toBe('APP_USR-publica');
    expect(sandbox).toBe(false);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 170 * 24 * 3600 * 1000);
    expect(mpUserId).toBe('987654');
    expect(nickname).toBe('LOJATESTE');
    expect(connectedBy).toBe(DONO);
    expect(res.headers.location).not.toContain('TG-');
  });

  test('users/me falhando não impede a conexão (nome fica vazio)', async () => {
    const state = mpOAuth.signState({ companyId: EMPRESA, userId: DONO });
    global.fetch
      .mockImplementationOnce(() => resposta(200, { access_token: 'A', refresh_token: 'R', public_key: 'P', user_id: 1 }))
      .mockImplementationOnce(() => resposta(500, {}));
    let insert = null;
    db.query.mockImplementation((sql, params) => {
      if (/FROM companies c/.test(sql)) return Promise.resolve({ rows: [{ x: 1 }] });
      if (/INSERT INTO/.test(sql)) { insert = params; return Promise.resolve({ rows: [{ id: 'g1' }] }); }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app()).get('/mp/oauth/callback').query({ code: 'c', state });
    expect(destino(res).searchParams.get('mp')).toBe('conectado');
    expect(insert[7]).toBeNull();
  });

  test('code recusado pelo Mercado Pago volta com erro, sem motivo técnico na URL', async () => {
    const state = mpOAuth.signState({ companyId: EMPRESA, userId: DONO });
    global.fetch.mockImplementationOnce(() => resposta(400, { error: 'invalid_grant', message: 'code expirado' }));
    db.query.mockImplementation((sql) => Promise.resolve({ rows: /FROM companies c/.test(sql) ? [{ x: 1 }] : [] }));
    const res = await request(app()).get('/mp/oauth/callback').query({ code: 'velho', state });
    expect(destino(res).searchParams.get('mp')).toBe('erro');
    expect(res.headers.location).not.toContain('invalid_grant');
    expect(db.query.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
  });

  test('quem começou deixou de ser dono: não grava', async () => {
    const state = mpOAuth.signState({ companyId: EMPRESA, userId: DONO });
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/mp/oauth/callback').query({ code: 'c', state });
    expect(destino(res).searchParams.get('mp')).toBe('erro');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ── token na hora do uso e renovação ────────────────────────────────────
describe('mpGateway.tokenDoGateway', () => {
  const enc = (v) => secretCrypto.encryptString(v);

  test('manual devolve o token como está, sem chamar ninguém', async () => {
    const t = await mpGateway.tokenDoGateway(db, { auth_method: 'manual', access_token: 'APP_USR-manual' });
    expect(t).toBe('APP_USR-manual');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('OAuth longe de vencer: decifra e não renova', async () => {
    const row = { id: 'g1', auth_method: 'oauth', connection_status: 'ok', access_token: enc('A1'), refresh_token: enc('R1'),
      token_expires_at: new Date(Date.now() + 100 * 24 * 3600 * 1000) };
    expect(await mpGateway.tokenDoGateway(db, row)).toBe('A1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('OAuth perto de vencer: renova e grava cifrado', async () => {
    const rt = enc('R1');
    const row = { id: 'g1', auth_method: 'oauth', connection_status: 'ok', access_token: enc('A1'), refresh_token: rt,
      token_expires_at: new Date(Date.now() + 3600 * 1000) };
    global.fetch.mockImplementationOnce((url, opts) => {
      expect(JSON.parse(opts.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'R1' });
      return resposta(200, { access_token: 'A2', refresh_token: 'R2', public_key: 'P2', user_id: 1, expires_in: 15552000 });
    });
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    expect(await mpGateway.tokenDoGateway(db, row)).toBe('A2');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/refresh_token IS NOT DISTINCT FROM \$6/);
    expect(secretCrypto.decryptString(params[1])).toBe('A2');
    expect(secretCrypto.decryptString(params[2])).toBe('R2');
    expect(params[5]).toBe(rt);
  });

  test('renovação recusada (invalid_grant): conexão cai e o token some', async () => {
    const rt = enc('R1');
    const row = { id: 'g1', auth_method: 'oauth', connection_status: 'ok', access_token: enc('A1'), refresh_token: rt,
      token_expires_at: new Date(Date.now() + 3600 * 1000) };
    global.fetch.mockImplementationOnce(() => resposta(400, { error: 'invalid_grant' }));
    db.query
      .mockResolvedValueOnce({ rows: [{ access_token: row.access_token, refresh_token: rt, token_expires_at: row.token_expires_at }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    expect(await mpGateway.tokenDoGateway(db, row)).toBeNull();
    expect(db.query.mock.calls[1][0]).toMatch(/connection_status = 'caiu'/);
  });

  test('conexão caída não cobra', async () => {
    expect(await mpGateway.tokenDoGateway(db, { auth_method: 'oauth', connection_status: 'caiu', access_token: enc('A') })).toBeNull();
  });

  test('temGatewayAtivo filtra conexão caída e cai no SELECT antigo sem a 419', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await mpGateway.temGatewayAtivo(db, EMPRESA)).toBe(false);
    expect(db.query.mock.calls[0][0]).toMatch(/connection_status = 'ok'/);

    mpGateway._resetCache();
    const e = new Error('column does not exist'); e.code = '42703';
    db.query.mockRejectedValueOnce(e).mockResolvedValueOnce({ rows: [{ id: 'g' }] });
    expect(await mpGateway.temGatewayAtivo(db, EMPRESA)).toBe(true);
  });
});

// ── checagem diária ─────────────────────────────────────────────────────
describe('mpConexaoDiariaJob.checarConexoes', () => {
  const job = () => require('../src/jobs/mpConexaoDiariaJob');
  const enc = (v) => secretCrypto.encryptString(v);

  test('dormente sem env', async () => {
    desligarEnv();
    expect(await job().checarConexoes({ db })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('autorização retirada (401 no users/me): marca caiu e avisa uma vez', async () => {
    const aviso = jest.fn();
    job().aoCair(aviso);
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'g1', company_id: EMPRESA, access_token: enc('A1'), refresh_token: enc('R1'),
        token_expires_at: new Date(Date.now() + 100 * 24 * 3600 * 1000), auth_method: 'oauth', connection_status: 'ok', mp_nickname: 'X' }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // marcarCaiu
    global.fetch.mockImplementationOnce(() => resposta(401, { message: 'invalid access token' }));
    const r = await job().checarConexoes({ db });
    expect(r).toMatchObject({ checadas: 1, caidas: 1, erros: 0 });
    expect(db.query.mock.calls[1][0]).toMatch(/connection_status = 'caiu'/);
    expect(aviso).toHaveBeenCalledWith({ gateway_id: 'g1', company_id: EMPRESA, motivo: 'autorizacao' });
  });

  test('5xx do Mercado Pago não derruba a conexão', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'g1', company_id: EMPRESA, access_token: enc('A1'), refresh_token: enc('R1'),
        token_expires_at: new Date(Date.now() + 100 * 24 * 3600 * 1000), auth_method: 'oauth', connection_status: 'ok', mp_nickname: 'X' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    global.fetch.mockImplementationOnce(() => resposta(503, {}));
    const r = await job().checarConexoes({ db });
    expect(r).toMatchObject({ checadas: 1, caidas: 0 });
    expect(db.query.mock.calls.some(([sql]) => /'caiu'/.test(sql))).toBe(false);
  });

  test('faltando menos de 30 dias: renova', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'g1', company_id: EMPRESA, access_token: enc('A1'), refresh_token: enc('R1'),
        token_expires_at: new Date(Date.now() + 10 * 24 * 3600 * 1000), auth_method: 'oauth', connection_status: 'ok', mp_nickname: 'X' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    global.fetch.mockImplementationOnce(() => resposta(200, { access_token: 'A2', refresh_token: 'R2', public_key: 'P', user_id: 1 }));
    const r = await job().checarConexoes({ db });
    expect(r).toMatchObject({ checadas: 1, renovadas: 1, caidas: 0 });
  });
});
