// ============================================================
// AURA. — Conferencia de estoque x "com clientes" (C14, condicional)
// Postgres real (nao roda sem banco local; roda no CI com Postgres).
//
// O que este arquivo trava:
//   1. esperado = sistema - com clientes; contou so o que esta na loja e
//      bate (sem falta falsa); aplicar grava fisico + com clientes
//   2. venda no Caixa depois do bipe fica mantida, com a peca fora
//   3. "para resolver" (voltou_defeito) NAO desconta
//   4. variante: a conta e por variante
//   5. zerar nao contados leva a com clientes, nao a 0
//   6. desfazer devolve o estoque de antes (inverte a diferenca gravada)
//   7. sem a trava (CONDICIONAL_LIBERADA desligada) tudo como antes
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
let seq = 0;
const ENV_ANTES = process.env.CONDICIONAL_LIBERADA;

const dono = uuid();
const loja = uuid();
const q = (sql, params) => pool.query(sql, params);
let colunasDeProduto = new Set();
async function produto(nome, extra = {}) {
  const campos = Object.fromEntries(Object.entries({ name: nome, price: 50, cost_price: 20, stock_qty: 10, ...extra })
    .filter(([k]) => colunasDeProduto.has(k)));
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [loja, ...Object.values(campos)]
  );
  return rows[0].id;
}
async function variante(pid, stock, sku) {
  const { rows } = await q(`INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, $2, $3) RETURNING id`, [pid, sku, stock]);
  return rows[0].id;
}
async function condicional(itens, status = 'aberta') {
  seq += 1;
  const id = uuid();
  await q(`INSERT INTO condicionais (id, company_id, numero, customer_name, customer_phone, due_date, status)
           VALUES ($1, $2, $3, 'Cliente', '11988887777', CURRENT_DATE + 3, $4)`, [id, loja, seq, status]);
  for (const it of itens) {
    await q(`INSERT INTO condicional_itens (condicional_id, product_id, variant_id, product_name, unit_price, situacao)
             VALUES ($1, $2, $3, 'Peca', 10, $4)`, [id, it.p, it.v || null, it.sit || 'com_cliente']);
  }
  return id;
}
const num = (v) => Number(v);
const estoque = async (pid) => num((await q(`SELECT stock_qty FROM products WHERE id=$1`, [pid])).rows[0].stock_qty);
const estoqueVar = async (vid) => num((await q(`SELECT stock_qty FROM product_variants WHERE id=$1`, [vid])).rows[0].stock_qty);
const base = `/companies/${loja}/estoque/conferencias`;
const nova = async (body = { escopo: { tipo: 'loja_toda' }, as_cegas: false }) => {
  const r = await request(app).post(base).send(body);
  expect(r.status).toBe(201);
  return r.body.conferencia;
};
const bipar = (countId, body) => request(app).put(`${base}/${countId}/itens`).send(body);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return { query: (...a) => c.query(...a), release: (...a) => c.release(...a) };
  });
  const { rows: colunas } = await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'`);
  colunasDeProduto = new Set(colunas.map((c) => c.column_name));
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture C14')`, [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Loja C14', 'Loja C14')`, [loja, dono]);
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: dono }; next(); });
  app.use('/companies/:id/estoque/conferencias', require('../src/routes/estoqueConferencias'));
});

beforeEach(() => { process.env.CONDICIONAL_LIBERADA = 'true'; });

afterAll(async () => {
  if (ENV_ANTES === undefined) delete process.env.CONDICIONAL_LIBERADA; else process.env.CONDICIONAL_LIBERADA = ENV_ANTES;
  if (!pool) return;
  const limpar = [
    `DELETE FROM condicionais WHERE company_id = $1`,
    `DELETE FROM stock_counts WHERE company_id = $1`,
    `DELETE FROM stock_movements WHERE company_id = $1`,
    `DELETE FROM products WHERE company_id = $1`,
  ];
  for (const sql of limpar) { try { await q(sql, [loja]); } catch (e) { /* banco de CI e descartavel */ } }
  try { await q(`DELETE FROM companies WHERE id = $1`, [loja]); } catch (e) { /* idem */ }
  try { await q(`DELETE FROM users WHERE id = $1`, [dono]); } catch (e) { /* idem */ }
  await pool.end();
});

describe('conferencia com pecas com clientes', () => {
  test('esperado = sistema - com clientes; aplicar grava fisico + com clientes; desfazer volta', async () => {
    const pid = await produto('Camisa C14', { stock_qty: 10 });
    await condicional([{ p: pid }, { p: pid }]); // 2 com clientes
    const c = await nova();
    const r = await bipar(c.id, { product_id: pid, quantidade: 8, modo: 'definir' }); // as 8 que estao na loja
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ contado: 8, estoque_no_bipe: 8, estoque_atual: 8, com_clientes: 2 });

    const d = await request(app).get(`${base}/${c.id}/diferencas`);
    const linha = d.body.itens.find((x) => x.product_id === pid);
    expect(linha).toMatchObject({ contado: 8, estoque_no_bipe: 8, estoque_atual: 8, com_clientes: 2, diferenca: 0, grupo: 'batem' });

    const a = await request(app).post(`${base}/${c.id}/aplicar`).send({});
    expect(a.status).toBe(200);
    expect(await estoque(pid)).toBe(10); // nada some: 8 + 2 com clientes

    // outra conferencia: faltou 1 na loja
    const c2 = await nova();
    await bipar(c2.id, { product_id: pid, quantidade: 7, modo: 'definir' });
    const d2 = await request(app).get(`${base}/${c2.id}/diferencas`);
    expect(d2.body.itens[0]).toMatchObject({ diferenca: -1, estoque_depois: 9, grupo: 'faltam' });
    await request(app).post(`${base}/${c2.id}/aplicar`).send({});
    expect(await estoque(pid)).toBe(9); // 7 na loja + 2 com clientes
    const des = await request(app).post(`${base}/${c2.id}/desfazer`).send({});
    expect(des.status).toBe(200);
    expect(await estoque(pid)).toBe(10);
  });

  test('venda no Caixa depois do bipe fica mantida; para resolver nao desconta', async () => {
    const pid = await produto('Saia C14', { stock_qty: 6 });
    await condicional([{ p: pid }]);                          // 1 com cliente
    await condicional([{ p: pid, sit: 'voltou_defeito' }]);   // 1 para resolver: esta na loja
    const c = await nova();
    const r = await bipar(c.id, { product_id: pid, quantidade: 5, modo: 'definir' });
    expect(r.body.item).toMatchObject({ estoque_no_bipe: 5, com_clientes: 1 }); // 6 - 1; o defeito nao desconta
    await q(`UPDATE products SET stock_qty = 5 WHERE id = $1`, [pid]); // vendeu 1 depois do bipe
    await request(app).post(`${base}/${c.id}/aplicar`).send({});
    expect(await estoque(pid)).toBe(5); // 5 + (5 - 5): a venda fica vendida
  });

  test('variante: a conta e por variante e o pai nao muda', async () => {
    const pid = await produto('Vestido C14', { stock_qty: 0 });
    const vm = await variante(pid, 5, 'M');
    const vg = await variante(pid, 4, 'G');
    await condicional([{ p: pid, v: vm }, { p: pid, v: vm }]);
    const c = await nova();
    const r = await bipar(c.id, { product_id: pid, variant_id: vm, quantidade: 3, modo: 'definir' });
    expect(r.body.item).toMatchObject({ estoque_no_bipe: 3, com_clientes: 2 });
    const g = await bipar(c.id, { product_id: pid, variant_id: vg, quantidade: 4, modo: 'definir' });
    expect(g.body.item).toMatchObject({ estoque_no_bipe: 4 });
    expect(g.body.item).not.toHaveProperty('com_clientes');
    await request(app).post(`${base}/${c.id}/aplicar`).send({});
    expect(await estoqueVar(vm)).toBe(5);
    expect(await estoqueVar(vg)).toBe(4);
  });

  test('zerar nao contados leva a com clientes, nao a 0', async () => {
    const contada = await produto('Meia C14', { stock_qty: 3 });
    const esquecida = await produto('Cinto C14', { stock_qty: 4 });
    await condicional([{ p: esquecida }]);
    const c = await nova();
    await bipar(c.id, { product_id: contada, quantidade: 3, modo: 'definir' });
    const d = await request(app).get(`${base}/${c.id}/diferencas`);
    expect(d.body.nao_contados.find((x) => x.product_id === esquecida)).toMatchObject({ estoque_atual: 3, com_clientes: 1 });
    await request(app).post(`${base}/${c.id}/aplicar`).send({ zerar_nao_contados: true });
    expect(await estoque(esquecida)).toBe(1); // a peca fora da loja continua no sistema
    const des = await request(app).post(`${base}/${c.id}/desfazer`).send({});
    expect(des.status).toBe(200);
    expect(await estoque(esquecida)).toBe(4);
  });

  test('sem a trava: igual a antes, sem com_clientes', async () => {
    delete process.env.CONDICIONAL_LIBERADA;
    const pid = await produto('Blusa C14', { stock_qty: 10 });
    await condicional([{ p: pid }]);
    const c = await nova();
    const r = await bipar(c.id, { product_id: pid, quantidade: 9, modo: 'definir' });
    expect(r.body.item).toMatchObject({ estoque_no_bipe: 10, estoque_atual: 10 });
    expect(r.body.item).not.toHaveProperty('com_clientes');
  });
});
