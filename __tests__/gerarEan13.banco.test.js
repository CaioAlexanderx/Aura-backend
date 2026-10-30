// ============================================================
// AURA. — Gerar EAN-13 (p-74, 30/10/2026) — Postgres real
//
// O que este arquivo cobre:
//   1. dry_run não grava nada; dry_run=false grava em products e
//      product_variants (barcode_format EAN-13) e devolve o mesmo da prévia
//   2. o contador parte do maior código da série no GRUPO: código numa
//      variante de outra empresa do grupo é respeitado (não repete)
//   3. empresa de fora do grupo não conta (o bipe não procura lá)
//   4. a filial gera para o produto compartilhado da matriz; produto da
//      matriz não compartilhado é nao_encontrado
//   5. rodar de novo não sobrescreve: ja_tem_codigo
//   6. audit_log "barcodes_generated"
//
// Mesmo padrão de variante.nomeDaCor.banco.test.js: tudo dentro de UMA
// transação revertida no afterAll. A concorrência (duas conexões de
// verdade) está em gerarEan13.concorrencia.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const { codigoDaSerie } = require('../src/services/gerarEan13');
const { validateEAN13 } = require('../src/services/barcode');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let app;

const userId = uuid();
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const ids = {};

async function q(sql, params) {
  return client.query(sql, params);
}

async function produto(companyId, nome, { shared = false, barcode = null } = {}) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty, is_group_shared, barcode)
     VALUES ($1, $2, 10, 0, $3, $4) RETURNING id`,
    [companyId, nome, shared, barcode]
  );
  return rows[0].id;
}

async function variante(pid, sku, barcode = null) {
  const { rows } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, barcode) VALUES ($1, $2, 1, $3) RETURNING id`,
    [pid, sku, barcode]
  );
  return rows[0].id;
}

async function codigoNoBanco(tabela, id) {
  const { rows } = await q(`SELECT barcode, barcode_format::text AS fmt FROM ${tabela} WHERE id = $1`, [id]);
  return rows[0];
}

const gerar = (cid, body) => request(app).post(`/companies/${cid}/products/barcodes/generate`).send(body);

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

  await q(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture EAN')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Matriz EAN LTDA', 'Matriz')`, [matriz, userId]);
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id)
     VALUES ($1, $2, 'Filial EAN LTDA', 'Filial', $3)`,
    [filial, userId, matriz]
  );
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Outra EAN LTDA', 'Outra')`, [deFora, userId]);

  // Filial já tem o número 5 da série numa VARIANTE de produto próprio
  // (não compartilhado). Variante não tem trava no banco.
  const daFilial = await produto(filial, 'Produto da filial');
  ids.varFilial = await variante(daFilial, 'U', codigoDaSerie(5));
  // Outra loja, fora do grupo, já está no 90: não pode contar.
  await produto(deFora, 'Produto de fora', { barcode: codigoDaSerie(90) });

  ids.semCodigo = await produto(matriz, 'Camiseta sem código', { shared: true });
  ids.comVariante = await produto(matriz, 'Calça com variante', { shared: true });
  ids.varM = await variante(ids.comVariante, 'M');
  ids.privado = await produto(matriz, 'Só da matriz', { shared: false });
  ids.comCodigo = await produto(matriz, 'Já tem código', { barcode: 'INTERNO-77' });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client' }; req.companyRole = 'owner'; next(); });
  app.use('/companies/:id/products', require('../src/routes/productsBarcodeGenerate'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('POST /products/barcodes/generate (Postgres real)', () => {
  const alvos = () => [
    { product_id: ids.semCodigo, variant_id: null },
    { product_id: ids.comVariante, variant_id: ids.varM },
    { product_id: ids.comCodigo, variant_id: null },
  ];
  let previa;

  test('dry_run: prévia parte do maior número do GRUPO (variante da filial), ignora quem é de fora, e não grava', async () => {
    const r = await gerar(matriz, { dry_run: true, targets: alvos() });
    expect(r.status).toBe(200);
    previa = r.body;
    expect(previa.items).toEqual([
      { product_id: ids.semCodigo, variant_id: null, barcode: codigoDaSerie(6) },
      { product_id: ids.comVariante, variant_id: ids.varM, barcode: codigoDaSerie(7) },
    ]);
    previa.items.forEach((i) => expect(validateEAN13(i.barcode)).toBe(true));
    expect(previa.skipped).toEqual([{ product_id: ids.comCodigo, variant_id: null, reason: 'ja_tem_codigo' }]);

    expect((await codigoNoBanco('products', ids.semCodigo)).barcode).toBeNull();
    expect((await codigoNoBanco('product_variants', ids.varM)).barcode).toBeNull();
  });

  test('dry_run=false grava o mesmo da prévia, com formato EAN-13, e audita', async () => {
    const r = await gerar(matriz, { dry_run: false, targets: alvos() });
    expect(r.status).toBe(200);
    expect(r.body.dry_run).toBe(false);
    expect(r.body.items).toEqual(previa.items);
    expect(r.body.skipped).toEqual(previa.skipped);

    expect(await codigoNoBanco('products', ids.semCodigo)).toEqual({ barcode: codigoDaSerie(6), fmt: 'EAN-13' });
    expect(await codigoNoBanco('product_variants', ids.varM)).toEqual({ barcode: codigoDaSerie(7), fmt: 'EAN-13' });
    expect((await codigoNoBanco('products', ids.comCodigo)).barcode).toBe('INTERNO-77');

    const { rows } = await q(
      `SELECT user_id, metadata FROM audit_log WHERE company_id = $1 AND action = 'barcodes_generated'`,
      [matriz]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userId);
    expect(rows[0].metadata).toMatchObject({ gerados: 2, de_produto: 1, de_variante: 1 });
  });

  test('rodar de novo não sobrescreve nada', async () => {
    const r = await gerar(matriz, { dry_run: false, targets: alvos() });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.skipped.map((s) => s.reason)).toEqual(['ja_tem_codigo', 'ja_tem_codigo', 'ja_tem_codigo']);
    expect((await codigoNoBanco('products', ids.semCodigo)).barcode).toBe(codigoDaSerie(6));
  });

  test('a filial gera para o compartilhado da matriz e segue o mesmo contador; o privado da matriz não aparece', async () => {
    const novo = await produto(matriz, 'Boné compartilhado', { shared: true });
    const r = await gerar(filial, {
      dry_run: false,
      targets: [{ product_id: novo, variant_id: null }, { product_id: ids.privado, variant_id: null }],
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ product_id: novo, variant_id: null, barcode: codigoDaSerie(8) }]);
    expect(r.body.skipped).toEqual([{ product_id: ids.privado, variant_id: null, reason: 'nao_encontrado' }]);
  });

  test('variante que não é do produto informado é nao_encontrado', async () => {
    const r = await gerar(matriz, { dry_run: true, targets: [{ product_id: ids.semCodigo, variant_id: ids.varFilial }] });
    expect(r.body.items).toEqual([]);
    expect(r.body.skipped[0].reason).toBe('nao_encontrado');
  });
});
