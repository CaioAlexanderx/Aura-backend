// ============================================================
// AURA. — Em qual loja o produto entra, B3: edicao (20/11/2026). Postgres real.
//
// O que este arquivo trava:
//   1. GET :pid/lojas: em quais lojas o produto esta (pelo master_sku), de
//      qualquer uma delas; para onde ainda pode levar; compartilhado
//   2. aplicar-nas-lojas: os campos do produto JA GRAVADO vao para o par de
//      cada loja; D7 (perfil tributario so com o mesmo regime); categoria
//      pelo nome; estoque nunca muda
//   3. loja sem o par: SEM_PAR; codigo de barras de outro produto: so aquela
//      loja falha; estoque no pedido: 400
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;
let colunasDeProduto = new Set();

const dono = uuid();
const usuarios = [dono];
const matriz = uuid();
const filial = uuid();
const filialMei = uuid();
const terceira = uuid();
const empresas = [filial, filialMei, terceira, matriz];
const ids = {};

const q = (sql, params) => pool.query(sql, params);
const num = (v) => Number(v);
const get = (loja, pid) => request(app).get(`/companies/${loja}/products/${pid}/lojas`).set('x-user', dono);
const aplicar = (loja, pid, body) => request(app).post(`/companies/${loja}/products/${pid}/aplicar-nas-lojas`).set('x-user', dono).send(body);
const doGrupo = (r, id) => r.body.resultados.find((x) => x.company_id === id);

async function produto(companyId, nome, extra = {}) {
  const campos = Object.fromEntries(Object.entries({ name: nome, price: 50, cost_price: 20, stock_qty: 0, ...extra })
    .filter(([k]) => colunasDeProduto.has(k)));
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [companyId, ...Object.values(campos)]
  );
  return rows[0].id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return { query: (...a) => c.query(...a), release: (...a) => c.release(...a) };
  });
  colunasDeProduto = new Set((await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'`)).rows.map((c) => c.column_name));
  const { rows: temSeparacao } = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'companies' AND column_name = 'share_products_in_group'`);

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Edicao')`, [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime) VALUES ($1, $2, 'Matriz Ed', 'Matriz', 'negocio', 'simples_nacional')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime, billing_owner_company_id) VALUES ($1, $2, 'Filial Ed', 'Filial Centro', 'negocio', 'simples_nacional', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime, billing_owner_company_id) VALUES ($1, $2, 'Filial MEI Ed', 'Filial MEI', 'negocio', 'mei', $3)`, [filialMei, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime, billing_owner_company_id) VALUES ($1, $2, 'Terceira Ed', 'Terceira', 'negocio', 'simples_nacional', $3)`, [terceira, dono, matriz]);
  if (temSeparacao.length) await q(`UPDATE companies SET share_products_in_group = false WHERE id = $1`, [filial]);

  const { rows: [cat] } = await q(`INSERT INTO product_categories (company_id, type, name) VALUES ($1, 'product', 'Vestidos') RETURNING id`, [matriz]);
  ids.categoriaNova = (await q(`INSERT INTO product_categories (company_id, type, name) VALUES ($1, 'product', 'Festa') RETURNING id`, [matriz])).rows[0].id;
  ids.vestido = await produto(matriz, 'Vestido edicao', { barcode: '7896660000011', sku: 'VE-1', category: 'Vestidos', tax_profile: 'simples_padrao', stock_qty: 4 });
  await q(`INSERT INTO product_category_links (product_id, category_id, is_primary) VALUES ($1, $2, true)`, [ids.vestido, cat.id]);
  ids.soNaMatriz = await produto(matriz, 'Saia edicao');
  ids.compartilhado = await produto(matriz, 'Cinto edicao', { is_group_shared: true });
  ids.donoDoCodigo = await produto(filial, 'Outro da filial', { barcode: '7896660000099' });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productsNasLojas'));

  // o vestido nasce na Filial (2 pecas) e na Filial MEI (0)
  const r = await request(app).post(`/companies/${matriz}/products/${ids.vestido}/lojas`).set('x-user', dono)
    .send({ lojas: [{ company_id: filial, stock_qty: 2 }, { company_id: filialMei }] });
  ids.naFilial = r.body.resultados.find((x) => x.company_id === filial).product_id;
  ids.naMei = r.body.resultados.find((x) => x.company_id === filialMei).product_id;
}, 30000);

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_category_links WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM product_categories WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await q(sql, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  }
  for (const id of empresas) {
    try { await q(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = ANY($1)`, [usuarios]); } catch (e) { /* idem */ }
  await pool.end();
});

describe('GET :pid/lojas', () => {
  test('da matriz: esta nas tres lojas e pode levar para a Terceira', async () => {
    const r = await get(matriz, ids.vestido);
    expect(r.status).toBe(200);
    expect(r.body.em).toEqual([
      { company_id: matriz, nome: 'Matriz', product_id: ids.vestido },
      { company_id: filial, nome: 'Filial Centro', product_id: ids.naFilial },
      { company_id: filialMei, nome: 'Filial MEI', product_id: ids.naMei },
    ]);
    expect(r.body.pode_levar_para).toEqual([{ company_id: terceira, nome: 'Terceira' }]);
    expect(r.body.compartilhado).toBeUndefined();
  });

  test('da filial, pelo produto dela: as mesmas lojas', async () => {
    const r = await get(filial, ids.naFilial);
    expect(r.body.em.map((x) => x.company_id).sort()).toEqual([matriz, filial, filialMei].sort());
    expect(r.body.pode_levar_para).toEqual([{ company_id: terceira, nome: 'Terceira' }]);
  });

  test('so na matriz; compartilhado; produto de fora: 404', async () => {
    const so = await get(matriz, ids.soNaMatriz);
    expect(so.body.em).toEqual([{ company_id: matriz, nome: 'Matriz', product_id: ids.soNaMatriz }]);
    expect(so.body.pode_levar_para.map((x) => x.company_id).sort()).toEqual([filial, filialMei, terceira].sort());
    const sh = await get(filial, ids.compartilhado);
    expect(sh.body).toEqual({ em: [{ company_id: matriz, nome: 'Matriz', product_id: ids.compartilhado }], pode_levar_para: [], compartilhado: true });
    expect((await get(matriz, ids.donoDoCodigo)).status).toBe(404);
  });
});

describe('POST :pid/aplicar-nas-lojas', () => {
  test('preco, nome, categoria e perfil tributario; a MEI nao leva o perfil; estoque nao muda', async () => {
    await q(`UPDATE products SET price = 129.9, name = 'Vestido edicao longo', category = 'Festa' WHERE id = $1`, [ids.vestido]);
    if (colunasDeProduto.has('tax_profile')) await q(`UPDATE products SET tax_profile = 'simples_st' WHERE id = $1`, [ids.vestido]);
    await q(`UPDATE product_category_links SET category_id = $2 WHERE product_id = $1`, [ids.vestido, ids.categoriaNova]);

    const r = await aplicar(matriz, ids.vestido, { campos: ['price', 'name', 'category', 'tax_profile'], lojas: [filial, filialMei] });
    expect(r.status).toBe(200);
    const comPerfil = colunasDeProduto.has('tax_profile');
    expect(doGrupo(r, filial)).toEqual({
      company_id: filial, nome: 'Filial Centro', status: 'aplicado', product_id: ids.naFilial,
      campos: comPerfil ? ['price', 'name', 'category', 'tax_profile'] : ['price', 'name', 'category'], avisos: [],
    });
    expect(doGrupo(r, filialMei)).toMatchObject({ status: 'aplicado', campos: ['price', 'name', 'category'], avisos: comPerfil ? ['fiscal_conferir'] : [] });

    const { rows: [f] } = await q(`SELECT * FROM products WHERE id = $1`, [ids.naFilial]);
    expect([num(f.price), f.name, f.category, num(f.stock_qty)]).toEqual([129.9, 'Vestido edicao longo', 'Festa', 2]);
    if (comPerfil) expect(f.tax_profile).toBe('simples_st');
    const { rows: [m] } = await q(`SELECT * FROM products WHERE id = $1`, [ids.naMei]);
    expect([num(m.price), m.name, num(m.stock_qty)]).toEqual([129.9, 'Vestido edicao longo', 0]);
    if (comPerfil) expect(m.tax_profile).toBeNull();
    const { rows: cats } = await q(
      `SELECT c.name, c.company_id FROM product_category_links l JOIN product_categories c ON c.id = l.category_id WHERE l.product_id = $1`, [ids.naFilial]);
    expect(cats).toEqual([{ name: 'Festa', company_id: filial }]);
  });

  test('loja sem o par: SEM_PAR; a mesma loja: MESMA_LOJA', async () => {
    const r = await aplicar(matriz, ids.vestido, { campos: ['price'], lojas: [terceira, matriz] });
    expect(doGrupo(r, terceira)).toMatchObject({ status: 'erro', erro: { code: 'SEM_PAR' } });
    expect(doGrupo(r, matriz)).toMatchObject({ status: 'erro', erro: { code: 'MESMA_LOJA' } });
  });

  test('codigo de barras novo que e de outro produto da filial: so a filial falha', async () => {
    await q(`UPDATE products SET barcode = '7896660000099' WHERE id = $1`, [ids.vestido]);
    const r = await aplicar(matriz, ids.vestido, { campos: ['barcode'], lojas: [filial, filialMei] });
    expect(doGrupo(r, filial)).toMatchObject({ status: 'erro', erro: { code: 'BARCODE_EM_USO', produto_conflito: { id: ids.donoDoCodigo } } });
    expect(doGrupo(r, filialMei)).toMatchObject({ status: 'aplicado', campos: ['barcode'] });
    expect((await q(`SELECT barcode FROM products WHERE id = $1`, [ids.naMei])).rows[0].barcode).toBe('7896660000099');
    expect((await q(`SELECT barcode FROM products WHERE id = $1`, [ids.naFilial])).rows[0].barcode).toBe('7896660000011');
  });

  test('estoque ou campo desconhecido: 400; compartilhado: 409', async () => {
    const a = await aplicar(matriz, ids.vestido, { campos: ['stock_qty'], lojas: [filial] });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe('CAMPOS_INVALIDOS');
    const b = await aplicar(matriz, ids.vestido, { campos: ['company_id'], lojas: [filial] });
    expect(b.status).toBe(400);
    const c = await aplicar(matriz, ids.compartilhado, { campos: ['price'], lojas: [filial] });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('PRODUTO_COMPARTILHADO');
  });
});
