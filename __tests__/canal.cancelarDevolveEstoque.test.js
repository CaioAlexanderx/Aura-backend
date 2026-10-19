// ============================================================
// AURA. — Todo cancelamento do pedido do Canal passa pela devolucao
// do estoque (19/10/2026)
//
// O que a devolucao FAZ esta provado no Postgres real
// (canal.cancelarDevolveEstoque.banco.test.js). Aqui, com banco de
// mentira, a LIGACAO: cada caminho de cancelamento chama a devolucao, e
// uma falha nela nao desfaz o cancelamento.
//   - "Cancelar pedido" no painel (PATCH /status cancelled)
//   - "Recusar pagamento" (POST /reject-payment)
//   - job do Pix vencido (so quem tem stock_deducted = TRUE)
// Nao ha rota de cancelamento pelo cliente na loja comum.
// ============================================================
'use strict';

jest.mock('../src/services/devolucaoDoEstoqueDoPedido', () => ({
  devolverEstoqueDoPedido: jest.fn(async () => ({ devolvido: true, itens: 1 })),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { devolverEstoqueDoPedido } = require('../src/services/devolucaoDoEstoqueDoPedido');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';
const OID = '11111111-2222-3333-4444-555555555555';

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
  devolverEstoqueDoPedido.mockClear();
  devolverEstoqueDoPedido.mockImplementation(async () => ({ devolvido: true, itens: 1 }));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('Cancelar pedido no painel', () => {
  const cancelar = () => request(app)
    .patch(`/companies/${CID}/digital-channel/orders/${OID}/status`).send({ status: 'cancelled' });

  test('devolve o estoque antes de responder, e a resposta ja mostra o marcador zerado', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'confirmed' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled', stock_deducted: true }]],
    ]);
    const r = await cancelar();
    expect(r.status).toBe(200);
    expect(devolverEstoqueDoPedido).toHaveBeenCalledWith(OID);
    expect(r.body.order.stock_deducted).toBe(false);
  });

  test('sem baixa (nada devolvido): o marcador da resposta fica como veio', async () => {
    devolverEstoqueDoPedido.mockResolvedValueOnce({ devolvido: false, motivo: 'sem_baixa' });
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'pending_payment', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled', stock_deducted: false }]],
    ]);
    const r = await cancelar();
    expect(r.status).toBe(200);
    expect(r.body.order.stock_deducted).toBe(false);
  });

  test('falha na devolucao nao desfaz o cancelamento (fica cancelled + stock_deducted, e loga)', async () => {
    devolverEstoqueDoPedido.mockRejectedValueOnce(new Error('conexao caiu'));
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'confirmed' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled', stock_deducted: true }]],
    ]);
    const r = await cancelar();
    expect(r.status).toBe(200);
    expect(r.body.order.stock_deducted).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/devolver estoque/), OID, 'conexao caiu');
  });

  test('avancar etapa nao chama a devolucao', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'confirmed' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'preparing' }]],
    ]);
    await request(app).patch(`/companies/${CID}/digital-channel/orders/${OID}/status`).send({ status: 'preparing' });
    expect(devolverEstoqueDoPedido).not.toHaveBeenCalled();
  });

  test('pedido ja cancelado: 409 e nenhuma devolucao (cancelar duas vezes)', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'cancelled', payment_status: 'confirmed' }]],
    ]);
    const r = await cancelar();
    expect(r.status).toBe(409);
    expect(devolverEstoqueDoPedido).not.toHaveBeenCalled();
  });
});

describe('Recusar pagamento', () => {
  test('passa pela devolucao (quem decide se houve baixa e o marcador)', async () => {
    devolverEstoqueDoPedido.mockResolvedValueOnce({ devolvido: false, motivo: 'sem_baixa' });
    banco([
      [/^\s*SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'awaiting_approval', payment_status: 'pending' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled', stock_deducted: false }]],
    ]);
    const r = await request(app).post(`/companies/${CID}/digital-channel/orders/${OID}/reject-payment`).send({});
    expect(r.status).toBe(200);
    expect(devolverEstoqueDoPedido).toHaveBeenCalledWith(OID);
  });
});

describe('Job do Pix vencido', () => {
  const { tickCancelarPixVencido } = require('../src/jobs/lojaPixExpiradoJob');
  const agora = new Date().toISOString();

  test('so devolve quem tem baixa marcada, com o db do job', async () => {
    const dbDoJob = {
      query: jest.fn(async () => ({
        rows: [
          { id: 'sem-baixa', company_id: CID, total: 10, created_at: agora, stock_deducted: false },
          { id: 'com-baixa', company_id: CID, total: 10, created_at: agora, stock_deducted: true },
        ],
      })),
    };
    const r = await tickCancelarPixVencido({ db: dbDoJob, lojaEvents: { emitLojaEvent: async () => null } });
    expect(r.cancelados).toBe(2);
    expect(devolverEstoqueDoPedido).toHaveBeenCalledTimes(1);
    expect(devolverEstoqueDoPedido).toHaveBeenCalledWith('com-baixa', { db: dbDoJob });
  });

  test('o UPDATE do job devolve o marcador da baixa', () => {
    const { sqlDoCancelamento } = require('../src/jobs/lojaPixExpiradoJob');
    expect(sqlDoCancelamento({ comComprovante: true })).toMatch(/RETURNING[^;]*stock_deducted/);
  });

  test('falha na devolucao nao para o job', async () => {
    devolverEstoqueDoPedido.mockRejectedValueOnce(new Error('x'));
    const dbDoJob = {
      query: jest.fn(async () => ({
        rows: [
          { id: 'a', company_id: CID, total: 10, created_at: agora, stock_deducted: true },
          { id: 'b', company_id: CID, total: 10, created_at: agora, stock_deducted: true },
        ],
      })),
    };
    const r = await tickCancelarPixVencido({ db: dbDoJob, lojaEvents: { emitLojaEvent: async () => null } });
    expect(r.cancelados).toBe(2);
    expect(devolverEstoqueDoPedido).toHaveBeenCalledTimes(2);
  });
});
