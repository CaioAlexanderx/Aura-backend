// ============================================================
// AURA. — Entrada de um produto (POST /products/:pid/stock-entries) —
// Postgres real. Testes de CARACTERIZAÇÃO (B1, 17/11/2026).
//
// Escritos ANTES de tirar o miolo da rota para src/services/
// entradaDeMercadoria.js (darEntradaNoProduto). Travam o que a rota faz
// hoje, no banco de verdade, para a mudança não mexer em nada:
//   1. produto simples: estoque somado, custo médio, cost_price, fornecedor
//      principal (product_suppliers + products.supplier_id), última compra
//      (colunas da 354) e o movimento com 'NF <n>'
//   2. segundo fornecedor não tira o principal; update_cost false
//   3. grade: soma por variante, um movimento por variante, products.stock_qty
//      intacto
//   4. multi-CNPJ: compartilhado do grupo recebe entrada da filial (um
//      estoque só; movimento com a loja que recebeu; product_suppliers com a
//      loja dona do produto); não compartilhado e loja de fora: 404
//   5. fornecedor novo pelo CNPJ: cadastrado uma vez só (o segundo reaproveita)
//   6. sem custo: soma o estoque e não mexe no custo; estoque negativo fora
//      da média
//   7. erros de grade e de fornecedor não gravam nada
//   8. o rastro: a sequência exata de SQL e parâmetros (snapshot), para a
//      extração não trocar nem a ordem das idas ao banco
//
// O caminho de um produto é a régua do lote (B2a): o teste do lote compara
// com estes mesmos números.
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
let app;
let rastro = null; // quando é array, cada ida ao banco da rota entra aqui

const dono = uuid();
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const empresas = [filial, deFora, matriz];

const q = (sql, params) => pool.query(sql, params);
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function produto(companyId, nome, extra = {}) {
  const campos = { name: nome, price: 50, cost_price: null, weighted_avg_cost: null, stock_qty: 0, ...extra };
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [companyId, ...Object.values(campos)]
  );
  return rows[0].id;
}
async function fornecedor(companyId, nome, cnpj = null) {
  const { rows } = await q(`INSERT INTO suppliers (company_id, name, cnpj) VALUES ($1, $2, $3) RETURNING id`, [companyId, nome, cnpj]);
  return rows[0].id;
}
const linha = async (pid) => {
  const { rows } = await q(
    `SELECT stock_qty, cost_price, weighted_avg_cost, supplier_id, supplier_name,
            last_supplier_name, last_purchase_unit_cost, last_purchase_at
       FROM products WHERE id = $1`, [pid]);
  const r = rows[0];
  return {
    ...r,
    stock_qty: num(r.stock_qty), cost_price: num(r.cost_price),
    weighted_avg_cost: num(r.weighted_avg_cost), last_purchase_unit_cost: num(r.last_purchase_unit_cost),
  };
};
const fornecedoresDo = async (pid) => (await q(
  `SELECT company_id, supplier_id, cost, supplier_code, is_main, last_purchase_at IS NOT NULL AS comprou
     FROM product_suppliers WHERE product_id = $1 ORDER BY is_main DESC, created_at`, [pid]))
  .rows.map((r) => ({ ...r, cost: num(r.cost) }));
const movimentosDo = async (pid) => (await q(
  `SELECT company_id, type, quantity, reference_type, reference_id, notes, supplier_id, unit_cost, variant_id
     FROM stock_movements WHERE product_id = $1 ORDER BY created_at, variant_id NULLS FIRST`, [pid]))
  .rows.map((r) => ({ ...r, quantity: num(r.quantity), unit_cost: num(r.unit_cost) }));

const entrada = (loja, pid, body) =>
  request(app).post(`/companies/${loja}/products/${pid}/stock-entries`).send(body);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return {
      query: (sql, params) => {
        if (rastro) rastro.push([String(sql).replace(/\s+/g, ' ').trim(), params]);
        return c.query(sql, params);
      },
      release: (...a) => c.release(...a),
    };
  });

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Entrada')`, [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Matriz Entrada')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Entrada', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Entrada')`, [deFora, dono]);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: dono }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productSuppliers'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM suppliers WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await q(sql, [empresas]); } catch (e) { /* banco de CI é descartável */ }
  }
  for (const id of empresas) {
    try { await q(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = $1`, [dono]); } catch (e) { /* idem */ }
  await pool.end();
});

describe('produto simples', () => {
  let capa; let alfa; let bras;
  beforeAll(async () => {
    capa = await produto(matriz, 'Capa iPhone 15', { stock_qty: 4, cost_price: 5.5 });
    alfa = await fornecedor(matriz, 'Distribuidora Alfa');
    bras = await fornecedor(matriz, 'Brás Capas');
  });

  test('4 un a R$ 5,50 + 20 a R$ 5,90: estoque 24, médio 5,8333, principal, última compra, movimento', async () => {
    const r = await entrada(matriz, capa, { supplier_id: alfa, quantity: 20, unit_cost: 5.9, invoice_number: ' 004512 ' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      supplier: { id: alfa, name: 'Distribuidora Alfa', created: false },
      quantity: 20,
      unit_cost: 5.9,
      before: { stock_qty: 4, avg_cost: 5.5 },
      after: { stock_qty: 24, avg_cost: 5.8333 },
    });
    const p = await linha(capa);
    expect(p).toMatchObject({
      stock_qty: 24, weighted_avg_cost: 5.8333, cost_price: 5.83,
      supplier_id: alfa, supplier_name: 'Distribuidora Alfa',
      last_supplier_name: 'Distribuidora Alfa', last_purchase_unit_cost: 5.9,
    });
    expect(p.last_purchase_at).not.toBeNull();
    expect(await fornecedoresDo(capa)).toEqual([
      { company_id: matriz, supplier_id: alfa, cost: 5.9, supplier_code: null, is_main: true, comprou: true },
    ]);
    expect(await movimentosDo(capa)).toEqual([
      { company_id: matriz, type: 'in', quantity: 20, reference_type: 'entrada', reference_id: null, notes: 'NF 004512', supplier_id: alfa, unit_cost: 5.9, variant_id: null },
    ]);
  });

  test('segundo fornecedor não tira o principal; update_cost false guarda só o médio', async () => {
    const r = await entrada(matriz, capa, { supplier_id: bras, quantity: 10, unit_cost: 4.8, update_cost: false });
    expect(r.status).toBe(201);
    // (24 × 5,8333 + 10 × 4,80) / 34 = 5,5294
    expect(r.body.after).toEqual({ stock_qty: 34, avg_cost: 5.5294 });
    expect(r.body.before).toEqual({ stock_qty: 24, avg_cost: 5.8333 });
    const p = await linha(capa);
    expect(p).toMatchObject({ stock_qty: 34, weighted_avg_cost: 5.5294, cost_price: 5.83, supplier_id: alfa, last_supplier_name: 'Brás Capas', last_purchase_unit_cost: 4.8 });
    const fs = await fornecedoresDo(capa);
    expect(fs.map((f) => [f.supplier_id, f.is_main, f.cost])).toEqual([[alfa, true, 5.9], [bras, false, 4.8]]);
    const ms = await movimentosDo(capa);
    expect(ms[1]).toMatchObject({ quantity: 10, notes: null, supplier_id: bras, unit_cost: 4.8 });
  });

  test('sem custo: soma o estoque e não mexe no custo nem no custo do fornecedor', async () => {
    const r = await entrada(matriz, capa, { supplier_id: bras, quantity: 6 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ unit_cost: null, before: { stock_qty: 34, avg_cost: 5.5294 }, after: { stock_qty: 40, avg_cost: 5.5294 } });
    const p = await linha(capa);
    expect(p).toMatchObject({ stock_qty: 40, weighted_avg_cost: 5.5294, cost_price: 5.83, last_purchase_unit_cost: 4.8 });
    expect((await fornecedoresDo(capa)).find((f) => f.supplier_id === bras).cost).toBe(4.8);
    expect((await movimentosDo(capa))[2]).toMatchObject({ quantity: 6, unit_cost: null, supplier_id: bras });
  });

  test('sem fornecedor: soma, médio, movimento sem fornecedor; nada em product_suppliers', async () => {
    const solto = await produto(matriz, 'Película', { stock_qty: 2, cost_price: 3 });
    const r = await entrada(matriz, solto, { quantity: 2, unit_cost: 5, invoice_number: '77' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ supplier: null, after: { stock_qty: 4, avg_cost: 4 } });
    expect(await linha(solto)).toMatchObject({ stock_qty: 4, weighted_avg_cost: 4, cost_price: 4, supplier_id: null, last_supplier_name: null });
    expect(await fornecedoresDo(solto)).toEqual([]);
    expect(await movimentosDo(solto)).toEqual([
      { company_id: matriz, type: 'in', quantity: 2, reference_type: 'entrada', reference_id: null, notes: 'NF 77', supplier_id: null, unit_cost: 5, variant_id: null },
    ]);
  });

  test('estoque negativo não entra na média', async () => {
    const neg = await produto(matriz, 'Cabo USB', { stock_qty: -3, cost_price: 9 });
    const r = await entrada(matriz, neg, { quantity: 10, unit_cost: 5 });
    expect(r.body.after).toEqual({ stock_qty: 7, avg_cost: 5 });
    expect(await linha(neg)).toMatchObject({ stock_qty: 7, weighted_avg_cost: 5, cost_price: 5 });
  });
});

describe('grade', () => {
  test('soma em cada variante, um movimento por variante; products.stock_qty intacto', async () => {
    const vestido = await produto(matriz, 'Vestido midi', { stock_qty: 0, cost_price: 24 });
    const { rows: vs } = await q(
      `INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, 'P', 2), ($1, 'G', 0) RETURNING id, sku_suffix`, [vestido]);
    const P = vs.find((v) => v.sku_suffix === 'P').id;
    const G = vs.find((v) => v.sku_suffix === 'G').id;
    const alfa = await fornecedor(matriz, 'Malharia Alfa');

    const r = await entrada(matriz, vestido, { supplier_id: alfa, items: [{ variant_id: P, quantity: 4 }, { variant_id: G, quantity: 6 }], unit_cost: 30 });
    expect(r.status).toBe(201);
    // base 2 (soma das variantes) a 24 + 10 a 30 = 29
    expect(r.body).toMatchObject({ quantity: 10, before: { stock_qty: 2, avg_cost: 24 }, after: { stock_qty: 12, avg_cost: 29 } });
    const { rows: depois } = await q(`SELECT id, stock_qty FROM product_variants WHERE product_id = $1`, [vestido]);
    expect(Object.fromEntries(depois.map((v) => [v.id, num(v.stock_qty)]))).toEqual({ [P]: 6, [G]: 6 });
    expect(await linha(vestido)).toMatchObject({ stock_qty: 0, weighted_avg_cost: 29, cost_price: 29 });
    const ms = await movimentosDo(vestido);
    expect(ms.map((m) => [m.variant_id, m.quantity, m.unit_cost]).sort()).toEqual([[G, 6, 30], [P, 4, 30]].sort());
  });

  test('com grade exige variante; variante de outro produto; variante repetida: 400 e nada grava', async () => {
    const saia = await produto(matriz, 'Saia', { stock_qty: 0 });
    const { rows: [v] } = await q(`INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, 'U', 1) RETURNING id`, [saia]);
    const outro = await produto(matriz, 'Blusa', { stock_qty: 0 });
    const { rows: [vOutro] } = await q(`INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, 'U', 1) RETURNING id`, [outro]);

    expect((await entrada(matriz, saia, { quantity: 3 })).status).toBe(400);
    expect((await entrada(matriz, saia, { items: [{ variant_id: vOutro, quantity: 1 }] })).status).toBe(400);
    expect((await entrada(matriz, saia, { items: [{ variant_id: v.id, quantity: 1 }, { variant_id: v.id, quantity: 1 }] })).status).toBe(400);
    expect((await entrada(matriz, outro, { quantity: 1, items: [] })).status).toBe(400); // tem grade
    const simples = await produto(matriz, 'Meia', { stock_qty: 1 });
    expect((await entrada(matriz, simples, { items: [{ variant_id: v.id, quantity: 1 }] })).status).toBe(400);
    expect(await movimentosDo(saia)).toEqual([]);
    expect(await movimentosDo(simples)).toEqual([]);
  });
});

describe('multi-CNPJ', () => {
  test('compartilhado do grupo: a filial dá entrada no mesmo estoque; movimento com a filial', async () => {
    const bolsa = await produto(matriz, 'Bolsa tote', { stock_qty: 5, cost_price: 40, is_group_shared: true });
    const forn = await fornecedor(matriz, 'Couros do Grupo');
    const r = await entrada(filial, bolsa, { supplier_id: forn, quantity: 5, unit_cost: 50 });
    expect(r.status).toBe(201);
    expect(r.body.after).toEqual({ stock_qty: 10, avg_cost: 45 });
    expect(await linha(bolsa)).toMatchObject({ stock_qty: 10, weighted_avg_cost: 45 });
    expect(await movimentosDo(bolsa)).toEqual([
      { company_id: filial, type: 'in', quantity: 5, reference_type: 'entrada', reference_id: null, notes: null, supplier_id: forn, unit_cost: 50, variant_id: null },
    ]);
    expect((await fornecedoresDo(bolsa))[0]).toMatchObject({ company_id: matriz, supplier_id: forn, is_main: true });
  });

  test('não compartilhado da matriz e loja de fora: 404 e nada grava', async () => {
    const soDaMatriz = await produto(matriz, 'Só da matriz', { stock_qty: 1 });
    const compartilhado = await produto(matriz, 'Compartilhado', { stock_qty: 1, is_group_shared: true });
    expect((await entrada(filial, soDaMatriz, { quantity: 1 })).status).toBe(404);
    expect((await entrada(deFora, compartilhado, { quantity: 1 })).status).toBe(404);
    expect(await linha(soDaMatriz)).toMatchObject({ stock_qty: 1 });
    expect(await linha(compartilhado)).toMatchObject({ stock_qty: 1 });
  });

  test('fornecedor de fora do grupo: 404 e nada grava', async () => {
    const p = await produto(matriz, 'Caneca', { stock_qty: 1 });
    const alheio = await fornecedor(deFora, 'Fornecedor alheio');
    expect((await entrada(matriz, p, { supplier_id: alheio, quantity: 1 })).status).toBe(404);
    expect(await linha(p)).toMatchObject({ stock_qty: 1 });
    expect(await movimentosDo(p)).toEqual([]);
  });
});

describe('fornecedor novo na hora', () => {
  test('pelo CNPJ: cadastra na loja da entrada uma vez; a segunda reaproveita', async () => {
    const p = await produto(filial, 'Vela', { stock_qty: 0 });
    const cnpj = '11222333000181';
    const r1 = await entrada(filial, p, { new_supplier: { name: 'Velas Centro', cnpj: '11.222.333/0001-81', phone: '11 99999-0000' }, quantity: 3, unit_cost: 7 });
    expect(r1.status).toBe(201);
    expect(r1.body.supplier).toMatchObject({ name: 'Velas Centro', created: true });
    const r2 = await entrada(filial, p, { new_supplier: { name: 'Outro nome', cnpj }, quantity: 1, unit_cost: 7 });
    expect(r2.body.supplier).toEqual({ id: r1.body.supplier.id, name: 'Velas Centro', created: false });
    const { rows } = await q(`SELECT company_id, phone FROM suppliers WHERE cnpj = $1 AND company_id = ANY($2)`, [cnpj, empresas]);
    expect(rows).toEqual([{ company_id: filial, phone: '11 99999-0000' }]);
  });

  test('CNPJ inválido ou sem nome: 400', async () => {
    const p = await produto(matriz, 'Vaso', { stock_qty: 0 });
    expect((await entrada(matriz, p, { new_supplier: { name: 'X', cnpj: '123' }, quantity: 1 })).status).toBe(400);
    expect((await entrada(matriz, p, { new_supplier: { name: ' ' }, quantity: 1 })).status).toBe(400);
    expect(await linha(p)).toMatchObject({ stock_qty: 0 });
  });
});

// ── 8. Rastro: SQL e parâmetros em ordem (ids viram <id1>, <id2>...) ──
describe('rastro da rota', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  async function gravar(fn) {
    rastro = [];
    try { await fn(); } finally {
      const nomes = new Map();
      const nome = (v) => {
        if (typeof v !== 'string' || !UUID_RE.test(v)) return v;
        if (!nomes.has(v)) nomes.set(v, `<id${nomes.size + 1}>`);
        return nomes.get(v);
      };
      var saida = rastro.map(([sql, params]) => [sql, (params || []).map((p) => (Array.isArray(p) ? p.map(nome) : nome(p)))]);
      rastro = null;
    }
    return saida;
  }

  test('produto simples com fornecedor, custo e nota', async () => {
    const p = await produto(matriz, 'Rastro simples', { stock_qty: 4, cost_price: 5.5 });
    const f = await fornecedor(matriz, 'Rastro Alfa');
    const r = await gravar(() => entrada(matriz, p, { supplier_id: f, quantity: 20, unit_cost: 5.9, invoice_number: '1' }));
    expect(r).toMatchSnapshot();
  });

  test('grade com fornecedor novo e update_cost false', async () => {
    const p = await produto(matriz, 'Rastro grade', { stock_qty: 0, cost_price: 10 });
    await q(`INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, 'P', 1), ($1, 'M', 1)`, [p]);
    const { rows } = await q(`SELECT id FROM product_variants WHERE product_id = $1 ORDER BY sku_suffix`, [p]);
    const r = await gravar(() => entrada(matriz, p, {
      new_supplier: { name: 'Rastro Novo' }, update_cost: false, unit_cost: 12,
      items: [{ variant_id: rows[0].id, quantity: 2 }, { variant_id: rows[1].id, quantity: 3 }],
    }));
    expect(r).toMatchSnapshot();
  });

  test('sem fornecedor e sem custo', async () => {
    const p = await produto(matriz, 'Rastro solto', { stock_qty: 1 });
    const r = await gravar(() => entrada(matriz, p, { quantity: 2 }));
    expect(r).toMatchSnapshot();
  });
});
