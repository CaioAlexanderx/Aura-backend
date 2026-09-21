// ============================================================
// POST /sales/:id/cancel — devolução do crediário (16/09/2026)
// Caso MHT / Karina Quadros: devolução cancelada deixava crédito e estoque;
// venda cancelada com devolução ativa repunha o item duas vezes.
//
//   1. venda com devolução ativa: 409 SALE_HAS_ACTIVE_RETURN, nada muda
//   2. cancelar a devolução chama o desfazer e devolve o resumo
//   3. recusa do desfazer (devolução antiga) chega ao app com o code
//   4. venda sem devolução segue o cancelamento de sempre
// O desfazer em si é coberto com Postgres real em
// credito.cancelarDevolucao.banco.test.js.
// ============================================================
jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const mockCancelDevolucao = jest.fn();
const mockActiveReturnsOf = jest.fn();
jest.mock('../src/services/credit/refund', () => ({
  refundCreditSale: jest.fn(),
  cancelDevolucao: (...a) => mockCancelDevolucao(...a),
  activeReturnsOf: (...a) => mockActiveReturnsOf(...a),
}));

const CID = 'comp-1';
const SALE = 'sale-34';
const DEV = 'dev-40';

const client = { query: jest.fn(), release: jest.fn() };
db.connect = jest.fn().mockResolvedValue(client);

const router = require('../src/routes/sales');
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'u1' }; next(); });
app.use('/companies/:id/sales', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));

function despachar(tipo) {
  client.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM sales WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(s)) {
      return Promise.resolve({ rows: [{ id: tipo === 'devolucao' ? DEV : SALE, total_amount: tipo === 'devolucao' ? -120 : 290, status: 'completed', type: tipo }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}
const houve = (re) => client.query.mock.calls.some(([s]) => re.test(String(s)));

beforeEach(() => {
  jest.clearAllMocks();
  client.query.mockReset();
  mockActiveReturnsOf.mockResolvedValue([]);
  mockCancelDevolucao.mockResolvedValue({ credit_removed: 120, stock_removed: [{ product_id: 'p', quantity: 1 }] });
});

test('1. venda com devolução ativa: 409 com code, sem cancelar nada', async () => {
  despachar('sale');
  mockActiveReturnsOf.mockResolvedValue([{ id: DEV, sale_number: 40, type: 'devolucao' }]);

  const res = await request(app).post(`/companies/${CID}/sales/${SALE}/cancel`).send({});

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('SALE_HAS_ACTIVE_RETURN');
  expect(res.body.error).toContain('#40');
  expect(houve(/UPDATE sales SET status = 'cancelled'/)).toBe(false);
  expect(houve(/UPDATE products SET stock_qty/)).toBe(false);
  expect(houve(/^ROLLBACK/)).toBe(true);
  expect(mockActiveReturnsOf).toHaveBeenCalledWith(client, { companyId: CID, saleId: SALE });
});

test('2. cancelar a devolução desfaz e devolve o resumo', async () => {
  despachar('devolucao');

  const res = await request(app).post(`/companies/${CID}/sales/${DEV}/cancel`).send({});

  expect(res.status).toBe(200);
  expect(mockCancelDevolucao).toHaveBeenCalledWith(client, { companyId: CID, devolucaoSaleId: DEV });
  expect(mockActiveReturnsOf).not.toHaveBeenCalled();
  expect(res.body.devolucao_undo).toEqual(expect.objectContaining({ credit_removed: 120 }));
  expect(houve(/UPDATE sales SET status = 'cancelled'/)).toBe(true);
  expect(houve(/^COMMIT/)).toBe(true);
});

test('3. recusa do desfazer chega com o code, sem cancelar', async () => {
  despachar('devolucao');
  const e = new Error('antiga');
  e.isRefundError = true; e.status = 409;
  e.body = { error: 'Esta devolução é anterior ao registro...', code: 'DEVOLUCAO_SEM_REGISTRO' };
  mockCancelDevolucao.mockRejectedValue(e);

  const res = await request(app).post(`/companies/${CID}/sales/${DEV}/cancel`).send({});

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('DEVOLUCAO_SEM_REGISTRO');
  expect(houve(/UPDATE sales SET status = 'cancelled'/)).toBe(false);
  expect(houve(/^COMMIT/)).toBe(false);
});

test('4. venda sem devolução: cancelamento de sempre', async () => {
  despachar('sale');

  const res = await request(app).post(`/companies/${CID}/sales/${SALE}/cancel`).send({});

  expect(res.status).toBe(200);
  expect(mockCancelDevolucao).not.toHaveBeenCalled();
  expect(res.body.devolucao_undo).toBeNull();
  expect(houve(/UPDATE sales SET status = 'cancelled'/)).toBe(true);
});
