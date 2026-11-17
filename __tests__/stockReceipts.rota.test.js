// ============================================================
// AURA. — POST/GET /products/stock-receipts sem banco (B2a/B3, 17/11/2026)
//
// O Postgres real está em stockReceipts.banco.test.js. Aqui, o que não
// precisa dele:
//   1. leitura do corpo: chave obrigatória, origem, chave da NF-e, limite de
//      300, linha com problema (index = posição), sem ir ao banco
//   2. base sem a migration 457: 503 SCHEMA_PENDENTE (padrão da casa)
//   3. a rota monta antes do /:pid curinga de ./products (via private.js)
//   4. o plano (sem banco): o produto repetido soma em ordem, como duas
//      entradas seguidas
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const { planejarEntradaEmLote } = require('../src/services/entradaEmLote');
const { lerEntrada } = require('../src/services/entradaDeMercadoria');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BASE = `/companies/${COMPANY}/products/stock-receipts`;
const token = () => jwt.sign({ id: 'dono', role: 'client', plan: 'essencial', company: COMPANY }, 'aura-test-secret-2026', { expiresIn: '1h' });

let montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
}, 60000);

let sqls;
function banco(extra = () => null) {
  sqls = [];
  const handler = (sql, params = []) => {
    const s = String(sql);
    sqls.push(s);
    const e = extra(s, params);
    if (e) return e;
    if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/AS is_owner/.test(s)) return Promise.resolve({ rows: [{ is_owner: true, role_label: null, permissions: null }] });
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  db.query.mockImplementation(handler);
  db.connect.mockImplementation(async () => ({ query: jest.fn(handler), release: jest.fn() }));
}
beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); });

const post = (body, chave) => {
  const r = request(montado).post(BASE).set('Authorization', `Bearer ${token()}`);
  if (chave) r.set('Idempotency-Key', chave);
  return r.send(body);
};
const CHAVE = 'chegou-0001-abcd';

describe('leitura do corpo (nada vai ao banco de estoque)', () => {
  const tocouNoEstoque = () => sqls.some((s) => /stock_receipts|FROM products|stock_movements/.test(s));

  test('sem chave: 400 SEM_CHAVE', async () => {
    banco();
    const r = await post({ items: [{ product_id: PID, quantity: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SEM_CHAVE');
    expect(tocouNoEstoque()).toBe(false);
  });

  test('origem, chave da NF-e, itens vazios', async () => {
    banco();
    expect((await post({ idempotency_key: CHAVE, origin: 'pix', items: [{ product_id: PID, quantity: 1 }] })).status).toBe(400);
    expect((await post({ idempotency_key: CHAVE, nfe_key: '123', items: [{ product_id: PID, quantity: 1 }] })).status).toBe(400);
    expect((await post({ idempotency_key: CHAVE, items: [] })).status).toBe(400);
    expect(tocouNoEstoque()).toBe(false);
  });

  test('301 itens: 400 LIMITE_DE_LINHAS', async () => {
    banco();
    const r = await post({ items: Array.from({ length: 301 }, () => ({ product_id: PID, quantity: 1 })) }, CHAVE);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'LIMITE_DE_LINHAS', limit: 300 });
  });

  test('linhas com problema voltam com a posição', async () => {
    banco();
    const r = await post({ idempotency_key: CHAVE, items: [
      { product_id: PID, quantity: 1 },
      { product_id: 'x', quantity: 1 },
      { product_id: PID, quantity: 0 },
      { product_id: PID, variants: [{ variant_id: 'v', quantity: 1 }] },
    ] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('LINHAS_COM_ERRO');
    expect(r.body.lines.map((l) => l.index)).toEqual([1, 2, 3]);
    expect(tocouNoEstoque()).toBe(false);
  });
});

test('base sem a migration 457: 503 SCHEMA_PENDENTE', async () => {
  banco((s) => (/INSERT INTO stock_receipts/.test(s)
    ? Promise.reject(Object.assign(new Error('relation "stock_receipts" does not exist'), { code: '42P01' }))
    : null));
  const r = await post({ idempotency_key: CHAVE, items: [{ product_id: PID, quantity: 1 }] });
  expect(r.status).toBe(503);
  expect(r.body.code).toBe('SCHEMA_PENDENTE');
});

test('GET /products/stock-receipts chega na rota nova (não no /:pid de ./products)', async () => {
  banco((s) => (/FROM stock_receipts r/.test(s) ? Promise.resolve({ rows: [{ id: 'r1' }] }) : null));
  const r = await request(montado).get(`${BASE}?invoice_number=12`).set('Authorization', `Bearer ${token()}`);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ receipts: [{ id: 'r1' }], legacy: [] });
});

test('GET sem a migration: só as entradas antigas, com indisponivel', async () => {
  banco((s) => (/FROM stock_receipts r/.test(s)
    ? Promise.reject(Object.assign(new Error('nope'), { code: '42P01' }))
    : null));
  const r = await request(montado).get(`${BASE}?invoice_number=12`).set('Authorization', `Bearer ${token()}`);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ receipts: [], legacy: [], indisponivel: true });
});

describe('plano (sem banco)', () => {
  test('produto repetido: duas entradas seguidas; cost_price pela última com update_cost', () => {
    const produtos = new Map([[PID, { id: PID, company_id: COMPANY, name: 'Capa', stock_qty: '4.000', cost_price: '5.50', weighted_avg_cost: null }]]);
    const linhas = [
      { index: 0, product_id: PID, entrada: lerEntrada({ quantity: 20, unit_cost: 5.9 }), supplierCode: 'A1' },
      { index: 1, product_id: PID, entrada: lerEntrada({ quantity: 6 }), supplierCode: null },
      { index: 2, product_id: PID, entrada: lerEntrada({ quantity: 2, unit_cost: 6.1, update_cost: false }), supplierCode: null },
    ];
    const plano = planejarEntradaEmLote({ produtos, variantes: new Map(), linhas });
    expect(plano.porLinha.map((l) => [l.before, l.after])).toEqual([
      [{ stock_qty: 4, avg_cost: 5.5 }, { stock_qty: 24, avg_cost: 5.8333 }],
      [{ stock_qty: 24, avg_cost: 5.8333 }, { stock_qty: 30, avg_cost: 5.8333 }],
      [{ stock_qty: 30, avg_cost: 5.8333 }, { stock_qty: 32, avg_cost: 5.85 }],
    ]);
    expect(plano.estoqueProduto).toEqual([{ id: PID, q: 32 - 4 }]);
    expect(plano.custo).toEqual([{ id: PID, avg: 5.85, alvo: 5.8333 }]);
    expect(plano.produtos).toEqual([{ id: PID, company_id: COMPANY, ultimoCusto: 6.1, codigo: 'A1' }]);
    expect(plano.movimentos.map((m) => [m.q, m.c])).toEqual([[20, 5.9], [6, null], [2, 6.1]]);
  });
});
