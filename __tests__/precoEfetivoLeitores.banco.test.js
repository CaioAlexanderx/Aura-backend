// ============================================================
// AURA. — De/Por nos leitores que vendem ou mostram preco (p-85, 08/11/2026)
// Postgres real, schema das migrations (inclui a 427).
//
//   1. bipe (/pdv/scan): codigo do produto, da variante, SKU, sugestoes e
//      lote trazem em_promocao/preco_efetivo; price segue o normal
//   2. /products/barcode/:code: produto e variante bipada
//   3. vitrine: peca em promocao sai com price = efetivo e preco_de;
//      sem promocao o payload e IDENTICO (nenhuma chave nova)
//   4. Aurinha: diz o preco de promocao e o "de"
//   5. agendada, vencida, variante com price_override, grupo
//
// Mesmo arreio do promocaoDePor.banco.test.js: uma transacao revertida no
// afterAll, fila unica, savepoint por consulta.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.user || { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

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

const dono = uuid();
const matriz = uuid();
const filial = uuid();
const ids = {};
const COD = {
  promo: '7891000000011',
  normal: '7891000000028',
  agendado: '7891000000035',
  vencido: '7891000000042',
  varPropria: '7891000000059',
  varHerda: '7891000000066',
  daFilial: '7891000000073',
};

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}
const q = (sql, params) => naFila(() => client.query(sql, params));

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  let qn = 0;
  db.query.mockImplementation((sql, params) => naFila(async () => {
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
  }));

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Leitores')`,
    [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES
             ($1, $3, 'Fixture Matriz LTDA', 'Matriz'), ($2, $3, 'Fixture Filial LTDA', 'Filial')`,
    [matriz, filial, dono]);
  await q(`UPDATE companies SET billing_owner_company_id = $1 WHERE id = $2`, [matriz, filial]);

  const produto = async (chave, { empresa = matriz, price = 100, shared = false, barcode = null, promo = null } = {}) => {
    const { rows: [r] } = await q(
      `INSERT INTO products (company_id, name, sku, barcode, price, cost_price, is_group_shared, is_active, stock_qty)
       VALUES ($1, $2, $3, $4, $5, 40, $6, true, 5) RETURNING id`,
      [empresa, `Peca ${chave}`, `SKU-LEIT-${chave}`, barcode, price, shared]
    );
    ids[chave] = r.id;
    if (promo) {
      await q(`UPDATE products SET promo_price = $2, promo_starts_at = NOW() + $3::interval, promo_ends_at = NOW() + $4::interval WHERE id = $1`,
        [r.id, promo[0], promo[1], promo[2]]);
    }
    return r.id;
  };
  await produto('promo', { barcode: COD.promo, promo: [79.9, '-1 day', '7 days'] });
  await produto('normal', { barcode: COD.normal });
  await produto('agendado', { barcode: COD.agendado, promo: [79.9, '2 days', '7 days'] });
  await produto('vencido', { barcode: COD.vencido, promo: [79.9, '-7 days', '-1 day'] });
  await produto('daFilial', { empresa: filial, shared: true, barcode: COD.daFilial, promo: [60, '-1 day', '7 days'] });
  // Produto com variantes: uma com preco proprio e promocao propria, uma
  // sem preco proprio (segue o produto, que esta em promocao).
  const comVar = await produto('comVar', { price: 150, promo: [120, '-1 day', '7 days'] });
  const { rows: [vp] } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, price_override, barcode, stock_qty, promo_price, promo_starts_at, promo_ends_at)
     VALUES ($1, 'G', 170, $2, 3, 140, NOW() - INTERVAL '1 day', NOW() + INTERVAL '7 days') RETURNING id`, [comVar, COD.varPropria]);
  const { rows: [vh] } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, price_override, barcode, stock_qty)
     VALUES ($1, 'P', NULL, $2, 3) RETURNING id`, [comVar, COD.varHerda]);
  ids.varPropria = vp.id;
  ids.varHerda = vh.id;

  app = express();
  app.use(express.json());
  app.use('/companies/:id/pdv', require('../src/routes/scanner'));
  app.use('/companies/:id/products', require('../src/routes/barcode'));
});

afterAll(async () => {
  await fila;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const bipe = (code, cid = matriz) => request(app).get(`/companies/${cid}/pdv/scan/${code}`);

describe('bipe (/pdv/scan)', () => {
  test('em promocao: preco_efetivo e o de promocao; price segue o normal', async () => {
    const r = await bipe(COD.promo);
    expect(r.status).toBe(200);
    expect(r.body.product).toMatchObject({ id: ids.promo, price: '100.00', promo_price: 79.9, em_promocao: true, preco_efetivo: 79.9 });
  });

  test('sem promocao, agendada e vencida: preco normal', async () => {
    expect((await bipe(COD.normal)).body.product).toMatchObject({ promo_price: null, em_promocao: false, preco_efetivo: 100 });
    expect((await bipe(COD.agendado)).body.product).toMatchObject({ promo_price: 79.9, em_promocao: false, preco_efetivo: 100 });
    expect((await bipe(COD.vencido)).body.product).toMatchObject({ promo_price: 79.9, em_promocao: false, preco_efetivo: 100 });
  });

  test('variante com preco proprio e promocao propria', async () => {
    const r = await bipe(COD.varPropria);
    expect(r.body).toMatchObject({
      source: 'variant_barcode', variant_id: ids.varPropria,
      effective_price: '170.00', em_promocao: true, preco_efetivo: 140, promo_price: 140,
    });
    expect(r.body.product).toMatchObject({ id: ids.comVar, em_promocao: true, preco_efetivo: 120 });
  });

  test('variante sem preco proprio segue a promocao do produto', async () => {
    const r = await bipe(COD.varHerda);
    expect(r.body).toMatchObject({ variant_id: ids.varHerda, em_promocao: true, preco_efetivo: 120 });
  });

  test('grupo: a matriz bipa o compartilhado da filial em promocao', async () => {
    const r = await bipe(COD.daFilial, matriz);
    expect(r.body.product).toMatchObject({ id: ids.daFilial, em_promocao: true, preco_efetivo: 60 });
  });

  test('SKU, sugestoes e lote', async () => {
    expect((await bipe('SKU-LEIT-promo')).body.product).toMatchObject({ em_promocao: true, preco_efetivo: 79.9 });
    const sug = await bipe('Peca prom');
    expect(sug.status).toBe(207);
    expect(sug.body.suggestions.find((s) => s.id === ids.promo)).toMatchObject({ preco_efetivo: 79.9 });
    const lote = await request(app).post(`/companies/${matriz}/pdv/scan/batch`).send({ codes: [COD.promo, COD.normal] });
    expect(lote.body.products[COD.promo]).toMatchObject({ em_promocao: true, preco_efetivo: 79.9 });
    expect(lote.body.products[COD.normal]).toMatchObject({ em_promocao: false, preco_efetivo: 100 });
  });

  test('produto com variantes pelo codigo do pai: cada variante com o seu preco', async () => {
    await q(`UPDATE products SET barcode = '7891000000080' WHERE id = $1`, [ids.comVar]);
    const r = await bipe('7891000000080');
    const porId = Object.fromEntries(r.body.product.variants.map((v) => [v.id, v]));
    expect(porId[ids.varPropria]).toMatchObject({ price_override: 170, em_promocao: true, preco_efetivo: 140 });
    expect(porId[ids.varHerda]).toMatchObject({ price_override: null, em_promocao: true, preco_efetivo: 120 });
  });
});

describe('/products/barcode/:code', () => {
  test('produto e variante bipada', async () => {
    const p = await request(app).get(`/companies/${matriz}/products/barcode/${COD.promo}`);
    expect(p.body.product).toMatchObject({ id: ids.promo, em_promocao: true, preco_efetivo: 79.9 });
    expect(p.body.product.matched_variant_preco_efetivo).toBeUndefined();
    const v = await request(app).get(`/companies/${matriz}/products/barcode/${COD.varPropria}`);
    expect(v.body.product).toMatchObject({
      id: ids.comVar, matched_variant_id: ids.varPropria, preco_efetivo: 120,
      matched_variant_em_promocao: true, matched_variant_preco_efetivo: 140,
    });
    expect(v.body.product.mv_promo_price).toBeUndefined();
  });
});

describe('vitrine (payload publico)', () => {
  const { fetchVariantesPorProduto, montarProdutoPublico } = require('../src/services/storefrontBuilder');
  const mapas = { categoryById: {}, primaryLinkByProduct: {}, mostrarPrecos: true };
  const linha = async (id) => (await q(
    `SELECT id, name, description, price, image_url, image_thumb_url, gallery_urls, category, stock_qty, created_at,
            promo_price, promo_starts_at, promo_ends_at FROM products WHERE id = $1`, [id])).rows[0];

  test('sem promocao (ou agendada/vencida): nenhuma chave nova, price normal', async () => {
    const vazio = { ...mapas, variantsByProduct: {} };
    const semPromo = montarProdutoPublico(await linha(ids.normal), vazio);
    const { promo_price, promo_starts_at, promo_ends_at, ...semColunas } = await linha(ids.normal);
    expect(semPromo).toEqual(montarProdutoPublico(semColunas, vazio));
    expect(semPromo.price).toBe(100);
    expect(semPromo).not.toHaveProperty('preco_de');
    expect(montarProdutoPublico(await linha(ids.agendado), vazio)).not.toHaveProperty('preco_de');
    expect(montarProdutoPublico(await linha(ids.vencido), vazio).price).toBe(100);
  });

  test('em promocao: price = efetivo (o carrinho e o pedido cobram ele) e preco_de', async () => {
    const p = montarProdutoPublico(await linha(ids.promo), { ...mapas, variantsByProduct: {} });
    expect(p).toMatchObject({ price: 79.9, preco_de: 100, em_promocao: true });
    const oculto = montarProdutoPublico(await linha(ids.promo), { ...mapas, mostrarPrecos: false, variantsByProduct: {} });
    expect(oculto.price).toBeNull();
    expect(oculto).not.toHaveProperty('preco_de');
  });

  test('variantes: promocao propria muda o price_override; quem herda fica null (usa o price do produto)', async () => {
    const porProduto = await fetchVariantesPorProduto([ids.comVar]);
    const porId = Object.fromEntries(porProduto[ids.comVar].map((v) => [v.id, v]));
    expect(porId[ids.varPropria]).toMatchObject({ price_override: 140, preco_de: 170, em_promocao: true });
    expect(porId[ids.varHerda].price_override).toBeNull();
    expect(porId[ids.varHerda]).not.toHaveProperty('preco_de');
    const p = montarProdutoPublico(await linha(ids.comVar), { ...mapas, variantsByProduct: porProduto });
    expect(p.price).toBe(120);
  });
});

describe('Aurinha', () => {
  const { execTool } = require('../src/services/aurinhaAgent');

  test('detalhe: preco de promocao e o "de"; sem promocao igual a antes', async () => {
    const promo = await execTool(matriz, {}, 'detalhe_produto', { produto_id: ids.promo });
    expect(promo).toMatchObject({ preco: 79.9, preco_de: 100 });
    const normal = await execTool(matriz, {}, 'detalhe_produto', { produto_id: ids.normal });
    expect(normal).toEqual({ id: ids.normal, nome: 'Peca normal', preco: 100, estoque_total: 5, variacoes: [] });
    const comVar = await execTool(matriz, {}, 'detalhe_produto', { produto_id: ids.comVar });
    const porNome = Object.fromEntries(comVar.variacoes.map((v) => [v.variacao, v]));
    expect(porNome.G).toMatchObject({ preco: 140, preco_de: 170 });
    expect(porNome.P).toMatchObject({ preco: 120, preco_de: 150 });
  });

  test('busca', async () => {
    const r = await execTool(matriz, {}, 'buscar_produtos', { termo: 'Peca promo' });
    expect(r.produtos[0]).toMatchObject({ id: ids.promo, preco: 79.9, preco_de: 100 });
  });
});
