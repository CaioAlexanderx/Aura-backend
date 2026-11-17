// ============================================================
// AURA. — Reserva calculada do pedido guardado no Caixa (B2 / p-61b)
// Postgres real. services/reservaDoPedido.js, GET /products, o bipe do
// Caixa (scanner.js) e o aviso ao guardar.
//
// Regra do Caio (17/11): pedido nao e venda; nao baixa estoque, so reserva.
// O que este arquivo prova:
//   1. reserved_qty = soma das pecas dos pedidos do balcao abertos
//      (confirmed, preparing, ready), por produto e por variante; pedido
//      concluido ou cancelado, pedido da loja online e pedido de outra loja
//      de fora do grupo nao contam; o estoque (stock_qty) nao muda;
//   2. produto compartilhado do grupo: o pedido da filial reserva o estoque
//      unico, e a matriz ve a reserva (e vice-versa);
//   3. peca personalizavel sob encomenda nao reserva;
//   4. ao guardar: sem saldo livre (estoque − reservado < qtd) e 409
//      PEDIDO_SEM_SALDO e nada e gravado; com "vender sem estoque" ligado
//      (allow_sale_without_stock) o pedido entra com o aviso.
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
  camiseta: uuid(), bone: uuid(), caneca: uuid(), liso: uuid(),
  varP: uuid(), varM: uuid(),
};
const EMPRESAS = [ID.matriz, ID.filial, ID.deFora];
const BARRAS_P = '7890000000017';

let pool;
let app;
let seq = 0;
let usuario;
const STAFF = { id: ID.dono, role: 'client', is_staff: true, plan: 'negocio' };
const LOJISTA = { id: ID.dono, role: 'client', plan: 'negocio' };
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  const passos = [
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono, ID.outroDono]]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

/** Pedido direto no banco (qualquer origem e situacao). */
async function pedido({ empresa = ID.matriz, origem = 'balcao', status = 'confirmed', itens, stockDeducted = false }) {
  seq += 1;
  const id = uuid();
  await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, origem, stock_deducted)
           VALUES ($1, $2, $3, 'Cliente', '', 0, 0, $4, $5, $6)`,
  [id, empresa, 'RS-' + String(seq).padStart(4, '0'), status, origem, stockDeducted]);
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
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  // Colunas de producao que o GET /products le e nenhuma migration do repo
  // cria (mesmo ajuste de buscaPorCor.banco.test.js).
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS ncm TEXT`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Reserva'), ($3, $4, 'x', 'Outro Dono')`,
    [ID.dono, `fixture-${ID.dono}@example.test`, ID.outroDono, `fixture-${ID.outroDono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Matriz')`, [ID.matriz, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial', $3)`,
    [ID.filial, ID.dono, ID.matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture De Fora')`, [ID.deFora, ID.outroDono]);

  const produto = (id, empresa, nome, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, 10, $4)`, [id, empresa, nome, estoque]);
  await produto(ID.camiseta, ID.matriz, 'Camiseta com grade', 0);
  await produto(ID.bone, ID.matriz, 'Bone compartilhado', 3);
  await produto(ID.caneca, ID.matriz, 'Caneca sob encomenda', 0);
  await produto(ID.liso, ID.matriz, 'Produto liso', 2);
  await q(`UPDATE products SET is_group_shared = true WHERE id = $1`, [ID.bone]);
  await q(`UPDATE products SET barcode = '7890000000099' WHERE id = $1`, [ID.liso]);
  await q(`UPDATE products SET is_personalizable = true, customization_config = '{"fields":[]}'::jsonb WHERE id = $1`, [ID.caneca]);
  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty, barcode, is_active) VALUES
             ($1, $3, 'P', 2, $4, true), ($2, $3, 'M', 5, NULL, true)`, [ID.varP, ID.varM, ID.camiseta, BARRAS_P]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/products', require('../src/routes/products'));
  app.use('/companies/:id/pdv', require('../src/routes/scanner'));
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
});

beforeEach(() => {
  usuario = STAFF;
  delete process.env.PEDIDO_LIBERADO;
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

describe('reserva calculada', () => {
  test('sem pedido: reserva 0 em todo produto', async () => {
    const p = await listar(ID.matriz);
    for (const id of [ID.camiseta, ID.bone, ID.caneca, ID.liso]) expect(p[id].reserved_qty).toBe(0);
  });

  test('soma so os pedidos do balcao abertos, por variante, sem mexer no estoque', async () => {
    await pedido({ itens: [{ p: ID.camiseta, v: ID.varP, qtd: 1 }, { p: ID.liso, qtd: 1 }] });
    await pedido({ status: 'preparing', itens: [{ p: ID.camiseta, v: ID.varM, qtd: 2 }] });
    await pedido({ status: 'ready', itens: [{ p: ID.camiseta, v: ID.varP, qtd: 1 }] });
    // Nao contam: concluido, cancelado, loja online, loja online com baixa.
    await pedido({ status: 'delivered', itens: [{ p: ID.camiseta, v: ID.varP, qtd: 9 }] });
    await pedido({ status: 'cancelled', itens: [{ p: ID.camiseta, v: ID.varP, qtd: 9 }] });
    await pedido({ origem: null, itens: [{ p: ID.camiseta, v: ID.varP, qtd: 9 }] });
    await pedido({ origem: null, stockDeducted: true, itens: [{ p: ID.liso, qtd: 9 }] });

    const p = await listar(ID.matriz);
    expect(p[ID.camiseta].reserved_qty).toBe(4);
    expect(p[ID.liso].reserved_qty).toBe(1);
    expect(p[ID.liso].stock_qty).toBe(2);
    expect(p[ID.camiseta].variants_stock_total).toBe(7);

    expect(p[ID.camiseta].reserved_by_variant).toEqual({ [ID.varP]: 2, [ID.varM]: 2 });
    expect(p[ID.liso].reserved_by_variant).toEqual({});
    expect(p[ID.bone].reserved_by_variant).toEqual({});
  });

  test('o bipe traz a reserva do produto e da variante bipada', async () => {
    const r = await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_P}`);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('variant_barcode');
    expect(r.body.product.reserved_qty).toBe(4);
    expect(r.body.variant_reserved_qty).toBe(2);

    const liso = await request(app).get(`/companies/${ID.matriz}/pdv/scan/7890000000099`);
    expect(liso.body.source).toBe('barcode');
    expect(liso.body.product.reserved_qty).toBe(1);
    const varianteDaLista = (liso.body.product.variants || []);
    expect(varianteDaLista).toEqual([]);
  });

  test('produto compartilhado: o pedido da filial reserva o estoque unico, e a matriz ve', async () => {
    await pedido({ empresa: ID.filial, itens: [{ p: ID.bone, qtd: 2 }] });
    expect((await listar(ID.matriz))[ID.bone].reserved_qty).toBe(2);
    expect((await listar(ID.filial))[ID.bone].reserved_qty).toBe(2);
    // Pedido de loja de outro dono nunca entra na conta (nem que cite o id).
    await pedido({ empresa: ID.deFora, itens: [{ p: ID.bone, qtd: 5 }] });
    expect((await listar(ID.matriz))[ID.bone].reserved_qty).toBe(2);
  });

  test('peca personalizavel sob encomenda nao reserva', async () => {
    await pedido({ itens: [{ p: ID.caneca, qtd: 3 }] });
    expect((await listar(ID.matriz))[ID.caneca].reserved_qty).toBe(0);
  });
});

describe('aviso ao guardar', () => {
  function guardar(empresa, itens) {
    return request(app).post(`/companies/${empresa}/pedidos`).set('Idempotency-Key', `reserva-${uuid()}`)
      .send({ items: itens.map((i) => ({ product_id: i.p, variant_id: i.v || null, quantity: i.qtd, unit_price: 10 })) });
  }

  test('sem saldo livre: 409 PEDIDO_SEM_SALDO e nada gravado', async () => {
    // Variante P: estoque 2, ja reservado 2 -> livre 0.
    const { rows: [{ n: antes }] } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1`, [ID.matriz]);
    const r = await guardar(ID.matriz, [{ p: ID.camiseta, v: ID.varM, qtd: 1 }, { p: ID.camiseta, v: ID.varP, qtd: 1 }]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PEDIDO_SEM_SALDO');
    expect(r.body.faltas).toEqual([
      expect.objectContaining({ product_id: ID.camiseta, variant_id: ID.varP, quantidade: 1, estoque: 2, reservado: 2, livre: 0 }),
    ]);
    const { rows: [{ n: depois }] } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1`, [ID.matriz]);
    expect(depois).toBe(antes);
  });

  test('o grupo conta junto: a filial nao separa o bone que a matriz ja separou', async () => {
    // Bone: estoque 3, reservado 2 (pedido da filial) -> livre 1.
    expect((await guardar(ID.matriz, [{ p: ID.bone, qtd: 2 }])).status).toBe(409);
    expect((await guardar(ID.matriz, [{ p: ID.bone, qtd: 1 }])).status).toBe(201);
    expect((await guardar(ID.filial, [{ p: ID.bone, qtd: 1 }])).status).toBe(409);
  });

  test('com saldo livre: 201 sem aviso; peca sob encomenda nunca e conferida', async () => {
    const r = await guardar(ID.matriz, [{ p: ID.camiseta, v: ID.varM, qtd: 3 }, { p: ID.caneca, qtd: 10 }]);
    expect(r.status).toBe(201);
    expect(r.body.avisos).toEqual([]);
  });

  test('com "vender sem estoque" ligado: o pedido entra com o aviso', async () => {
    await q(`UPDATE companies SET pdv_settings = '{"allow_sale_without_stock": true}'::jsonb WHERE id = $1`, [ID.matriz]);
    const r = await guardar(ID.matriz, [{ p: ID.liso, qtd: 5 }]);
    expect(r.status).toBe(201);
    expect(r.body.avisos).toEqual([
      expect.objectContaining({ product_id: ID.liso, variant_id: null, quantidade: 5, estoque: 2, reservado: 1, livre: 1 }),
    ]);
    // O estoque continua o da prateleira.
    const { rows: [p] } = await q(`SELECT stock_qty::numeric AS s FROM products WHERE id = $1`, [ID.liso]);
    expect(Number(p.s)).toBe(2);
  });
});

describe('trava PEDIDO_LIBERADO desligada (lojista)', () => {
  // Ha pedidos do balcao abertos reservando pecas (os testes acima).
  const db = () => require('../src/config/database');
  const consultasAosItens = () => db().query.mock.calls
    .filter(([sql]) => /digital_order_items/.test(String(sql))).length;

  beforeEach(() => { usuario = LOJISTA; db().query.mockClear(); });

  test('GET /products: nenhuma consulta a digital_order_items e nenhum campo novo', async () => {
    const r = await request(app).get(`/companies/${ID.matriz}/products?limit=100`);
    expect(r.status).toBe(200);
    expect(consultasAosItens()).toBe(0);
    for (const p of r.body.products) {
      expect(p).not.toHaveProperty('reserved_qty');
      expect(p).not.toHaveProperty('reserved_by_variant');
    }
    expect(JSON.stringify(r.body)).not.toMatch(/reserved/);
  });

  test('bipe (variante, produto, sugestoes e lote): nenhuma consulta nova e nenhum campo novo', async () => {
    const respostas = [
      await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_P}`),
      await request(app).get(`/companies/${ID.matriz}/pdv/scan/7890000000099`),
      await request(app).get(`/companies/${ID.matriz}/pdv/scan/Camiseta`),
      await request(app).post(`/companies/${ID.matriz}/pdv/scan/batch`).send({ codes: ['7890000000099'] }),
    ];
    expect(respostas.map((r) => r.status)).toEqual([200, 200, 207, 200]);
    expect(consultasAosItens()).toBe(0);
    for (const r of respostas) expect(JSON.stringify(r.body)).not.toMatch(/reserved/);
  });

  test('com staff (ou PEDIDO_LIBERADO=true) a reserva aparece no /products e no bipe', async () => {
    for (const modo of ['staff', 'env']) {
      if (modo === 'staff') usuario = STAFF;
      else { usuario = LOJISTA; process.env.PEDIDO_LIBERADO = 'true'; }
      // O esperado sai do servico (os testes de "guardar" acima somaram pedidos).
      const R = require('../src/services/reservaDoPedido');
      const m = await R.lerReservas(pool, ID.matriz, [ID.camiseta, ID.liso]);
      expect(R.reservadoDoProduto(m, ID.camiseta)).toBeGreaterThan(0);
      const lista = await listar(ID.matriz);
      expect(lista[ID.camiseta].reserved_qty).toBe(R.reservadoDoProduto(m, ID.camiseta));
      expect(lista[ID.camiseta].reserved_by_variant).toEqual(R.reservasPorVariante(m, ID.camiseta));
      const bipe = await request(app).get(`/companies/${ID.matriz}/pdv/scan/${BARRAS_P}`);
      expect(bipe.body.product.reserved_qty).toBe(R.reservadoDoProduto(m, ID.camiseta));
      expect(bipe.body.variant_reserved_qty).toBe(R.reservadoDaVariante(m, ID.camiseta, ID.varP));
      const lote = await request(app).post(`/companies/${ID.matriz}/pdv/scan/batch`).send({ codes: ['7890000000099'] });
      expect(lote.body.products['7890000000099'].reserved_qty).toBe(R.reservadoDoProduto(m, ID.liso));
    }
  });
});
