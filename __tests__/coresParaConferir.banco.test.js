// ============================================================
// AURA. — Nomes de cor para conferir — Postgres real (CP5, 14/11/2026)
//
// O que este arquivo cobre:
//   1. GET lista o que a loja enxerga: próprios + compartilhados do grupo
//      (filial vê o compartilhado da matriz); nada de outra empresa
//   2. o GET não escreve nada
//   3. POST grava o nome só nas variantes ativas daquele produto e daquela
//      cor; o sku_suffix não muda; outra cor do mesmo produto fica igual
//   4. POST num produto de outra empresa não grava (recusado)
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
const companyId = uuid();   // matriz
const filialId  = uuid();
const outraId   = uuid();   // outra empresa, fora do grupo
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
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture Matriz LTDA', 'Matriz')`,
    [companyId, userId]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial LTDA', 'Filial', $3)`,
    [filialId, userId, companyId]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture Outra LTDA', 'Outra')`,
    [outraId, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client', plan: 'negocio' }; next(); });
  // Mesma ordem do private.js: ./productsVariations antes de ./products.
  app.use('/companies/:id/products', require('../src/routes/productColorNames'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});


async function produto(empresa, nome, compartilhado = false) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty, is_group_shared) VALUES ($1, $2, 89.9, 0, $3) RETURNING id`,
    [empresa, nome, compartilhado]
  );
  return rows[0].id;
}
async function variante(pid, { sku, hex, tamanho, colorName = null }) {
  const { rows } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, color_name) VALUES ($1, $2, 1, $3) RETURNING id`,
    [pid, sku, colorName]
  );
  await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Cor', $2), ($1, 'Tamanho', $3)`, [rows[0].id, hex, tamanho]);
  return rows[0].id;
}
async function nomes(pid) {
  const { rows } = await q(
    `SELECT pv.sku_suffix, pv.color_name,
            (SELECT value FROM product_variant_values WHERE variant_id = pv.id AND attribute_name = 'Cor') AS cor
       FROM product_variants pv WHERE pv.product_id = $1 ORDER BY pv.sku_suffix`,
    [pid]
  );
  return rows;
}

let vestido, saiaDaMatriz, blusaDeOutra;
beforeAll(async () => {
  vestido = await produto(companyId, 'Vestido Midi');
  await variante(vestido, { sku: 'AZUL ESCUR-M', hex: '#1F2A44', tamanho: 'M', colorName: 'AZUL ESCUR' });
  await variante(vestido, { sku: 'AZUL ESCUR-G', hex: '#1F2A44', tamanho: 'G' });
  await variante(vestido, { sku: 'CAQUI-M', hex: '#C3B091', tamanho: 'M', colorName: 'Caqui' });
  saiaDaMatriz = await produto(companyId, 'Saia compartilhada', true);
  await variante(saiaDaMatriz, { sku: 'OFF WHITE-P', hex: '#FAF9F6', tamanho: 'P', colorName: 'OFF WHITE' });
  blusaDeOutra = await produto(outraId, 'Blusa de outra loja');
  await variante(blusaDeOutra, { sku: 'AZUL ESCUR-P', hex: '#1F2A44', tamanho: 'P', colorName: 'AZUL ESCUR' });
});

describe('GET /cores-para-conferir', () => {
  test('a matriz vê o próprio e o compartilhado; nada da outra empresa', async () => {
    const r = await request(app).get(`/companies/${companyId}/products/cores-para-conferir`).expect(200);
    const g = Object.fromEntries(r.body.grupos.map((x) => [x.pedaco, x]));
    expect(Object.keys(g).sort()).toEqual(['AZUL ESCUR', 'OFF WHITE']);
    expect(g['AZUL ESCUR']).toMatchObject({ tipo: 'cortado', variantes: 2, produtos: 1, unica_da_paleta: true, hoje: 'Cinza escuro', sugestao: { nome: 'Azul escuro', fonte: 'paleta' } });
    expect(g['AZUL ESCUR'].itens.map((i) => i.product_id)).toEqual([vestido]);
    expect(g['OFF WHITE']).toMatchObject({ tipo: 'maiusculo', sugestao: { nome: 'Off white', fonte: 'paleta' } });
  });
  test('a filial vê o compartilhado da matriz', async () => {
    const r = await request(app).get(`/companies/${filialId}/products/cores-para-conferir`).expect(200);
    expect(r.body.grupos.map((x) => x.pedaco)).toEqual(['OFF WHITE']);
  });
  test('ler não escreve', async () => {
    await request(app).get(`/companies/${companyId}/products/cores-para-conferir`).expect(200);
    expect((await nomes(vestido)).map((x) => x.color_name)).toEqual([null, 'AZUL ESCUR', 'Caqui']);
  });
});

describe('POST /cores-para-conferir/confirmar', () => {
  test('grava o nome só naquela cor do produto, nas variantes ativas, e o sufixo fica', async () => {
    const r = await request(app).post(`/companies/${companyId}/products/cores-para-conferir/confirmar`)
      .send({ itens: [{ product_id: vestido, hex: '#1f2a44', nome: 'Azul escuro' }] }).expect(200);
    expect(r.body).toEqual({ variantes: 2, itens: 1, recusados: 0 });
    expect(await nomes(vestido)).toEqual([
      { sku_suffix: 'AZUL ESCUR-G', color_name: 'Azul escuro', cor: '#1F2A44' },
      { sku_suffix: 'AZUL ESCUR-M', color_name: 'Azul escuro', cor: '#1F2A44' },
      { sku_suffix: 'CAQUI-M', color_name: 'Caqui', cor: '#C3B091' },
    ]);
  });
  test('produto de outra empresa: recusado, nada muda', async () => {
    const r = await request(app).post(`/companies/${companyId}/products/cores-para-conferir/confirmar`)
      .send({ itens: [{ product_id: blusaDeOutra, hex: '#1F2A44', nome: 'Azul escuro' }] }).expect(200);
    expect(r.body).toEqual({ variantes: 0, itens: 1, recusados: 1 });
    expect((await nomes(blusaDeOutra)).map((x) => x.color_name)).toEqual(['AZUL ESCUR']);
  });
  test('a filial confirma o compartilhado da matriz', async () => {
    await request(app).post(`/companies/${filialId}/products/cores-para-conferir/confirmar`)
      .send({ itens: [{ product_id: saiaDaMatriz, hex: '#FAF9F6', nome: 'Off White' }] }).expect(200);
    expect((await nomes(saiaDaMatriz)).map((x) => x.color_name)).toEqual(['Off White']);
  });
});
