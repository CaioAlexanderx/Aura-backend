// ============================================================
// AURA. — Caixa enxerga o grupo como o Estoque (02/11/2026) — Postgres real
//
// O Estoque (products.js) lista o produto compartilhado nos dois sentidos:
// a filial vê o da matriz e a matriz vê o da filial. O bipe (scanner.js),
// a venda (pdv.js) e a troca (trocaV2.js) só enxergavam matriz → filial:
// a matriz via o produto da filial no Estoque e o Caixa dizia "não achei".
// Agora os quatro usam a mesma função (utils/companyGroup.js).
//
// O que este arquivo trava:
//   1. bipe: matriz acha o compartilhado da filial (produto e variante);
//      filial acha o da matriz (como antes); não compartilhado e empresa de
//      fora do grupo não aparecem; o produto da própria loja ganha quando o
//      código se repete no grupo
//   2. venda: matriz vende o da filial e a baixa cai na linha da filial
//      (produto é uma linha só para o grupo); variante idem; filial vende o
//      da matriz como antes; venda de fora do grupo não mexe no estoque
//   3. troca: o item novo da filial baixa estoque quando a troca é na
//      matriz; de fora do grupo cai em estoque insuficiente
//
// Fixtures com COMMIT de verdade (a venda abre a própria transação), uuid
// próprio, apagadas no afterAll — mesmo padrão de vendas.idempotencia.banco.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.user || { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;

const userId = uuid();
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const empresas = [filial, deFora, matriz]; // filial antes da matriz (FK do grupo)

const ids = {};
const COD = {
  daFilial: '7890000000017',
  varDaFilial: '7890000000024',
  daMatriz: '7890000000031',
  privadoFilial: '7890000000048',
  deFora: '7890000000055',
  varDeFora: '7890000000062',
  repetido: '7890000000079',
};

async function produto(companyId, nome, { shared = false, stock = 10, barcode = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO products (company_id, name, price, cost_price, stock_qty, is_group_shared, barcode)
     VALUES ($1, $2, 50, 20, $3, $4, $5) RETURNING id`,
    [companyId, nome, stock, shared, barcode]
  );
  return rows[0].id;
}
async function variante(pid, { stock = 5, barcode = null, sku = 'M' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, barcode) VALUES ($1, $2, $3, $4) RETURNING id`,
    [pid, sku, stock, barcode]
  );
  return rows[0].id;
}
const estoque = async (pid) => Number((await pool.query(`SELECT stock_qty FROM products WHERE id=$1`, [pid])).rows[0].stock_qty);
const estoqueVar = async (vid) => Number((await pool.query(`SELECT stock_qty FROM product_variants WHERE id=$1`, [vid])).rows[0].stock_qty);

const bipar = (loja, code) => request(app).get(`/companies/${loja}/pdv/scan/${code}`);
const vender = (loja, item) => request(app).post(`/companies/${loja}/pdv/sale`).send({
  items: [{ quantity: 1, unit_price: 50, product_name_snapshot: 'Fixture', ...item }],
  payment_method: 'dinheiro',
});

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Grupo Caixa')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Matriz Fixture')`, [matriz, userId]);
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', $3)`,
    [filial, userId, matriz]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Fixture')`, [deFora, userId]);

  ids.daFilial = await produto(filial, 'Compartilhado da filial', { shared: true, barcode: COD.daFilial });
  ids.comVarDaFilial = await produto(filial, 'Grade da filial', { shared: true });
  ids.varDaFilial = await variante(ids.comVarDaFilial, { barcode: COD.varDaFilial });
  ids.daMatriz = await produto(matriz, 'Compartilhado da matriz', { shared: true, barcode: COD.daMatriz });
  ids.privadoFilial = await produto(filial, 'Só da filial', { shared: false, barcode: COD.privadoFilial });
  ids.deFora = await produto(deFora, 'De outra loja', { shared: true, barcode: COD.deFora });
  ids.comVarDeFora = await produto(deFora, 'Grade de outra loja', { shared: true });
  ids.varDeFora = await variante(ids.comVarDeFora, { barcode: COD.varDeFora });
  ids.repetidoMatriz = await produto(matriz, 'Repetido (matriz)', { shared: false, barcode: COD.repetido });
  ids.repetidoFilial = await produto(filial, 'Repetido (filial)', { shared: true, barcode: COD.repetido });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/scanner'));
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
});

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200)); // tarefas da venda sem await
  const limpar = [
    [`DELETE FROM transactions WHERE company_id = ANY($1)`],
    [`DELETE FROM sale_payments WHERE company_id = ANY($1)`],
    [`DELETE FROM stock_movements WHERE company_id = ANY($1)`],
    [`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`],
    [`DELETE FROM sales WHERE company_id = ANY($1)`],
    [`DELETE FROM products WHERE company_id = ANY($1)`],
  ];
  for (const [sql] of limpar) {
    try { await pool.query(sql, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  }
  for (const id of empresas) {
    try { await pool.query(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await pool.query(`DELETE FROM users WHERE id = $1`, [userId]); } catch (e) { /* idem */ }
  await pool.end();
});

describe('bipe — mesma visibilidade do Estoque', () => {
  test('matriz acha o compartilhado da filial', async () => {
    const res = await bipar(matriz, COD.daFilial);
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(ids.daFilial);
    expect(res.body.product.stock_company_id).toBe(filial);
  });

  test('matriz acha a variante de um produto da filial', async () => {
    const res = await bipar(matriz, COD.varDaFilial);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('variant_barcode');
    expect(res.body.variant_id).toBe(ids.varDaFilial);
    expect(res.body.product.stock_company_id).toBe(filial);
  });

  test('filial acha o compartilhado da matriz (como antes)', async () => {
    const res = await bipar(filial, COD.daMatriz);
    expect(res.status).toBe(200);
    expect(res.body.product.id).toBe(ids.daMatriz);
  });

  test('produto não compartilhado da filial não aparece na matriz', async () => {
    const res = await bipar(matriz, COD.privadoFilial);
    expect(res.status).toBe(404);
  });

  test('empresa de fora do grupo não aparece, nem produto nem variante', async () => {
    expect((await bipar(matriz, COD.deFora)).status).toBe(404);
    expect((await bipar(filial, COD.varDeFora)).status).toBe(404);
    // e quem é de fora não vê o grupo
    expect((await bipar(deFora, COD.daFilial)).status).toBe(404);
    expect((await bipar(deFora, COD.varDaFilial)).status).toBe(404);
  });

  test('código repetido no grupo: o da própria loja ganha', async () => {
    const naMatriz = await bipar(matriz, COD.repetido);
    expect(naMatriz.body.product.id).toBe(ids.repetidoMatriz);
    const naFilial = await bipar(filial, COD.repetido);
    expect(naFilial.body.product.id).toBe(ids.repetidoFilial);
  });

  test('lote: matriz acha o da filial; de fora não entra; o da loja ganha', async () => {
    const res = await request(app).post(`/companies/${matriz}/pdv/scan/batch`)
      .send({ codes: [COD.daFilial, COD.deFora, COD.repetido] });
    expect(res.status).toBe(200);
    expect(res.body.products[COD.daFilial].id).toBe(ids.daFilial);
    expect(res.body.products[COD.deFora]).toBeUndefined();
    expect(res.body.products[COD.repetido].id).toBe(ids.repetidoMatriz);
  });
});

describe('venda — baixa na linha do produto, para o grupo', () => {
  test('matriz vende o compartilhado da filial: baixa na linha da filial', async () => {
    const antes = await estoque(ids.daFilial);
    const res = await vender(matriz, { product_id: ids.daFilial });
    expect(res.status).toBe(201);
    expect(await estoque(ids.daFilial)).toBe(antes - 1);
    const { rows } = await pool.query(
      `SELECT company_id FROM stock_movements WHERE reference_id=$1 AND product_id=$2`,
      [res.body.sale.id, ids.daFilial]
    );
    expect(rows.map((r) => r.company_id)).toEqual([filial]);
    const { rows: si } = await pool.query(`SELECT unit_cost FROM sale_items WHERE sale_id=$1`, [res.body.sale.id]);
    expect(Number(si[0].unit_cost)).toBe(20); // custo achado: o produto foi validado
  });

  test('matriz vende a variante de um produto da filial', async () => {
    const antes = await estoqueVar(ids.varDaFilial);
    const res = await vender(matriz, { product_id: ids.comVarDaFilial, variant_id: ids.varDaFilial });
    expect(res.status).toBe(201);
    expect(await estoqueVar(ids.varDaFilial)).toBe(antes - 1);
  });

  test('matriz respeita o saldo do produto da filial (sem estoque → 409)', async () => {
    const semSaldo = await produto(filial, 'Sem saldo na filial', { shared: true, stock: 0 });
    const res = await vender(matriz, { product_id: semSaldo });
    expect(res.status).toBe(409);
  });

  test('filial vende o compartilhado da matriz (como antes)', async () => {
    const antes = await estoque(ids.daMatriz);
    const res = await vender(filial, { product_id: ids.daMatriz });
    expect(res.status).toBe(201);
    expect(await estoque(ids.daMatriz)).toBe(antes - 1);
  });

  test('venda com produto de fora do grupo não mexe no estoque dele', async () => {
    const antesP = await estoque(ids.deFora);
    const antesV = await estoqueVar(ids.varDeFora);
    await vender(matriz, { product_id: ids.deFora });
    await vender(matriz, { product_id: ids.comVarDeFora, variant_id: ids.varDeFora });
    expect(await estoque(ids.deFora)).toBe(antesP);
    expect(await estoqueVar(ids.varDeFora)).toBe(antesV);
  });
});

describe('troca — item novo com a mesma regra', () => {
  const { adjustStock } = require('../src/services/trocaV2')._internal;

  async function naTransacao(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  test('troca na matriz leva produto e variante da filial: baixa nas linhas da filial', async () => {
    await naTransacao(async (c) => {
      const p0 = Number((await c.query(`SELECT stock_qty FROM products WHERE id=$1`, [ids.daFilial])).rows[0].stock_qty);
      const v0 = Number((await c.query(`SELECT stock_qty FROM product_variants WHERE id=$1`, [ids.varDaFilial])).rows[0].stock_qty);
      await adjustStock(c, [], [
        { product_id: ids.daFilial, quantity: 1 },
        { product_id: ids.comVarDaFilial, variant_id: ids.varDaFilial, quantity: 1 },
      ], matriz, uuid());
      expect(Number((await c.query(`SELECT stock_qty FROM products WHERE id=$1`, [ids.daFilial])).rows[0].stock_qty)).toBe(p0 - 1);
      expect(Number((await c.query(`SELECT stock_qty FROM product_variants WHERE id=$1`, [ids.varDaFilial])).rows[0].stock_qty)).toBe(v0 - 1);
      const { rows } = await c.query(
        `SELECT DISTINCT company_id FROM stock_movements WHERE product_id = ANY($1) AND reference_type='troca'`,
        [[ids.daFilial, ids.comVarDaFilial]]
      );
      expect(rows.map((r) => r.company_id)).toEqual([filial]);
    });
  });

  test('troca com produto ou variante de fora do grupo: estoque insuficiente, nada baixa', async () => {
    await naTransacao(async (c) => {
      await expect(adjustStock(c, [], [{ product_id: ids.deFora, quantity: 1 }], matriz, uuid()))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    });
    await naTransacao(async (c) => {
      await expect(adjustStock(c, [], [{ product_id: ids.comVarDeFora, variant_id: ids.varDeFora, quantity: 1 }], matriz, uuid()))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect(Number((await c.query(`SELECT stock_qty FROM product_variants WHERE id=$1`, [ids.varDeFora])).rows[0].stock_qty)).toBe(5);
    });
  });
});
