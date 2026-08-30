// ============================================================
// AURA — AURINHA / HUB SOCIAL (312)
//
// Cobertura:
//  (1) webhook IG: assinatura inválida → 401; DM válida → upsert de
//      conversa + insert em ig_messages + dispara handleInbound;
//      echo (is_echo) NÃO dispara a Aurinha.
//  (2) aurinhaAgent.handleInbound: settings desligado → não roda;
//      resposta feliz → enqueue pending_approval + triagem gravada;
//      escalar → conversa vira precisa_humano ANTES do acolhimento;
//      JSON inválido do modelo → escala em vez de mandar texto cru.
//  (3) igOutbox.processBatch: sem credenciais → SEM_CREDENCIAIS;
//      janela de 24h fechada → JANELA_FECHADA; envio ok → sent + mid;
//      sugestão da Aurinha em conversa assumida → CONVERSA_NAO_IA.
//  (4) hubSocial: reply com janela fechada → 422 JANELA_FECHADA.
// ============================================================
'use strict';

process.env.IG_VERIFY_TOKEN = 'ig-verify-test';
process.env.IG_APP_SECRET = 'ig-secret-test';

jest.mock('../src/config/database');
jest.mock('../src/services/instagram', () => ({
  sendText: jest.fn(),
  sendImage: jest.fn(),
  clampText: (s) => s,
}));
jest.mock('../src/services/claudeClient', () => ({
  callClaude: jest.fn(),
  DEFAULT_MODEL: 'test-model',
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const ig = require('../src/services/instagram');
const { callClaude } = require('../src/services/claudeClient');
const igOutbox = require('../src/services/igOutbox');
const { handleInbound } = require('../src/services/aurinhaAgent');

const COMPANY = 'company-uuid-ig';
const CONV = 'conv-uuid-1';

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  ig.sendText.mockReset();
  callClaude.mockReset();
});

function sign(bodyStr) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.IG_APP_SECRET)
    .update(Buffer.from(bodyStr, 'utf8')).digest('hex');
}

function webhookApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/webhooks/instagram', require('../src/routes/webhookInstagram'));
  return app;
}

// ── (1) webhook ─────────────────────────────────────────────
describe('webhook Instagram', () => {
  const dmBody = JSON.stringify({
    object: 'instagram',
    entry: [{
      id: 'ig-acc-1',
      messaging: [{ sender: { id: 'IGSID-cliente' }, message: { mid: 'mid-1', text: 'tem no M?' } }],
    }],
  });

  it('assinatura inválida → 401 e nada processa', async () => {
    const res = await request(webhookApp())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send(dmBody);
    expect(res.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('DM válida → upsert conversa, insert ig_messages e dispara a Aurinha', async () => {
    const calls = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      calls.push(s);
      if (s.includes('FROM companies WHERE ig_account_id')) return Promise.resolve({ rows: [{ id: COMPANY }] });
      if (s.includes('-- aurinha:conv-upsert')) return Promise.resolve({ rows: [{ id: CONV }] });
      if (s.includes('FROM hub_agent_settings')) return Promise.resolve({ rows: [] }); // Aurinha desligada → para aqui
      return Promise.resolve({ rows: [] });
    });

    const res = await request(webhookApp())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(dmBody))
      .send(dmBody);
    expect(res.status).toBe(200);
    // processamento é async pós-200
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.some((s) => s.includes('-- aurinha:conv-upsert'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT INTO ig_messages'))).toBe(true);
    // handleInbound chegou a rodar (buscou settings)
    expect(calls.some((s) => s.includes('FROM hub_agent_settings'))).toBe(true);
  });

  it('echo (is_echo) não cria conversa nem dispara a Aurinha', async () => {
    const echo = JSON.stringify({
      object: 'instagram',
      entry: [{
        id: 'ig-acc-1',
        messaging: [{ sender: { id: 'ig-acc-1' }, message: { mid: 'mid-2', text: 'resposta da loja', is_echo: true } }],
      }],
    });
    const calls = [];
    db.query.mockImplementation((sql) => { calls.push(String(sql)); return Promise.resolve({ rows: [{ id: COMPANY }] }); });

    await request(webhookApp())
      .post('/webhooks/instagram')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(echo))
      .send(echo);
    await new Promise((r) => setTimeout(r, 20));

    expect(calls.some((s) => s.includes('-- aurinha:conv-upsert'))).toBe(false);
    expect(calls.some((s) => s.includes('INSERT INTO ig_messages'))).toBe(false);
  });
});

// ── (2) aurinhaAgent ────────────────────────────────────────
describe('aurinhaAgent.handleInbound', () => {
  function mockAgentDb({ settings, conv, history, extra }) {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('FROM hub_agent_settings')) return Promise.resolve({ rows: settings ? [settings] : [] });
      if (s.includes('FROM hub_conversations WHERE id')) return Promise.resolve({ rows: conv ? [conv] : [] });
      if (s.includes('FROM companies WHERE id')) return Promise.resolve({ rows: [{ trade_name: 'Finesse', legal_name: 'Finesse LTDA' }] });
      if (s.includes('FROM digital_channel_config')) return Promise.resolve({ rows: [{ slug: 'finesse', pix_discount_pct: 5, always_open: false, pickup_enabled: true }] });
      if (s.includes('FROM ig_messages')) return Promise.resolve({ rows: history || [] });
      if (extra) { const r = extra(s, params); if (r) return r; }
      return Promise.resolve({ rows: [] });
    });
  }

  const baseConv = { id: CONV, external_id: 'IGSID-cliente', status: 'ia', category: null, customer_name: null };
  const baseHistory = [{ direction: 'inbound', content: 'tem a blusa no M?' }];

  it('settings desligado → não roda', async () => {
    mockAgentDb({ settings: { enabled: false }, conv: baseConv, history: baseHistory });
    const r = await handleInbound(COMPANY, CONV);
    expect(r.handled).toBe(false);
    expect(r.reason).toBe('DESATIVADA');
    expect(callClaude).not.toHaveBeenCalled();
  });

  it('resposta feliz → enqueue pending_approval + triagem gravada', async () => {
    const writes = [];
    mockAgentDb({
      settings: { enabled: true, approval_mode: true, model: null, extra_instructions: null },
      conv: baseConv, history: baseHistory,
      extra: (s, params) => {
        if (s.includes('-- ig:outbox-enqueue')) { writes.push({ enq: params }); return Promise.resolve({ rows: [{ id: 'ob-1', status: 'pending_approval' }] }); }
        if (s.includes('UPDATE hub_conversations SET category')) { writes.push({ cat: params }); return Promise.resolve({ rows: [] }); }
        return null;
      },
    });
    callClaude.mockResolvedValueOnce({
      stopReason: 'end_turn', content: [], toolUses: [],
      text: '{"resposta":"Tem sim! 💜","categoria":"produto","escalar":false}',
      inputTokens: 10, outputTokens: 5, model: 'test-model',
    });

    const r = await handleInbound(COMPANY, CONV);
    expect(r.handled).toBe(true);
    expect(r.escalada).toBe(false);
    expect(r.categoria).toBe('produto');
    const enq = writes.find((w) => w.enq);
    expect(enq).toBeTruthy();
    expect(enq.enq[5]).toBe('pending_approval'); // status
    expect(enq.enq[3]).toBe('Tem sim! 💜');       // text_body
  });

  it('tool escalar → precisa_humano ANTES do acolhimento entrar na fila', async () => {
    const order = [];
    mockAgentDb({
      settings: { enabled: true, approval_mode: false },
      conv: baseConv, history: [{ direction: 'inbound', content: 'veio com defeito!!' }],
      extra: (s) => {
        if (s.includes("SET status = 'precisa_humano'")) { order.push('handoff'); return Promise.resolve({ rows: [] }); }
        if (s.includes('-- ig:outbox-enqueue')) { order.push('enqueue'); return Promise.resolve({ rows: [{ id: 'ob-2', status: 'pending' }] }); }
        return null;
      },
    });
    callClaude
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'escalar', input: { motivo: 'reclamação de defeito', categoria: 'troca' } }],
        toolUses: [{ type: 'tool_use', id: 'tu-1', name: 'escalar', input: { motivo: 'reclamação de defeito', categoria: 'troca' } }],
        text: '', inputTokens: 10, outputTokens: 5, model: 'test-model',
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn', content: [], toolUses: [],
        text: '{"resposta":"Sinto muito! A equipe da loja já vai falar com você.","categoria":"troca","escalar":{"motivo":"defeito"}}',
        inputTokens: 10, outputTokens: 5, model: 'test-model',
      });

    const r = await handleInbound(COMPANY, CONV);
    expect(r.handled).toBe(true);
    expect(r.escalada).toBe(true);
    expect(order.indexOf('handoff')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('handoff')).toBeLessThan(order.indexOf('enqueue'));
  });

  it('JSON inválido do modelo → escala, nunca manda texto cru para o cliente', async () => {
    const writes = [];
    mockAgentDb({
      settings: { enabled: true, approval_mode: true },
      conv: baseConv, history: baseHistory,
      extra: (s) => {
        if (s.includes("SET status = 'precisa_humano'")) { writes.push('handoff'); return Promise.resolve({ rows: [] }); }
        if (s.includes('-- ig:outbox-enqueue')) { writes.push('enqueue'); return Promise.resolve({ rows: [{ id: 'ob-3', status: 'pending_approval' }] }); }
        return null;
      },
    });
    callClaude.mockResolvedValueOnce({
      stopReason: 'end_turn', content: [], toolUses: [],
      text: 'Claro! Temos a blusa no M sim.', // fugiu do contrato JSON
      inputTokens: 10, outputTokens: 5, model: 'test-model',
    });

    const r = await handleInbound(COMPANY, CONV);
    expect(r.handled).toBe(true);
    expect(r.escalada).toBe(true);
    expect(writes).toContain('handoff');
    expect(writes).not.toContain('enqueue'); // sem resposta válida, nada vai pro cliente
  });
});

// ── (3) igOutbox.processBatch ───────────────────────────────
describe('igOutbox.processBatch', () => {
  function mockBatch(row, { creds } = {}) {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- ig:outbox-pick')) return Promise.resolve({ rows: [row] });
      if (s.includes('-- ig:creds')) {
        return Promise.resolve({ rows: creds ? [creds] : [{}] });
      }
      return Promise.resolve({ rows: [] });
    });
  }
  const freshInbound = new Date(Date.now() - 3600000).toISOString();   // 1h atrás
  const staleInbound = new Date(Date.now() - 30 * 3600000).toISOString(); // 30h atrás

  const baseRow = {
    id: 'ob-1', company_id: COMPANY, conversation_id: CONV, to_ig_id: 'IGSID-cliente',
    text_body: 'oi!', edited_body: null, attempts: 0, source_type: 'aurinha',
    conv_last_inbound_at: freshInbound, conv_status: 'ia',
  };

  it('sem credenciais → skipped SEM_CREDENCIAIS', async () => {
    mockBatch(baseRow, { creds: null });
    const r = await igOutbox.processBatch(5);
    expect(r.skipped).toBe(1);
    expect(ig.sendText).not.toHaveBeenCalled();
  });

  it('janela de 24h fechada → skipped JANELA_FECHADA', async () => {
    mockBatch({ ...baseRow, conv_last_inbound_at: staleInbound },
      { creds: { ig_account_id: 'ig-acc-1', ig_access_token: 'tok' } });
    const r = await igOutbox.processBatch(5);
    expect(r.skipped).toBe(1);
    expect(ig.sendText).not.toHaveBeenCalled();
  });

  it('sugestão da Aurinha em conversa assumida → skipped CONVERSA_NAO_IA', async () => {
    mockBatch({ ...baseRow, conv_status: 'humano' },
      { creds: { ig_account_id: 'ig-acc-1', ig_access_token: 'tok' } });
    const r = await igOutbox.processBatch(5);
    expect(r.skipped).toBe(1);
    expect(ig.sendText).not.toHaveBeenCalled();
  });

  it('envio ok → sent com ig_message_id', async () => {
    mockBatch(baseRow, { creds: { ig_account_id: 'ig-acc-1', ig_access_token: 'tok' } });
    ig.sendText.mockResolvedValueOnce({ recipient_id: 'IGSID-cliente', message_id: 'mid-out-1' });
    const r = await igOutbox.processBatch(5);
    expect(r.sent).toBe(1);
    expect(ig.sendText).toHaveBeenCalledWith('ig-acc-1', 'tok', 'IGSID-cliente', 'oi!');
  });
});

// ── (4) hubSocial: reply fora da janela ─────────────────────
describe('hubSocial reply', () => {
  function hubApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/hub', (req, _res, next) => { req.user = { id: 'user-1' }; next(); },
      require('../src/routes/hubSocial'));
    return app;
  }

  it('janela de 24h fechada → 422 JANELA_FECHADA', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (s.includes('FROM hub_conversations')) {
        return Promise.resolve({ rows: [{ external_id: 'IGSID-cliente', channel: 'instagram', last_inbound_at: new Date(Date.now() - 25 * 3600000).toISOString() }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(hubApp())
      .post(`/companies/${COMPANY}/hub/conversations/${CONV}/reply`)
      .send({ text: 'oi!' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('JANELA_FECHADA');
  });
});
