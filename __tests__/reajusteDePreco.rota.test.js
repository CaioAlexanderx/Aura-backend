// ============================================================
// AURA. — Reajuste de preco em lote: rota sem banco (p-51)
// Aplicar antes da migration 422 = 503 MIGRATION_PENDING (nada gravado);
// a previa nao depende da 422. PR 2: lista vazia e desfazer 503 sem ela.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const CID = '11111111-1111-4111-8111-111111111111';
const PID = '00000000-0000-4000-8000-000000000001';
const produto = { id: PID, company_id: CID, name: 'P', sku: null, price: '100.00', cost_price: '50.00', card_price: null, is_group_shared: false };

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = { id: 'u1', role: 'client' }; next(); });
  a.use('/companies/:id/products', require('../src/routes/productPriceAdjustments'));
  return a;
}

function responder(sql) {
  if (/COUNT\(\*\)::int AS n FROM companies/.test(sql)) return { rows: [{ n: 1 }] };
  if (/FROM products p/.test(sql)) return { rows: [produto] };
  if (/FROM product_variants pv/.test(sql)) return { rows: [] };
  if (/INSERT INTO product_price_adjustments/.test(sql)) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
  return { rows: [] };
}

beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); });

test('previa funciona sem a 422', async () => {
  db.query.mockImplementation(async (sql) => responder(sql));
  const r = await request(app()).post(`/companies/${CID}/products/price-adjustments`)
    .send({ product_ids: [PID], mode: 'percent', direction: 'up', value: 10 });
  expect(r.status).toBe(200);
  expect(r.body.items[0].price_after).toBe(110);
});

test('aplicar sem a 422 = 503 MIGRATION_PENDING com ROLLBACK', async () => {
  const chamadas = [];
  db.connect.mockResolvedValue({
    query: jest.fn(async (sql) => { chamadas.push(String(sql).trim().split(/\s+/)[0]); return responder(sql); }),
    release: jest.fn(),
  });
  const r = await request(app()).post(`/companies/${CID}/products/price-adjustments`)
    .send({ product_ids: [PID], mode: 'percent', direction: 'up', value: 10, dry_run: false });
  expect(r.status).toBe(503);
  expect(r.body.code).toBe('MIGRATION_PENDING');
  expect(chamadas).toContain('ROLLBACK');
  expect(chamadas).not.toContain('COMMIT');
  expect(chamadas).not.toContain('UPDATE');
});

// PR 2: lista sem a 422 nunca e erro; desfazer sem a 422 = 503.
function tabelaAusente() { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }

test('lista sem a 422 devolve vazio', async () => {
  db.query.mockImplementation(async () => tabelaAusente());
  const r = await request(app()).get(`/companies/${CID}/products/price-adjustments`);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ adjustments: [], total: 0 });
});

test('desfazer sem a 422 = 503 MIGRATION_PENDING', async () => {
  db.connect.mockResolvedValue({
    query: jest.fn(async (sql) => (/product_price_adjustments/.test(sql) ? tabelaAusente() : { rows: [] })),
    release: jest.fn(),
  });
  const r = await request(app()).post(`/companies/${CID}/products/price-adjustments/${PID}/undo`).send();
  expect(r.status).toBe(503);
  expect(r.body.code).toBe('MIGRATION_PENDING');
});
