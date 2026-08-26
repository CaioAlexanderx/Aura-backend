// ============================================================
// AURA — WhatsApp: quando a META RECUSA o token (migration 309)
//
// Achado no QA de 26/08 (dojô Kondei): o card mostrava "Conectado" com
// selo verde e o token estava morto havia dois dias. Ao clicar em
// sincronizar, o dono do dojô lia o erro cru da Meta em inglês.
//
// Cobertura:
//  (1) isTokenError reconhece o que a Meta manda (código 190, "session
//      has expired") e NÃO confunde com falha de rede.
//  (2) sync com token recusado → 409 TOKEN_EXPIRADO, mensagem em
//      português, texto da Meta em `detail` (não na mensagem).
//  (3) status para de dizer "conectado" depois da recusa.
//  (4) a FILA também carimba: quem descobre a recusa quase sempre é o
//      dispatcher, não a tela.
//  (5) reconectar limpa a marca.
//  (6) 309 pendente (42703) → nada quebra.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  exchangeCodeForToken: jest.fn(), getPhoneInfo: jest.fn(),
  listTemplates: jest.fn(), createTemplate: jest.fn(),
  sendTemplate: jest.fn(), sendText: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const outbox = require('../src/services/waOutbox');

const COMPANY = 'company-uuid-tok';
const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'essencial' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

const META_EXPIRED = 'Error validating access token: Session has expired on Monday, 24-Aug-26 23:00:00 PDT.';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  Object.values(wa).forEach((f) => f.mockReset && f.mockReset());
});

it('(1) reconhece a recusa da Meta e não confunde com falha de rede', () => {
  expect(outbox.isTokenError(new Error(META_EXPIRED))).toBe(true);
  expect(outbox.isTokenError(new Error('Meta 400: (#190) OAuthException'))).toBe(true);
  expect(outbox.isTokenError(new Error('code: 190'))).toBe(true);
  // Falhas que NÃO são de credencial seguem como estão (retry, 502…).
  expect(outbox.isTokenError(new Error('socket hang up'))).toBe(false);
  expect(outbox.isTokenError(new Error('rate limit exceeded'))).toBe(false);
  expect(outbox.isTokenError(null)).toBe(false);
});

it('(2)(3) sync recusado → 409 em português; depois o status deixa de dizer conectado', async () => {
  let carimbado = false;
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/wa_token_invalid_at = NOW\(\)/.test(s)) { carimbado = true; return Promise.resolve({ rows: [] }); }
    if (/SELECT wa_token_invalid_at/.test(s)) {
      return Promise.resolve({ rows: [{ wa_token_invalid_at: carimbado ? '2026-08-26T18:00:00Z' : null }] });
    }
    if (/FROM companies WHERE id/.test(s)) {
      return Promise.resolve({ rows: [{
        wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', wa_phone_display: '+1 555',
        wa_connected_at: '2026-08-25T04:00:00Z', has_token: true, wa_access_token: 'TK',
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
  wa.listTemplates.mockRejectedValue(new Error(META_EXPIRED));

  const app = buildApp();
  const antes = await request(app).get(`/companies/${COMPANY}/whatsapp/status`).set('Authorization', 'Bearer ' + token);
  expect(antes.body.connected).toBe(true);

  const sync = await request(app).post(`/companies/${COMPANY}/whatsapp/templates/sync`).set('Authorization', 'Bearer ' + token);
  expect(sync.status).toBe(409);
  expect(sync.body.code).toBe('TOKEN_EXPIRADO');
  expect(sync.body.error).toMatch(/Reconecte o número do dojô/);
  expect(sync.body.error).not.toMatch(/access token/i); // inglês da Meta não vai para o dono do dojô
  expect(sync.body.detail).toContain('Session has expired'); // mas fica disponível p/ suporte
  expect(carimbado).toBe(true);

  const depois = await request(app).get(`/companies/${COMPANY}/whatsapp/status`).set('Authorization', 'Bearer ' + token);
  expect(depois.body.connected).toBe(false);
  expect(depois.body.token_expired).toBe(true);
});

it('(4) a fila carimba a recusa — o dispatcher descobre antes da tela', async () => {
  let carimbado = false;
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (s.includes('-- wa:outbox-pick')) {
      return Promise.resolve({ rows: [{
        id: 'ob-1', company_id: COMPANY, to_phone: '5511988887777', kind: 'template',
        template_name: 'mensalidade_lembrete', template_language: 'pt_BR',
        components: null, text_body: null, attempts: 0,
      }] });
    }
    if (s.includes('-- wa:creds')) return Promise.resolve({ rows: [{ wa_phone_number_id: 'PN1', wa_access_token: 'TK' }] });
    if (/wa_token_invalid_at = NOW\(\)/.test(s)) { carimbado = true; return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  wa.sendTemplate.mockRejectedValue(new Error(META_EXPIRED));

  const r = await outbox.processBatch(5);
  expect(r.retried).toBe(1);   // segue tentando; reconectar resolve
  expect(carimbado).toBe(true);
});

it('(5) reconectar limpa a marca', async () => {
  let limpo = false;
  wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
  wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
  db.query.mockImplementation((sql) => {
    if (/wa_token_invalid_at = NULL/.test(String(sql))) { limpo = true; }
    return Promise.resolve({ rows: [] });
  });
  const res = await request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/connect`)
    .set('Authorization', 'Bearer ' + token)
    .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });
  expect(res.status).toBe(200);
  expect(limpo).toBe(true);
});

it('(6) migração 309 pendente (42703): carimbar não vira um segundo problema', async () => {
  db.query.mockImplementation((sql) => {
    if (/wa_token_invalid_at/.test(String(sql))) {
      const e = new Error('column does not exist'); e.code = '42703';
      return Promise.reject(e);
    }
    return Promise.resolve({ rows: [] });
  });
  await expect(outbox.markTokenInvalid(COMPANY, 'x')).resolves.toBeUndefined();
  await expect(outbox.clearTokenInvalid(COMPANY)).resolves.toBeUndefined();
});
