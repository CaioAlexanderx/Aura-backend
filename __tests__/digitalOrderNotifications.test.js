// ============================================================
// Notificações do Canal Digital — pedido confirmado
//
// Bug de 17/08/2026: cada caller de notifyPaymentConfirmed montava o `order`
// com um SELECT próprio, e 3 dos 5 esqueciam `total`, `delivery_type` e
// `customer_phone` (approve-payment, webhookMp Pix/cartão, webhookAsaas).
// O notificador fazia `Number(undefined).toFixed(2)` -> o lojista recebia
// push e e-mail com "R$ NaN", modalidade sempre "Retirada" (o ternário cai
// no else quando o campo é undefined) e sem o bloco de WhatsApp.
//
// Nunca apareceu em produção porque nenhum pedido chegava a `confirmed` —
// o botão de aprovar Pix estava quebrado no app (aura-app#686). Ou seja:
// código nunca exercitado que ia falhar no primeiro uso real.
//
// O mock do db despacha por CONTEÚDO DO SQL, não por ordem de chamada —
// senão o teste passa a depender da sequência interna do notificador.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/mailer', () => ({
  sendOrderStatusEmail: jest.fn().mockResolvedValue(undefined),
  sendOwnerNewOrderEmail: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../src/config/database');
const { sendOwnerNewOrderEmail, sendOrderStatusEmail } = require('../src/services/mailer');
const notify = require('../src/services/digitalOrderNotifications');

// Linha canônica do pedido no banco.
const DB_ROW = {
  id: 'bb2ffcea-0000-0000-0000-000000000001',
  company_id: 'c1',
  order_number: '00001',
  customer_name: 'Davi Calçados',
  customer_email: 'cliente@exemplo.com',
  customer_phone: '(91) 98888-7777',
  total: '45.90',
  delivery_type: 'delivery',
  payment_method: 'pix',
};

// Exatamente o recorte que digitalOrders.js montava no approve-payment.
const PARTIAL_ORDER = {
  id: DB_ROW.id,
  status: 'awaiting_approval',
  payment_method: 'pix',
  order_number: '00001',
  customer_name: 'Davi Calçados',
  customer_email: 'cliente@exemplo.com',
  company_id: 'c1',
};

function mockDb({ orderRow = DB_ROW } = {}) {
  db.query.mockImplementation((sql) => {
    if (/FROM\s+digital_orders/i.test(sql)) {
      return Promise.resolve({ rows: orderRow ? [orderRow] : [] });
    }
    if (/FROM\s+digital_channel_config/i.test(sql)) {
      return Promise.resolve({ rows: [{ site_name: 'Davi Calçados' }] });
    }
    // push_tokens / users.push_token / e-mails do lojista
    if (/push_tokens|push_token/i.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    if (/FROM\s+users/i.test(sql)) {
      return Promise.resolve({ rows: [{ email: 'lojista@exemplo.com' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
});

describe('notifyPaymentConfirmed — enriquecimento do pedido', () => {
  it('recarrega total/delivery_type/customer_phone quando o caller passa recorte parcial', async () => {
    mockDb();

    await notify.notifyPaymentConfirmed({ order: { ...PARTIAL_ORDER } });

    expect(sendOwnerNewOrderEmail).toHaveBeenCalledTimes(1);
    const [to, payload] = sendOwnerNewOrderEmail.mock.calls[0];
    expect(to).toBe('lojista@exemplo.com');
    expect(payload.total).toBe('45.90');
    expect(payload.delivery_type).toBe('delivery');
    expect(payload.customer_phone).toBe('(91) 98888-7777');
    expect(payload.store_name).toBe('Davi Calçados');
  });

  it('nunca monta "R$ NaN" no push do lojista', async () => {
    mockDb();
    db.query.mockImplementation((sql) => {
      if (/FROM\s+digital_orders/i.test(sql)) return Promise.resolve({ rows: [DB_ROW] });
      if (/FROM\s+digital_channel_config/i.test(sql)) return Promise.resolve({ rows: [{ site_name: 'Davi Calçados' }] });
      if (/push_tokens/i.test(sql)) return Promise.resolve({ rows: [{ token: 'ExponentPushToken[abc]' }] });
      if (/FROM\s+users/i.test(sql)) return Promise.resolve({ rows: [{ email: 'lojista@exemplo.com' }] });
      return Promise.resolve({ rows: [] });
    });

    await notify.notifyPaymentConfirmed({ order: { ...PARTIAL_ORDER } });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body[0].body).not.toMatch(/NaN/);
    expect(body[0].body).toContain('R$ 45,90');
    expect(body[0].body).toContain('🚚 Entrega');
  });

  it('não vai ao banco quando o caller já passa a linha completa (INSERT ... RETURNING *)', async () => {
    mockDb();

    await notify.notifyPaymentConfirmed({ order: { ...DB_ROW, status: 'confirmed' } });

    const orderSelects = db.query.mock.calls.filter(([sql]) => /FROM\s+digital_orders/i.test(sql));
    expect(orderSelects).toHaveLength(0);
    expect(sendOwnerNewOrderEmail.mock.calls[0][1].total).toBe('45.90');
  });

  it('degrada pra "R$ —" (não "R$ NaN") se o pedido sumiu do banco', async () => {
    mockDb({ orderRow: null });
    db.query.mockImplementation((sql) => {
      if (/FROM\s+digital_orders/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM\s+digital_channel_config/i.test(sql)) return Promise.resolve({ rows: [{ site_name: 'Loja' }] });
      if (/push_tokens/i.test(sql)) return Promise.resolve({ rows: [{ token: 'ExponentPushToken[abc]' }] });
      if (/FROM\s+users/i.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await notify.notifyPaymentConfirmed({ order: { ...PARTIAL_ORDER } });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body[0].body).not.toMatch(/NaN/);
    expect(body[0].body).toContain('R$ —');
  });

  it('ainda envia o e-mail de status ao cliente', async () => {
    mockDb();

    await notify.notifyPaymentConfirmed({ order: { ...PARTIAL_ORDER } });

    expect(sendOrderStatusEmail).toHaveBeenCalledTimes(1);
    expect(sendOrderStatusEmail.mock.calls[0][0]).toBe('cliente@exemplo.com');
    expect(sendOrderStatusEmail.mock.calls[0][1].status).toBe('confirmed');
  });
});
