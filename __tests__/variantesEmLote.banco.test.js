// ============================================================
// AURA. — Variantes em lote para a tela de etiquetas (p-73, 30/10/2026)
// Postgres real.
//
// A tela de etiquetas buscava as variantes de cada produto marcado com uma
// chamada por produto. GET /products/variants?product_ids= devolve tudo
// numa consulta só, com a mesma regra de grupo da listagem de produtos.
//
// O que este arquivo cobre:
//   1. só variante ativa, com os campos do GET /:pid/variants + product_id,
//      color, size, price e is_active
//   2. produto sem variante vem com []
//   3. produto compartilhado da matriz aparece para a filial
//   4. produto da matriz NÃO compartilhado e produto de fora do grupo são
//      omitidos (sem 403)
//   5. id que não é uuid é omitido; mais de 200 ids -> 400
//   6. o GET de um produto continua devolvendo os mesmos campos
//
// Mesmo padrão de variante.nomeDaCor.banco.test.js: tudo dentro de UMA
// transação revertida no afterAll.
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

const userId  = uuid();
const matriz  = uuid();
const filial  = uuid();
const deFora  = uuid();

const ids = {};

async function q(sql, params) {
  return client.query(sql, params);
}

async function produto(companyId, nome, { shared = false, price = 50 } = {}) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty, is_group_shared)
     VALUES ($1, $2, $3, 0, $4) RETURNING id`,
    [companyId, nome, price, shared]
  );
  return rows[0].id;
}

async function variante(pid, { sku, stock, barcode = null, price = null, ativo = true, cor, tamanho, nomeCor = null }) {
  const { rows } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, barcode, price_override, is_active, color_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [pid, sku, stock, barcode, price, ativo, nomeCor]
  );
  const vid = rows[0].id;
  if (cor) await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Cor', $2)`, [vid, cor]);
  if (tamanho) await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', $2)`, [vid, tamanho]);
  return vid;
}

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

  await q(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Lote')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Matriz Fixture LTDA', 'Matriz')`,
    [matriz, userId]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id)
     VALUES ($1, $2, 'Filial Fixture LTDA', 'Filial', $3)`,
    [filial, userId, matriz]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Outra Fixture LTDA', 'Outra')`,
    [deFora, userId]
  );

  ids.compartilhado = await produto(matriz, 'Tênis compartilhado', { shared: true, price: 249.9 });
  ids.v38 = await variante(ids.compartilhado, { sku: 'PRETO-38', stock: 3, barcode: '7891234567895', cor: '#000000', tamanho: '38', nomeCor: 'Preto' });
  ids.v39 = await variante(ids.compartilhado, { sku: 'PRETO-39', stock: 0, price: 199.9, cor: '#000000', tamanho: '39', nomeCor: 'Preto' });
  ids.vInativa = await variante(ids.compartilhado, { sku: 'PRETO-40', stock: 7, ativo: false, cor: '#000000', tamanho: '40' });

  ids.daMatrizPrivado = await produto(matriz, 'Só da matriz', { shared: false });
  await variante(ids.daMatrizPrivado, { sku: 'P', stock: 1, tamanho: 'P' });

  ids.daFilialSemVariante = await produto(filial, 'Bolsa da filial');
  ids.deFora = await produto(deFora, 'Produto de outra loja', { shared: true });
  await variante(ids.deFora, { sku: 'M', stock: 1, tamanho: 'M' });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client', plan: 'negocio' }; next(); });
  app.use('/companies/:id/products', require('../src/routes/products'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('GET /products/variants?product_ids= (lote)', () => {
  test('filial enxerga o compartilhado da matriz e o próprio; o resto fica de fora', async () => {
    const lista = [ids.compartilhado, ids.daMatrizPrivado, ids.daFilialSemVariante, ids.deFora, 'nao-e-uuid'].join(',');
    const r = await request(app).get(`/companies/${filial}/products/variants`).query({ product_ids: lista });
    expect(r.status).toBe(200);
    const mapa = r.body.variants_by_product;
    expect(Object.keys(mapa).sort()).toEqual([ids.compartilhado, ids.daFilialSemVariante].sort());
    expect(mapa[ids.daFilialSemVariante]).toEqual([]);

    const vs = mapa[ids.compartilhado];
    expect(vs.map((v) => v.id).sort()).toEqual([ids.v38, ids.v39].sort());
    const v38 = vs.find((v) => v.id === ids.v38);
    expect(v38).toMatchObject({
      product_id: ids.compartilhado,
      sku_suffix: 'PRETO-38',
      barcode: '7891234567895',
      color_name: 'Preto',
      color: '#000000',
      size: '38',
      price: null,
      price_override: null,
      is_active: true,
    });
    expect(parseFloat(v38.stock_qty)).toBe(3);
    expect(v38.attributes).toEqual([
      { attribute: 'Cor', value: '#000000' },
      { attribute: 'Tamanho', value: '38' },
    ]);
    const v39 = vs.find((v) => v.id === ids.v39);
    expect(v39.price).toBe(199.9);
    expect(v39.barcode).toBeNull();
  });

  test('a matriz enxerga o próprio produto mesmo sem compartilhar', async () => {
    const r = await request(app)
      .get(`/companies/${matriz}/products/variants`)
      .query({ product_ids: `${ids.daMatrizPrivado},${ids.daFilialSemVariante}` });
    expect(r.status).toBe(200);
    // Produto da filial sem is_group_shared: a matriz não vê (regra da listagem).
    expect(Object.keys(r.body.variants_by_product)).toEqual([ids.daMatrizPrivado]);
    expect(r.body.variants_by_product[ids.daMatrizPrivado]).toHaveLength(1);
    expect(r.body.variants_by_product[ids.daMatrizPrivado][0]).toMatchObject({ size: 'P', color: null });
  });

  test('cada variante do lote traz os mesmos campos do GET de um produto', async () => {
    const um = await request(app).get(`/companies/${filial}/products/${ids.compartilhado}/variants`);
    expect(um.status).toBe(200);
    const lote = await request(app).get(`/companies/${filial}/products/variants`).query({ product_ids: ids.compartilhado });
    const doLote = lote.body.variants_by_product[ids.compartilhado];
    expect(doLote).toHaveLength(um.body.variants.length);
    for (const v of um.body.variants) {
      const igual = doLote.find((x) => x.id === v.id);
      for (const k of Object.keys(v)) expect(igual[k]).toEqual(v[k]);
    }
  });

  test('ids repetidos contam uma vez; mais de 200 distintos -> 400', async () => {
    const rep = await request(app)
      .get(`/companies/${filial}/products/variants`)
      .query({ product_ids: `${ids.daFilialSemVariante},${ids.daFilialSemVariante}` });
    expect(rep.status).toBe(200);
    expect(Object.keys(rep.body.variants_by_product)).toEqual([ids.daFilialSemVariante]);

    const muitos = Array.from({ length: 201 }, () => uuid()).join(',');
    const r = await request(app).get(`/companies/${filial}/products/variants`).query({ product_ids: muitos });
    expect(r.status).toBe(400);
  });
});
