// ============================================================
// AURA — WhatsApp: a CADEIA DE MOUNTS não pode barrar o essencial
//
// Achado no QA de 27/08 (dojô Areikan, plano essencial, véspera da
// liberação para o primeiro sensei real): a aba WhatsApp mostrava
// "Plano atual não inclui esta funcionalidade". O whatsappCloud não
// tem gate de plano — mas private.js montava o router legado como
//   router.use('/whatsapp', requirePlan('negocio','expansao'), ...)
// e, no Express, o middleware de um use() roda por PREFIXO: o 403
// nascia ali e o request nunca chegava ao whatsappCloud montado
// depois. O teste de consolidação não viu porque testava o router
// ISOLADO. Este aqui monta a cadeia na MESMA ordem do index.js
// (private primeiro, whatsappCloud depois — index.js:35 e :39).
//
// Cobertura:
//  (1) essencial: GET /whatsapp/status atravessa a cadeia → 200.
//  (2) essencial: rotas legadas (/send, /messages) SEGUEM gateadas
//      → 403 com o shape do requirePlan.
//  (3) negocio: /send passa do gate (o gate mudou de lugar, não sumiu).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  exchangeCodeForToken: jest.fn(), getPhoneInfo: jest.fn(),
  listTemplates: jest.fn(), createTemplate: jest.fn(),
  sendTemplate: jest.fn(), sendText: jest.fn(), sendMedia: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const COMPANY = 'company-uuid-mount';

const tokenFor = (plan) => jwt.sign(
  { id: 'user-dono', role: 'admin', plan },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

// A MESMA ordem do index.js: private (35) antes do whatsappCloud (39).
// Se alguém devolver um gate de prefixo ao mount do legado, o caso (1)
// quebra aqui antes de quebrar na tela do sensei.
function buildChain() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/private'));
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

beforeEach(() => {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/SELECT wa_token_invalid_at/.test(s)) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (/FROM companies WHERE id/.test(s)) {
      return Promise.resolve({ rows: [{
        wa_waba_id: null, wa_phone_number_id: null, wa_phone_display: null,
        wa_connected_at: null, has_token: false,
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
});

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
});

it('(1) essencial atravessa a cadeia: GET /whatsapp/status → 200, nunca 403 de plano', async () => {
  const res = await request(buildChain())
    .get(`/companies/${COMPANY}/whatsapp/status`)
    .set('Authorization', 'Bearer ' + tokenFor('essencial'));
  expect(res.status).toBe(200);
  expect(res.body.connected).toBe(false); // dojô ainda não conectou — mas VIU a tela
});

it('(2) essencial segue barrado nas rotas legadas (/send, /messages)', async () => {
  const app = buildChain();
  const send = await request(app)
    .post(`/companies/${COMPANY}/whatsapp/send`)
    .set('Authorization', 'Bearer ' + tokenFor('essencial'))
    .send({ to: '5511999990000' });
  expect(send.status).toBe(403);
  expect(send.body.error).toBe('Plano atual não inclui esta funcionalidade');

  const msgs = await request(app)
    .get(`/companies/${COMPANY}/whatsapp/messages`)
    .set('Authorization', 'Bearer ' + tokenFor('essencial'));
  expect(msgs.status).toBe(403);
});

it('(3) negocio passa do gate legado — o gate mudou de lugar, não sumiu', async () => {
  const res = await request(buildChain())
    .post(`/companies/${COMPANY}/whatsapp/send`)
    .set('Authorization', 'Bearer ' + tokenFor('negocio'))
    .send({ to: '5511999990000' });
  // Sem credenciais mockadas o envio falha DEPOIS do gate — o que importa
  // é que não foi o 403 de plano.
  expect(res.status).not.toBe(403);
});
