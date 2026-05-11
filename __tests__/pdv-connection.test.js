// ============================================================
// AURA. — Test: PDV → Cliente → Funcionário connection
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const mockClient = { query: jest.fn(), release: jest.fn() };
db.connect = jest.fn().mockResolvedValue(mockClient);
db.query = jest.fn();

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const pdvRouter = require('../src/routes/pdv');
const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);

const CID = 'comp-1', CUST = 'cust-1', EMP = 'emp-1', PROD = 'prod-1', SALE = 'sale-1';

// Helper: mock padrao para assertCaixaOpenOrAllowed (PR Aura-backend#56).
// Retorna caixa_enabled=false → helper aprova sem checar sessoes.
// Usar logo apos o BEGIN em cada teste de POST /sale e POST /troca.
const CAIXA_DISABLED_MOCK = { rows: [{ pdv_settings: { caixa_enabled: false } }] };

beforeEach(() => { jest.clearAllMocks(); mockClient.query.mockReset(); db.query.mockReset(); });

describe('PDV → Cliente → Funcionário', () => {

  describe('POST /sale com customer_id + employee_id', () => {
    it('cria venda e atualiza métricas do cliente e funcionário', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(CAIXA_DISABLED_MOCK) // assertCaixaOpenOrAllowed: caixa_enabled=false
        .mockResolvedValueOnce({ rows: [{ name: 'Corte', cost_price: 10, stock_qty: 50 }] })
        .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // employee check
        .mockResolvedValueOnce({ rows: [{ id: SALE, total_amount: 70, employee_id: EMP, customer_id: CUST }] })
        .mockResolvedValueOnce({}) // sale_item
        .mockResolvedValueOnce({}) // stock
        .mockResolvedValueOnce({}) // movement
        .mockResolvedValueOnce({}) // customer update
        .mockResolvedValueOnce({}) // employee update
        .mockResolvedValueOnce({}); // COMMIT
      db.query.mockResolvedValueOnce({ rows: [{ id: 'i1', product_name: 'Corte' }] });

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 70 }], customer_id: CUST, employee_id: EMP, payment_method: 'pix' });

      expect(res.status).toBe(201);
      expect(res.body.sale.employee_id).toBe(EMP);
      expect(res.body.sale.customer_id).toBe(CUST);
      const calls = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
      expect(calls.some(c => c.includes('UPDATE customers SET total_purchases'))).toBe(true);
      expect(calls.some(c => c.includes('UPDATE employees SET total_sales'))).toBe(true);
    });

    it('cria venda sem cliente/funcionário (ambos opcionais)', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(CAIXA_DISABLED_MOCK) // assertCaixaOpenOrAllowed: caixa_enabled=false
        .mockResolvedValueOnce({ rows: [{ name: 'X', cost_price: 5, stock_qty: 10 }] })
        .mockResolvedValueOnce({ rows: [{ id: SALE, total_amount: 50, employee_id: null, customer_id: null }] })
        .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({})
        .mockResolvedValueOnce({}); // COMMIT
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 50 }], payment_method: 'dinheiro' });

      expect(res.status).toBe(201);
      const calls = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
      expect(calls.some(c => c.includes('UPDATE customers'))).toBe(false);
      expect(calls.some(c => c.includes('UPDATE employees SET total_sales'))).toBe(false);
    });

    it('rejeita employee_id inválido', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(CAIXA_DISABLED_MOCK) // assertCaixaOpenOrAllowed: caixa_enabled=false
        .mockResolvedValueOnce({ rows: [{ name: 'P', cost_price: 5, stock_qty: 10 }] })
        .mockResolvedValueOnce({ rows: [] }) // employee NOT found
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 50 }], employee_id: 'fake', payment_method: 'dinheiro' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Funcionario');
    });
  });

  describe('DELETE /sale/:saleId (cancelamento)', () => {
    it('reverte métricas do cliente e funcionário', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: SALE, customer_id: CUST, employee_id: EMP, total_amount: 70 }] })
        .mockResolvedValueOnce({ rows: [{ product_id: PROD, variant_id: null, quantity: 1 }] })
        .mockResolvedValueOnce({}) // stock revert
        .mockResolvedValueOnce({}) // customer revert
        .mockResolvedValueOnce({}) // employee revert
        .mockResolvedValueOnce({}) // mark cancelled
        .mockResolvedValueOnce({}); // COMMIT

      const res = await request(app).delete(`/companies/${CID}/pdv/sale/${SALE}`);

      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(SALE);
      const calls = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
      expect(calls.some(c => c.includes('UPDATE customers') && c.includes('GREATEST'))).toBe(true);
      expect(calls.some(c => c.includes('UPDATE employees') && c.includes('GREATEST'))).toBe(true);
    });
  });

  describe('GET /employee-ranking', () => {
    it('retorna ranking de vendas por funcionário', async () => {
      db.query.mockResolvedValueOnce({ rows: [
        { id: 'e1', name: 'Carlos', role: 'Barbeiro', sales_count: '5', total_revenue: '350.00', avg_ticket: '70.00' },
        { id: 'e2', name: 'Ana', role: 'Atendente', sales_count: '3', total_revenue: '180.00', avg_ticket: '60.00' },
      ] });

      const res = await request(app).get(`/companies/${CID}/pdv/employee-ranking?period=30d`);

      expect(res.status).toBe(200);
      expect(res.body.period).toBe('30d');
      expect(res.body.employees).toHaveLength(2);
      expect(res.body.employees[0].name).toBe('Carlos');
    });
  });
});
