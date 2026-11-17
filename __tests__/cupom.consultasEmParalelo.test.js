// ============================================================
// Cupom do Caixa: as consultas do _loadSaleData saem juntas (p-162,
// 17/11/2026). Cada ida ao banco custa ~190 ms; em fila eram 5 a 6 antes
// do HTML. O HTML nao muda (cupom.logoDaLoja.test.js trava byte a byte).
//   (1) as 5 consultas sao disparadas antes de qualquer uma responder;
//   (2) erro nas parcelas nao derruba o cupom de venda fora do crediario;
//   (3) no crediario, erro de verdade nas parcelas continua dando erro;
//       tabela ausente (42P01) continua ignorada.
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const LOJA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const VENDA = '5b1d3f0a-0000-4000-8000-000000000162';

const app = express();
app.use('/companies/:id/print', require('../src/routes/print'));

function resposta(sql, { pagamento = 'pix', erroParcelas = null } = {}) {
  const s = String(sql || '');
  if (/FROM companies WHERE id/i.test(s)) return { rows: [{ trade_name: 'Loja', legal_name: 'Loja LTDA' }] };
  if (/FROM sales s/i.test(s)) return { rows: [{ id: VENDA, total_amount: '50.00', created_at: '2026-11-17T15:00:00.000Z', payment_method: pagamento }] };
  if (/FROM sale_items/i.test(s)) return { rows: [{ product_name: 'Blusa', quantity: 1, unit_price: 50, total_price: 50, discount: 0 }] };
  if (/FROM sale_payments/i.test(s)) return { rows: [{ method: pagamento, amount: '50.00' }] };
  if (/FROM credit_installments/i.test(s)) {
    if (erroParcelas) throw erroParcelas;
    return { rows: [{ installment_number: 1, total_installments: 1, amount_due: '50.00', due_date_br: '17/12/2026' }] };
  }
  return { rows: [] };
}

beforeEach(() => db.query.mockReset());

test('(1) as 5 consultas saem juntas, antes de qualquer resposta', async () => {
  const pendentes = [];
  let disparadasAntesDaPrimeiraResposta = null;
  db.query.mockImplementation((sql) => new Promise((resolve, reject) => {
    pendentes.push(() => { try { resolve(resposta(sql)); } catch (e) { reject(e); } });
    // Libera tudo no proximo tick: se o codigo esperasse uma resposta antes
    // de disparar a seguinte, so haveria 1 consulta pendente aqui.
    if (pendentes.length === 1) {
      setTimeout(() => {
        disparadasAntesDaPrimeiraResposta = pendentes.length;
        pendentes.splice(0).forEach((f) => f());
      }, 0);
    }
  }));
  const res = await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`);
  expect(res.status).toBe(200);
  expect(disparadasAntesDaPrimeiraResposta).toBe(5);
});

test('(2) erro nas parcelas nao derruba o cupom fora do crediario', async () => {
  db.query.mockImplementation(async (sql) => resposta(sql, { erroParcelas: Object.assign(new Error('boom'), { code: '57014' }) }));
  const res = await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('Blusa');
});

test('(3a) crediario: tabela ausente segue ignorada', async () => {
  db.query.mockImplementation(async (sql) => resposta(sql, { pagamento: 'crediario', erroParcelas: Object.assign(new Error('no table'), { code: '42P01' }) }));
  const res = await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`);
  expect(res.status).toBe(200);
});

test('(3b) crediario: erro de verdade nas parcelas continua sendo erro', async () => {
  db.query.mockImplementation(async (sql) => resposta(sql, { pagamento: 'crediario', erroParcelas: Object.assign(new Error('boom'), { code: '57014' }) }));
  const res = await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`);
  expect(res.status).toBeGreaterThanOrEqual(500);
});

test('(3c) crediario: parcelas saem no cupom', async () => {
  db.query.mockImplementation(async (sql) => resposta(sql, { pagamento: 'crediario' }));
  const res = await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`);
  expect(res.status).toBe(200);
  expect(res.text).toContain('17/12/2026');
});
