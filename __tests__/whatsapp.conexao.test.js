// ============================================================
// AURA — WhatsApp: a CONEXÃO COMPLETA do número (migration 328)
//
// Trocar o code do Embedded Signup por um token deixava o dojô com um
// selo verde que não envia nem recebe nada: faltavam os dois passos
// invisíveis da Cloud API —
//   POST /{waba}/subscribed_apps  → sem isto o webhook nunca recebe
//        evento deste número (entrega, aprovação de template, qualidade);
//   POST /{phone_number_id}/register → sem isto o primeiro envio morre
//        com 133010 ("phone number not registered").
//
// Cobertura:
//  (1) connect assina o webhook, registra o número e devolve
//      subscribed/registered; o PIN vai CIFRADO para o banco.
//  (2) falha do register vira WARNING — a conexão ainda acontece.
//  (3) número já registrado ("already"/133005) conta como sucesso.
//  (4) sem phone_number_id, busca o primeiro número da WABA.
//  (5) disconnect solta a assinatura ANTES de esquecer a credencial.
//  (6) erro da Graph carrega err.meta.code (é por código que a Fase 2
//      decide o que é permanente — nunca por regex na frase em inglês).
//  (7) status devolve addon/template/uso/embedded_signup e sobrevive à
//      tabela ausente (42P01).
//  (8) colunas da 328 ausentes (42703) não derrubam o status.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
process.env.WA_APP_ID = '1496711532094674';
process.env.WA_ES_CONFIG_ID = 'CFG-ES-TESTE';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  exchangeCodeForToken: jest.fn(), getPhoneInfo: jest.fn(),
  listTemplates: jest.fn(), createTemplate: jest.fn(),
  sendTemplate: jest.fn(), sendText: jest.fn(),
  listPhoneNumbers: jest.fn(), subscribeApp: jest.fn(),
  unsubscribeApp: jest.fn(), registerPhone: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const addons = require('../src/services/addons');

const COMPANY = 'company-uuid-wa-conexao';
const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'essencial' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

// Captura o que cada UPDATE gravou, por âncora de SQL.
function mockConexao({ connRow = null } = {}) {
  const gravado = { credencial: null, extras: null, limpouToken: false, limpouExtras: false };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('-- wa:conn-extras-set')) { gravado.extras = params; return Promise.resolve({ rows: [] }); }
    if (s.includes('-- wa:conn-extras-clear')) { gravado.limpouExtras = true; return Promise.resolve({ rows: [] }); }
    if (s.includes('-- wa:conn-extras-get')) return Promise.resolve({ rows: [] });
    if (/wa_token_invalid_at = NULL/.test(s)) { gravado.limpouToken = true; return Promise.resolve({ rows: [] }); }
    if (/wa_access_token\s*=\s*\$4/.test(s)) { gravado.credencial = params; return Promise.resolve({ rows: [] }); }
    if (/SELECT wa_access_token FROM companies/.test(s)) {
      return Promise.resolve({ rows: [{ wa_access_token: 'TOKEN-GRAVADO' }] });
    }
    if (/FROM companies WHERE id/.test(s)) return Promise.resolve({ rows: connRow ? [connRow] : [] });
    return Promise.resolve({ rows: [] });
  });
  return gravado;
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  Object.values(wa).forEach((f) => f.mockReset && f.mockReset());
  addons.clearCache();
});

it('(1) connect assina o webhook, registra o número e cifra o PIN', async () => {
  wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
  wa.subscribeApp.mockResolvedValue({ success: true });
  wa.registerPhone.mockResolvedValue({ success: true });
  wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000', quality_rating: 'GREEN' });
  const gravado = mockConexao();

  const res = await request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/connect`)
    .set('Authorization', 'Bearer ' + token)
    .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    connected: true, subscribed: true, registered: true,
    waba_id: 'WABA1', phone_number_id: 'PN1', phone_display: '+55 11 99999-0000',
  });
  expect(res.body.warnings).toEqual([]);

  expect(wa.subscribeApp).toHaveBeenCalledWith('WABA1', 'TOKEN-NOVO');
  const [pnId, tk, pin] = wa.registerPhone.mock.calls[0];
  expect(pnId).toBe('PN1');
  expect(tk).toBe('TOKEN-NOVO');
  expect(String(pin)).toMatch(/^[0-9]{6}$/); // PIN de 6 dígitos

  // PIN em repouso é cifrado (v1:) — nunca os 6 dígitos em texto puro.
  expect(gravado.extras).toBeTruthy();
  expect(String(gravado.extras[1])).toMatch(/^v1:/);
  expect(String(gravado.extras[1])).not.toContain(String(pin));
  expect(gravado.extras[2]).toBe(true);  // subscribed
  expect(gravado.extras[3]).toBe(true);  // registered
  expect(gravado.extras[4]).toBe('GREEN');
});

it('(2) register recusado vira warning — o dojô continua conectado', async () => {
  wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
  wa.subscribeApp.mockResolvedValue({ success: true });
  const erro = new Error('Invalid parameter');
  erro.meta = { code: 100, type: 'OAuthException' };
  wa.registerPhone.mockRejectedValue(erro);
  wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
  const gravado = mockConexao();

  const res = await request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/connect`)
    .set('Authorization', 'Bearer ' + token)
    .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });

  expect(res.status).toBe(200);
  expect(res.body.connected).toBe(true);
  expect(res.body.subscribed).toBe(true);
  expect(res.body.registered).toBe(false);
  expect(res.body.warnings.join(' ')).toMatch(/registrar o número/i);
  // A credencial foi gravada assim mesmo (token válido serve para
  // sincronizar templates enquanto o suporte destrava o registro).
  expect(gravado.credencial).toBeTruthy();
  expect(String(gravado.credencial[3])).toMatch(/^v1:/);
  expect(gravado.extras[3]).toBe(false); // registered NÃO carimbado
  expect(gravado.extras[1]).toBeNull();  // sem PIN: não fomos nós que registramos
});

it('(3) número já registrado conta como sucesso, sem gravar PIN falso', async () => {
  wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
  wa.subscribeApp.mockResolvedValue({ success: true });
  const erro = new Error('Phone number already registered');
  erro.meta = { code: 133005 };
  wa.registerPhone.mockRejectedValue(erro);
  wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 99999-0000' });
  const gravado = mockConexao();

  const res = await request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/connect`)
    .set('Authorization', 'Bearer ' + token)
    .send({ code: 'CODE', waba_id: 'WABA1', phone_number_id: 'PN1' });

  expect(res.status).toBe(200);
  expect(res.body.registered).toBe(true);
  expect(res.body.warnings).toEqual([]);
  expect(gravado.extras[1]).toBeNull(); // o PIN de verdade é de quem registrou antes
});

it('(4) sem phone_number_id, o connect busca o primeiro número da WABA', async () => {
  wa.exchangeCodeForToken.mockResolvedValue('TOKEN-NOVO');
  wa.listPhoneNumbers.mockResolvedValue([{ id: 'PN-DESCOBERTO', display_phone_number: '+55 11 91111-2222' }]);
  wa.subscribeApp.mockResolvedValue({ success: true });
  wa.registerPhone.mockResolvedValue({ success: true });
  wa.getPhoneInfo.mockResolvedValue({ display_phone_number: '+55 11 91111-2222' });
  const gravado = mockConexao();

  const res = await request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/connect`)
    .set('Authorization', 'Bearer ' + token)
    .send({ code: 'CODE', waba_id: 'WABA1' });

  expect(res.status).toBe(200);
  expect(wa.listPhoneNumbers).toHaveBeenCalledWith('WABA1', 'TOKEN-NOVO');
  expect(res.body.phone_number_id).toBe('PN-DESCOBERTO');
  expect(gravado.credencial[1]).toBe('PN-DESCOBERTO'); // foi para o banco
});

it('(5) disconnect solta a assinatura da WABA antes de esquecer a credencial', async () => {
  wa.unsubscribeApp.mockResolvedValue({ success: true });
  const gravado = mockConexao({ connRow: { wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', has_token: true } });

  const res = await request(buildApp())
    .post(`/companies/${COMPANY}/whatsapp/disconnect`)
    .set('Authorization', 'Bearer ' + token);

  expect(res.status).toBe(200);
  expect(res.body.disconnected).toBe(true);
  expect(wa.unsubscribeApp).toHaveBeenCalledWith('WABA1', 'TOKEN-GRAVADO');
  expect(gravado.limpouExtras).toBe(true);
});

it('(6) erro da Graph API carrega err.meta.code (e não só a frase em inglês)', async () => {
  const real = jest.requireActual('../src/services/whatsapp');
  const antes = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    status: 400,
    json: async () => ({ error: {
      message: 'Template name does not exist in the translation',
      type: 'OAuthException', code: 132001, error_subcode: 2494010,
      fbtrace_id: 'ABC123', error_data: { details: 'template mensalidade_lembrete não existe' },
    } }),
  });
  try {
    await expect(real.graphPost('/PN1/messages', 'TK', {})).rejects.toMatchObject({
      message: 'Template name does not exist in the translation',
      httpStatus: 400,
      meta: { code: 132001, error_subcode: 2494010, fbtrace_id: 'ABC123' },
    });
    // O detalhe real da Meta fica acessível — a message é genérica demais.
    const err = await real.graphPost('/PN1/messages', 'TK', {}).catch((e) => e);
    expect(err.meta.details).toContain('mensalidade_lembrete');
    // E o 190 continua sendo reconhecido como credencial, agora por código.
    const outbox = require('../src/services/waOutbox');
    const e190 = new Error('algo aconteceu');
    e190.meta = { code: 190 };
    expect(outbox.isTokenError(e190)).toBe(true);
  } finally {
    global.fetch = antes;
  }
});

it('(7) status devolve addon, template, uso e embedded_signup — com wa_outbox ausente (42P01)', async () => {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (s.includes('-- wa:conn-extras-get')) {
      return Promise.resolve({ rows: [{
        wa_subscribed_at: '2026-09-13T10:00:00Z', wa_registered_at: '2026-09-13T10:00:01Z',
        wa_quality_rating: 'GREEN', wa_paused_reason: null, wa_paused_at: null,
      }] });
    }
    if (s.includes('-- addon:has')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
    if (s.includes('-- wa:status-template')) return Promise.resolve({ rows: [{ status: 'APPROVED' }] });
    if (/SELECT wa_token_invalid_at/.test(s)) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (/FROM companies WHERE id/.test(s)) {
      return Promise.resolve({ rows: [{
        wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', wa_phone_display: '+55 11 99999-0000',
        wa_connected_at: '2026-09-13T10:00:00Z', has_token: true,
      }] });
    }
    if (/FROM wa_outbox/.test(s)) {
      const e = new Error('relation "wa_outbox" does not exist'); e.code = '42P01';
      return Promise.reject(e);
    }
    return Promise.resolve({ rows: [] });
  });

  const res = await request(buildApp())
    .get(`/companies/${COMPANY}/whatsapp/status`)
    .set('Authorization', 'Bearer ' + token);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    connected: true, addon_active: true,
    template_name: 'mensalidade_lembrete', template_status: 'APPROVED', template_ready: true,
    quality_rating: 'GREEN', paused_reason: null,
    subscribed: true, registered: true,
  });
  // Fila ausente não zera o resto: o uso vem em zeros, nunca undefined.
  expect(res.body.usage).toEqual({ today_sent: 0, month_sent: 0, daily_cap: 300 });
  expect(res.body.embedded_signup).toEqual({
    app_id: '1496711532094674', config_id: 'CFG-ES-TESTE', graph_version: 'v21.0',
  });
});

it('(8) colunas da 328 ausentes (42703): o status responde mesmo assim', async () => {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (s.includes('-- wa:conn-extras-get')) {
      const e = new Error('column "wa_quality_rating" does not exist'); e.code = '42703';
      return Promise.reject(e);
    }
    if (s.includes('-- addon:has')) {
      const e = new Error('relation "company_addons" does not exist'); e.code = '42P01';
      return Promise.reject(e);
    }
    if (/SELECT wa_token_invalid_at/.test(s)) return Promise.resolve({ rows: [{ wa_token_invalid_at: null }] });
    if (/FROM companies WHERE id/.test(s)) {
      return Promise.resolve({ rows: [{
        wa_waba_id: 'WABA1', wa_phone_number_id: 'PN1', wa_phone_display: '+55 11 9',
        wa_connected_at: null, has_token: true,
      }] });
    }
    return Promise.resolve({ rows: [] });
  });

  const res = await request(buildApp())
    .get(`/companies/${COMPANY}/whatsapp/status`)
    .set('Authorization', 'Bearer ' + token);

  expect(res.status).toBe(200);
  expect(res.body.connected).toBe(true);
  expect(res.body.addon_active).toBe(false);
  expect(res.body.subscribed).toBe(false);
  expect(res.body.registered).toBe(false);
  expect(res.body.quality_rating).toBeNull();
});
