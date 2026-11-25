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

  // p-185: pedido de orcamento com conta a receber cancela numa transacao
  // (pedido travado; status, conta e marcos juntos; erro desfaz tudo).
  function clienteDaTransacao({ falhaNaConta = false, statusTravado = 'confirmed' } = {}) {
    const chamadas = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        chamadas.push([s, params]);
        if (/FOR UPDATE/.test(s)) return { rows: [{ status: statusTravado }] };
        if (/UPDATE digital_orders SET/.test(s)) return { rows: [{ id: OID, status: 'cancelled', stock_deducted: false }] };
        if (/'pedido-areceber-' \|\| sq\.order_id/.test(s)) return { rows: [{ '?column?': 1 }] };
        if (/UPDATE transactions/.test(s) && falhaNaConta) throw new Error('conexao caiu');
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };
    db.connect.mockReset();
    db.connect.mockImplementation(async () => client);
    return { client, chamadas };
  }
  const COM_CONTA = [/'pedido-areceber-' \|\| sq\.order_id/, [{ '?column?': 1 }]];

  test('p-185: pedido de orcamento com conta: status, conta e marcos na mesma transacao', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'pending' }]],
      COM_CONTA,
    ]);
    const { chamadas, client } = clienteDaTransacao();
    const r = await cancelar();
    expect(r.status).toBe(200);
    const sqls = chamadas.map(([q]) => q);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/FROM digital_orders WHERE id = \$1 AND company_id = \$2 FOR UPDATE/);
    expect(sqls[2]).toMatch(/UPDATE digital_orders SET/);
    const conta = chamadas.find(([q]) => /UPDATE transactions/.test(q));
    expect(conta[0]).toMatch(/status = 'pending'/);
    expect(conta[1]).toEqual(['Pedido cancelado', `pedido-areceber-${OID}`, CID]);
    const marcos = chamadas.find(([q]) => /UPDATE studio_payments SET status = 'cancelled'/.test(q));
    expect(marcos[1]).toEqual([OID, CID]);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
    // nada do dinheiro fora da transacao
    expect(db.query.mock.calls.some(([q]) => /UPDATE transactions|UPDATE studio_payments|UPDATE digital_orders SET/.test(String(q)))).toBe(false);
  });

  test('p-185: erro ao fechar a conta desfaz o cancelamento (ROLLBACK, 500, sem COMMIT)', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'pending' }]],
      COM_CONTA,
    ]);
    const { chamadas } = clienteDaTransacao({ falhaNaConta: true });
    const r = await cancelar();
    expect(r.status).toBe(500);
    const sqls = chamadas.map(([q]) => q);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(devolverEstoqueDoPedido).not.toHaveBeenCalled();
  });

  test('p-185: outro toque ja cancelou (visto com o pedido travado): 409, nada muda', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'pending' }]],
      COM_CONTA,
    ]);
    const { chamadas } = clienteDaTransacao({ statusTravado: 'cancelled' });
    const r = await cancelar();
    expect(r.status).toBe(409);
    expect(chamadas.map(([q]) => q)).toContain('ROLLBACK');
    expect(chamadas.some(([q]) => /^\s*UPDATE/.test(q))).toBe(false);
  });

  test('p-185: pedido sem conta do orcamento (trava desligada no aprovar, ou nao e orcamento): o de antes', async () => {
    banco([
      [/SELECT id, status, payment_status FROM digital_orders/, [{ id: OID, status: 'confirmed', payment_status: 'confirmed' }]],
      [/UPDATE digital_orders SET/, [{ id: OID, status: 'cancelled', stock_deducted: false }]],
    ]);
    db.connect.mockReset();
    expect((await cancelar()).status).toBe(200);
    expect(db.connect).not.toHaveBeenCalled();
    const calls = db.query.mock.calls.map(([q, p]) => [String(q), p || []]);
    expect(calls.some(([q, p]) => /UPDATE transactions/.test(q) && p.some((x) => String(x).startsWith('pedido-areceber')))).toBe(false);
    expect(calls.some(([q]) => /UPDATE studio_payments/.test(q))).toBe(false);
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
