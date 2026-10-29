// ============================================================
// POST /webhooks/mp — lojas conectadas por OAuth (tq-95, 29/10/2026)
//
// Um webhook só, da aplicação da Aura, assinado com MP_WEBHOOK_SECRET. A
// loja é resolvida pelo user_id do vendedor; o pagamento é sempre
// reconsultado com o token da própria loja; repetir a notificação não muda
// nada. Lojas com token manual seguem na regra antiga
// (webhookMp.security.test.js continua valendo).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/mpService', () => ({ getMpPayment: jest.fn() }));
jest.mock('../src/services/digitalOrderConfirmation', () => ({ onOrderConfirmed: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

const CHAVE = crypto.randomBytes(32).toString('hex');
const APP_SECRET = 'segredo-do-webhook-da-aplicacao';

let db, getMpPayment, onOrderConfirmed, secretCrypto, route;
beforeAll(() => {
  process.env.CERT_MASTER_KEY = CHAVE;
  db = require('../src/config/database');
  ({ getMpPayment } = require('../src/services/mpService'));
  ({ onOrderConfirmed } = require('../src/services/digitalOrderConfirmation'));
  secretCrypto = require('../src/utils/secretCrypto');
  route = require('../src/routes/webhookMp');
});
beforeEach(() => {
  jest.resetAllMocks();
  process.env.MP_WEBHOOK_SECRET = APP_SECRET;
  process.env.MP_CLIENT_ID = '123';
  process.env.MP_CLIENT_SECRET = 'cs';
});
afterAll(() => {
  delete process.env.MP_WEBHOOK_SECRET;
  delete process.env.MP_CLIENT_ID;
  delete process.env.MP_CLIENT_SECRET;
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/webhooks/mp', route);
  return a;
}
function assinar(secret, dataId, requestId, ts = '1730000000') {
  const v1 = crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
  return `ts=${ts},v1=${v1}`;
}
const esperar = () => new Promise((r) => setImmediate(r));
const mutacoes = () => db.query.mock.calls.filter(([sql]) => /UPDATE\s+digital_orders/i.test(sql));
const longe = () => new Date(Date.now() + 100 * 24 * 3600 * 1000);

function gwOAuth(over = {}) {
  return {
    id: 'gw-a', company_id: 'empresa-a', access_token: secretCrypto.encryptString('TOKEN-A'),
    webhook_secret: null, auth_method: 'oauth', refresh_token: secretCrypto.encryptString('R-A'),
    token_expires_at: longe(), connection_status: 'ok', mp_user_id: '555', ...over,
  };
}

async function notificar(body, { secret = APP_SECRET, requestId = 'req-1' } = {}) {
  const r = request(app()).post('/webhooks/mp');
  if (secret) r.set('x-signature', assinar(secret, String(body.data.id), requestId)).set('x-request-id', requestId);
  const res = await r.send(body);
  expect(res.status).toBe(200);
  await esperar(); await esperar();
}

describe('webhook da aplicação (OAuth)', () => {
  test('Pix: assinatura da aplicação + user_id do vendedor + reconsulta com o token da loja → confirma', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth(), gwOAuth({ id: 'gw-b', company_id: 'empresa-b', mp_user_id: '777' })] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-1', company_id: 'empresa-a', status: 'pending_payment', total: '50.00' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    getMpPayment.mockResolvedValueOnce({ id: 9001, status: 'approved', transaction_amount: 50 });

    await notificar({ action: 'payment.updated', type: 'payment', user_id: 555, data: { id: '9001' } });

    expect(getMpPayment).toHaveBeenCalledWith({ accessToken: 'TOKEN-A', paymentId: '9001' });
    expect(mutacoes()).toHaveLength(1);
    expect(onOrderConfirmed).toHaveBeenCalledWith('pedido-1');
  });

  test('assinatura inválida: nem consulta o Mercado Pago', async () => {
    db.query.mockResolvedValueOnce({ rows: [gwOAuth()] });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9001' } }, { secret: 'segredo-errado' });
    expect(getMpPayment).not.toHaveBeenCalled();
    expect(mutacoes()).toHaveLength(0);
  });

  test('sem assinatura nenhuma, com MP_WEBHOOK_SECRET configurado: ignora', async () => {
    db.query.mockResolvedValueOnce({ rows: [gwOAuth()] });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9001' } }, { secret: null });
    expect(getMpPayment).not.toHaveBeenCalled();
  });

  test('pedido de outra loja (user_id não bate com a empresa do pedido): não confirma', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth(), gwOAuth({ id: 'gw-b', company_id: 'empresa-b', mp_user_id: '777' })] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-b', company_id: 'empresa-b', status: 'pending_payment' }] });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9002' } });
    expect(getMpPayment).not.toHaveBeenCalled();
    expect(mutacoes()).toHaveLength(0);
  });

  test('cartão: external_reference de pedido de outra empresa é recusado', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth()] })
      .mockResolvedValueOnce({ rows: [] }) // mp_payment_id não achou
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-x', company_id: 'empresa-z', status: 'pending_payment' }] });
    getMpPayment.mockResolvedValueOnce({ id: 9003, status: 'approved', external_reference: 'pedido-x' });
    await notificar({ action: 'payment.created', user_id: 555, data: { id: '9003' } });
    expect(mutacoes()).toHaveLength(0);
  });

  test('cartão: mesma conta do Mercado Pago em dois CNPJs — o pedido desempata', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth(), gwOAuth({ id: 'gw-b', company_id: 'empresa-b', access_token: secretCrypto.encryptString('TOKEN-B') })] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-b', company_id: 'empresa-b', status: 'pending_payment', total: 80 }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // salva mp_payment_id
      .mockResolvedValueOnce({ rowCount: 1 }); // confirma
    getMpPayment.mockResolvedValueOnce({ id: 9004, status: 'approved', external_reference: 'pedido-b', transaction_amount: 80 });
    await notificar({ action: 'payment.created', user_id: 555, data: { id: '9004' } });
    expect(getMpPayment).toHaveBeenCalledTimes(1); // uma consulta por conta do MP
    expect(mutacoes()).toHaveLength(2);
    expect(onOrderConfirmed).toHaveBeenCalledWith('pedido-b');
  });

  test('valor aprovado menor que o total: não confirma', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth()] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-1', company_id: 'empresa-a', status: 'pending_payment', total: '120.00' }] });
    getMpPayment.mockResolvedValueOnce({ id: 9005, status: 'approved', transaction_amount: 1 });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9005' } });
    expect(mutacoes()).toHaveLength(0);
  });

  test('notificação repetida: o UPDATE condicional não muda nada e não confirma de novo', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth()] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-1', company_id: 'empresa-a', status: 'pending_payment', total: 50 }] })
      .mockResolvedValueOnce({ rowCount: 0 }); // outra notificação já confirmou
    getMpPayment.mockResolvedValueOnce({ id: 9006, status: 'approved', transaction_amount: 50 });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9006' } });
    expect(onOrderConfirmed).not.toHaveBeenCalled();
  });

  test('pedido já confirmado: nem reconsulta', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [gwOAuth()] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-1', company_id: 'empresa-a', status: 'confirmed' }] });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9007' } });
    expect(getMpPayment).not.toHaveBeenCalled();
  });

  test('conexão caída não é candidata', async () => {
    db.query.mockResolvedValueOnce({ rows: [gwOAuth({ connection_status: 'caiu' })] });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9008' } });
    expect(getMpPayment).not.toHaveBeenCalled();
  });
});

describe('convivência com token manual', () => {
  test('loja manual com segredo próprio segue confirmando pela assinatura dela', async () => {
    const SEG = 'segredo-da-loja-manual-123';
    db.query
      .mockResolvedValueOnce({ rows: [
        gwOAuth(),
        { id: 'gw-m', company_id: 'empresa-m', access_token: 'APP_USR-manual', webhook_secret: SEG, auth_method: 'manual', connection_status: 'ok', mp_user_id: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-m', company_id: 'empresa-m', status: 'pending_payment' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    getMpPayment.mockResolvedValueOnce({ id: 9100, status: 'approved' });
    await notificar({ action: 'payment.updated', data: { id: '9100' } }, { secret: SEG });
    expect(getMpPayment).toHaveBeenCalledWith({ accessToken: 'APP_USR-manual', paymentId: '9100' });
    expect(onOrderConfirmed).toHaveBeenCalledWith('pedido-m');
  });

  test('assinatura da loja manual não abre as lojas OAuth', async () => {
    const SEG = 'segredo-da-loja-manual-123';
    db.query
      .mockResolvedValueOnce({ rows: [
        gwOAuth(),
        { id: 'gw-m', company_id: 'empresa-m', access_token: 'APP_USR-manual', webhook_secret: SEG, auth_method: 'manual', connection_status: 'ok', mp_user_id: null },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: 'pedido-a', company_id: 'empresa-a', status: 'pending_payment' }] });
    await notificar({ action: 'payment.updated', user_id: 555, data: { id: '9101' } }, { secret: SEG });
    expect(getMpPayment).not.toHaveBeenCalled();
    expect(mutacoes()).toHaveLength(0);
  });
});
