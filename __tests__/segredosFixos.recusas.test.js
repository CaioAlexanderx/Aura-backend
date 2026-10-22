// ============================================================
// INC-2026-10-21-03 (tq-101): sem segredo fixo, cada porta recusa.
//
//  1. GET /api/v1/reports/admin/test-weekly — só JWT de conta is_staff.
//     Token compartilhado (query ?token= ou header x-admin-token) não abre
//     mais nada, qualquer que seja o valor — inclusive o literal antigo, que
//     de propósito NÃO é reproduzido aqui (repositório público).
//  2. NFS-e — em produção sem AURA_ENCRYPTION_KEY, cifrar/decifrar recusa
//     com 500 controlado + console.error; nunca cai numa chave fixa.
//  3. Webhooks Meta — Instagram sem IG_VERIFY_TOKEN: GET 403; sem
//     IG_APP_SECRET: POST 401. WhatsApp sem WA_APP_SECRET: POST 401.
// ============================================================
'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

// tests/jest.setup.js fixa JWT_SECRET antes de qualquer require.
const assinar = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
const ENV_ORIGINAL = { ...process.env };

function restaurarEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_ORIGINAL)) delete process.env[k];
  }
  Object.assign(process.env, ENV_ORIGINAL);
}

let errSpy;
beforeEach(() => {
  db.query.mockReset();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  restaurarEnv();
  jest.restoreAllMocks();
});

const logouErro = (trecho) =>
  errSpy.mock.calls.some((args) => args.map(String).join(' ').includes(trecho));

// ─── 1. test-weekly ─────────────────────────────────────────
describe('GET /api/v1/reports/admin/test-weekly — só equipe Aura com JWT', () => {
  const URL = '/api/v1/reports/admin/test-weekly';
  let app;
  beforeAll(() => { app = require('../src/app'); });

  test('sem JWT → 401 e não consulta empresas', async () => {
    const res = await request(app).get(URL).query({ q: 'finesse' });
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('JWT válido de usuário NÃO staff → 403', async () => {
    const token = assinar({ id: 'u-cliente', role: 'client', is_staff: false });
    const res = await request(app).get(URL).query({ q: 'finesse' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('JWT sem a claim is_staff (admin de role) → 403', async () => {
    const token = assinar({ id: 'u-admin', role: 'admin' });
    const res = await request(app).get(URL).query({ q: 'finesse' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('token compartilhado no header x-admin-token ou em ?token= → 401, mesmo igual à env antiga', async () => {
    // Se a env antiga ainda existir na Railway, o valor dela também não abre.
    const compartilhado = crypto.randomBytes(12).toString('hex');
    process.env.ADMIN_REPORTS_TEST_TOKEN = compartilhado;

    const porHeader = await request(app).get(URL).query({ q: 'finesse' })
      .set('x-admin-token', compartilhado);
    expect(porHeader.status).toBe(401);

    const porQuery = await request(app).get(URL).query({ q: 'finesse', token: compartilhado });
    expect(porQuery.status).toBe(401);

    // Token compartilhado no lugar do Bearer também não passa por JWT.
    const comoBearer = await request(app).get(URL).query({ q: 'finesse' })
      .set('Authorization', `Bearer ${compartilhado}`);
    expect(comoBearer.status).toBe(401);

    expect(db.query).not.toHaveBeenCalled();
  });

  test('o código não tem mais caminho de token fixo nem env de token', () => {
    const fonte = require('fs').readFileSync(require.resolve('../src/routes/publicReports'), 'utf8');
    expect(fonte).not.toMatch(/ADMIN_REPORTS_TEST_TOKEN/);
    expect(fonte).not.toMatch(/x-admin-token/);
    expect(fonte).not.toMatch(/req\.query\.token/);
  });

  test('JWT de staff passa do portão (chega na busca)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // nenhuma empresa casa
    const token = assinar({ id: 'u-staff', role: 'admin', is_staff: true });
    const res = await request(app).get(URL).query({ q: 'zzqa-inexistente' })
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. NFS-e ───────────────────────────────────────────────
describe('NFS-e — chave de criptografia obrigatória em produção', () => {
  const nfse = require('../src/routes/nfse');
  const { encrypt, decrypt, NfseEncryptionKeyError } = nfse._crypto;
  const CHAVE_DE_TESTE = () => crypto.randomBytes(32).toString('hex');

  function nfseApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/nfse', nfse);
    return app;
  }
  const authCliente = () => ({ Authorization: `Bearer ${assinar({ id: 'u1', role: 'client' })}` });

  test('produção sem AURA_ENCRYPTION_KEY: cifrar e decifrar recusam (nunca chave fixa)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AURA_ENCRYPTION_KEY;
    expect(() => encrypt('api-key-do-provedor')).toThrow(NfseEncryptionKeyError);
    expect(() => decrypt('qualquer-coisa-cifrada')).toThrow(NfseEncryptionKeyError);
  });

  test('desenvolvimento sem a env também recusa (chave só existe em NODE_ENV=test)', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AURA_ENCRYPTION_KEY;
    expect(() => encrypt('x')).toThrow(NfseEncryptionKeyError);
  });

  test('chave mal formada recusa sem ecoar o valor', () => {
    process.env.NODE_ENV = 'production';
    process.env.AURA_ENCRYPTION_KEY = 'nao-e-hex-de-64';
    let erro;
    try { encrypt('x'); } catch (e) { erro = e; }
    expect(erro).toBeInstanceOf(NfseEncryptionKeyError);
    expect(erro.message).not.toContain('nao-e-hex-de-64');
  });

  test('produção com chave válida: ida e volta funcionam', () => {
    process.env.NODE_ENV = 'production';
    process.env.AURA_ENCRYPTION_KEY = CHAVE_DE_TESTE();
    expect(decrypt(encrypt('segredo-do-provedor'))).toBe('segredo-do-provedor');
  });

  test('NODE_ENV=test sem a env: chave aleatória do processo (ida e volta)', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AURA_ENCRYPTION_KEY;
    expect(decrypt(encrypt('abc'))).toBe('abc');
  });

  test('PUT /config em produção sem chave → 500 controlado + log de erro, nada gravado', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AURA_ENCRYPTION_KEY;
    const res = await request(nfseApp())
      .put('/companies/c1/nfse/config')
      .set(authCliente())
      .send({ provider: 'focus', api_key: 'chave-do-provedor' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('NFSE_ENCRYPTION_KEY_MISSING');
    expect(db.query).not.toHaveBeenCalled();
    expect(logouErro('AURA_ENCRYPTION_KEY')).toBe(true);
  });

  test('POST / (emitir) em produção sem chave → 500 controlado, não vira "api key não configurada"', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AURA_ENCRYPTION_KEY;
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.connect.mockReturnValueOnce(client);
    db.query.mockResolvedValueOnce({
      rows: [{ company_id: 'c1', is_active: true, provider: 'focus', api_key_encrypted: 'cifrado-antigo' }],
    });
    const res = await request(nfseApp())
      .post('/companies/c1/nfse')
      .set(authCliente())
      .send({ service_description: 'Consulta', service_amount: 100, recipient_name: 'Fulano', recipient_doc: '00000000000' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('NFSE_ENCRYPTION_KEY_MISSING');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(logouErro('AURA_ENCRYPTION_KEY')).toBe(true);
  });
});

// ─── 3. Webhooks Meta ───────────────────────────────────────
describe('Webhooks Meta — sem segredo, recusa', () => {
  function webhookApp(rota, modulo) {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use(rota, require(modulo));
    return app;
  }
  const ig = () => webhookApp('/webhooks/instagram', '../src/routes/webhookInstagram');
  const wa = () => webhookApp('/webhooks/whatsapp', '../src/routes/webhookWhatsapp');
  const assinarCorpo = (segredo, corpo) =>
    'sha256=' + crypto.createHmac('sha256', segredo).update(Buffer.from(corpo, 'utf8')).digest('hex');
  const IG_BODY = JSON.stringify({ object: 'instagram', entry: [] });
  const WA_BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  test('Instagram GET de verificação sem IG_VERIFY_TOKEN → 403 (sem fallback)', async () => {
    delete process.env.IG_VERIFY_TOKEN;
    const res = await request(ig()).get('/webhooks/instagram').query({
      'hub.mode': 'subscribe', 'hub.verify_token': 'qualquer', 'hub.challenge': '123',
    });
    expect(res.status).toBe(403);
    expect(logouErro('IG_VERIFY_TOKEN')).toBe(true);
  });

  test('Instagram GET com IG_VERIFY_TOKEN certo → devolve o challenge', async () => {
    process.env.IG_VERIFY_TOKEN = 'verify-de-teste';
    const res = await request(ig()).get('/webhooks/instagram').query({
      'hub.mode': 'subscribe', 'hub.verify_token': 'verify-de-teste', 'hub.challenge': '123',
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe('123');
  });

  test('Instagram POST sem IG_APP_SECRET → 401, loga o motivo, não processa', async () => {
    delete process.env.IG_APP_SECRET;
    const res = await request(ig()).post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + 'a'.repeat(64))
      .send(IG_BODY);
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(logouErro('IG_APP_SECRET')).toBe(true);
  });

  test('Instagram POST com IG_APP_SECRET e assinatura válida → 200', async () => {
    process.env.IG_APP_SECRET = 'segredo-ig-de-teste';
    const res = await request(ig()).post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', assinarCorpo('segredo-ig-de-teste', IG_BODY))
      .send(IG_BODY);
    expect(res.status).toBe(200);
  });

  test('WhatsApp POST sem WA_APP_SECRET → 401, loga o motivo, não processa', async () => {
    delete process.env.WA_APP_SECRET;
    const res = await request(wa()).post('/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .send(WA_BODY);
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(logouErro('WA_APP_SECRET')).toBe(true);
  });

  test('WhatsApp GET de verificação sem WA_VERIFY_TOKEN → 403', async () => {
    delete process.env.WA_VERIFY_TOKEN;
    const res = await request(wa()).get('/webhooks/whatsapp').query({
      'hub.mode': 'subscribe', 'hub.verify_token': 'qualquer', 'hub.challenge': '1',
    });
    expect(res.status).toBe(403);
  });
});
