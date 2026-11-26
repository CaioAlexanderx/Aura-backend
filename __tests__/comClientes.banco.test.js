// ============================================================
// AURA. — "Com clientes" no calculo de livres (C3) — Postgres real
// services/comClientes.js, GET /products (routes/products.js) e o bipe do
// Caixa (routes/scanner.js), migration 467.
//
// O que este arquivo prova:
//   1. out_qty = pecas das condicionais ABERTAS com situacao com_cliente, ou
//      ficou ainda sem venda, por produto e por variante; voltou, voltou com
//      defeito, ficou ja cobrada, condicional encerrada ou cancelada nao
//      contam; o estoque (stock_qty) nao muda (R3);
//   2. out_qty e reserved_qty sao numeros separados: a peca do pedido esta na
//      prateleira, a da condicional saiu da loja;
//   3. produto compartilhado do grupo: a condicional da filial tira do
//      estoque unico, e a matriz ve (e vice-versa); loja de outro dono nunca;
//   4. trava CONDICIONAL_LIBERADA desligada (lojista): os campos nao aparecem
//      e a resposta e a mesma de antes; ligada sem condicional: 0 e {}.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
// O bipe chama requireAuth no proprio router: aqui o usuario vem do app.
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = {
  dono: uuid(), outroDono: uuid(),
  matriz: uuid(), filial: uuid(), deFora: uuid(),
  vestido: uuid(), bolsa: uuid(), liso: uuid(),
  varP: uuid(), varM: uuid(),
};
const EMPRESAS = [ID.matriz, ID.filial, ID.deFora];
const BARRAS_P = '7890000000467';
const BARRAS_LISO = '7890000000468';

let pool;
let app;
let seq = 0;
let usuario;
const STAFF = { id: ID.dono, role: 'client', is_staff: true, plan: 'negocio' };
const LOJISTA = { id: ID.dono, role: 'client', plan: 'negocio' };
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  const passos = [
    [`UPDATE condicional_itens SET sale_id = NULL WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM sales WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicionais WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono, ID.outroDono]]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

/** Condicional direto no banco. itens: [{p, v?, sit?, venda?}] */
async function condicional({ empresa = ID.matriz, status = 'aberta', itens }) {
  seq += 1;
  const id = uuid();
  await q(`INSERT INTO condicionais (id, company_id, numero, customer_name, customer_phone, due_date, status)
           VALUES ($1, $2, $3, 'Cliente', '11988887777', CURRENT_DATE + 3, $4)`, [id, empresa, seq, status]);
  for (const it of itens) {
    await q(`INSERT INTO condicional_itens (condicional_id, product_id, variant_id, product_name, unit_price, situacao, sale_id)
             VALUES ($1, $2, $3, 'Peca', 10, $4, $5)`, [id, it.p, it.v || null, it.sit || 'com_cliente', it.venda || null]);
  }
  return id;
}

async function pedido({ empresa = ID.matriz, itens }) {
  seq += 1;
  const id = uuid();
  await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, origem, stock_deducted)
           VALUES ($1, $2, $3, 'Cliente', '', 0, 0, 'confirmed', 'balcao', false)`, [id, empresa, 'RS-CC-' + seq]);
  for (const it of itens) {
    await q(`INSERT INTO digital_order_items (order_id, product_id, variant_id, product_name, unit_price, quantity, subtotal)
             VALUES ($1, $2, $3, 'Item', 10, $4, 10 * $4)`, [id, it.p, it.v || null, it.qtd]);
  }
  return id;
}

async function listar(empresa) {
  const r = await request(app).get(`/companies/${empresa}/products?limit=100`);
  expect(r.status).toBe(200);
  return Object.fromEntries(r.body.products.map((p) => [p.id, p]));
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  // Colunas de producao que o GET /products le e nenhuma migration do repo
  // cria (mesmo ajuste de reservaDoPedido.banco.test.js).
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS ncm TEXT`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Com Clientes'), ($3, $4, 'x', 'Outro Dono')`,
    [ID.dono, `fixture-${ID.dono}@example.test`, ID.outroDono, `fixture-${ID.outroDono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Matriz')`, [ID.matriz, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial', $3)`,
    [ID.filial, ID.dono, ID.matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture De Fora')`, [ID.deFora, ID.outroDono]);

  const produto = (id, empresa, nome, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, 10, $4)`, [id, empresa, nome, estoque]);
  await produto(ID.vestido, ID.matriz, 'Vestido com grade', 0);
  await produto(ID.bolsa, ID.matriz, 'Bolsa compartilhada', 3);
  await produto(ID.liso, ID.matriz, 'Produto liso', 5);
  await q(`UPDATE products SET is_group_shared = true WHERE id = $1`, [ID.bolsa]);
  await q(`UPDATE products SET barcode = $2 WHERE id = $1`, [ID.liso, BARRAS_LISO]);
  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty, barcode, is_active) VALUES
             ($1, $3, 'P', 3, $4, true), ($2, $3, 'M', 5, NULL, true)`, [ID.varP, ID.varM, ID.vestido, BARRAS_P]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/products', require('../src/routes/products'));
  app.use('/companies/:id/pdv', require('../src/routes/scanner'));
});

beforeEach(() => {
  usuario = STAFF;
  delete process.env.CONDICIONAL_LIBERADA;
  delete process.env.PEDIDO_LIBERADO;
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

describe('trava CONDICIONAL_LIBERADA', () => {
  test('desligada (lojista): sem campos novos; a resposta e a de antes', async () => {
    usuario = LOJISTA;
    const p = await listar(ID.matriz);
    for (const id of [ID.vestido, ID.bolsa, ID.liso]) {
      expect(p[id]).not.toHaveProperty('out_qty');
      expect(p[id]).not.toHaveProperty('out_by_variant');
      expect(p[id]).not.toHaveProperty('resolver_qty');
    }
    const bipe = await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_P}`);
    expect(bipe.status).toBe(200);
    expect(bipe.body).not.toHaveProperty('variant_out_qty');
    expect(bipe.body.product).not.toHaveProperty('out_qty');
    expect(bipe.body).not.toHaveProperty('variant_resolver_qty');
    expect(bipe.body.product).not.toHaveProperty('resolver_qty');
  });

  test('ligada, sem condicional: 0 e {}', async () => {
    usuario = LOJISTA;
    process.env.CONDICIONAL_LIBERADA = 'true';
    const p = await listar(ID.matriz);
    for (const id of [ID.vestido, ID.bolsa, ID.liso]) {
      expect(p[id].out_qty).toBe(0);
      expect(p[id].out_by_variant).toEqual({});
      // A reserva continua atras da propria trava (PEDIDO_LIBERADO).
      expect(p[id]).not.toHaveProperty('reserved_qty');
    }
  });
});

describe('com clientes calculado (R3)', () => {
  test('so pecas fora da loja de condicionais abertas, por variante, sem mexer no estoque', async () => {
    const venda = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount) VALUES ($1, $2, 10)`, [venda, ID.matriz]);
    await condicional({ itens: [{ p: ID.vestido, v: ID.varP }, { p: ID.liso }] });
    await condicional({ itens: [{ p: ID.vestido, v: ID.varM }, { p: ID.vestido, v: ID.varM, sit: 'ficou' }] });
    // Nao contam: voltou, voltou com defeito, ficou ja cobrada, encerrada, cancelada.
    await condicional({ itens: [{ p: ID.vestido, v: ID.varP, sit: 'voltou' }, { p: ID.liso, sit: 'voltou_defeito' }, { p: ID.liso, sit: 'ficou', venda }] });
    // Peca cobrada nunca conta, nem com_cliente (fora do contrato do C11).
    await condicional({ itens: [{ p: ID.liso, sit: 'com_cliente', venda }] });
    await condicional({ status: 'encerrada', itens: [{ p: ID.vestido, v: ID.varP }] });
    await condicional({ status: 'cancelada', itens: [{ p: ID.liso }] });

    const p = await listar(ID.matriz);
    expect(p[ID.vestido].out_qty).toBe(3);
    expect(p[ID.vestido].out_by_variant).toEqual({ [ID.varP]: 1, [ID.varM]: 2 });
    expect(p[ID.liso].out_qty).toBe(1);
    expect(p[ID.liso].out_by_variant).toEqual({});
    expect(p[ID.liso].stock_qty).toBe(5);
    expect(p[ID.vestido].variants_stock_total).toBe(8);
  });

  test('com clientes e reservado sao numeros separados', async () => {
    await pedido({ itens: [{ p: ID.liso, qtd: 2 }] });
    const p = await listar(ID.matriz);
    expect(p[ID.liso]).toMatchObject({ out_qty: 1, reserved_qty: 2, stock_qty: 5 });
  });

  test('o bipe traz com clientes do produto e da variante bipada', async () => {
    const r = await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_P}`);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('variant_barcode');
    expect(r.body.product.out_qty).toBe(3);
    expect(r.body.variant_out_qty).toBe(1);
    expect(r.body.variant_reserved_qty).toBe(0);

    const liso = await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_LISO}`);
    expect(liso.body.source).toBe('barcode');
    expect(liso.body.product).toMatchObject({ out_qty: 1, reserved_qty: 2 });

    const lote = await request(app).post(`/companies/${ID.matriz}/pdv/scan/batch`).send({ codes: [BARRAS_LISO] });
    expect(lote.status).toBe(200);
    expect(JSON.stringify(lote.body)).toContain('"out_qty":1');
  });

  test('produto compartilhado: a condicional da filial tira do estoque unico, e a matriz ve', async () => {
    await condicional({ empresa: ID.filial, itens: [{ p: ID.bolsa }, { p: ID.bolsa }] });
    expect((await listar(ID.matriz))[ID.bolsa].out_qty).toBe(2);
    expect((await listar(ID.filial))[ID.bolsa].out_qty).toBe(2);
    // Condicional de loja de outro dono nunca entra na conta (nem que cite o id).
    await condicional({ empresa: ID.deFora, itens: [{ p: ID.bolsa }] });
    expect((await listar(ID.matriz))[ID.bolsa].out_qty).toBe(2);
  });

  test('para resolver (C9): voltou com defeito sem decisao, separado de com clientes', async () => {
    // Ja existe 1 liso voltou_defeito numa condicional aberta (teste acima).
    const encerrada = await condicional({ status: 'encerrada', itens: [{ p: ID.vestido, v: ID.varP, sit: 'voltou_defeito' }] });
    // Nao contam: resolvida (C16), cancelada, e de outro dono.
    const resolvida = await condicional({ status: 'encerrada', itens: [{ p: ID.vestido, v: ID.varM, sit: 'voltou_defeito' }] });
    await q(`UPDATE condicional_itens SET resolved_at = NOW() WHERE condicional_id = $1`, [resolvida]);
    await condicional({ status: 'cancelada', itens: [{ p: ID.vestido, v: ID.varM, sit: 'voltou_defeito' }] });
    await condicional({ empresa: ID.deFora, status: 'encerrada', itens: [{ p: ID.liso, sit: 'voltou_defeito' }] });
    expect(encerrada).toBeTruthy();

    const p = await listar(ID.matriz);
    expect(p[ID.vestido]).toMatchObject({ resolver_qty: 1, resolver_by_variant: { [ID.varP]: 1 }, out_qty: 3 });
    expect(p[ID.liso]).toMatchObject({ resolver_qty: 1, resolver_by_variant: {}, out_qty: 1, stock_qty: 5 });
    expect(p[ID.bolsa]).toMatchObject({ resolver_qty: 0, resolver_by_variant: {} });

    const r = await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_P}`);
    expect(r.body.product.resolver_qty).toBe(1);
    expect(r.body.variant_resolver_qty).toBe(1);
  });
});
