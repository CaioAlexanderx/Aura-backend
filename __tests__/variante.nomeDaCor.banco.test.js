// ============================================================
// AURA. — Nome da cor por variante — Postgres real (tq-55b, 26/10/2026)
//
// O nome que a lojista dá à cor só ficava em product_variants.sku_suffix,
// em maiúsculas e cortado em 10 letras. A migration 414 cria
// product_variants.color_name; o PUT /variations grava o nome como veio e
// os dois GETs devolvem.
//
// O que este arquivo cobre:
//   1. PUT grava color_name como veio (sem caixa alta nem corte; só tira o
//      espaço das pontas) e o sku_suffix continua o de sempre
//   2. GET /variations devolve o nome inteiro em colors[].name
//   3. GET /products/:pid/variants devolve color_name por variante
//   4. variante antiga (color_name NULL) segue com o nome tirado do sufixo
//   5. nome vazio ou hex vira NULL; produto só com tamanho fica NULL
//
// Mesmo padrão de produto.excluirNuncaNegado.banco.test.js: tudo dentro de
// UMA transação revertida no afterAll.
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

async function variantesNoBanco(pid) {
  const { rows } = await q(
    `SELECT pv.sku_suffix, pv.color_name,
            MAX(pvv.value) FILTER (WHERE pvv.attribute_name = 'Cor') AS cor,
            MAX(pvv.value) FILTER (WHERE pvv.attribute_name = 'Tamanho') AS tamanho
       FROM product_variants pv
       LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
      WHERE pv.product_id = $1 AND pv.is_active = true
      GROUP BY pv.id ORDER BY pv.created_at, pv.sku_suffix`,
    [pid]
  );
  return rows;
}

describe('PUT /variations grava o nome da cor como veio', () => {
  let pid;
  beforeAll(async () => {
    pid = await produto('Legging Fit');
    const r = await request(app).put(`${base}/${pid}/variations`).send({
      colors: [{ hex: '#1F5F6B', name: 'Azul petróleo' }, { hex: '#F4F1EA', name: 'Off' }],
      sizes: ['P', 'M'],
      matrix: { '#1F5F6B|P': 2, '#1F5F6B|M': 1, '#F4F1EA|P': 3, '#F4F1EA|M': 0 },
    });
    expect(r.status).toBe(200);
  });

  test('color_name inteiro, com acento e caixa da lojista; sku_suffix como sempre', async () => {
    const rows = await variantesNoBanco(pid);
    expect(rows).toHaveLength(4);
    const azul = rows.filter((v) => v.cor === '#1F5F6B');
    expect(azul.map((v) => v.color_name)).toEqual(['Azul petróleo', 'Azul petróleo']);
    expect(azul.map((v) => v.sku_suffix).sort()).toEqual(['AZUL PETRÓ-M', 'AZUL PETRÓ-P']);
    const off = rows.filter((v) => v.cor === '#F4F1EA');
    expect(off.map((v) => v.color_name)).toEqual(['Off', 'Off']);
    expect(off.map((v) => v.sku_suffix).sort()).toEqual(['OFF-M', 'OFF-P']);
  });

  test('GET /variations devolve o nome inteiro em colors[].name', async () => {
    const r = await request(app).get(`${base}/${pid}/variations`);
    expect(r.status).toBe(200);
    // Dentro da transacao do teste o created_at e o mesmo para todas: a
    // ordem entre cores nao e o que se mede aqui.
    const cores = [...r.body.colors].sort((a, b) => a.hex.localeCompare(b.hex));
    expect(cores).toEqual([
      { hex: '#1F5F6B', name: 'Azul petróleo' },
      { hex: '#F4F1EA', name: 'Off' },
    ]);
    expect(r.body.mode).toBe('matrix');
  });

  test('GET /products/:pid/variants devolve color_name por variante', async () => {
    const r = await request(app).get(`${base}/${pid}/variants`);
    expect(r.status).toBe(200);
    expect(r.body.variants).toHaveLength(4);
    for (const v of r.body.variants) {
      const cor = v.attributes.find((a) => a.attribute === 'Cor').value;
      expect(v.color_name).toBe(cor === '#1F5F6B' ? 'Azul petróleo' : 'Off');
    }
  });

  test('salvar de novo com outro nome troca o nome (o PUT reescreve as variantes)', async () => {
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [{ hex: '#1F5F6B', name: 'Petróleo' }], sizes: [], matrix: { '#1F5F6B|': 4 },
    }).expect(200);
    const rows = await variantesNoBanco(pid);
    expect(rows).toEqual([{ sku_suffix: 'PETRÓLEO', color_name: 'Petróleo', cor: '#1F5F6B', tamanho: null }]);
  });
});

describe('sem nome para gravar', () => {
  test('nome vazio, hex ou ausente fica NULL; o sufixo segue o de sempre', async () => {
    const pid = await produto('Camiseta');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [{ hex: '#000000', name: '' }, { hex: '#FFFFFF', name: '#FFFFFF' }, { hex: '#3B82F6' }],
      sizes: [], matrix: {},
    }).expect(200);
    const rows = await variantesNoBanco(pid);
    expect(rows.map((v) => v.color_name)).toEqual([null, null, null]);
    expect(rows.map((v) => v.sku_suffix).sort()).toEqual(['000000', '#FFFFFF', '3B82F6'].sort());
  });

  test('espaço nas pontas sai do nome (o sufixo segue o de sempre)', async () => {
    const pid = await produto('Regata');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [{ hex: '#4B5320', name: '  Militar  ' }], sizes: [], matrix: {},
    }).expect(200);
    const rows = await variantesNoBanco(pid);
    expect(rows.map((v) => v.color_name)).toEqual(['Militar']);
  });

  test('produto só com tamanho: color_name NULL', async () => {
    const pid = await produto('Meia');
    await request(app).put(`${base}/${pid}/variations`).send({ colors: [], sizes: ['P'], matrix: { '|P': 1 } }).expect(200);
    const rows = await variantesNoBanco(pid);
    expect(rows).toEqual([{ sku_suffix: 'P', color_name: null, cor: null, tamanho: 'P' }]);
  });
});

describe('variante antiga (gravada antes da 414)', () => {
  test('color_name NULL: o GET /variations segue tirando o nome do sufixo', async () => {
    const pid = await produto('Blusa antiga');
    const { rows } = await q(
      `INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, 'VERMELHO-P', 2) RETURNING id`,
      [pid]
    );
    await q(
      `INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Cor', '#EF4444'), ($1, 'Tamanho', 'P')`,
      [rows[0].id]
    );
    const r = await request(app).get(`${base}/${pid}/variations`);
    expect(r.body.colors).toEqual([{ hex: '#EF4444', name: 'VERMELHO' }]);
    const v = await request(app).get(`${base}/${pid}/variants`);
    expect(v.body.variants[0].color_name).toBeNull();
    expect(v.body.variants[0].sku_suffix).toBe('VERMELHO-P');
  });
});
