// ============================================================
// AURA — WhatsApp: Coexistence (migration 331)
//
// A Meta permite que o mesmo número fique ao mesmo tempo no app
// WhatsApp Business do celular E na Cloud API ("Onboard WhatsApp
// Business app users"). Duas regras cobertas aqui:
//
//  (1)/(2) connect: GET /{phone_number_id}?fields=is_on_biz_app decide
//      se o /register pode ser chamado. Chamar /register num número que
//      já está no app do celular QUEBRA o app — por isso, com
//      is_on_biz_app=true (ou mode='coexistence' explícito), o connect
//      PULA o /register e ainda assim marca registered=true (o número
//      já está registrado, só que por outro caminho).
//  (3)/(4) webhook smb_message_echoes: mensagem que a PRÓPRIA empresa
//      mandou pelo app do celular. Vira wa_messages outbound
//      (source: smb_app) e toca wa_contacts (garante que o contato
//      existe) SEM abrir a janela de 24h de atendimento — só o CLIENTE
//      mandando mensagem abre essa janela (touchInbound). Os dois lados
//      são testados: mensagem recebida abre a janela; o echo não.
// ============================================================
'use strict';

const crypto = require('crypto');

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.WA_APP_ID = '1496711532094674';
process.env.WA_ES_CONFIG_ID = 'CFG-ES-TESTE';
process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test-coexistence';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  exchangeCodeForToken: jest.fn(),
  getPhoneInfo: jest.fn(),
  getPhoneOnboarding: jest.fn(),
  listTemplates: jest.fn(),
  createTemplate: jest.fn(),
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
  listPhoneNumbers: jest.fn(),
  subscribeApp: jest.fn(),
  unsubscribeApp: jest.fn(),
  registerPhone: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const addons = require('../src/services/addons');

const COMPANY = 'company-uuid-wa-coexistence';
const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'essencial' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  Object.values(wa).forEach((f) => f.mockReset && f.mockReset());
  if (addons.clearCache) addons.clearCache();
});

// ── (1)/(2) POST /whatsapp/connect ──────────────────────────
describe('POST /whatsapp/connect — Coexistence', () => {
  function buildConnectApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id', require('../src/routes/whatsappCloud'));
    return app;
  }

  // Captura o que cada UPDATE gravou, por âncora de SQL — mesmo padrão
  // de __tests__/whatsapp.conexao.test.js.
  function mockConexao() {
    const gravado = { extras: null, coexistence: null };
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:conn-extras-set')) { gravado.extras = params; return Promise.resolve({ rows: [] }); }
      if (s.includes('-- wa:coexistence-set')) { gravado.coexistence = params; return Promise.resolve({ rows: [] }); }
      if (/wa_access_token\s*=\s*\$4/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM companies WHERE id/.test(s)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    return gravado;
  }

  it('(1) is_on_biz_app=true → NÃO chama /register; resposta tem coexistence=true', async () => {
    wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
    wa.subscribeApp.mockResolvedValue({ success: true });
    wa.getPhoneOnboarding.mockResolvedValue({
      is_on_biz_app: true, platform_type: 'CLOUD_API',
      display_phone_number: '+55 11 99999-0000', quality_rating: 'GREEN',
    });
    wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000', quality_rating: 'GREEN' });
    const gravado = mockConexao();

    const res = await request(buildConnectApp())
      .post(`/companies/${COMPANY}/whatsapp/connect`)
      .set('Authorization', 'Bearer ' + token)
      .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true, coexistence: true, is_on_biz_app: true, registered: true,
    });
    expect(wa.registerPhone).not.toHaveBeenCalled();
    // Gravou wa_coexistence=true (migration 331).
    expect(gravado.coexistence).toEqual([COMPANY, true]);
    // registered=true também carimba wa_registered_at (migration 328),
    // sem PIN nenhum (ninguém gerou PIN pra um número já registrado).
    expect(gravado.extras[3]).toBe(true); // registered
    expect(gravado.extras[1]).toBeNull(); // encryptedPin
  });

  it('(1b) mode="coexistence" força o mesmo caminho mesmo se a Graph não confirmar is_on_biz_app', async () => {
    wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
    wa.subscribeApp.mockResolvedValue({ success: true });
    wa.getPhoneOnboarding.mockResolvedValue({ is_on_biz_app: false, platform_type: null });
    wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
    mockConexao();

    const res = await request(buildConnectApp())
      .post(`/companies/${COMPANY}/whatsapp/connect`)
      .set('Authorization', 'Bearer ' + token)
      .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1', mode: 'coexistence' });

    expect(res.status).toBe(200);
    expect(res.body.coexistence).toBe(true);
    expect(res.body.is_on_biz_app).toBe(false); // valor cru da Graph, sem misturar com o mode
    expect(res.body.registered).toBe(true);
    expect(wa.registerPhone).not.toHaveBeenCalled();
  });

  it('(2) modo padrão com is_on_biz_app=false → continua chamando /register normalmente', async () => {
    wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
    wa.subscribeApp.mockResolvedValue({ success: true });
    wa.getPhoneOnboarding.mockResolvedValue({ is_on_biz_app: false, platform_type: null });
    wa.registerPhone.mockResolvedValue({ success: true });
    wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
    const gravado = mockConexao();

    const res = await request(buildConnectApp())
      .post(`/companies/${COMPANY}/whatsapp/connect`)
      .set('Authorization', 'Bearer ' + token)
      .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });

    expect(res.status).toBe(200);
    expect(res.body.coexistence).toBe(false);
    expect(res.body.is_on_biz_app).toBe(false);
    expect(res.body.registered).toBe(true);
    expect(wa.registerPhone).toHaveBeenCalledTimes(1);
    const [pnId, tk, pin] = wa.registerPhone.mock.calls[0];
    expect(pnId).toBe('PN1');
    expect(tk).toBe('TOKEN-NOVO');
    expect(String(pin)).toMatch(/^[0-9]{6}$/);
    expect(gravado.coexistence).toEqual([COMPANY, false]);
  });

  it('(2b) getPhoneOnboarding falha (rede) → segue como modo padrão, sem derrubar o connect', async () => {
    wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
    wa.subscribeApp.mockResolvedValue({ success: true });
    wa.getPhoneOnboarding.mockRejectedValue(new Error('timeout'));
    wa.registerPhone.mockResolvedValue({ success: true });
    wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
    mockConexao();

    const res = await request(buildConnectApp())
      .post(`/companies/${COMPANY}/whatsapp/connect`)
      .set('Authorization', 'Bearer ' + token)
      .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });

    expect(res.status).toBe(200);
    expect(res.body.coexistence).toBe(false);
    expect(wa.registerPhone).toHaveBeenCalledTimes(1);
  });
});

// ── (3)/(4) webhook: smb_message_echoes vs. mensagem recebida ──
describe('Webhook WhatsApp — Coexistence (smb_message_echoes)', () => {
  function buildWebhookApp() {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
    return app;
  }
  function sign(body) {
    return 'sha256=' + crypto.createHmac('sha256', 'secret-test-coexistence')
      .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
  }

  it('(3) echo grava wa_messages outbound (source=smb_app) e toca wa_contacts SEM abrir a janela', async () => {
    const wamWrites = [];
    const contactWrites = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/wa_phone_number_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (/INSERT INTO wa_messages/i.test(s)) { wamWrites.push({ sql: s, params }); return Promise.resolve({ rows: [] }); }
      if (s.includes('-- wa:contact-touch-outbound-human')) {
        contactWrites.push({ sql: s, params });
        return Promise.resolve({ rows: [{ id: 'contact-1' }] });
      }
      // Se o código chamasse touchInbound por engano, cairia aqui — não deve acontecer.
      if (s.includes('-- wa:contact-touch')) { contactWrites.push({ sql: s, params, viaTouchInbound: true }); return Promise.resolve({ rows: [{ id: 'contact-1' }] }); }
      return Promise.resolve({ rows: [] });
    });

    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'smb_message_echoes', value: {
        metadata: { phone_number_id: 'PN1' },
        message_echoes: [{
          id: 'wamid.ECHO1', from: '5511999998888', to: '5511988887777',
          timestamp: '1780000000', text: { body: 'Chegou sua encomenda!' },
        }],
      } }] }],
    };

    const res = await request(buildWebhookApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30)); // processamento pós-200

    // wa_messages: outbound, sent, metadata.source === 'smb_app'.
    expect(wamWrites).toHaveLength(1);
    expect(wamWrites[0].sql).toMatch(/direction/);
    const [companyId, wamid, toPhone, content, metadataJson] = wamWrites[0].params;
    expect(companyId).toBe(COMPANY);
    expect(wamid).toBe('wamid.ECHO1');
    expect(toPhone).toBe('5511988887777');
    expect(content).toBe('Chegou sua encomenda!');
    expect(JSON.parse(metadataJson)).toEqual({ source: 'smb_app' });
    expect(wamWrites[0].sql).toMatch(/'outbound'/);
    expect(wamWrites[0].sql).toMatch(/'sent'/);

    // wa_contacts: tocado pela função de echo (touchOutboundHuman), nunca por touchInbound.
    expect(contactWrites).toHaveLength(1);
    expect(contactWrites[0].viaTouchInbound).toBeUndefined();
    expect(contactWrites[0].params).toEqual([COMPANY, '5511988887777']);
    // A SQL do echo não referencia nenhum campo de janela/opt — é isso que
    // garante que a janela de 24h e o opt-in/opt-out não foram tocados.
    expect(contactWrites[0].sql).not.toMatch(/last_inbound_at/);
    expect(contactWrites[0].sql).not.toMatch(/opted_in_at/);
    expect(contactWrites[0].sql).not.toMatch(/opted_out_at/);
  });

  it('(4) mensagem RECEBIDA (cliente → loja) abre a janela de 24h; o echo NÃO abre', async () => {
    const touchInboundWrites = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/wa_phone_number_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (/INSERT INTO wa_messages/i.test(s)) return Promise.resolve({ rows: [] });
      if (s.includes('-- wa:contact-touch') && !s.includes('outbound-human')) {
        touchInboundWrites.push({ sql: s, params });
        return Promise.resolve({ rows: [{ id: 'contact-1', opted_out_at: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PN1' },
        messages: [{ id: 'wamid.IN1', from: '5511988887777', type: 'text', text: { body: 'Oi, quero comprar' } }],
      } }] }],
    };

    const res = await request(buildWebhookApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    // touchInbound É a função que abre a janela: sua SQL grava last_inbound_at=NOW().
    expect(touchInboundWrites).toHaveLength(1);
    expect(touchInboundWrites[0].sql).toMatch(/last_inbound_at/);
  });

  it('(4b) history e smb_app_state_sync só logam a contagem, sem gravar nada', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/wa_phone_number_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      return Promise.resolve({ rows: [] });
    });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const body = {
        object: 'whatsapp_business_account',
        entry: [{ id: 'WABA1', changes: [
          { field: 'history', value: { metadata: { phone_number_id: 'PN1' }, history: [{ a: 1 }, { a: 2 }] } },
          { field: 'smb_app_state_sync', value: { metadata: { phone_number_id: 'PN1' }, state_sync: [{ a: 1 }] } },
        ] }],
      };
      const res = await request(buildWebhookApp()).post('/webhooks/whatsapp')
        .set('x-hub-signature-256', sign(body)).send(body);
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(spy.mock.calls.some((c) => String(c[0]).includes('history sync: 2 itens'))).toBe(true);
      expect(spy.mock.calls.some((c) => String(c[0]).includes('smb_app_state_sync: 1 itens'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
