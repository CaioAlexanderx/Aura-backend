// ============================================================
// AURA Studio — confirmar o Pix da vitrine pelo painel (A1, 26/09/2026)
//
// P0 do QA da lojista: o pedido da vitrine Studio pago por chave Pix fica
// em 'pending_payment' ate a lojista confirmar, e a unica tela com o botao
// era a fila do Canal Digital (de onde a conta Studio e redirecionada). O
// detalhe /studio/pedidos/:id nao sabia nada do pagamento, e o job de 72 h
// cancelava o pedido pago.
//
// Aqui trava:
//   (1) o detalhe Studio recebe forma, situacao, comprovante e total do
//       pedido digital, sem perder nada do head, escopado na empresa;
//   (2) base sem payment_proof_url (42703): cai sem o comprovante, uma vez;
//   (3) erro na consulta do pagamento nao derruba o detalhe;
//   (4) as listas (hub e /orders) ganham os campos do selo;
//   (5) a conta Studio (plano negocio) atravessa a CADEIA de mounts ate o
//       approve-payment do Canal, e o pedido vira confirmado.
//
// Mock por SQL, nunca por posicao.
// ============================================================
'use strict';

jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyStatusChange: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const pagamento = require('../src/services/pagamentoDoPedidoStudio');

const CID = 'c-studio';
const OID = '11111111-2222-3333-4444-555555555555';

const HEAD = {
  id: OID, company_id: CID, created_at: '2026-09-20T12:00:00Z', updated_at: '2026-09-20T12:00:00Z',
  total_amount: '89.82', status: 'pending_payment', studio_production_status: 'pending_art',
  customer_name: 'Helena Teste', customer_phone: '11999990000', display_name: '42',
  source: 'digital', digital_order_id: OID, pdv_sale_id: null, marketplace_order_id: null,
};

const PAGAMENTO = {
  id: OID, company_id: CID, status: 'awaiting_approval', payment_method: 'pix',
  payment_status: 'pending', total: '89.82', order_number: 42, confirmed_at: null,
  cancelled_at: null, payment_proof_url: 'https://cdn/c-studio/orders/x/proof.jpg?v=1',
  payment_proof_uploaded_at: '2026-09-20T13:00:00Z',
};

function appDoStudio() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'u1', role: 'client', plan: 'negocio' }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioKdsApproval'));
  app.use('/companies/:id/studio', require('../src/routes/studioBulkHub'));
  return app;
}

beforeEach(() => {
  db.query.mockReset();
  pagamento._resetParaTeste();
});

describe('GET /studio/orders/:oid — bloco Pagamento', () => {
  test('(1) soma forma, situacao, comprovante e total ao head, escopado na empresa', async () => {
    const vistos = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      vistos.push({ sql: s, params });
      if (/FROM studio_orders/.test(s)) return Promise.resolve({ rows: [HEAD] });
      if (/FROM digital_orders/.test(s) && /payment_method/.test(s)) return Promise.resolve({ rows: [PAGAMENTO] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(appDoStudio()).get(`/companies/${CID}/studio/orders/${OID}`);

    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({
      // nada do head se perde
      id: OID, total_amount: '89.82', studio_production_status: 'pending_art', source: 'digital',
      // e o pagamento chega fresco de digital_orders
      status: 'awaiting_approval', payment_method: 'pix', payment_status: 'pending',
      payment_proof_url: PAGAMENTO.payment_proof_url, total: 89.82, order_number: 42,
    });
    const q = vistos.find((v) => /FROM digital_orders/.test(v.sql) && /payment_method/.test(v.sql));
    expect(q.sql).toMatch(/company_id = \$1/);
    expect(q.params).toEqual([CID, [OID]]);
  });

  test('(2) base sem a coluna do comprovante: responde sem ele (42703), e so tenta uma vez', async () => {
    let tentativasComComprovante = 0;
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM studio_orders/.test(s)) return Promise.resolve({ rows: [HEAD] });
      if (/FROM digital_orders/.test(s) && /payment_method/.test(s)) {
        if (/payment_proof_url/.test(s)) {
          tentativasComComprovante++;
          return Promise.reject(Object.assign(new Error('column "payment_proof_url" does not exist'), { code: '42703' }));
        }
        const { payment_proof_url, payment_proof_uploaded_at, ...semComprovante } = PAGAMENTO;
        return Promise.resolve({ rows: [{ ...semComprovante, status: 'pending_payment' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = appDoStudio();
    const r1 = await request(app).get(`/companies/${CID}/studio/orders/${OID}`);
    const r2 = await request(app).get(`/companies/${CID}/studio/orders/${OID}`);

    expect(r1.status).toBe(200);
    expect(r1.body.order).toMatchObject({ status: 'pending_payment', payment_method: 'pix', payment_proof_url: null });
    expect(r2.body.order.payment_method).toBe('pix');
    expect(tentativasComComprovante).toBe(1);
  });

  test('(3) falha na consulta do pagamento nao derruba o detalhe', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM studio_orders/.test(s)) return Promise.resolve({ rows: [HEAD] });
      if (/FROM digital_orders/.test(s) && /payment_method/.test(s)) return Promise.reject(new Error('timeout'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(appDoStudio()).get(`/companies/${CID}/studio/orders/${OID}`);
    expect(res.status).toBe(200);
    expect(res.body.order.id).toBe(OID);
    expect(res.body.order.payment_method).toBeUndefined();
  });

  test('pedido de PDV nao consulta digital_orders', async () => {
    const vistos = [];
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      vistos.push(s);
      if (/FROM studio_orders/.test(s)) {
        return Promise.resolve({ rows: [{ ...HEAD, source: 'pdv', digital_order_id: null, pdv_sale_id: OID }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(appDoStudio()).get(`/companies/${CID}/studio/orders/${OID}`);
    expect(res.status).toBe(200);
    expect(vistos.some((s) => /FROM digital_orders/.test(s) && /payment_method/.test(s))).toBe(false);
  });
});

describe('(4) listas: campos do selo "Pagamento a conferir"', () => {
  test('hub/orders soma order_status, forma e se ha comprovante, sem trocar a etapa', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM digital_orders o/.test(s) && /'order'::text AS kind/.test(s)) {
        return Promise.resolve({ rows: [
          { id: OID, kind: 'order', created_at: '2026-09-20T12:00:00Z', amount: '89.82', status: 'pending_art', name: 'Helena', qty: 1 },
        ] });
      }
      if (/FROM digital_orders/.test(s) && /payment_method/.test(s)) {
        return Promise.resolve({ rows: [{ ...PAGAMENTO, status: 'pending_payment' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(appDoStudio()).get(`/companies/${CID}/studio/hub/orders?source=orders`);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      status: 'pending_art', order_status: 'pending_payment', payment_method: 'pix', has_payment_proof: true,
    });
    expect(res.body.items[0].payment_proof_url).toBeUndefined();
  });

  test('comPagamentoNaLista: so toca linha de pedido digital e sobrevive a erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...PAGAMENTO, payment_proof_url: null }] });
    const linhas = [
      { id: 'a', source: 'digital', digital_order_id: OID },
      { id: 'b', source: 'pdv', digital_order_id: null },
    ];
    const out = await pagamento.comPagamentoNaLista(db, CID, linhas, (o) => o.digital_order_id);
    expect(out[0]).toMatchObject({ order_status: 'awaiting_approval', has_payment_proof: false });
    expect(out[1]).toEqual(linhas[1]);

    db.query.mockRejectedValueOnce(new Error('caiu'));
    const deNovo = await pagamento.comPagamentoNaLista(db, CID, linhas, (o) => o.digital_order_id);
    expect(deNovo).toEqual(linhas);
  });
});

describe('(5) a conta Studio confirma o Pix pela rota do Canal', () => {
  // private.js carrega todos os routers na primeira requisicao.
  jest.setTimeout(30000);
  function cadeia() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id', require('../src/routes/private'));
    return app;
  }
  const token = jwt.sign({ id: 'dona-sheid', role: 'client', plan: 'negocio', vertical: 'studio' },
    'aura-test-secret-2026', { expiresIn: '1h' });

  test('approve-payment: pending_payment do Studio vira confirmado', async () => {
    const updates = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/SELECT 'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/SELECT id, status, payment_method, order_number/.test(s)) {
        return Promise.resolve({ rows: [{ id: OID, status: 'pending_payment', payment_method: 'pix', order_number: 42, company_id: CID }] });
      }
      if (/UPDATE digital_orders SET/.test(s)) {
        updates.push({ sql: s, params });
        return Promise.resolve({ rows: [{ id: OID, status: 'confirmed', payment_status: 'confirmed', vertical: 'studio' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(cadeia())
      .post(`/companies/${CID}/digital-channel/orders/${OID}/approve-payment`)
      .set('Authorization', 'Bearer ' + token)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/status = 'confirmed'/);
    expect(updates[0].sql).toMatch(/payment_status = 'confirmed'/);
    expect(updates[0].params).toEqual([OID, CID]);
  });

  test('reject-payment com motivo: cancela e grava o motivo', async () => {
    const updates = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/SELECT 'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/SELECT id, status FROM digital_orders/.test(s)) return Promise.resolve({ rows: [{ id: OID, status: 'awaiting_approval' }] });
      if (/UPDATE digital_orders SET/.test(s)) {
        updates.push({ sql: s, params });
        return Promise.resolve({ rows: [{ id: OID, status: 'cancelled' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(cadeia())
      .post(`/companies/${CID}/digital-channel/orders/${OID}/reject-payment`)
      .set('Authorization', 'Bearer ' + token)
      .send({ reason: 'Comprovante de outro valor' });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toBe(true);
    expect(updates[0].params[0]).toMatch(/Comprovante de outro valor/);
  });
});
