// ============================================================
// AURA. — Test: PDV → Cliente → Funcionário connection
// ============================================================
// 29/05/2026: metricas do cliente (total_purchases/total_spent) deixaram de
// ser atualizadas por UPDATE manual no pdv.js -- agora sao mantidas pelo
// trigger trg_sale_update_customer (migration 137), fonte unica. Os testes
// abaixo passaram a verificar a AUSENCIA do UPDATE customers no pdv.js.
// As metricas de FUNCIONARIO (employees) continuam no codigo do pdv.js.
//
// 11/06/2026 (auditoria C2-BE): o cancelamento passou a reverter o crediario
// via cancelCreditSale (services/creditLedger), que emite suas proprias queries
// (SELECT customer_id + DELETEs + UPDATE installments + UPDATE credit_used). O
// mock do DELETE foi atualizado para cobrir essa sequencia.

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
    it('cria venda e atualiza metrica do funcionario (cliente via trigger 137)', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce(CAIXA_DISABLED_MOCK) // assertCaixaOpenOrAllowed: caixa_enabled=false
        .mockResolvedValueOnce({ rows: [{ name: 'Corte', cost_price: 10, stock_qty: 50 }] })
        .mockResolvedValueOnce({ rows: [{ id: EMP }] }) // employee check
        .mockResolvedValueOnce({ rows: [{ id: SALE, total_amount: 70, employee_id: EMP, customer_id: CUST }] })
        .mockResolvedValueOnce({}) // sale_item
        .mockResolvedValueOnce({}) // stock
        .mockResolvedValueOnce({}) // movement
        .mockResolvedValueOnce({}) // employee update (cliente NAO faz mais UPDATE manual)
        .mockResolvedValueOnce({}); // COMMIT
      db.query.mockResolvedValueOnce({ rows: [{ id: 'i1', product_name: 'Corte' }] });

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 70 }], customer_id: CUST, employee_id: EMP, payment_method: 'pix' });

      expect(res.status).toBe(201);
      expect(res.body.sale.employee_id).toBe(EMP);
      expect(res.body.sale.customer_id).toBe(CUST);
      const calls = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
      // Metrica do cliente e mantida pelo trigger trg_sale_update_customer (migration 137),
      // por isso o pdv.js NAO deve mais conter UPDATE customers.
      expect(calls.some(c => c.includes('UPDATE customers SET total_purchases'))).toBe(false);
      // Metrica do funcionario continua no codigo do pdv.js.
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
    it('reverte metrica do funcionario + crediario via cancelCreditSale (cliente via trigger 137)', async () => {
      mockClient.query
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: SALE, customer_id: CUST, employee_id: EMP, total_amount: 70 }] }) // SELECT sale
        .mockResolvedValueOnce({ rows: [{ product_id: PROD, variant_id: null, quantity: 1 }] }) // SELECT items
        .mockResolvedValueOnce({}) // stock revert (UPDATE products)
        .mockResolvedValueOnce({}) // INSERT stock_movements
        .mockResolvedValueOnce({}) // employee revert (cliente NAO faz mais UPDATE manual)
        .mockResolvedValueOnce({}) // DELETE tx pdv-sale (caixa)
        // cancelCreditSale(client, {...}):
        .mockResolvedValueOnce({ rows: [{ customer_id: CUST }] }) // SELECT customer_id FROM sales
        .mockResolvedValueOnce({}) // DELETE customer_credit_transactions debit
        .mockResolvedValueOnce({}) // DELETE transactions A Receber exata
        .mockResolvedValueOnce({}) // DELETE transactions -rest- (LIKE)
        .mockResolvedValueOnce({}) // UPDATE credit_installments cancelled
        .mockResolvedValueOnce({}) // UPDATE customer_credit_profiles (credit_used)
        // de volta no route:
        .mockResolvedValueOnce({}) // mark cancelled (UPDATE sales)
        .mockResolvedValueOnce({}); // COMMIT

      const res = await request(app).delete(`/companies/${CID}/pdv/sale/${SALE}`);

      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(SALE);
      const calls = mockClient.query.mock.calls.map(c => typeof c[0] === 'string' ? c[0] : '');
      // Metrica do cliente e recalculada pelo trigger 137 ao mudar status -> cancelled.
      // pdv.js NAO deve mais conter UPDATE customers no cancelamento.
      expect(calls.some(c => c.includes('UPDATE customers') && c.includes('GREATEST'))).toBe(false);
      // Metrica do funcionario continua revertida no codigo.
      expect(calls.some(c => c.includes('UPDATE employees') && c.includes('GREATEST'))).toBe(true);
      // C2-BE: reversao do crediario via cancelCreditSale — remove debit + os -rest- (LIKE).
      expect(calls.some(c => /DELETE FROM customer_credit_transactions/i.test(c) && /'debit'/i.test(c))).toBe(true);
      expect(calls.some(c => /DELETE FROM transactions/i.test(c) && /LIKE/i.test(c))).toBe(true);
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
