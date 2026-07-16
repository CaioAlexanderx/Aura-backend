// ============================================================
// Testes de segurança — POST /webhooks/mp (rota pública, sem auth)
//
// Este webhook já tinha, antes desta auditoria, uma mitigação parcial:
// quando nenhum gateway tem webhook_secret cadastrado, a validação HMAC
// (x-signature) é pulada, mas NENHUM caminho de mutação confia no body —
// getMpPayment() sempre reverifica contra a API do Mercado Pago antes de
// confirmar um pedido (ver comentário de topo de webhookMp.js). Esta
// mudança:
//   1) adiciona um WARN ruidoso quando opera sem HMAC (visibilidade —
//      antes era um "aceitar sem log");
//   2) tem estes testes NOVOS provando que o comportamento sempre foi (e
//      continua sendo) seguro: (a) assinatura inválida com gateway
//      cadastrado -> zero mutação; (b) sem NENHUM secret cadastrado,
//      notificação forjada -> zero mutação (o provedor não confirma);
//      (c) evento legítimo -> processa e confirma o pedido normalmente.
//
// O webhook responde 200 sempre e imediatamente (contrato do MP: <500ms),
// então "zero mutação" é verificado via asserção nas queries do banco, não
// via status HTTP (ver webhookAsaas.security.test.js pro caso onde o
// status HTTP É o sinal, já que aquele webhook pode responder 401).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/mpService', () => ({ getMpPayment: jest.fn() }));
jest.mock('../src/services/digitalOrderConfirmation', () => ({ onOrderConfirmed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
}));

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

const db                  = require('../src/config/database');
const { getMpPayment }    = require('../src/services/mpService');
const route                = require('../src/routes/webhookMp');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/mp', route);
  return app;
}

function computeMpHmac(secret, dataId, requestId, ts) {
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return crypto.createHmac('sha256', secret).update(manifest).digest('hex');
}

const UPDATE_ORDERS_RE = /UPDATE\s+digital_orders/i;

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /webhooks/mp', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('(a) gateway com webhook_secret cadastrado + x-signature inválida -> ZERO mutação', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'gw-1', company_id: 'company-1', access_token: 'tok-1', webhook_secret: 'seg-1' }],
    });

    const res = await request(app)
      .post('/webhooks/mp')
      .set('x-signature', 'ts=1720000000,v1=assinaturaforjadaevidentementeerrada00000000000000000000000000')
      .set('x-request-id', 'req-forjado')
      .send({ action: 'payment.updated', data: { id: 'pay_forjado' } });

    expect(res.status).toBe(200); // MP exige 200 imediato — o sinal de segurança é a ausência de mutação
    // dá tempo do processamento assíncrono (fire-and-forget pós res.sendStatus) rodar
    await new Promise((r) => setImmediate(r));

    expect(getMpPayment).not.toHaveBeenCalled();
    const mutations = db.query.mock.calls.filter((c) => UPDATE_ORDERS_RE.test(c[0]));
    expect(mutations.length).toBe(0);
  });

  it('(b) NENHUM gateway com webhook_secret cadastrado + notificação forjada (paymentId inexistente) -> Mercado Pago não confirma -> ZERO mutação', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'gw-1', company_id: 'company-1', access_token: 'tok-1', webhook_secret: null }],
    });
    // 1ª tentativa: lookup por mp_payment_id -> nao encontrado
    db.query.mockResolvedValueOnce({ rows: [] });
    // fallback CheckoutPro: getMpPayment falha (paymentId forjado não existe de verdade no MP)
    getMpPayment.mockRejectedValueOnce(new Error('MP API error 404'));

    const res = await request(app)
      .post('/webhooks/mp')
      // sem x-signature — não há segredo cadastrado pra apresentar mesmo
      .send({ action: 'payment.updated', data: { id: 'pay_totalmente_forjado' } });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    expect(getMpPayment).toHaveBeenCalledWith({ accessToken: 'tok-1', paymentId: 'pay_totalmente_forjado' });
    const mutations = db.query.mock.calls.filter((c) => UPDATE_ORDERS_RE.test(c[0]));
    expect(mutations.length).toBe(0);
  });

  it('(b2) sem segredo cadastrado + paymentId real mas status NÃO approved (ex.: pending forjado como approved no body) -> ZERO mutação', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'gw-1', company_id: 'company-1', access_token: 'tok-1', webhook_secret: null }],
    });
    db.query.mockResolvedValueOnce({ // lookup por mp_payment_id -> nao encontrado (fluxo cartao)
      rows: [],
    });
    getMpPayment.mockResolvedValueOnce({ id: 'pay_real_pending', status: 'pending', external_reference: 'order-1' });
    db.query.mockResolvedValueOnce({ // lookup do pedido por external_reference -> encontrado, ainda pending_payment
      rows: [{ id: 'order-1', company_id: 'company-1', status: 'pending_payment', order_number: 1, customer_name: 'Cliente', customer_email: 'c@x.com' }],
    });

    const res = await request(app)
      .post('/webhooks/mp')
      .send({ action: 'payment.updated', data: { id: 'pay_real_pending' } });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    // Nunca chega a fazer o SELECT/UPDATE do pedido por external_reference,
    // pois payment.status !== 'approved' -> return antes.
    const mutations = db.query.mock.calls.filter((c) => UPDATE_ORDERS_RE.test(c[0]));
    expect(mutations.length).toBe(0);
  });

  it('(c) evento legítimo (HMAC válido + Mercado Pago confirma approved) -> confirma o pedido normalmente', async () => {
    const SECRET = 'segredo-gw-legitimo';
    const REQUEST_ID = 'req-legitimo-001';
    const TS = '1720000000';
    const PAYMENT_ID = 'pay_legitimo_1';
    const sig = computeMpHmac(SECRET, PAYMENT_ID, REQUEST_ID, TS);

    db.query.mockResolvedValueOnce({ // carrega gateways
      rows: [{ id: 'gw-1', company_id: 'company-1', access_token: 'tok-1', webhook_secret: SECRET }],
    });
    db.query.mockResolvedValueOnce({ // lookup por mp_payment_id -> encontrado (fluxo Pix)
      rows: [{ id: 'order-1', company_id: 'company-1', status: 'pending_payment', order_number: 42, customer_name: 'Cliente', customer_email: 'c@x.com' }],
    });
    getMpPayment.mockResolvedValueOnce({ id: PAYMENT_ID, status: 'approved' });
    db.query.mockResolvedValueOnce({ rowCount: 1 }); // UPDATE digital_orders

    const res = await request(app)
      .post('/webhooks/mp')
      .set('x-signature', `ts=${TS},v1=${sig}`)
      .set('x-request-id', REQUEST_ID)
      .send({ action: 'payment.updated', data: { id: PAYMENT_ID } });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const mutations = db.query.mock.calls.filter((c) => UPDATE_ORDERS_RE.test(c[0]));
    expect(mutations.length).toBe(1);
    expect(mutations[0][1][0]).toBe('order-1'); // WHERE id = $1
  });
});
