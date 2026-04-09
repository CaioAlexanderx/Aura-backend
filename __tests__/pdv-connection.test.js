// ============================================================
// AURA. — Test: PDV → Cliente → Funcionário connection
// Validates: sale with customer_id updates customer.total_spent
//            sale with employee_id updates employee.total_sales/total_revenue
//            cancel reverts both metrics
// ============================================================

jest.mock('../config/database');
const db = require('../config/database');
const express = require('express');
const request = require('supertest');

// Setup mock chain
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};
db.connect = jest.fn().mockResolvedValue(mockClient);
db.query = jest.fn();

// Auth + company access mocks
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => { next(); },
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const pdvRouter = require('../routes/pdv');
const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);

const COMPANY_ID = 'comp-1';
const CUSTOMER_ID = 'cust-1';
const EMPLOYEE_ID = 'emp-1';
const PRODUCT_ID = 'prod-1';
const SALE_ID = 'sale-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.release.mockReset();
  db.query.mockReset();
});

describe('PDV → Cliente → Funcionário', () => {

  describe('POST /sale with customer_id + employee_id', () => {
    it('creates sale and updates both customer and employee metrics', async () => {
      // Mock: requireCompanyAccess
      db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      // Setup transaction mocks in order:
      mockClient.query
        // BEGIN
        .mockResolvedValueOnce({})
        // Product lookup
        .mockResolvedValueOnce({ rows: [{ name: 'Corte', cost_price: 10, stock_qty: 50 }] })
        // Employee validation
        .mockResolvedValueOnce({ rows: [{ id: EMPLOYEE_ID }] })
        // INSERT sale
        .mockResolvedValueOnce({ rows: [{ id: SALE_ID, total_amount: 70, employee_id: EMPLOYEE_ID, customer_id: CUSTOMER_ID }] })
        // INSERT sale_item
        .mockResolvedValueOnce({})
        // UPDATE product stock
        .mockResolvedValueOnce({})
        // INSERT stock_movement
        .mockResolvedValueOnce({})
        // UPDATE customer metrics
        .mockResolvedValueOnce({})
        // UPDATE employee metrics
        .mockResolvedValueOnce({})
        // COMMIT
        .mockResolvedValueOnce({});

      // GET sale items after commit
      db.query.mockResolvedValueOnce({ rows: [{ id: 'item-1', product_name: 'Corte' }] });

      const res = await request(app)
        .post(`/companies/${COMPANY_ID}/pdv/sale`)
        .send({
          items: [{ product_id: PRODUCT_ID, quantity: 1, unit_price: 70 }],
          customer_id: CUSTOMER_ID,
          employee_id: EMPLOYEE_ID,
          payment_method: 'pix',
        });

      expect(res.status).toBe(201);
      expect(res.body.sale).toBeDefined();
      expect(res.body.sale.employee_id).toBe(EMPLOYEE_ID);
      expect(res.body.sale.customer_id).toBe(CUSTOMER_ID);

      // Verify customer metrics update was called
      const customerUpdateCall = mockClient.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE customers SET total_purchases')
      );
      expect(customerUpdateCall).toBeDefined();
      expect(customerUpdateCall[1]).toContain(CUSTOMER_ID);

      // Verify employee metrics update was called
      const employeeUpdateCall = mockClient.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE employees SET total_sales')
      );
      expect(employeeUpdateCall).toBeDefined();
      expect(employeeUpdateCall[1]).toContain(EMPLOYEE_ID);
    });

    it('creates sale without customer/employee (both optional)', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ name: 'Produto X', cost_price: 5, stock_qty: 10 }] })
        .mockResolvedValueOnce({ rows: [{ id: SALE_ID, total_amount: 50, employee_id: null, customer_id: null }] })
        .mockResolvedValueOnce({}) // sale_item
        .mockResolvedValueOnce({}) // stock update
        .mockResolvedValueOnce({}) // stock_movement
        .mockResolvedValueOnce({}); // COMMIT

      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post(`/companies/${COMPANY_ID}/pdv/sale`)
        .send({
          items: [{ product_id: PRODUCT_ID, quantity: 1, unit_price: 50 }],
          payment_method: 'dinheiro',
        });

      expect(res.status).toBe(201);

      // No customer/employee update should be called
      const customerCall = mockClient.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE customers')
      );
      const employeeCall = mockClient.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE employees')
      );
      expect(customerCall).toBeUndefined();
      expect(employeeCall).toBeUndefined();
    });

    it('rejects invalid employee_id', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ name: 'Produto', cost_price: 5, stock_qty: 10 }] })
        .mockResolvedValueOnce({ rows: [] }) // Employee NOT found
        .mockResolvedValueOnce({}); // ROLLBACK

      const res = await request(app)
        .post(`/companies/${COMPANY_ID}/pdv/sale`)
        .send({
          items: [{ product_id: PRODUCT_ID, quantity: 1, unit_price: 50 }],
          employee_id: 'fake-emp',
          payment_method: 'dinheiro',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Funcionario');
    });
  });

  describe('DELETE /sale/:saleId (cancel)', () => {
    it('reverts customer and employee metrics on cancel', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        // Sale lookup with customer + employee
        .mockResolvedValueOnce({ rows: [{
          id: SALE_ID, customer_id: CUSTOMER_ID, employee_id: EMPLOYEE_ID, total_amount: 70
        }] })
        // Sale items (for stock revert)
        .mockResolvedValueOnce({ rows: [{ product_id: PRODUCT_ID, variant_id: null, quantity: 1 }] })
        // Revert stock
        .mockResolvedValueOnce({})
        // Revert customer metrics
        .mockResolvedValueOnce({})
        // Revert employee metrics
        .mockResolvedValueOnce({})
        // Mark sale as cancelled
        .mockResolvedValueOnce({})
        // COMMIT
        .mockResolvedValueOnce({});

      const res = await request(app)
        .delete(`/companies/${COMPANY_ID}/pdv/sale/${SALE_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(SALE_ID);

      // Verify customer revert
      const custRevert = mockClient.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE customers') && c[0].includes('GREATEST')
      );
      expect(custRevert).toBeDefined();

      // Verify employee revert
      const empRevert = mockClient.query.mock.calls.find(c =>
        typeof c[0] === 'string' && c[0].includes('UPDATE employees') && c[0].includes('GREATEST')
      );
      expect(empRevert).toBeDefined();
    });
  });

  describe('GET /employee-ranking', () => {
    it('returns sales ranking by employee', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ role: 'owner' }] })
        .mockResolvedValueOnce({ rows: [
          { id: 'emp-1', name: 'Carlos', role: 'Barbeiro', sales_count: '5', total_revenue: '350.00', avg_ticket: '70.00', last_sale_at: '2026-04-09' },
          { id: 'emp-2', name: 'Ana', role: 'Atendente', sales_count: '3', total_revenue: '180.00', avg_ticket: '60.00', last_sale_at: '2026-04-08' },
        ] });

      const res = await request(app)
        .get(`/companies/${COMPANY_ID}/pdv/employee-ranking?period=30d`);

      expect(res.status).toBe(200);
      expect(res.body.period).toBe('30d');
      expect(res.body.employees).toHaveLength(2);
      expect(res.body.employees[0].name).toBe('Carlos');
      expect(parseFloat(res.body.employees[0].total_revenue)).toBe(350);
    });
  });
});
