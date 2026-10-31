// ============================================================
// AURA. — Reajuste de preco em lote — Postgres real (p-51, 30/10/2026)
//
// POST /companies/:id/products/price-adjustments contra o schema das
// migrations (inclui a 422). Cobre:
//   1. previa (padrao) nao grava nada
//   2. aplicar grava preco, card_price manual na proporcao, variante com
//      preco proprio; nunca muda estoque, custo nem codigo; lote + itens
//   3. abaixo do custo: 409 BELOW_COST sem allow_below_cost; grava com ele
//   4. markup/margem: sem custo fica de fora
//   5. grupo: produto compartilhado da filial e visivel e sinalizado;
//      produto de outra loja e inativo voltam em not_found_ids
//   6. (PR 2) desfazer parcial: volta so onde o preco ainda e o gravado;
//      card mudado depois tambem conta como "mudou depois"; uma vez so;
//      prazo de 7 dias; lote de outra empresa e 404
//   7. (PR 2) lista e detalhe dos reajustes da empresa
//
// Mesmo padrao de produto.excluirNuncaNegado.banco.test.js: tudo dentro de
// UMA transacao revertida no afterAll; BEGIN/COMMIT/ROLLBACK da rota viram
// savepoints.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let app;

const userId = uuid();
const matriz = uuid();
const filial = uuid();
const outraLoja = uuid();
const url = (cid = matriz) => `/companies/${cid}/products/price-adjustments`;

const q = (sql, params) => client.query(sql, params);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  let qn = 0;
  let fila = Promise.resolve();
  async function noSavepoint(sql, params) {
    qn += 1;
    const sp = `q_${qn}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      const r = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      throw err;
    }
  }
  db.query.mockImplementation((sql, params) => {
    const p = fila.then(() => noSavepoint(sql, params));
    fila = p.catch(() => {});
    return p;
  });
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Reajuste')`,
    [userId, `fixture-${userId}@example.test`]);
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES
       ($1, $4, 'Fixture Matriz LTDA', 'Matriz'),
       ($2, $4, 'Fixture Filial LTDA', 'Filial'),
       ($3, $4, 'Fixture Outra LTDA', 'Outra')`,
    [matriz, filial, outraLoja, userId]
  );
  await q(`UPDATE companies SET billing_owner_company_id = $1 WHERE id = $2`, [matriz, filial]);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client', plan: 'negocio' }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productPriceAdjustments'));
});

afterAll(async () => {
  // logAuditAction roda sem await depois da resposta; deixa a fila esvaziar.
  await new Promise((r) => setTimeout(r, 50));
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function produto(nome, { empresa = matriz, price = 100, cost = 50, card = null, shared = false, active = true, stock = 7 } = {}) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, sku, barcode, price, cost_price, card_price, is_group_shared, is_active, stock_qty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [empresa, nome, `SKU-${nome}`, `789${Math.floor(Math.random() * 1e9)}`, price, cost, card, shared, active, stock]
  );
  return rows[0].id;
}

async function linha(pid) {
  const { rows } = await q(`SELECT price, cost_price, card_price, stock_qty, sku, barcode FROM products WHERE id = $1`, [pid]);
  return rows[0];
}

test('previa (sem dry_run) nao grava nada', async () => {
  const pid = await produto('Previa');
  const r = await request(app).post(url()).send({ product_ids: [pid], mode: 'percent', direction: 'up', value: 10 });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ dry_run: true, adjustment_id: null });
  expect(r.body.items[0]).toMatchObject({ price_before: 100, price_after: 110, status: 'change' });
  expect(Number((await linha(pid)).price)).toBe(100);
});

test('aplicar: preco, card manual, variante; estoque/custo/codigo intactos; lote e itens', async () => {
  const comCartao = await produto('Com cartao', { price: 59.9, cost: 24.5, card: 62.9 });
  const auto = await produto('Cartao auto', { price: 189.9, cost: 92 });
  const { rows: [v] } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty) VALUES ($1, 'G', 199.9, 3) RETURNING id`,
    [auto]
  );
  await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', 'G')`, [v.id]);
  const antes = await linha(comCartao);

  const r = await request(app).post(url()).send({
    product_ids: [comCartao, auto], mode: 'percent', direction: 'up', value: 10, rounding: '90', dry_run: false,
  });
  expect(r.status).toBe(200);
  expect(r.body.dry_run).toBe(false);
  expect(r.body.adjustment_id).toEqual(expect.any(String));
  expect(r.body.summary).toMatchObject({ items_changed: 3, products_changed: 2, variants_changed: 1, card_price_changed: 1 });

  const depois = await linha(comCartao);
  expect(Number(depois.price)).toBe(65.9); // 65,89 -> 65,90
  expect(Number(depois.card_price)).toBe(69.2); // 62,90 x 65,90/59,90 = 69,20
  expect(depois.stock_qty).toBe(antes.stock_qty);
  expect(depois.cost_price).toBe(antes.cost_price);
  expect(depois.sku).toBe(antes.sku);
  expect(depois.barcode).toBe(antes.barcode);

  const a = await linha(auto);
  expect(Number(a.price)).toBe(208.9);
  expect(a.card_price).toBeNull();
  const { rows: [vv] } = await q(`SELECT price_override, stock_qty FROM product_variants WHERE id = $1`, [v.id]);
  expect(Number(vv.price_override)).toBe(219.9);
  expect(Number(vv.stock_qty)).toBe(3);
  expect(r.body.items.find((i) => i.variant_id === v.id)).toMatchObject({ variant_label: 'G', price_after: 219.9 });

  const { rows: [lote] } = await q(`SELECT * FROM product_price_adjustments WHERE id = $1`, [r.body.adjustment_id]);
  expect(lote).toMatchObject({ company_id: matriz, user_id: userId, mode: 'percent', direction: 'up', rounding: '90', items_count: 3, products_count: 2 });
  const { rows: itens } = await q(
    `SELECT product_id, variant_id, price_before, price_after, card_price_before, card_price_after
       FROM product_price_adjustment_items WHERE adjustment_id = $1`, [r.body.adjustment_id]);
  expect(itens).toHaveLength(3);
  const it = itens.find((i) => i.product_id === comCartao);
  expect(it).toMatchObject({ price_before: '59.90', price_after: '65.90', card_price_before: '62.90', card_price_after: '69.20' });
});

test('abaixo do custo: 409 sem flag, grava com allow_below_cost', async () => {
  const pid = await produto('Abaixo', { price: 60, cost: 55 });
  const body = { product_ids: [pid], mode: 'percent', direction: 'down', value: 20, dry_run: false };
  const r1 = await request(app).post(url()).send(body);
  expect(r1.status).toBe(409);
  expect(r1.body).toMatchObject({ code: 'BELOW_COST', summary: { below_cost: 1 } });
  expect(Number((await linha(pid)).price)).toBe(60);

  const r2 = await request(app).post(url()).send({ ...body, allow_below_cost: true });
  expect(r2.status).toBe(200);
  expect(Number((await linha(pid)).price)).toBe(48);
  const { rows: [lote] } = await q(`SELECT allow_below_cost, below_cost_count FROM product_price_adjustments WHERE id = $1`, [r2.body.adjustment_id]);
  expect(lote).toMatchObject({ allow_below_cost: true, below_cost_count: 1 });
});

test('markup: sem custo fica de fora e e contado', async () => {
  const comCusto = await produto('Markup com custo', { price: 100, cost: 40 });
  const semCusto = await produto('Markup sem custo', { price: 100, cost: null });
  const r = await request(app).post(url()).send({ product_ids: [comCusto, semCusto], mode: 'markup', value: 100, dry_run: false });
  expect(r.status).toBe(200);
  expect(r.body.summary).toMatchObject({ items_changed: 1, skipped_no_cost: 1 });
  expect(Number((await linha(comCusto)).price)).toBe(80);
  expect(Number((await linha(semCusto)).price)).toBe(100);
});

test('grupo: compartilhado da filial e visivel e sinalizado; outra loja e inativo nao', async () => {
  const daFilial = await produto('Da filial', { empresa: filial, shared: true });
  const naoCompartilhado = await produto('Filial so dela', { empresa: filial, shared: false });
  const deOutra = await produto('De outra', { empresa: outraLoja });
  const inativo = await produto('Inativo', { active: false });

  const r = await request(app).post(url()).send({ product_ids: [daFilial, naoCompartilhado, deOutra, inativo], mode: 'fixed', direction: 'up', value: 5 });
  expect(r.status).toBe(200);
  expect(r.body.items).toHaveLength(1);
  expect(r.body.items[0]).toMatchObject({ product_id: daFilial, group_shared: true, owner_is_other: true, owner_company_id: filial, price_after: 105 });
  expect(r.body.summary).toMatchObject({ group_shared: 1, owner_is_other: 1, not_found: 3 });
  expect(r.body.not_found_ids.sort()).toEqual([naoCompartilhado, deOutra, inativo].sort());
});

test('nada a mudar: nao cria lote', async () => {
  const pid = await produto('Igual', { price: 184, cost: 92 });
  const r = await request(app).post(url()).send({ product_ids: [pid], mode: 'margin', value: 50, dry_run: false });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ adjustment_id: null, summary: { items_changed: 0, unchanged: 1 } });
});

test('corpo invalido: 400 com code', async () => {
  const r = await request(app).post(url()).send({ product_ids: [], mode: 'percent', value: 10 });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe('INVALID_INPUT');
});

// ─── PR 2: desfazer e lista ─────────────────────────────────

async function aplicar(ids, extra = {}) {
  const r = await request(app).post(url()).send({ product_ids: ids, mode: 'percent', direction: 'up', value: 10, dry_run: false, allow_below_cost: true, ...extra });
  expect(r.status).toBe(200);
  return r.body.adjustment_id;
}

test('desfazer parcial: so onde o preco ainda e o que o lote gravou', async () => {
  const intacto = await produto('Desfazer intacto', { price: 100, card: 105 });
  const mexido = await produto('Desfazer mexido', { price: 50 });
  const cartaoMexido = await produto('Desfazer cartao mexido', { price: 80, card: 84 });
  const comVar = await produto('Desfazer com variante', { price: 30 });
  const { rows: [v] } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty) VALUES ($1, 'P', 40, 2) RETURNING id`, [comVar]);
  const adj = await aplicar([intacto, mexido, cartaoMexido, comVar]);

  // Depois do reajuste: alguem muda o preco de um, o cartao de outro, e vende (estoque) o intacto.
  await q(`UPDATE products SET price = 59.9 WHERE id = $1`, [mexido]);
  await q(`UPDATE products SET card_price = 99 WHERE id = $1`, [cartaoMexido]);
  await q(`UPDATE products SET stock_qty = stock_qty - 1 WHERE id = $1`, [intacto]);

  const r = await request(app).post(`${url()}/${adj}/undo`).send();
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ adjustment_id: adj, restored_count: 3, changed_after_count: 2 });
  expect(r.body.changed_after.map((c) => [c.product_id, c.reason]).sort()).toEqual([[cartaoMexido, 'changed'], [mexido, 'changed']].sort());
  expect(r.body.changed_after.find((c) => c.product_id === mexido)).toMatchObject({ price_after: 55, price_now: 59.9 });

  const i = await linha(intacto);
  expect(Number(i.price)).toBe(100);
  expect(Number(i.card_price)).toBe(105);
  expect(Number(i.stock_qty)).toBe(6); // a venda depois do reajuste continua
  expect(Number((await linha(mexido)).price)).toBe(59.9);
  const cm = await linha(cartaoMexido);
  expect(Number(cm.price)).toBe(88);
  expect(Number(cm.card_price)).toBe(99);
  expect(Number((await linha(comVar)).price)).toBe(30);
  const { rows: [vv] } = await q(`SELECT price_override FROM product_variants WHERE id = $1`, [v.id]);
  expect(Number(vv.price_override)).toBe(40);

  const { rows: [lote] } = await q(`SELECT undone_at, undone_by, undo_restored_count, undo_changed_count FROM product_price_adjustments WHERE id = $1`, [adj]);
  expect(lote).toMatchObject({ undone_by: userId, undo_restored_count: 3, undo_changed_count: 2 });
  expect(lote.undone_at).toBeTruthy();
  const { rows: st } = await q(`SELECT undo_status, COUNT(*)::int AS n FROM product_price_adjustment_items WHERE adjustment_id = $1 GROUP BY 1 ORDER BY 1`, [adj]);
  expect(st).toEqual([{ undo_status: 'changed_after', n: 2 }, { undo_status: 'restored', n: 3 }]);

  // Uma vez so.
  const r2 = await request(app).post(`${url()}/${adj}/undo`).send();
  expect(r2.status).toBe(409);
  expect(r2.body.code).toBe('ALREADY_UNDONE');
});

test('desfazer: produto que deixou de ser visivel conta como not_found', async () => {
  const daFilial = await produto('Desfazer da filial', { empresa: filial, shared: true, price: 20 });
  const adj = await aplicar([daFilial]);
  await q(`UPDATE products SET is_group_shared = false WHERE id = $1`, [daFilial]);
  const r = await request(app).post(`${url()}/${adj}/undo`).send();
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ restored_count: 0, changed_after_count: 1 });
  expect(r.body.changed_after[0]).toMatchObject({ product_id: daFilial, reason: 'not_found', price_now: null });
  expect(Number((await linha(daFilial)).price)).toBe(22);
});

test('desfazer: prazo de 7 dias e lote de outra empresa', async () => {
  const pid = await produto('Desfazer vencido', { price: 10 });
  const adj = await aplicar([pid]);
  await q(`UPDATE product_price_adjustments SET created_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [adj]);
  const r = await request(app).post(`${url()}/${adj}/undo`).send();
  expect(r.status).toBe(410);
  expect(r.body).toMatchObject({ code: 'EXPIRED' });
  expect(Number((await linha(pid)).price)).toBe(11);

  const pid2 = await produto('Desfazer outra empresa', { price: 10 });
  const adj2 = await aplicar([pid2]);
  const r2 = await request(app).post(`${url(outraLoja)}/${adj2}/undo`).send();
  expect(r2.status).toBe(404);
  expect(r2.body.code).toBe('NOT_FOUND');
  const r3 = await request(app).post(`${url()}/nao-e-uuid/undo`).send();
  expect(r3.status).toBe(404);
});

test('lista e detalhe dos reajustes da empresa', async () => {
  const pid = await produto('Lista', { price: 10, cost: 4 });
  const adj = await aplicar([pid], { rounding: '90' });

  // Tudo roda numa transacao so (NOW() igual em todos os lotes), entao o
  // teste procura o lote pelo id em vez de confiar na posicao.
  const pag = await request(app).get(url()).query({ limit: 2 });
  expect(pag.status).toBe(200);
  expect(pag.body.adjustments).toHaveLength(2);
  const r = await request(app).get(url()).query({ limit: 100 });
  expect(r.body.total).toBe(r.body.adjustments.length);
  const meu = r.body.adjustments.find((a) => a.id === adj);
  expect(r.body.adjustments.find((a) => a.undone_at)).toMatchObject({ can_undo: false });
  expect(meu).toMatchObject({
    id: adj, mode: 'percent', direction: 'up', value: 10, rounding: '90', items_count: 1, products_count: 1,
    can_undo: true, undone_at: null, user: { id: userId, name: 'Fixture Reajuste' },
  });
  expect(meu.undo_deadline).toBeTruthy();

  const outra = await request(app).get(url(outraLoja));
  expect(outra.body).toEqual({ adjustments: [], total: 0 });

  const d = await request(app).get(`${url()}/${adj}`);
  expect(d.status).toBe(200);
  expect(d.body).toMatchObject({ id: adj, can_undo: true });
  expect(d.body.items).toEqual([expect.objectContaining({ product_id: pid, variant_id: null, price_before: 10, price_after: 11.9, cost_price: 4, undo_status: null })]);
  expect((await request(app).get(`${url(outraLoja)}/${adj}`)).status).toBe(404);
});
