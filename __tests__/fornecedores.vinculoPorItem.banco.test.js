// ============================================================
// AURA. — Vínculo em lote com custo e código por produto (B4) — Postgres
// real (migration 424)
//
// O que este arquivo prova:
//   1. PARIDADE: o corpo de hoje ({ product_ids, cost }) e o novo com o
//      mesmo custo em todos os itens deixam product_suppliers e products
//      iguais, nos dois modos (principal e is_main false).
//   2. custo por produto: cada produto fica com o SEU custo e o seu código;
//      item sem custo mantém o gravado; sem código mantém o código.
//   3. is_main false não tira o principal de quem já tem; quem não tinha
//      nenhum ganha este (e o espelho em products.supplier_id).
//   4. estoque, cost_price, custo médio e movimentos não mudam.
//   5. multi-CNPJ: produto de outra loja fora do grupo fica em not_found;
//      o compartilhado do grupo liga.
//   6. quem não vê custo: liga e grava o código, sem custo.
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

const dono = uuid();
const semCusto = uuid(); // edita estoque, não vê custo (painel desligado)
const usuarios = [dono, semCusto];
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const empresas = [filial, deFora, matriz];

const q = (sql, params) => pool.query(sql, params);
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function produto(companyId, nome, extra = {}) {
  const campos = { name: nome, price: 50, cost_price: 10, weighted_avg_cost: 10, stock_qty: 5, ...extra };
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

// O que o vínculo mexe num produto (sem ids nem horários).
async function retrato(pid) {
  const { rows: [p] } = await q(
    `SELECT stock_qty, cost_price, weighted_avg_cost, supplier_id, supplier_name, supplier_cnpj FROM products WHERE id = $1`, [pid]);
  const { rows: ps } = await q(
    `SELECT supplier_id, cost, supplier_code, is_main FROM product_suppliers WHERE product_id = $1 ORDER BY is_main DESC, supplier_id`, [pid]);
  const { rows: [m] } = await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id = $1`, [pid]);
  return {
    produto: { ...p, stock_qty: num(p.stock_qty), cost_price: num(p.cost_price), weighted_avg_cost: num(p.weighted_avg_cost) },
    fornecedores: ps.map((r) => ({ ...r, cost: num(r.cost) })),
    movimentos: m.n,
  };
}
// Troca os ids de um cenário pelos rótulos, para comparar dois cenários.
const semIds = (obj, mapa) => JSON.parse(JSON.stringify(obj, (k, v) => (typeof v === 'string' && mapa[v] ? mapa[v] : v)));

const vincular = (loja, sid, body, user = dono) => request(app)
  .post(`/companies/${loja}/suppliers/${sid}/products`)
  .set('x-user', user)
  .send(body);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.queryRetry = (sql, params) => pool.query(sql, params);

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Vinculo')`, [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Matriz Vinculo')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Vinculo', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Vinculo')`, [deFora, dono]);
  await q(
    `INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, 'estoquista', 'active', true, $3)`,
    [matriz, semCusto, JSON.stringify({ estoque: true, pdv: true, painel: false })]);

  const { semCustoEmConsulta } = require('../src/middleware/estoqueSoConsulta');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  // A mesma ordem de src/routes/private.js
  app.use('/companies/:id/suppliers', semCustoEmConsulta());
  app.use('/companies/:id/suppliers', require('../src/routes/suppliers'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM company_members WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await q(sql, [empresas]); } catch (e) { /* banco de CI é descartável */ }
  }
  for (const id of empresas) {
    try { await q(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = ANY($1)`, [usuarios]); } catch (e) { /* idem */ }
  await pool.end();
});

// ── 1. Paridade ──────────────────────────────────────────────────────
describe('paridade: o corpo de hoje e items[] com o mesmo custo deixam o banco igual', () => {
  async function cenario(rotulo) {
    const alfa = await fornecedor(matriz, `${rotulo} Alfa`, null);
    const outro = await fornecedor(matriz, `${rotulo} Outro`, null);
    const ids = {
      solto: await produto(matriz, `${rotulo} Solto`),
      comOutro: await produto(matriz, `${rotulo} Com outro`),
      jaLigado: await produto(matriz, `${rotulo} Ja ligado`),
    };
    // um já tem outro principal; outro já está ligado à Alfa com custo 7
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main) VALUES ($1, $2, $3, 11, true)`, [matriz, ids.comOutro, outro]);
    await q(`UPDATE products SET supplier_id = $2 WHERE id = $1`, [ids.comOutro, outro]);
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main) VALUES ($1, $2, $3, 7, false)`, [matriz, ids.jaLigado, alfa]);
    const mapa = {
      [alfa]: 'ALFA', [outro]: 'OUTRO', [`${rotulo} Alfa`]: 'NOME_ALFA', [`${rotulo} Outro`]: 'NOME_OUTRO',
      [ids.solto]: 'SOLTO', [ids.comOutro]: 'COM_OUTRO', [ids.jaLigado]: 'JA_LIGADO',
    };
    return { alfa, ids, mapa };
  }
  const fotografar = async ({ ids, mapa }) => semIds({
    solto: await retrato(ids.solto),
    comOutro: await retrato(ids.comOutro),
    jaLigado: await retrato(ids.jaLigado),
  }, mapa);

  test.each([
    ['principal, com custo', { cost: 5.5 }],
    ['principal, sem custo', {}],
    ['is_main false, com custo', { is_main: false, cost: 5.5 }],
    ['is_main false, sem custo', { is_main: false }],
  ])('%s', async (_n, extra) => {
    const a = await cenario('PA');
    const b = await cenario('PB');
    const lista = (c) => [c.ids.solto, c.ids.comOutro, c.ids.jaLigado];

    const ra = await vincular(matriz, a.alfa, { product_ids: lista(a), ...extra });
    const { cost, ...semCustoGeral } = extra;
    const rb = await vincular(matriz, b.alfa, {
      ...semCustoGeral,
      items: lista(b).map((product_id) => (cost === undefined ? { product_id } : { product_id, cost })),
    });
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(rb.body.updated).toBe(ra.body.updated);
    expect(await fotografar(b)).toEqual(await fotografar(a));
  });
});

// ── 2 a 4. Custo e código por produto ───────────────────────────────
describe('items[]: cada produto com o seu custo', () => {
  test('is_main false: custo e código de cada um, principal de quem tem fica, estoque e custo do produto não mudam', async () => {
    const alfa = await fornecedor(matriz, 'Distribuidora Alfa B4', '12345678000190');
    const outro = await fornecedor(matriz, 'Outro B4', null);
    const esmalte = await produto(matriz, 'Esmalte B4', { stock_qty: 36, cost_price: 4.2, weighted_avg_cost: 4.1 });
    const acetona = await produto(matriz, 'Acetona B4', { stock_qty: 16, cost_price: 6, weighted_avg_cost: 6 });
    const algodao = await produto(matriz, 'Algodao B4', { stock_qty: 0, cost_price: 3, weighted_avg_cost: null });
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main) VALUES ($1, $2, $3, 4, true)`, [matriz, esmalte, outro]);
    await q(`UPDATE products SET supplier_id = $2, supplier_name = 'Outro B4' WHERE id = $1`, [esmalte, outro]);
    // a acetona já estava ligada à Alfa, com código e custo antigos
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, supplier_code, is_main) VALUES ($1, $2, $3, 5, 'AL-OLD', false)`, [matriz, acetona, alfa]);
    const antes = { esmalte: await retrato(esmalte), acetona: await retrato(acetona), algodao: await retrato(algodao) };

    const res = await vincular(matriz, alfa, {
      is_main: false,
      items: [
        { product_id: esmalte, cost: 3.95, supplier_code: 'AL-0101' },
        { product_id: acetona },                              // sem custo nem código: mantém os dois
        { product_id: algodao, cost: 2.4, supplier_code: 'AL-0391' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3, unlink: false, is_main: false, linked: 3, not_found: [] });

    const depois = { esmalte: await retrato(esmalte), acetona: await retrato(acetona), algodao: await retrato(algodao) };
    // custo e código de cada um
    expect(depois.esmalte.fornecedores).toEqual([
      { supplier_id: outro, cost: 4, supplier_code: null, is_main: true },
      { supplier_id: alfa, cost: 3.95, supplier_code: 'AL-0101', is_main: false },
    ].sort((x, y) => (x.is_main === y.is_main ? (x.supplier_id < y.supplier_id ? -1 : 1) : (x.is_main ? -1 : 1))));
    expect(depois.acetona.fornecedores).toEqual([{ supplier_id: alfa, cost: 5, supplier_code: 'AL-OLD', is_main: true }]);
    expect(depois.algodao.fornecedores).toEqual([{ supplier_id: alfa, cost: 2.4, supplier_code: 'AL-0391', is_main: true }]);
    // o esmalte segue com o principal de antes; quem não tinha ganhou a Alfa (e o espelho)
    expect(depois.esmalte.produto.supplier_id).toBe(outro);
    expect(depois.acetona.produto).toMatchObject({ supplier_id: alfa, supplier_name: 'Distribuidora Alfa B4', supplier_cnpj: '12345678000190' });
    expect(depois.algodao.produto.supplier_id).toBe(alfa);
    // estoque, custo do produto, custo médio e movimentos: iguais
    for (const k of Object.keys(antes)) {
      const { supplier_id: _a, supplier_name: _b, supplier_cnpj: _c, ...resto } = depois[k].produto;
      const { supplier_id: _d, supplier_name: _e, supplier_cnpj: _f, ...restoAntes } = antes[k].produto;
      expect(resto).toEqual(restoAntes);
      expect(depois[k].movimentos).toBe(0);
    }
  });

  test('ligar de novo troca o custo e o código pelos da lista nova', async () => {
    const alfa = await fornecedor(matriz, 'Alfa B4 relista', null);
    const vela = await produto(matriz, 'Vela B4');
    await vincular(matriz, alfa, { is_main: false, items: [{ product_id: vela, cost: 3, supplier_code: 'V1' }] });
    await vincular(matriz, alfa, { is_main: false, items: [{ product_id: vela, cost: 3.5, supplier_code: 'V2' }] });
    expect((await retrato(vela)).fornecedores).toEqual([{ supplier_id: alfa, cost: 3.5, supplier_code: 'V2', is_main: true }]);
  });

  test('principal: vira o principal de todos, cada um com o seu custo', async () => {
    const alfa = await fornecedor(matriz, 'Alfa B4 principal', null);
    const outro = await fornecedor(matriz, 'Outro B4 principal', null);
    const capa = await produto(matriz, 'Capa B4');
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main) VALUES ($1, $2, $3, 4, true)`, [matriz, capa, outro]);
    const cabo = await produto(matriz, 'Cabo B4');
    const res = await vincular(matriz, alfa, { items: [{ product_id: capa, cost: 5.9 }, { product_id: cabo, cost: 8 }] });
    expect(res.status).toBe(200);
    const rc = await retrato(capa);
    expect(rc.produto.supplier_id).toBe(alfa);
    expect(rc.fornecedores.find((f) => f.supplier_id === alfa)).toMatchObject({ cost: 5.9, is_main: true });
    expect(rc.fornecedores.find((f) => f.supplier_id === outro)).toMatchObject({ cost: 4, is_main: false });
    expect((await retrato(cabo)).fornecedores).toEqual([{ supplier_id: alfa, cost: 8, supplier_code: null, is_main: true }]);
  });
});

// ── 5. Multi-CNPJ ───────────────────────────────────────────────────
describe('multi-CNPJ', () => {
  test('a filial liga o compartilhado da matriz; produto de fora do grupo fica em not_found e não grava', async () => {
    const alfa = await fornecedor(matriz, 'Alfa B4 grupo', null); // fornecedor vale para o grupo
    const compartilhado = await produto(matriz, 'Compartilhado B4', { is_group_shared: true });
    const soDaMatriz = await produto(matriz, 'So da matriz B4');
    const deOutraLoja = await produto(deFora, 'De fora B4');
    const res = await vincular(filial, alfa, {
      is_main: false,
      items: [
        { product_id: compartilhado, cost: 2 },
        { product_id: soDaMatriz, cost: 3 },
        { product_id: deOutraLoja, cost: 4 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(1);
    expect(res.body.not_found.sort()).toEqual([soDaMatriz, deOutraLoja].sort());
    // company_id da linha é o dono do produto (decisão b da 424)
    const { rows } = await q(`SELECT company_id, cost FROM product_suppliers WHERE product_id = $1`, [compartilhado]);
    expect(rows.map((r) => ({ company_id: r.company_id, cost: num(r.cost) }))).toEqual([{ company_id: matriz, cost: 2 }]);
    expect((await retrato(soDaMatriz)).fornecedores).toEqual([]);
    expect((await retrato(deOutraLoja)).fornecedores).toEqual([]);
  });

  test('fornecedor de fora do grupo: 404', async () => {
    const deOutro = await fornecedor(deFora, 'Fornecedor de fora B4', null);
    const p = await produto(matriz, 'Produto B4 404');
    const res = await vincular(matriz, deOutro, { is_main: false, items: [{ product_id: p, cost: 1 }] });
    expect(res.status).toBe(404);
    expect((await retrato(p)).fornecedores).toEqual([]);
  });
});

// ── 6. Quem não vê custo ────────────────────────────────────────────
test('quem não vê custo: liga e grava o código, sem custo (o gravado fica)', async () => {
  const alfa = await fornecedor(matriz, 'Alfa B4 sem custo', null);
  const p1 = await produto(matriz, 'Produto B4 sem custo 1');
  const p2 = await produto(matriz, 'Produto B4 sem custo 2');
  await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main) VALUES ($1, $2, $3, 9, false)`, [matriz, p2, alfa]);
  const res = await vincular(matriz, alfa, {
    is_main: false,
    cost: 1,
    items: [{ product_id: p1, cost: 3, supplier_code: 'C1' }, { product_id: p2, cost: 4, supplier_code: 'C2' }],
  }, semCusto);
  expect(res.status).toBe(200);
  expect((await retrato(p1)).fornecedores).toEqual([{ supplier_id: alfa, cost: null, supplier_code: 'C1', is_main: true }]);
  expect((await retrato(p2)).fornecedores).toEqual([{ supplier_id: alfa, cost: 9, supplier_code: 'C2', is_main: true }]);
});
