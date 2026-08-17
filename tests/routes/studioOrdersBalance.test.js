// ============================================================
// AURA. -- Testes: saldo a receber nos pedidos do Studio
//
// GET /studio/orders passa a expor o saldo em aberto da encomenda
// (venda com sinal / F2), pra que Kanban e lista de Pedidos mostrem
// "quanto ainda tenho a receber" sem depender da tela de Crediario --
// vocabulario que nao existe no mercado de personalizados.
//
// O que estes testes travam:
//   1. o saldo sai da parcela em aberto da venda (source='pdv')
//   2. ?with_balance=true filtra so quem tem saldo (aba "A receber")
//   3. parcela paga/cancelada/quitada nao conta como saldo
//   4. vencida vira 'overdue' -- e o que o selo pinta de vermelho
//   5. os 3 fallbacks (rich/slim/raw) devolvem o MESMO shape, pro app
//      nunca ter que checar se o campo existe
//   6. sem a tabela de parcelas, "A receber" devolve VAZIO -- nunca
//      a lista inteira, que faria parecer que todo pedido tem saldo
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

let db;
let app;

// O modulo cacheia a existencia de credit_installments em escopo de modulo
// (60s). Cada teste precisa de um require limpo pra escolher o cenario.
function buildApp() {
  jest.resetModules();
  process.env.JWT_SECRET = SECRET;
  db = require('../../src/config/database');
  const studioRouter = require('../../src/routes/studioKdsApproval');
  const a = express();
  a.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/studio', studioRouter);
  a.use('/api/v1/companies/:id', scoped);
  return a;
}

// hasTable: to_regclass devolve a tabela ou null.
// richFails: força a queda pro fallback slim.
// slimFails: força a queda pro fallback raw.
function mockDb({ hasTable = true, rows = [], richFails = false, slimFails = false } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/to_regclass/i.test(s)) {
      return Promise.resolve({ rows: [{ t: hasTable ? 'credit_installments' : null }] });
    }
    if (/FROM studio_orders/i.test(s)) {
      const isRich = /approval_count/i.test(s);
      if (isRich && richFails) return Promise.reject(Object.assign(new Error('rich boom'), { code: '42703' }));
      if (!isRich && slimFails) return Promise.reject(Object.assign(new Error('slim boom'), { code: '42P01' }));
      return Promise.resolve({ rows });
    }
    if (/FROM digital_orders/i.test(s)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

const get = (qs = '') => request(app).get(`/api/v1/companies/${cid}/studio/orders${qs}`).set(adminAuth);
const richSql = () => db.query.mock.calls.map((c) => String(c[0] || '')).find((s) => /approval_count/i.test(s)) || '';

const PEDIDO_COM_SALDO = {
  id: 'sale-1', source: 'pdv', pdv_sale_id: 'sale-1',
  customer_name: 'Maria Sheid', customer_phone: '11988887777',
  total_amount: '240.00', studio_production_status: 'pending_art',
  balance_installment_id: 'inst-1', balance_amount: '140.00',
  balance_due_date: '2026-08-24', balance_status: 'pending',
};

beforeEach(() => {
  jest.resetAllMocks();
  app = buildApp();
});

describe('GET /studio/orders — saldo a receber', () => {
  test('expõe o saldo da encomenda junto do pedido', async () => {
    mockDb({ rows: [PEDIDO_COM_SALDO] });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.orders[0]).toMatchObject({
      balance_installment_id: 'inst-1',
      balance_amount: '140.00',
      balance_due_date: '2026-08-24',
      balance_status: 'pending',
    });
  });

  test('o saldo vem da parcela EM ABERTO da venda, ignorando paga e cancelada', async () => {
    mockDb({ rows: [] });
    await get();

    const sql = richSql();
    expect(sql).toMatch(/credit_installments/i);
    expect(sql).toMatch(/ci\.sale_id\s*=\s*o\.pdv_sale_id/i);      // só o ramo de PDV
    expect(sql).toMatch(/ci\.company_id\s*=\s*o\.company_id/i);    // escopo por empresa
    expect(sql).toMatch(/NOT IN \('paid', 'cancelled'\)/i);
    expect(sql).toMatch(/covered_amount/i);                        // desconta o já pago
    expect(sql).toMatch(/ORDER BY ci\.due_date ASC/i);             // a mais antiga primeiro
  });

  test('vencida sai como overdue, no fuso de São Paulo', async () => {
    mockDb({ rows: [] });
    await get();

    const sql = richSql();
    expect(sql).toMatch(/America\/Sao_Paulo/);
    expect(sql).toMatch(/'overdue'/);
  });

  test('parcela quitada (covered == devido) não conta como saldo', async () => {
    mockDb({ rows: [] });
    await get();

    // limiar > 0.005 evita saldo residual de centavo virar cobrança
    expect(richSql()).toMatch(/>\s*0\.005/);
  });
});

describe('GET /studio/orders?with_balance=true — aba "A receber"', () => {
  test('filtra só encomendas com saldo em aberto', async () => {
    mockDb({ rows: [PEDIDO_COM_SALDO] });

    const res = await get('?with_balance=true');
    expect(res.status).toBe(200);
    expect(richSql()).toMatch(/bal\.installment_id IS NOT NULL/i);
  });

  test('sem o filtro, NÃO restringe por saldo', async () => {
    mockDb({ rows: [PEDIDO_COM_SALDO] });

    await get();
    expect(richSql()).not.toMatch(/bal\.installment_id IS NOT NULL/i);
  });

  // Sem a tabela, listar tudo faria parecer que todo pedido tem saldo.
  test('sem credit_installments, "A receber" devolve vazio — não a lista inteira', async () => {
    mockDb({ hasTable: false, rows: [PEDIDO_COM_SALDO] });

    const res = await get('?with_balance=true');
    expect(res.status).toBe(200);
    expect(richSql()).toMatch(/AND FALSE/i);
    expect(richSql()).not.toMatch(/credit_installments/i);
  });
});

describe('deploy parcial e degradação', () => {
  test('sem credit_installments a query rica não quebra: sai sem o LATERAL', async () => {
    mockDb({ hasTable: false, rows: [{ id: 'o1', source: 'digital' }] });

    const res = await get();
    expect(res.status).toBe(200);
    expect(richSql()).not.toMatch(/LEFT JOIN LATERAL/i);
    // shape preservado mesmo sem a tabela
    expect(res.body.orders[0]).toMatchObject({ balance_amount: null, balance_status: null });
  });

  test.each([
    ['slim', { richFails: true },                 'slim'],
    ['raw',  { richFails: true, slimFails: true }, 'raw'],
  ])('fallback %s mantém o mesmo shape de saldo', async (_label, opts, degraded) => {
    mockDb({ rows: [{ id: 'o1', customer_name: 'Maria' }], ...opts });

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(degraded);
    expect(res.body.orders[0]).toHaveProperty('balance_amount', null);
    expect(res.body.orders[0]).toHaveProperty('balance_due_date', null);
    expect(res.body.orders[0]).toHaveProperty('balance_installment_id', null);
    expect(res.body.orders[0]).toHaveProperty('balance_status', null);
  });

  test('401 sem token', async () => {
    mockDb({ rows: [] });
    const res = await request(app).get(`/api/v1/companies/${cid}/studio/orders`);
    expect(res.status).toBe(401);
  });
});
