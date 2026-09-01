// ============================================================
// AURA — AURINHA: contrato de checkout + sino no handoff (313)
//
// Cobertura:
//  (1) link_do_produto: gera o link do contrato (produto + origem +
//      conversa; variante quando escolhida) validando o produto na
//      company; sem slug → erro orientando a escalar.
//  (2) handoff → notifyCompany (sino do app) com dedupe por conversa+dia.
//  (3) POST /storefront/:slug/order com origem/hub_conversation_id →
//      UPDATE de atribuição best-effort; UUID inválido é descartado.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/instagram', () => ({
  sendText: jest.fn(), sendImage: jest.fn(), clampText: (s) => s,
}));
jest.mock('../src/services/claudeClient', () => ({
  callClaude: jest.fn(), DEFAULT_MODEL: 'test-model',
}));
jest.mock('../src/services/appNotifications', () => ({
  notifyCompany: jest.fn(() => Promise.resolve(null)),
}));

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { callClaude } = require('../src/services/claudeClient');
const { notifyCompany } = require('../src/services/appNotifications');
const { handleInbound } = require('../src/services/aurinhaAgent');

const COMPANY = 'c-uuid-1';
const CONV = 'a1b2c3d4-1111-2222-3333-444455556666';

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  callClaude.mockReset();
  notifyCompany.mockReset();
});

function mockAgentDb({ channelConfig, extra }) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('FROM hub_agent_settings')) return Promise.resolve({ rows: [{ enabled: true, approval_mode: true }] });
    if (s.includes('FROM hub_conversations WHERE id')) {
      return Promise.resolve({ rows: [{ id: CONV, external_id: 'IGSID-1', status: 'ia', category: null, customer_name: null }] });
    }
    if (s.includes('FROM companies WHERE id')) return Promise.resolve({ rows: [{ trade_name: 'Finesse' }] });
    if (s.includes('FROM digital_channel_config')) return Promise.resolve({ rows: channelConfig ? [channelConfig] : [] });
    if (s.includes('FROM ig_messages')) return Promise.resolve({ rows: [{ direction: 'inbound', content: 'quero comprar!' }] });
    if (extra) { const r = extra(s, params); if (r) return r; }
    return Promise.resolve({ rows: [] });
  });
}

// ── (1) link_do_produto ─────────────────────────────────────
describe('link_do_produto', () => {
  function toolCall(input) {
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu-1', name: 'link_do_produto', input }],
      toolUses: [{ type: 'tool_use', id: 'tu-1', name: 'link_do_produto', input }],
      text: '', inputTokens: 1, outputTokens: 1, model: 'test-model',
    };
  }
  const finalOk = {
    stopReason: 'end_turn', content: [], toolUses: [],
    text: '{"resposta":"Link enviado!","categoria":"produto","escalar":false}',
    inputTokens: 1, outputTokens: 1, model: 'test-model',
  };

  it('gera link do contrato com produto, variante, origem e conversa', async () => {
    mockAgentDb({
      channelConfig: { slug: 'finesse', pix_discount_pct: 5 },
      extra: (s) => {
        if (s.includes('FROM products WHERE company_id')) {
          return Promise.resolve({ rows: [{ id: 'prod-1', name: 'Blusa Antonella' }] });
        }
        if (s.includes('-- ig:outbox-enqueue')) return Promise.resolve({ rows: [{ id: 'ob-1', status: 'pending_approval' }] });
        return null;
      },
    });
    callClaude
      .mockResolvedValueOnce(toolCall({ produto_id: 'prod-1', variante: 'M-vinho' }))
      .mockResolvedValueOnce(finalOk);

    const r = await handleInbound(COMPANY, CONV);
    expect(r.handled).toBe(true);

    // O tool_result devolvido na 2ª chamada carrega o link do contrato
    const secondCall = callClaude.mock.calls[1][0];
    const toolResultTurn = secondCall.messages[secondCall.messages.length - 1];
    const payload = JSON.parse(toolResultTurn.content[0].content);
    expect(payload.link).toContain('https://loja.getaura.com.br/finesse?');
    expect(payload.link).toContain('produto=prod-1');
    expect(payload.link).toContain('variante=M-vinho');
    expect(payload.link).toContain('origem=aurinha');
    expect(payload.link).toContain(`conversa=${CONV}`);
    expect(payload.desconto_pix_pct).toBe(5);
  });

  it('sem loja virtual configurada → erro orientando, nunca link inventado', async () => {
    mockAgentDb({
      channelConfig: null,
      extra: (s) => (s.includes('-- ig:outbox-enqueue')
        ? Promise.resolve({ rows: [{ id: 'ob-2', status: 'pending_approval' }] }) : null),
    });
    callClaude
      .mockResolvedValueOnce(toolCall({ produto_id: 'prod-1' }))
      .mockResolvedValueOnce(finalOk);

    await handleInbound(COMPANY, CONV);
    const secondCall = callClaude.mock.calls[1][0];
    const toolResultTurn = secondCall.messages[secondCall.messages.length - 1];
    const payload = JSON.parse(toolResultTurn.content[0].content);
    expect(payload.erro).toMatch(/loja virtual/);
    expect(payload.link).toBeUndefined();
  });
});

// ── (2) handoff → sino do app ───────────────────────────────
describe('handoff notifica pelo sino', () => {
  it('escalada chama notifyCompany com dedupe por conversa+dia e ctaRoute /agentes', async () => {
    mockAgentDb({
      channelConfig: { slug: 'finesse' },
      extra: (s) => (s.includes('-- ig:outbox-enqueue')
        ? Promise.resolve({ rows: [{ id: 'ob-3', status: 'pending_approval' }] }) : null),
    });
    callClaude.mockResolvedValueOnce({
      stopReason: 'end_turn', content: [], toolUses: [],
      text: '{"resposta":"A equipe já vai falar com você!","categoria":"troca","escalar":{"motivo":"cliente pediu troca com defeito"}}',
      inputTokens: 1, outputTokens: 1, model: 'test-model',
    });

    const r = await handleInbound(COMPANY, CONV);
    expect(r.escalada).toBe(true);
    expect(notifyCompany).toHaveBeenCalledTimes(1);
    const [cid, payload] = notifyCompany.mock.calls[0];
    expect(cid).toBe(COMPANY);
    expect(payload.ctaRoute).toBe('/agentes');
    expect(payload.body).toMatch(/troca com defeito/);
    expect(payload.dedupeKey).toMatch(new RegExp(`^hub_handoff:${CONV}:\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('resposta sem escalada não notifica', async () => {
    mockAgentDb({
      channelConfig: { slug: 'finesse' },
      extra: (s) => (s.includes('-- ig:outbox-enqueue')
        ? Promise.resolve({ rows: [{ id: 'ob-4', status: 'pending_approval' }] }) : null),
    });
    callClaude.mockResolvedValueOnce({
      stopReason: 'end_turn', content: [], toolUses: [],
      text: '{"resposta":"Temos sim!","categoria":"produto","escalar":false}',
      inputTokens: 1, outputTokens: 1, model: 'test-model',
    });
    await handleInbound(COMPANY, CONV);
    expect(notifyCompany).not.toHaveBeenCalled();
  });
});

// ── (3) atribuição no POST /order ───────────────────────────
describe('POST /storefront/:slug/order — atribuição da Aurinha', () => {
  const PRODUTO = { id: 'p1', name: 'BLUSA', price: '129.90', stock_qty: 10, image_url: null, is_active: true };
  const LOJA = {
    company_id: COMPANY, pickup_enabled: true, delivery_enabled: false,
    pix_key: 'chave-pix', company_display_name: 'Finesse',
  };

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/storefront', require('../src/routes/storefront'));
    return app;
  }

  function mockBanco(updates) {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/FROM digital_channel_config/.test(s)) return Promise.resolve({ rows: [LOJA] });
      if (/FROM companies_payment_gateways/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM products/.test(s)) return Promise.resolve({ rows: [PRODUTO] });
      if (/UPDATE digital_orders SET origem/.test(s)) { updates.push(params); return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockImplementation(() => ({
      query: jest.fn((sql) => {
        if (/INSERT INTO digital_orders/.test(String(sql))) {
          return Promise.resolve({ rows: [{ id: 'order-1', order_number: 7, total: '129.90' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    }));
  }

  function pedido(extra) {
    return request(makeApp()).post('/storefront/finesse/order').send({
      customer_name: 'Mariana', customer_phone: '34999999999',
      delivery_type: 'pickup', payment_method: 'pix',
      items: [{ product_id: 'p1', quantity: 1 }],
      ...extra,
    });
  }

  it('origem + conversa válidas → UPDATE de atribuição com os dois valores', async () => {
    const updates = [];
    mockBanco(updates);
    const res = await pedido({ origem: 'aurinha', hub_conversation_id: CONV });
    expect(res.status).not.toBe(400);
    expect(updates.length).toBe(1);
    expect(updates[0][0]).toBe('aurinha');
    expect(updates[0][1]).toBe(CONV);
    expect(updates[0][2]).toBe('order-1');
  });

  it('UUID inválido é descartado; origem sozinha ainda grava', async () => {
    const updates = [];
    mockBanco(updates);
    await pedido({ origem: 'aurinha', hub_conversation_id: 'nao-e-uuid' });
    expect(updates.length).toBe(1);
    expect(updates[0][0]).toBe('aurinha');
    expect(updates[0][1]).toBeNull();
  });

  it('pedido sem atribuição não dispara o UPDATE', async () => {
    const updates = [];
    mockBanco(updates);
    await pedido({});
    expect(updates.length).toBe(0);
  });
});
