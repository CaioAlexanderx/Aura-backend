// ============================================================
// AURA. — Busca pelo nome da cor — Postgres real (CP6, 14/11/2026)
//
//   1. a lista de produtos traz variant_color_names (nome da regra + gravado)
//   2. ?search= acha pelo color_name da variante; "preta" acha "Preto";
//      "verde agua" acha "Verde-água"; a busca pelo nome segue igual
//   3. a vitrine (paginaDoCatalogo) acha pela cor da variante quando há
//      busca e mostra tudo sem busca
// Tudo dentro de UMA transação revertida no afterAll.
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

const userId    = uuid();
const companyId = uuid();
const base = `/companies/${companyId}/products`;

async function q(sql, params) {
  return client.query(sql, params);
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

  // O PUT lê products.color/size, colunas que o banco de produção tem e o
  // schema montado pelas migrations não. Só nesta transação.
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT`);

  await q(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Cor')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture Leibert LTDA', 'Leibert')`,
    [companyId, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client', plan: 'negocio' }; next(); });
  // Mesma ordem do private.js: ./productsVariations antes de ./products.
  app.use('/companies/:id/products', require('../src/routes/productsVariations'));
  app.use('/companies/:id/products', require('../src/routes/products'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});


async function produto(nome) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty) VALUES ($1, $2, 89.9, 0) RETURNING id`,
    [companyId, nome]
  );
  return rows[0].id;
}
async function variante(pid, { sku, hex, tamanho, colorName = null, estoque = 2 }) {
  const { rows } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, color_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [pid, sku, estoque, colorName]
  );
  await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Cor', $2), ($1, 'Tamanho', $3)`, [rows[0].id, hex, tamanho]);
}

let vestido, saia, blusa;
beforeAll(async () => {
  vestido = await produto('Vestido Midi');
  await variante(vestido, { sku: 'PRETO-M', hex: '#000000', tamanho: 'M', colorName: 'Preto' });
  saia = await produto('Saia Lápis');
  await variante(saia, { sku: 'VERDE AGUA-P', hex: '#7FD1C1', tamanho: 'P', colorName: 'Verde-água' });
  blusa = await produto('Blusa Básica');
  await variante(blusa, { sku: 'AZUL ESCUR-G', hex: '#1F2A44', tamanho: 'G', colorName: 'AZUL ESCUR' });
});

describe('lista de produtos (Caixa e Estoque)', () => {
  test('variant_color_names traz o nome da regra e o gravado', async () => {
    const r = await request(app).get(`${base}?limit=50`).expect(200);
    const porId = Object.fromEntries(r.body.products.map((p) => [p.id, p]));
    expect(porId[vestido].variant_color_names).toEqual(['Preto']);
    expect(porId[blusa].variant_color_names).toEqual(['Cinza escuro', 'AZUL ESCUR']);
  });
  test('?search=preta acha o vestido Preto; "verde agua" acha a Verde-água', async () => {
    const preta = await request(app).get(`${base}?search=preta`).expect(200);
    expect(preta.body.products.map((p) => p.id)).toEqual([vestido]);
    const agua = await request(app).get(`${base}?search=${encodeURIComponent('verde agua')}`).expect(200);
    expect(agua.body.products.map((p) => p.id)).toEqual([saia]);
  });
  test('a busca de sempre continua (pelo nome)', async () => {
    const r = await request(app).get(`${base}?search=Blusa`).expect(200);
    expect(r.body.products.map((p) => p.id)).toEqual([blusa]);
  });
});

describe('vitrine', () => {
  const { paginaDoCatalogo } = require('../src/services/catalogoPaginado');
  const { listVisibilityWhere } = require('../src/services/storefrontBuilder');
  const ids = async (busca) => {
    const r = await paginaDoCatalogo({ cid: companyId, visibilityWhere: listVisibilityWhere('$1'), busca, exigeFoto: false });
    return (r.items || r.produtos || r.products || []).map((p) => p.id).sort();
  };
  test('"preta" acha a peça com variante Preto; "agua" acha a Verde-água', async () => {
    expect(await ids('preta')).toEqual([vestido]);
    expect(await ids('agua')).toEqual([saia]);
  });
  test('sem busca, as três', async () => {
    expect(await ids('')).toEqual([vestido, saia, blusa].sort());
  });
});
