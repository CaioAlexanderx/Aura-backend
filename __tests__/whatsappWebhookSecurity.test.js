// ============================================================
// AURA — Onda 5a: segurança do webhook do WhatsApp (A7/A8)
//  - POST exige assinatura X-Hub-Signature-256 válida (HMAC do App Secret).
//  - /ping não vaza o valor do verify token.
// ============================================================
'use strict';

const crypto = require('crypto');

// PRECISA vir antes de require('../src/index'): o webhook lê WA_APP_SECRET no
// carregamento do módulo.
const APP_SECRET = 'test_app_secret_123';
process.env.WA_APP_SECRET = APP_SECRET;
process.env.WA_VERIFY_TOKEN = 'test_verify_token';

const request = require('supertest');

let app, db;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
});
afterEach(() => { if (db.query.mockReset) db.query.mockReset(); });

const BASE = '/api/v1/webhooks/whatsapp';
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

describe('Webhook WhatsApp — segurança (Onda 5a)', () => {
  test('POST sem assinatura → 401 (não processa)', async () => {
    const res = await request(app).post(BASE).set('Content-Type', 'application/json').send(BODY);
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST com assinatura INVÁLIDA → 401', async () => {
    const res = await request(app).post(BASE)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send(BODY);
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST com assinatura VÁLIDA → 200', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post(BASE)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(BODY))
      .send(BODY);
    expect(res.status).toBe(200);
  });

  test('/ping NÃO vaza o valor do verify token', async () => {
    const res = await request(app).get(`${BASE}/ping`);
    expect(res.status).toBe(200);
    expect(res.body.verify_token_set).toBe(true);
    expect(res.body).not.toHaveProperty('verify_token_value');
  });
});
