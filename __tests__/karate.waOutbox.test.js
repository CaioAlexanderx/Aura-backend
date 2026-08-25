// ============================================================
// AURA — ONDA 5b: fila de WhatsApp (waOutbox) + webhook
//
// Cobertura:
//  (1) normalizePhone: BR 10/11 dígitos ganha 55; lixo → null.
//  (2) enqueue: opt-out SEMPRE vence (skipped OPT_OUT); texto fora da
//      janela de 24h → skipped JANELA_FECHADA; template → pending;
//      dedupe_key repetida → DUPLICADO (nada enfileira).
//  (3) processBatch: sem credenciais → skipped SEM_CREDENCIAIS; envio
//      ok → sent + wa_message_id; erro → retry com backoff; teto de
//      tentativas → failed permanente.
//  (4) touchInbound: SAIR → opt-out; mensagem comum → abre janela e
//      confirma opt-in.
//  (5) webhook: assinatura inválida → 401; template status update →
//      upsert em wa_templates; status delivered → espelha na fila.
// ============================================================
'use strict';

process.env.WA_VERIFY_TOKEN = 'verify-test';
process.env.WA_APP_SECRET = 'secret-test';
// Cofre do token cifrado (A9) — mesma chave do dojoBaasCrypto.
process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({
  sendTemplate: jest.fn(),
  sendText: jest.fn(),
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const outbox = require('../src/services/waOutbox');

const COMPANY = 'company-uuid-wa';

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  wa.sendTemplate.mockReset();
  wa.sendText.mockReset();
});

// ── (1) normalizePhone ──────────────────────────────────────
describe('normalizePhone', () => {
  it('BR de 10/11 dígitos ganha 55; E.164 passa; lixo → null', () => {
    expect(outbox.normalizePhone('(11) 98888-7777')).toBe('5511988887777');
    expect(outbox.normalizePhone('1133334444')).toBe('551133334444');
    expect(outbox.normalizePhone('+55 11 98888-7777')).toBe('5511988887777');
    expect(outbox.normalizePhone('15556309005')).toBe('15556309005'); // teste Meta
    expect(outbox.normalizePhone('123')).toBeNull();
    expect(outbox.normalizePhone(null)).toBeNull();
  });
});

// ── (2) enqueue ─────────────────────────────────────────────
describe('enqueue', () => {
  function mockContact(contact, insertedRows = [{ id: 'ob-1', status: 'pending' }]) {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: contact ? [contact] : [] });
      if (s.includes('-- wa:outbox-enqueue')) return Promise.resolve({ rows: insertedRows });
      return Promise.resolve({ rows: [] });
    });
  }

  it('opt-out SEMPRE vence: grava skipped OPT_OUT, não pending', async () => {
    mockContact({ opted_out_at: '2026-08-01T00:00:00Z', last_inbound_at: null },
      [{ id: 'ob-1', status: 'skipped' }]);
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'tpl' });
    expect(r.queued).toBe(false);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('OPT_OUT');
  });

  it('texto fora da janela de 24h → skipped JANELA_FECHADA; dentro → pending', async () => {
    mockContact({ opted_out_at: null, last_inbound_at: new Date(Date.now() - 30 * 3600000).toISOString() },
      [{ id: 'ob-2', status: 'skipped' }]);
    const fora = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', kind: 'text', textBody: 'oi' });
    expect(fora.reason).toBe('JANELA_FECHADA');

    mockContact({ opted_out_at: null, last_inbound_at: new Date(Date.now() - 3600000).toISOString() });
    const dentro = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', kind: 'text', textBody: 'oi' });
    expect(dentro.queued).toBe(true);
  });

  it('dedupe_key repetida → DUPLICADO (ON CONFLICT devolve zero linhas)', async () => {
    mockContact(null, []);
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: '11988887777', templateName: 'tpl', dedupeKey: 'k1' });
    expect(r.queued).toBe(false);
    expect(r.reason).toBe('DUPLICADO');
  });
});

// ── (3) processBatch ────────────────────────────────────────
describe('processBatch', () => {
  function mockBatch(row, { creds = { wa_phone_number_id: 'PN1', wa_access_token: 'TK' }, contact = null } = {}) {
    const updates = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:outbox-pick')) return Promise.resolve({ rows: [row] });
      if (s.includes('-- wa:creds')) return Promise.resolve({ rows: creds ? [creds] : [] });
      if (s.includes('-- wa:contact-get')) return Promise.resolve({ rows: contact ? [contact] : [] });
      if (/UPDATE wa_outbox/i.test(s)) { updates.push({ s, params }); return Promise.resolve({ rows: [] }); }
      if (/INSERT INTO wa_messages/i.test(s)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    return updates;
  }
  const baseRow = {
    id: 'ob-1', company_id: COMPANY, to_phone: '5511988887777', kind: 'template',
    template_name: 'mensalidade_lembrete', template_language: 'pt_BR',
    components: null, text_body: null, attempts: 0,
  };

  it('sem credenciais → skipped SEM_CREDENCIAIS (nada vai à Meta)', async () => {
    const updates = mockBatch(baseRow, { creds: null });
    const r = await outbox.processBatch(5);
    expect(r.skipped).toBe(1);
    expect(wa.sendTemplate).not.toHaveBeenCalled();
    expect(updates.some(u => u.params.includes('SEM_CREDENCIAIS'))).toBe(true);
  });

  it('envio ok → sent + wa_message_id da Meta', async () => {
    const updates = mockBatch(baseRow);
    wa.sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.ABC' }] });
    const r = await outbox.processBatch(5);
    expect(r.sent).toBe(1);
    expect(wa.sendTemplate).toHaveBeenCalledWith('PN1', 'TK', '5511988887777', 'mensalidade_lembrete', 'pt_BR', undefined);
    expect(updates.some(u => u.params.includes('wamid.ABC'))).toBe(true);
  });

  it('token CIFRADO (v1:) é decifrado antes de ir à Meta; texto puro passa direto', async () => {
    // O Embedded Signup grava cifrado (A9). Sem decifrar, o Bearer seria o
    // ciphertext e TODO dojô conectado pelo fluxo oficial falharia.
    const { encrypt } = require('../src/services/dojoBaasCrypto');
    const cifrado = encrypt('TOKEN-REAL-DA-META');
    expect(cifrado.startsWith('v1:')).toBe(true);

    mockBatch(baseRow, { creds: { wa_phone_number_id: 'PN1', wa_access_token: cifrado } });
    wa.sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.CRYPT' }] });
    await outbox.processBatch(5);
    expect(wa.sendTemplate).toHaveBeenCalledWith('PN1', 'TOKEN-REAL-DA-META', expect.anything(), expect.anything(), expect.anything(), undefined);

    wa.sendTemplate.mockReset();
    mockBatch(baseRow, { creds: { wa_phone_number_id: 'PN1', wa_access_token: 'TOKEN-LEGADO' } });
    wa.sendTemplate.mockResolvedValue({ messages: [{ id: 'wamid.PLAIN' }] });
    await outbox.processBatch(5);
    expect(wa.sendTemplate).toHaveBeenCalledWith('PN1', 'TOKEN-LEGADO', expect.anything(), expect.anything(), expect.anything(), undefined);
  });

  it('erro da Meta → retry com backoff; no teto → failed permanente', async () => {
    let updates = mockBatch(baseRow);
    wa.sendTemplate.mockRejectedValue(new Error('rate limited'));
    let r = await outbox.processBatch(5);
    expect(r.retried).toBe(1);
    expect(updates.some(u => /next_attempt_at/.test(u.s))).toBe(true);

    updates = mockBatch({ ...baseRow, attempts: outbox.MAX_ATTEMPTS - 1 });
    wa.sendTemplate.mockRejectedValue(new Error('still down'));
    r = await outbox.processBatch(5);
    expect(r.failed).toBe(1);
    expect(updates.some(u => u.params.includes('failed'))).toBe(true);
  });
});

// ── (4) touchInbound ────────────────────────────────────────
describe('touchInbound', () => {
  it('SAIR marca opt-out; mensagem comum abre a janela (opt-in)', async () => {
    const calls = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- wa:contact-touch')) { calls.push(params); return Promise.resolve({ rows: [{ id: 'c1' }] }); }
      return Promise.resolve({ rows: [] });
    });
    const sair = await outbox.touchInbound(COMPANY, '5511988887777', 'SAIR');
    expect(sair.opt_out).toBe(true);
    expect(calls[0][3]).toBe(true); // $4 = optOut

    const oi = await outbox.touchInbound(COMPANY, '5511988887777', 'oi, quero pagar');
    expect(oi.opt_out).toBe(false);
    expect(calls[1][3]).toBe(false);
  });
});

// ── (5) webhook ─────────────────────────────────────────────
describe('webhook WhatsApp (5b)', () => {
  function buildApp() {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    app.use('/webhooks/whatsapp', require('../src/routes/webhookWhatsapp'));
    return app;
  }
  function sign(body) {
    return 'sha256=' + crypto.createHmac('sha256', 'secret-test')
      .update(Buffer.from(JSON.stringify(body), 'utf8')).digest('hex');
  }

  it('assinatura inválida → 401; GET verification devolve o challenge', async () => {
    const app = buildApp();
    const bad = await request(app).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send({ object: 'whatsapp_business_account' });
    expect(bad.status).toBe(401);

    const ver = await request(app).get('/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-test', 'hub.challenge': '12345' });
    expect(ver.status).toBe(200);
    expect(ver.text).toBe('12345');
  });

  it('template status update → upsert em wa_templates (resolve company pelo WABA)', async () => {
    const writes = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/wa_waba_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (s.includes('-- wa:template-status')) { writes.push(params); return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'message_template_status_update', value: {
        event: 'APPROVED', message_template_id: 777,
        message_template_name: 'mensalidade_lembrete', message_template_language: 'pt_BR',
      } }] }],
    };
    const res = await request(buildApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30)); // processamento pós-200
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual([COMPANY, 'mensalidade_lembrete', 'pt_BR', 'APPROVED', '777']);
  });

  it('status delivered espelha na fila por wamid', async () => {
    const outboxWrites = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/wa_phone_number_id=\$1/.test(s)) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (s.includes('-- wa:outbox-status')) { outboxWrites.push(params); return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
        metadata: { phone_number_id: 'PN1' },
        statuses: [{ id: 'wamid.ABC', status: 'delivered' }],
      } }] }],
    };
    const res = await request(buildApp()).post('/webhooks/whatsapp')
      .set('x-hub-signature-256', sign(body)).send(body);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(outboxWrites).toHaveLength(1);
    expect(outboxWrites[0]).toEqual(['delivered', null, 'wamid.ABC', COMPANY]);
  });
});
