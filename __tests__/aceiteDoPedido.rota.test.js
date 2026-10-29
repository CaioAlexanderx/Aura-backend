// ============================================================
// AURA. — Rotas do aceite do pagar na entrega (tq-44, 29/10/2026)
//
// O que o aceite, a recusa e a quitacao FAZEM esta provado no Postgres
// real (aceiteDoPedido.banco.test.js). Aqui, com banco de mentira, a
// LIGACAO das rotas do painel:
//   - POST /accept e /refuse chamam o servico e devolvem a mensagem dele;
//   - o pedido que espera aceite nao avanca pelo PATCH /status (pularia a
//     baixa e o lancamento); cancelar por la vira recusa;
//   - entregue quita, cancelado estorna o a receber.
// ============================================================
'use strict';

jest.mock('../src/services/aceiteDoPedido', () => ({
  aceitarPedido: jest.fn(),
  recusarPedido: jest.fn(),
  quitarNaEntrega: jest.fn(async () => true),
  estornarAReceber: jest.fn(async () => true),
}));
jest.mock('../src/services/devolucaoDoEstoqueDoPedido', () => ({
  devolverEstoqueDoPedido: jest.fn(async () => ({ devolvido: false, motivo: 'sem_baixa' })),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const aceite = require('../src/services/aceiteDoPedido');
const lojaEvents = require('../src/services/lojaEvents');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';
const OID = '11111111-2222-3333-4444-555555555555';
const base = `/companies/${CID}/digital-channel/orders/${OID}`;

function banco(regras) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    for (const [re, rows] of regras) if (re.test(s)) return { rows, rowCount: rows.length };
    return { rows: [], rowCount: 0 };
  });
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 'u1', role: 'client' }; next(); });
app.use('/companies/:id/digital-channel/orders', require('../src/routes/digitalOrders'));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  banco([]);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /accept', () => {
  test('aceita com o tempo de preparo', async () => {
    aceite.aceitarPedido.mockResolvedValueOnce({ order: { id: OID, status: 'preparing', prep_minutes: 45 }, jaAceito: false });
    const r = await request(app).post(`${base}/accept`).send({ prep_minutes: 45 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: true, ja_aceito: false, order: { status: 'preparing' } });
    expect(aceite.aceitarPedido).toHaveBeenCalledWith({ orderId: OID, companyId: CID, prepMinutes: 45 });
  });

  test('segundo toque: 200 "ja aceito", sem aviso de novo', async () => {
    aceite.aceitarPedido.mockResolvedValueOnce({ order: { id: OID, status: 'preparing' }, jaAceito: true });
    const r = await request(app).post(`${base}/accept`).send({ prep_minutes: 45 });
    expect(r.status).toBe(200);
    expect(r.body.ja_aceito).toBe(true);
    expect(require('../src/services/digitalOrderNotifications').notifyStatusChange).not.toHaveBeenCalled();
  });

  test('erro do servico vira a mensagem dele com o status certo', async () => {
    aceite.aceitarPedido.mockRejectedValueOnce(Object.assign(new Error('Este pedido já foi recusado ou cancelado.'), { status: 409, statusAtual: 'cancelled' }));
    const r = await request(app).post(`${base}/accept`).send({ prep_minutes: 45 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Este pedido já foi recusado ou cancelado.', status: 'cancelled' });
  });

  test('falha inesperada: 500 dizendo que nada mudou', async () => {
    aceite.aceitarPedido.mockRejectedValueOnce(new Error('conexao caiu'));
    const r = await request(app).post(`${base}/accept`).send({ prep_minutes: 45 });
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/Nada foi alterado/);
  });
});

describe('POST /refuse', () => {
  test('recusa com o motivo e avisa no sino', async () => {
    aceite.recusarPedido.mockResolvedValueOnce({ id: OID, status: 'cancelled', cancel_kind: 'recusado_pela_loja' });
    const r = await request(app).post(`${base}/refuse`).send({ reason: 'Acabou o gelo' });
    expect(r.status).toBe(200);
    expect(r.body.refused).toBe(true);
    expect(aceite.recusarPedido).toHaveBeenCalledWith({ orderId: OID, companyId: CID, motivo: 'Acabou o gelo' });
    expect(lojaEvents.emit).toHaveBeenCalledWith('loja_pedido_cancelado', expect.objectContaining({ id: OID }));
  });

  test('sem motivo: 400 do servico', async () => {
    aceite.recusarPedido.mockRejectedValueOnce(Object.assign(new Error('Conte para a cliente por que o pedido foi recusado.'), { status: 400 }));
    const r = await request(app).post(`${base}/refuse`).send({});
    expect(r.status).toBe(400);
  });
});

describe('PATCH /status com o pedido de pagar na entrega', () => {
  const patch = (status) => request(app).patch(`${base}/status`).send({ status });

  test('esperando aceite nao avanca pelo status (pularia a baixa)', async () => {
    banco([[/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'aguardando_aceite', payment_status: 'pending' }]]]);
    const r = await patch('preparing');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Aceite ou recuse/);
    expect(db.query.mock.calls.some(([s]) => /UPDATE digital_orders SET\s+status/.test(String(s)))).toBe(false);
  });

  test('cancelar quem esperava aceite fica registrado como recusa', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'aguardando_aceite', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET\s+status/, [{ id: OID, status: 'cancelled', cancel_kind: 'cancelado_pela_loja' }]],
    ]);
    const r = await patch('cancelled');
    expect(r.status).toBe(200);
    expect(r.body.order.cancel_kind).toBe('recusado_pela_loja');
  });

  test('entregue quita o a receber; cancelado estorna', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'preparing', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET\s+status/, [{ id: OID, status: 'delivered', payment_method: 'on_delivery', pay_on_delivery_method: 'cash' }]],
    ]);
    expect((await patch('delivered')).status).toBe(200);
    expect(aceite.quitarNaEntrega).toHaveBeenCalledWith(expect.objectContaining({ id: OID, status: 'delivered' }));
    expect(aceite.estornarAReceber).not.toHaveBeenCalled();

    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'preparing', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET\s+status/, [{ id: OID, status: 'cancelled', payment_method: 'on_delivery', pay_on_delivery_method: 'cash' }]],
    ]);
    expect((await patch('cancelled')).status).toBe(200);
    expect(aceite.estornarAReceber).toHaveBeenCalledWith(expect.objectContaining({ id: OID, status: 'cancelled' }));
  });
});
