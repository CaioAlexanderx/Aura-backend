// ============================================================
// AURA. — Test: PDV → Cliente → Funcionário connection
// ============================================================
// 29/05/2026: metricas do cliente (total_purchases/total_spent) deixaram de
// ser atualizadas por UPDATE manual no pdv.js -- agora sao mantidas pelo
// trigger trg_sale_update_customer (migration 137), fonte unica. Os testes
// abaixo verificam a AUSENCIA do UPDATE customers no pdv.js.
// As metricas de FUNCIONARIO (employees) continuam no codigo do pdv.js.
//
// 11/06/2026 (auditoria C2-BE): o cancelamento passou a reverter o crediario
// via cancelCreditSale (services/creditLedger), que emite suas proprias
// queries (SELECT customer_id + DELETEs + UPDATE installments + UPDATE
// credit_used).
//
// 18/08/2026 — CONVERTIDO PRA DESPACHO POR SQL.
//
// Antes, o mock era uma cadeia de ~39 mockResolvedValueOnce que codificava a
// SEQUENCIA EXATA das queries do handleSale. Toda query nova no fluxo de
// venda deslocava a fila inteira e o teste quebrava com 500 mudo, sem dizer
// o que mudou. O cabecalho deste arquivo e do integration/pdv.test.js
// registram duas correcoes assim (07/05 e 11/05) -- manutencao pura, sem
// nenhum bug encontrado.
//
// Pior: a fragilidade era INTERMITENTE. Nas fases F2, K1 e K3 foram
// adicionadas queries ao handleSale, e so a incondicional (K3) quebrou --
// as condicionais passaram batido. Um teste que reclama as vezes da falsa
// confianca de estar cobrindo.
//
// Agora o mock despacha por CONTEUDO DO SQL (convencao do CLAUDE.md), entao
// sobrevive a query nova e a reordenacao, e as assercoes falam do que
// importa: qual cliente foi gravado, qual metrica mexeu, o que foi revertido.
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

// Despacha por conteudo do SQL. `over` sobrescreve casos pontuais sem
// reescrever o dispatcher -- e por onde cada teste diz o que ha de diferente
// nele (funcionario inexistente, venda sem cliente, etc).
function despachar(over = {}) {
  mockClient.query.mockImplementation((sql) => {
    const s = String(sql || '');
    for (const [padrao, valor] of Object.entries(over)) {
      if (new RegExp(padrao, 'i').test(s)) return Promise.resolve(valor);
    }
    // assertCaixaOpenOrAllowed: caixa_enabled=false aprova sem checar sessoes
    if (/SELECT pdv_settings FROM companies/i.test(s)) {
      return Promise.resolve({ rows: [{ pdv_settings: { caixa_enabled: false } }] });
    }
    if (/FROM caixa_sessoes/i.test(s))        return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Corte', cost_price: 10, stock_qty: 50, stock_company_id: CID }] });
    }
    if (/FROM employees WHERE id/i.test(s))   return Promise.resolve({ rows: [{ id: EMP }] });
    if (/INSERT INTO sales/i.test(s)) {
      return Promise.resolve({ rows: [{ id: SALE, total_amount: 70, employee_id: EMP, customer_id: CUST }] });
    }
    // cancelamento
    if (/SELECT id, customer_id, employee_id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: SALE, customer_id: CUST, employee_id: EMP, total_amount: 70, status: 'completed' }] });
    }
    if (/FROM sale_items si LEFT JOIN products/i.test(s)) {
      return Promise.resolve({ rows: [{ product_id: PROD, variant_id: null, quantity: 1, stock_company_id: CID }] });
    }
    if (/SELECT customer_id FROM sales/i.test(s)) return Promise.resolve({ rows: [{ customer_id: CUST }] });
    return Promise.resolve({ rows: [] });
  });
}

const sqls = () => mockClient.query.mock.calls.map((c) => String(c[0] || ''));
const houve = (re) => sqls().some((s) => re.test(s));
const paramsDe = (re) => (mockClient.query.mock.calls.find((c) => re.test(String(c[0] || ''))) || [])[1];

beforeEach(() => { jest.clearAllMocks(); mockClient.query.mockReset(); db.query.mockReset(); });

describe('PDV → Cliente → Funcionário', () => {

  describe('POST /sale com customer_id + employee_id', () => {
    it('cria venda, grava o cliente e atualiza métrica do funcionário', async () => {
      despachar();
      db.query.mockResolvedValue({ rows: [{ id: 'i1', product_name: 'Corte' }] });

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 70 }], customer_id: CUST, employee_id: EMP, payment_method: 'pix' });

      expect(res.status).toBe(201);
      expect(res.body.sale.employee_id).toBe(EMP);
      expect(res.body.sale.customer_id).toBe(CUST);

      // O cliente foi gravado NA VENDA (2o parametro do INSERT), e nao só
      // devolvido no corpo — é o que a F5 corrigiu e precisa continuar valendo.
      expect(paramsDe(/INSERT INTO sales/i)[1]).toBe(CUST);

      // Métrica do cliente é do trigger trg_sale_update_customer (migration
      // 137). O pdv.js NÃO pode voltar a fazer UPDATE manual — duplicaria.
      expect(houve(/UPDATE customers SET total_purchases/i)).toBe(false);
      // Métrica do funcionário continua no código, e pro funcionário certo.
      expect(houve(/UPDATE employees SET total_sales/i)).toBe(true);
      expect(paramsDe(/UPDATE employees SET total_sales/i)).toContain(EMP);

      // A venda saiu do estoque e deixou rastro.
      expect(houve(/UPDATE products SET stock_qty/i)).toBe(true);
      expect(houve(/INSERT INTO stock_movements/i)).toBe(true);
    });

    it('cria venda sem cliente/funcionário (ambos opcionais)', async () => {
      despachar({
        'INSERT INTO sales': { rows: [{ id: SALE, total_amount: 50, employee_id: null, customer_id: null }] },
      });
      db.query.mockResolvedValue({ rows: [] });

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 50 }], payment_method: 'dinheiro' });

      expect(res.status).toBe(201);
      expect(paramsDe(/INSERT INTO sales/i)[1]).toBeNull();     // sem cliente
      expect(houve(/UPDATE customers/i)).toBe(false);
      expect(houve(/UPDATE employees SET total_sales/i)).toBe(false);
    });

    it('rejeita employee_id inválido, sem gravar venda nenhuma', async () => {
      despachar({ 'FROM employees WHERE id': { rows: [] } });   // funcionário não existe

      const res = await request(app)
        .post(`/companies/${CID}/pdv/sale`)
        .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 50 }], employee_id: 'fake', payment_method: 'dinheiro' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Funcionario');
      // A transação abortou antes de escrever — sem venda órfã.
      expect(houve(/INSERT INTO sales/i)).toBe(false);
      expect(houve(/ROLLBACK/i)).toBe(true);
    });
  });

  describe('DELETE /sale/:saleId (cancelamento)', () => {
    it('reverte estoque, métrica do funcionário e o crediário', async () => {
      despachar();

      const res = await request(app).delete(`/companies/${CID}/pdv/sale/${SALE}`);

      expect(res.status).toBe(200);
      expect(res.body.cancelled).toBe(SALE);

      // Métrica do cliente é recalculada pelo trigger 137 ao virar cancelled.
      expect(houve(/UPDATE customers.*GREATEST/is)).toBe(false);
      // A do funcionário continua revertida no código.
      expect(houve(/UPDATE employees.*GREATEST/is)).toBe(true);
      // Estoque volta.
      expect(houve(/UPDATE products SET stock_qty=stock_qty\+/i)).toBe(true);
      // C2-BE: crediário revertido via cancelCreditSale — debit + os "-rest-".
      expect(houve(/DELETE FROM customer_credit_transactions/i)).toBe(true);
      expect(houve(/DELETE FROM transactions.*LIKE/is)).toBe(true);
      // A venda fica marcada como cancelada.
      expect(houve(/UPDATE sales SET status='cancelled'/i)).toBe(true);
    });

    // Guarda da taxa da maquininha (17/08): sem isso, cancelar deixava a
    // despesa órfã — a receita sumia e o custo ficava.
    it('apaga a taxa da maquininha junto com a receita da venda', async () => {
      despachar();

      await request(app).delete(`/companies/${CID}/pdv/sale/${SALE}`);

      const del = mockClient.query.mock.calls.find((c) => /DELETE FROM transactions WHERE idempotency_key = ANY/i.test(String(c[0] || '')));
      expect(del).toBeDefined();
      expect(del[1][0]).toEqual(expect.arrayContaining([`pdv-sale-${SALE}`, `pdv-card-fee-${SALE}`]));
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
