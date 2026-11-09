// ============================================================
// AURA. — Vendidos na promocao — Postgres real (p-92, migration 428)
//
// Contra o schema das migrations (inclui 427 e 428):
//   1. POST /pdv/sale grava preco_lista/em_promocao por item: produto em
//      promocao, produto sem promocao, variante que herda, variante com
//      price_override (isolada). unit_price e total da venda intactos.
//   2. troca: o item novo tambem e marcado
//   3. GET /products/promotions/vendidos: itens, faturamento, desconto dado
//      e vendas; venda cancelada fora; Caixa que mandou o preco normal na
//      promocao conta com desconto 0; filtro por produto; janela
//   4. consolidado (escopo=grupo): soma matriz + filial, com por_loja
//   5. permissao: perfil "Estoque so consulta" 403; membro sem chave da
//      retaguarda 403 SEM_PERMISSAO_RELATORIO
//
// Mesmo arreio de vendas.idempotencia / caixa.grupoBidirecional: a venda
// precisa de COMMIT de verdade; fixtures com uuid proprio, apagadas no
// afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;
let usuario = null; // req.user da vez

const dono = uuid();
const consulta = uuid();
const semRetaguarda = uuid();
const matriz = uuid();
const filial = uuid();
const empresas = [matriz, filial];
const ids = {};

const ONTEM = () => new Date(Date.now() - 864e5).toISOString();
const SEMANA = () => new Date(Date.now() + 7 * 864e5).toISOString();

async function produto(empresa, nome, price, promo) {
  const { rows } = await pool.query(
    `INSERT INTO products (company_id, name, price, cost_price, stock_qty, is_active, promo_price, promo_starts_at, promo_ends_at)
     VALUES ($1, $2, $3, 10, 100, true, $4, $5, $6) RETURNING id`,
    [empresa, nome, price, promo ? promo : null, promo ? ONTEM() : null, promo ? SEMANA() : null]
  );
  return rows[0].id;
}
async function variante(pid, sku, override) {
  const { rows } = await pool.query(
    `INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty) VALUES ($1, $2, $3, 100) RETURNING id`,
    [pid, sku, override]
  );
  return rows[0].id;
}

const vender = (loja, items) => request(app).post(`/companies/${loja}/pdv/sale`).send({ items, payment_method: 'dinheiro' });
const vendidos = (loja, query = {}) => request(app).get(`/companies/${loja}/products/promotions/vendidos`).query(query);
const itensDaVenda = async (saleId) => (await pool.query(
  `SELECT product_id, variant_id, quantity, unit_price, total_price, preco_lista, em_promocao
     FROM sale_items WHERE sale_id = $1`, [saleId]
)).rows;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES
       ($1, $2, 'x', 'Fixture Dono'), ($3, $4, 'x', 'Fixture Consulta'), ($5, $6, 'x', 'Fixture Balcao')`,
    [dono, `fixture-${dono}@example.test`, consulta, `fixture-${consulta}@example.test`,
      semRetaguarda, `fixture-${semRetaguarda}@example.test`]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture Matriz LTDA', 'Matriz')`, [matriz, dono]);
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial LTDA', 'Filial', $3)`,
    [filial, dono, matriz]
  );
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role_label, permissions) VALUES
       ($1, $2, 'employee', '{"estoque": true, "estoque_consulta": true}'::jsonb),
       ($1, $3, 'employee', '{"pdv": true, "estoque": true, "painel": false}'::jsonb)`,
    [matriz, consulta, semRetaguarda]
  );

  ids.promo = await produto(matriz, 'Fixture Em Promocao', 100, 80);
  ids.normal = await produto(matriz, 'Fixture Normal', 50, null);
  ids.grade = await produto(matriz, 'Fixture Grade', 200, 160);
  ids.varHerda = await variante(ids.grade, 'P', null);
  ids.varPropria = await variante(ids.grade, 'G', 180);
  ids.daFilial = await produto(filial, 'Fixture Da Filial', 30, 25);

  const { estoqueSoConsulta } = require('../src/middleware/estoqueSoConsulta');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = usuario || { id: dono, role: 'client' }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
  app.use('/companies/:id/products', estoqueSoConsulta);
  app.use('/companies/:id/products', require('../src/routes/productPromotions'));
});

afterEach(() => { usuario = null; });

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 300)); // tarefas da venda sem await
  const limpar = [
    `DELETE FROM transactions WHERE company_id = ANY($1)`,
    `DELETE FROM sale_payments WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM troca_returned_items WHERE troca_sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
    `DELETE FROM sales WHERE company_id = ANY($1)`,
    `DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM company_members WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await pool.query(sql, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  }
  for (const id of [filial, matriz]) {
    try { await pool.query(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[dono, consulta, semRetaguarda]]); } catch (e) { /* idem */ }
  await pool.end();
});

const venda = {};

describe('POST /pdv/sale grava a promocao no item', () => {
  test('cada item com a sua marcacao; unit_price e total intactos', async () => {
    const res = await vender(matriz, [
      { product_id: ids.promo, quantity: 2, unit_price: 80 },
      { product_id: ids.normal, quantity: 1, unit_price: 50 },
      { product_id: ids.grade, variant_id: ids.varHerda, quantity: 1, unit_price: 160 },
      { product_id: ids.grade, variant_id: ids.varPropria, quantity: 1, unit_price: 180 },
    ]);
    expect(res.status).toBe(201);
    venda.principal = res.body.sale.id;
    expect(Number(res.body.sale.total_amount)).toBe(550);

    const itens = await itensDaVenda(venda.principal);
    const de = (pid, vid = null) => itens.find((i) => i.product_id === pid && (i.variant_id || null) === vid);
    expect(de(ids.promo)).toMatchObject({ unit_price: '80.00', total_price: '160.00', preco_lista: '100.00', em_promocao: true });
    expect(de(ids.normal)).toMatchObject({ unit_price: '50.00', preco_lista: null, em_promocao: false });
    expect(de(ids.grade, ids.varHerda)).toMatchObject({ unit_price: '160.00', preco_lista: '200.00', em_promocao: true });
    expect(de(ids.grade, ids.varPropria)).toMatchObject({ unit_price: '180.00', preco_lista: null, em_promocao: false });
  });

  test('Caixa que mandou o preco normal durante a promocao: marcado, sem desconto', async () => {
    const res = await vender(matriz, [{ product_id: ids.promo, quantity: 1, unit_price: 100 }]);
    expect(res.status).toBe(201);
    const [item] = await itensDaVenda(res.body.sale.id);
    expect(item).toMatchObject({ unit_price: '100.00', preco_lista: '100.00', em_promocao: true });
  });

  test('venda cancelada continua marcada (o resumo e que a tira)', async () => {
    const res = await vender(matriz, [{ product_id: ids.promo, quantity: 5, unit_price: 80 }]);
    expect(res.status).toBe(201);
    venda.cancelada = res.body.sale.id;
    await pool.query(`UPDATE sales SET status = 'cancelled' WHERE id = $1`, [venda.cancelada]);
  });

  test('filial vende o seu item em promocao', async () => {
    const res = await vender(filial, [{ product_id: ids.daFilial, quantity: 3, unit_price: 25 }]);
    expect(res.status).toBe(201);
    const [item] = await itensDaVenda(res.body.sale.id);
    expect(item).toMatchObject({ preco_lista: '30.00', em_promocao: true });
  });
});

describe('troca: o item novo tambem e marcado', () => {
  test('devolve o normal e leva o da promocao', async () => {
    const itens = await itensDaVenda(venda.principal);
    const normal = (await pool.query(
      `SELECT id FROM sale_items WHERE sale_id = $1 AND product_id = $2`, [venda.principal, ids.normal]
    )).rows[0];
    expect(itens.length).toBe(4);
    const res = await request(app).post(`/companies/${matriz}/pdv/troca`).send({
      original_sale_ids: [venda.principal],
      returned_items: [{ original_sale_id: venda.principal, original_sale_item_id: normal.id, product_id: ids.normal, quantity: 1, unit_price: 50 }],
      new_items: [{ product_id: ids.promo, quantity: 1, unit_price: 80 }],
      payment_splits: [{ method: 'dinheiro', amount: 30 }],
      nfce_strategy: 'none',
    });
    expect(res.status).toBe(201);
    venda.troca = res.body.sale.id;
    const [novo] = await itensDaVenda(venda.troca);
    expect(novo).toMatchObject({ product_id: ids.promo, unit_price: '80.00', preco_lista: '100.00', em_promocao: true });
  });
});

describe('GET /products/promotions/vendidos', () => {
  test('loja: soma so os itens na promocao, sem a cancelada', async () => {
    const res = await vendidos(matriz);
    expect(res.status).toBe(200);
    expect(res.body.consolidado).toBe(false);
    expect(res.body.lojas).toBe(1);
    // venda principal: 2 x 80 (De 100) + 1 x 160 (De 200);
    // preco normal: 1 x 100 (De 100, desconto 0); troca: 1 x 80 (De 100).
    expect(res.body.resumo).toEqual({ itens_vendidos: 5, faturamento: 500, desconto_dado: 100, vendas: 3 });
    expect(res.body.por_loja).toEqual([]);
    const porProduto = Object.fromEntries(res.body.items.map((i) => [`${i.product_id}:${i.variant_id}`, i]));
    expect(porProduto[`${ids.promo}:null`]).toMatchObject({ nome: 'Fixture Em Promocao', itens_vendidos: 4, faturamento: 340, desconto_dado: 60, vendas: 3 });
    expect(porProduto[`${ids.grade}:${ids.varHerda}`]).toMatchObject({ variant_label: 'P', itens_vendidos: 1, faturamento: 160, desconto_dado: 40, vendas: 1 });
    expect(res.body.items).toHaveLength(2);
    // Nada de cliente na resposta.
    expect(JSON.stringify(res.body)).not.toMatch(/customer/i);
  });

  test('filtro por produto', async () => {
    const res = await vendidos(matriz, { product_id: ids.grade });
    expect(res.status).toBe(200);
    expect(res.body.resumo).toEqual({ itens_vendidos: 1, faturamento: 160, desconto_dado: 40, vendas: 1 });
  });

  test('janela sem venda: zeros', async () => {
    const res = await vendidos(matriz, { desde: '2020-01-01', ate: '2020-01-31' });
    expect(res.status).toBe(200);
    expect(res.body.resumo).toEqual({ itens_vendidos: 0, faturamento: 0, desconto_dado: 0, vendas: 0 });
    expect(res.body.items).toEqual([]);
    expect(res.body.desde).toBe('2020-01-01T03:00:00.000Z');
    expect(res.body.ate).toBe('2020-02-01T02:59:59.999Z');
  });

  test('datas invalidas ou fora de ordem: 400', async () => {
    expect((await vendidos(matriz, { desde: 'ontem' })).status).toBe(400);
    expect((await vendidos(matriz, { desde: '2026-11-10', ate: '2026-11-01' })).body.code).toBe('INVALID_DATES');
    expect((await vendidos(matriz, { desde: '2020-01-01', ate: '2026-01-01' })).body.code).toBe('INVALID_DATES');
    expect((await vendidos(matriz, { product_id: 'x' })).body.code).toBe('INVALID_INPUT');
  });

  test('consolidado (escopo=grupo): matriz + filial, com por_loja', async () => {
    const res = await vendidos(matriz, { escopo: 'grupo' });
    expect(res.status).toBe(200);
    expect(res.body.consolidado).toBe(true);
    expect(res.body.lojas).toBe(2);
    expect(res.body.resumo).toEqual({ itens_vendidos: 8, faturamento: 575, desconto_dado: 115, vendas: 4 });
    const lojas = Object.fromEntries(res.body.por_loja.map((l) => [l.company_id, l]));
    expect(lojas[matriz]).toMatchObject({ nome: 'Matriz', itens_vendidos: 5, faturamento: 500, desconto_dado: 100, vendas: 3 });
    expect(lojas[filial]).toMatchObject({ nome: 'Filial', itens_vendidos: 3, faturamento: 75, desconto_dado: 15, vendas: 1 });
  });

  test('consolidated_view no token vale como escopo=grupo', async () => {
    usuario = { id: dono, role: 'client', consolidated_view: true };
    const res = await vendidos(filial);
    expect(res.status).toBe(200);
    expect(res.body.resumo.vendas).toBe(4);
  });

  test('perfil "Estoque so consulta": 403', async () => {
    usuario = { id: consulta, role: 'client' };
    const res = await vendidos(matriz);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ESTOQUE_SO_CONSULTA');
  });

  test('membro sem chave da retaguarda (so Caixa e Estoque): 403 sem valores', async () => {
    usuario = { id: semRetaguarda, role: 'client' };
    const res = await vendidos(matriz);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEM_PERMISSAO_RELATORIO');
    expect(res.body.resumo).toBeUndefined();
  });
});
