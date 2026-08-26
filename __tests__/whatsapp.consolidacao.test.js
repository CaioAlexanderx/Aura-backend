// ============================================================
// AURA — WhatsApp: CONSOLIDAÇÃO dos dois routers (25/08/2026)
//
// O legado (whatsappRoutes) sombreava GET status/templates do router
// novo e devolvia OUTRO shape — o card de Templates do app ficava vazio.
// Estes testes travam o contrato consolidado:
//  (1) whatsappCloud é a fonte única: connect/disconnect/status/
//      templates(+sync/create)/outbox/test-send/contacts-opt.
//  (2) o legado ficou SÓ com /send e /messages (sem sombrear nada).
//  (3) status carrega os campos do shape legado (connected_at) + fila.
//  (4) templates devolve `data` (app) E `templates`/`total` (legado).
//  (5) connect grava o token CIFRADO (nunca em texto puro).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  exchangeCodeForToken: jest.fn(),
  getPhoneInfo: jest.fn(),
  listTemplates: jest.fn(),
  createTemplate: jest.fn(),
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
  sendMedia: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');

const COMPANY = 'company-uuid-wa-cons';
const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'essencial' }, // plano BAIXO de propósito
  'aura-test-secret-2026', { expiresIn: '1h' }
);

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

describe('consolidação dos routers de WhatsApp', () => {
  it('(1)(2) o legado ficou só com /send e /messages; o resto vive no whatsappCloud', () => {
    const legado = require('fs').readFileSync(require.resolve('../src/routes/whatsappRoutes.js'), 'utf8');
    // Nenhuma rota que colidia pode ter sobrado no legado.
    for (const path of ["'/connect'", "'/disconnect'", "'/status'", "'/templates'"]) {
      expect(legado.includes(`router.post(${path}`)).toBe(false);
      expect(legado.includes(`router.get(${path}`)).toBe(false);
    }
    expect(legado).toContain("router.post('/send'");
    expect(legado).toContain("router.get('/messages'");

    const cloud = require('fs').readFileSync(require.resolve('../src/routes/whatsappCloud.js'), 'utf8');
    for (const r of ['/whatsapp/connect', '/whatsapp/disconnect', '/whatsapp/status',
                     '/whatsapp/templates', '/whatsapp/outbox', '/whatsapp/test-send',
                     '/whatsapp/contacts/opt']) {
      expect(cloud).toContain(r);
    }
    // Sem gate de plano: 104 dos 106 dojôs são 'essencial' e são o público
    // do addon de lembretes — o gate certo é o addon, não o plano.
    // Ignora comentários: a decisão está explicada em prosa no topo do
    // arquivo, mas NÃO pode existir chamada real de requirePlan.
    const semComentarios = cloud.replace(/^[ 	]*\/\/.*$/gm, '');
    expect(semComentarios).not.toMatch(/requirePlan\s*\(/);
  });

  it('(3) status devolve o shape legado (connected_at) + contadores da fila', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM companies WHERE id/.test(s)) {
        return Promise.resolve({ rows: [{
          wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', wa_phone_display: '+1 555',
          wa_connected_at: '2026-08-25T04:07:12.000Z', has_token: true,
        }] });
      }
      if (/FROM wa_outbox WHERE company_id/.test(s)) {
        return Promise.resolve({ rows: [{ status: 'sent', n: 3 }, { status: 'failed', n: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/whatsapp/status`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true, phone_display: '+1 555', waba_id: 'WABA1',
      connected_at: '2026-08-25T04:07:12.000Z',
      queue: { sent: 3, failed: 1 },
    });
  });

  it('(4) templates serve o app (data) e o contrato legado (templates/total)', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [
      { name: 'mensalidade_lembrete', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED', body_preview: 'Olá', last_status_at: null },
    ] }));
    const res = await request(buildApp())
      .get(`/companies/${COMPANY}/whatsapp/templates`)
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(1);
    expect(res.body.templates).toEqual(res.body.data);
  });

  it('(5) connect grava o token CIFRADO (v1:), nunca em texto puro', async () => {
    let gravado = null;
    wa.exchangeCodeForToken.mockResolvedValue('TOKEN-PERMANENTE-DA-META');
    wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
    db.query.mockImplementation((sql, params) => {
      // Só o UPDATE que grava a credencial — o connect também roda um
      // segundo UPDATE (limpar a marca de token recusado, 309).
      if (/wa_access_token\s*=/i.test(String(sql))) { gravado = params[3]; }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(buildApp())
      .post(`/companies/${COMPANY}/whatsapp/connect`)
      .set('Authorization', 'Bearer ' + token)
      .send({ code: 'CODE123', waba_id: 'WABA1', phone_number_id: 'PN1' });
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(gravado).toMatch(/^v1:/);
    expect(gravado).not.toContain('TOKEN-PERMANENTE-DA-META');
  });
});
