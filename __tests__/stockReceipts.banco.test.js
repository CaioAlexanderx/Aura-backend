// ============================================================
// AURA. — Entrada de vários itens (POST /products/stock-receipts, B2a) e
// leituras do B3 — Postgres real (migration 457)
//
// O que este arquivo prova:
//   1. EQUIVALÊNCIA: a mesma nota lançada (a) produto a produto pela rota
//      de um produto, em ordem, e (b) numa entrada só, deixa o banco igual:
//      estoque (produto e variantes), custo médio, cost_price, fornecedor
//      principal, última compra, custo em product_suppliers e os movimentos
//      (quantidade, custo, variante, 'NF <n>', ordem). Inclui produto
//      repetido em duas linhas, update_cost false, linha sem custo, estoque
//      negativo e produto que já tinha outro principal.
//   2. idempotência: a mesma chave de novo devolve a resposta guardada e
//      não soma; chave de outra loja: 409
//   3. concorrência de verdade (COMMIT em várias conexões):
//      - 6 pedidos simultâneos com a MESMA chave somam UMA vez;
//      - entradas simultâneas com chaves diferentes e os mesmos produtos em
//        ordem invertida, mais entradas de um produto no meio, terminam sem
//        deadlock e com o estoque somado certo
//   4. tudo ou nada: produto de fora (multi-CNPJ), grade errada ou
//      fornecedor de fora do grupo: 400/404, nada grava e a chave continua
//      livre
//   5. multi-CNPJ: a filial dá entrada no compartilhado da matriz (um
//      estoque só), movimento e cabeçalho com a filial
//   6. supplier_code vai para product_suppliers; GET /suppliers/:sid/codes
//   7. quem não vê custo: a linha entra sem custo e a resposta sai sem custo;
//      o perfil consulta leva 403
//   8. "nota já lançada": chave da NF-e, número sem zeros à esquerda,
//      fornecedor, e o texto 'NF <n>' das entradas antigas de um produto
//   9. fornecedores: last_delivery_at na lista e linked_products na ficha
//  10. limite de 300 linhas e a duração de uma entrada de 300 linhas
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
const semCusto = uuid();   // edita estoque, não vê custo (painel desligado)
const consulta = uuid();   // estoque só consulta
const usuarios = [dono, semCusto, consulta];
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
async function variantes(pid, grade) {
  const out = {};
  for (const [suf, qtd] of grade) {
    const { rows } = await q(`INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, $2, $3) RETURNING id`, [pid, suf, qtd]);
    out[suf] = rows[0].id;
  }
  return out;
}

// Retrato do que a entrada mexe num produto (sem ids nem horários).
async function retrato(pid) {
  const { rows: [p] } = await q(
    `SELECT stock_qty, cost_price, weighted_avg_cost, supplier_id, supplier_name, supplier_cnpj,
            last_supplier_name, last_purchase_unit_cost, last_purchase_at IS NOT NULL AS comprou
       FROM products WHERE id = $1`, [pid]);
  const { rows: vs } = await q(`SELECT sku_suffix, stock_qty FROM product_variants WHERE product_id = $1 ORDER BY sku_suffix`, [pid]);
  const { rows: ps } = await q(
    `SELECT supplier_id, cost, is_main, last_purchase_at IS NOT NULL AS comprou
       FROM product_suppliers WHERE product_id = $1 ORDER BY is_main DESC, supplier_id`, [pid]);
  const { rows: ms } = await q(
    `SELECT sm.company_id, sm.type, sm.quantity, sm.reference_type, sm.notes, sm.supplier_id, sm.unit_cost, v.sku_suffix
       FROM stock_movements sm LEFT JOIN product_variants v ON v.id = sm.variant_id
      WHERE sm.product_id = $1 ORDER BY sm.created_at, sm.id`, [pid]);
  return {
    produto: { ...p, stock_qty: num(p.stock_qty), cost_price: num(p.cost_price), weighted_avg_cost: num(p.weighted_avg_cost), last_purchase_unit_cost: num(p.last_purchase_unit_cost) },
    variantes: vs.map((v) => [v.sku_suffix, num(v.stock_qty)]),
    fornecedores: ps.map((r) => ({ ...r, cost: num(r.cost) })),
    // a ordem dos movimentos de uma mesma linha (várias variantes) pode
    // empatar no created_at: compara como conjunto ordenado
    movimentos: ms.map((m) => ({ ...m, quantity: num(m.quantity), unit_cost: num(m.unit_cost) }))
      .map((m) => JSON.stringify(m)).sort(),
  };
}

const http = (user = dono) => ({
  post: (url, body, chave) => {
    const r = request(app).post(url).set('x-user', user);
    if (chave) r.set('Idempotency-Key', chave);
    return r.send(body);
  },
  get: (url) => request(app).get(url).set('x-user', user),
});
const receber = (loja, body, user = dono) => http(user).post(`/companies/${loja}/products/stock-receipts`, body);
const umProduto = (loja, pid, body) => http().post(`/companies/${loja}/products/${pid}/stock-entries`, body);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.queryRetry = (sql, params) => pool.query(sql, params);
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return { query: (...a) => c.query(...a), release: (...a) => c.release(...a) };
  });

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Recebimento')`, [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Matriz Recebimento')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Recebimento', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Recebimento')`, [deFora, dono]);
  const membro = (user, label, perms) => q(
    `INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, $3, 'active', true, $4)`,
    [matriz, user, label, JSON.stringify(perms)]);
  await membro(semCusto, 'estoquista', { estoque: true, pdv: true, painel: false });
  await membro(consulta, 'vendedor', { estoque_consulta: true, painel: false });

  const { estoqueSoConsulta, semCustoEmConsulta } = require('../src/middleware/estoqueSoConsulta');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  // A mesma ordem de src/routes/private.js
  app.use('/companies/:id/products', estoqueSoConsulta);
  app.use('/companies/:id/suppliers', semCustoEmConsulta());
  app.use('/companies/:id/products', require('../src/routes/stockReceipts'));
  app.use('/companies/:id/products', require('../src/routes/productSuppliers'));
  app.use('/companies/:id/suppliers', require('../src/routes/suppliers'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_receipts WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
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

// ── 1. Equivalência com o caminho de um produto ─────────────────────
describe('a entrada de vários itens bate com a de um produto, em ordem', () => {
  // Monta o mesmo cenário duas vezes (A: produto a produto; B: numa entrada só).
  async function cenario(rotulo, forn, outro) {
    const ids = {};
    ids.capa = await produto(matriz, `${rotulo} Capa`, { stock_qty: 4, cost_price: 5.5 });
    ids.cabo = await produto(matriz, `${rotulo} Cabo`, { stock_qty: -3, cost_price: 9 });
    ids.vestido = await produto(matriz, `${rotulo} Vestido`, { stock_qty: 0, cost_price: 24 });
    ids.grade = await variantes(ids.vestido, [['G', 0], ['M', 1], ['P', 2]]);
    ids.vela = await produto(matriz, `${rotulo} Vela`, { stock_qty: 10, weighted_avg_cost: 3.3333, cost_price: 3.33 });
    ids.caneca = await produto(matriz, `${rotulo} Caneca`, { stock_qty: 7, cost_price: 12 });
    // a caneca já tem outro fornecedor como principal
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main) VALUES ($1, $2, $3, 11, true)`, [matriz, ids.caneca, outro]);
    await q(`UPDATE products SET supplier_id = $2 WHERE id = $1`, [ids.caneca, outro]);
    ids.kg = await produto(matriz, `${rotulo} Granel`, { stock_qty: 1.25, cost_price: 20 });
    return ids;
  }
  // As linhas da nota, em ordem. `v` = grade por sufixo.
  const linhasDaNota = (ids) => [
    { product_id: ids.capa, quantity: 20, unit_cost: 5.9 },
    { product_id: ids.cabo, quantity: 10, unit_cost: 5 },
    { product_id: ids.vestido, v: [['P', 4], ['G', 6]], unit_cost: 30 },
    { product_id: ids.vela, quantity: 5, unit_cost: 4, update_cost: false },
    { product_id: ids.capa, quantity: 6 }, // a capa de novo, sem custo
    { product_id: ids.caneca, quantity: 3, unit_cost: 13.5 },
    { product_id: ids.vestido, v: [['M', 2]], unit_cost: 28.75 },
    { product_id: ids.kg, quantity: 0.375, unit_cost: 18.4 },
    { product_id: ids.capa, quantity: 2, unit_cost: 6.1, update_cost: false },
    { product_id: ids.vela, quantity: 1, unit_cost: 5 },
  ];
  const grade = (ids, v) => v.map(([suf, qtd]) => ({ variant_id: ids.grade[suf], quantity: qtd }));

  test('estoque, custo médio, cost_price, fornecedor, última compra e movimentos iguais', async () => {
    const forn = await fornecedor(matriz, 'Distribuidora Equivalência', '11444777000161');
    const outro = await fornecedor(matriz, 'Principal de antes');
    const A = await cenario('A', forn, outro);
    const B = await cenario('B', forn, outro);

    // A: produto a produto, em ordem
    const respostasA = [];
    for (const l of linhasDaNota(A)) {
      const body = { supplier_id: forn, invoice_number: '004512', unit_cost: l.unit_cost, update_cost: l.update_cost };
      if (l.v) body.items = grade(A, l.v); else body.quantity = l.quantity;
      const r = await umProduto(matriz, l.product_id, body);
      expect(r.status).toBe(201);
      respostasA.push({ before: r.body.before, after: r.body.after });
    }

    // B: numa entrada só
    const itens = linhasDaNota(B).map((l) => {
      const it = { product_id: l.product_id, unit_cost: l.unit_cost, update_cost: l.update_cost };
      if (l.v) it.variants = grade(B, l.v); else it.quantity = l.quantity;
      return it;
    });
    const r = await receber(matriz, { idempotency_key: uuid(), supplier_id: forn, invoice_number: '004512', origin: 'nota', items: itens });
    expect(r.status).toBe(201);
    expect(r.body.lines.map((l) => ({ before: l.before, after: l.after }))).toEqual(respostasA);
    expect(r.body.lines.map((l) => l.index)).toEqual(itens.map((_, i) => i));
    expect(r.body.totals).toMatchObject({ lines: 10, products: 6 });

    for (const k of ['capa', 'cabo', 'vestido', 'vela', 'caneca', 'kg']) {
      const a = await retrato(A[k]);
      const b = await retrato(B[k]);
      expect({ k, ...b }).toEqual({ k, ...a });
    }
    // conferência à mão de dois números (para não comparar erro com erro)
    const capa = await retrato(B.capa);
    // 4 a 5,50 + 20 a 5,90 = 5,8333; + 6 sem custo; + 2 a 6,10 (não mexe no cost_price)
    // (30 × 5,8333 + 2 × 6,10) / 32 = 5,8500
    expect(capa.produto).toMatchObject({ stock_qty: 32, weighted_avg_cost: 5.85, cost_price: 5.83, supplier_id: forn, last_purchase_unit_cost: 6.1 });
    const caneca = await retrato(B.caneca);
    expect(caneca.produto.supplier_id).toBe(outro);
    expect(caneca.fornecedores.map((f) => [f.supplier_id === outro ? 'antes' : 'nota', f.is_main])).toEqual([['antes', true], ['nota', false]]);

    // o movimento aponta para o cabeçalho
    const { rows: refs } = await q(`SELECT DISTINCT reference_id FROM stock_movements WHERE product_id = ANY($1)`, [[B.capa, B.vestido]]);
    expect(refs).toEqual([{ reference_id: r.body.receipt.id }]);
    const { rows: [cab] } = await q(`SELECT company_id, supplier_id, invoice_number, origin, created_by, result->'totals'->>'lines' AS n FROM stock_receipts WHERE id = $1`, [r.body.receipt.id]);
    expect(cab).toEqual({ company_id: matriz, supplier_id: forn, invoice_number: '004512', origin: 'nota', created_by: dono, n: '10' });
  });
});

// ── 2 e 3. Idempotência e concorrência ─────────────────────────────
describe('chave contra entrar em dobro', () => {
  test('a mesma chave de novo devolve a resposta guardada e não soma', async () => {
    const p = await produto(matriz, 'Idem simples', { stock_qty: 1, cost_price: 2 });
    const chave = uuid();
    const body = { idempotency_key: chave, items: [{ product_id: p, quantity: 5, unit_cost: 3 }] };
    const r1 = await receber(matriz, body);
    expect(r1.status).toBe(201);
    const r2 = await receber(matriz, body);
    expect(r2.status).toBe(200);
    expect(r2.body.repeated).toBe(true);
    const { repeated, ...guardada } = r2.body;
    expect(guardada).toEqual(r1.body);
    expect((await retrato(p)).produto.stock_qty).toBe(6);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id = $1`, [p]);
    expect(rows[0].n).toBe(1);
    // pelo cabeçalho também
    const r3 = await http().post(`/companies/${matriz}/products/stock-receipts`, { items: body.items }, chave);
    expect(r3.status).toBe(200);
    expect((await retrato(p)).produto.stock_qty).toBe(6);
  });

  test('chave de outra loja: 409 e nada grava', async () => {
    const p = await produto(filial, 'Idem da filial', { stock_qty: 0 });
    const chave = uuid();
    expect((await receber(matriz, { idempotency_key: chave, items: [{ product_id: await produto(matriz, 'x'), quantity: 1 }] })).status).toBe(201);
    const r = await receber(filial, { idempotency_key: chave, items: [{ product_id: p, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CHAVE_DE_OUTRA_LOJA');
    expect((await retrato(p)).produto.stock_qty).toBe(0);
  });

  test('6 pedidos SIMULTÂNEOS com a mesma chave somam uma vez', async () => {
    const p1 = await produto(matriz, 'Corrida 1', { stock_qty: 0 });
    const p2 = await produto(matriz, 'Corrida 2', { stock_qty: 10, cost_price: 4 });
    const body = { idempotency_key: uuid(), items: [{ product_id: p1, quantity: 3, unit_cost: 2 }, { product_id: p2, quantity: 2, unit_cost: 7 }] };
    const rs = await Promise.all(Array.from({ length: 6 }, () => receber(matriz, body)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(rs.filter((r) => r.status === 200).every((r) => r.body.repeated === true)).toBe(true);
    expect((await retrato(p1)).produto.stock_qty).toBe(3);
    expect((await retrato(p2)).produto).toMatchObject({ stock_qty: 12, weighted_avg_cost: 4.5 });
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM stock_receipts WHERE idempotency_key = $1`, [body.idempotency_key]);
    expect(rows[0].n).toBe(1);
  });

  test('chaves diferentes, mesmos produtos em ordem invertida e entradas de um produto no meio: sem deadlock, soma certa', async () => {
    const ps = [];
    for (let i = 0; i < 8; i++) ps.push(await produto(matriz, `Disputa ${i}`, { stock_qty: 100 }));
    const ida = ps.map((id) => ({ product_id: id, quantity: 1 }));
    const volta = [...ida].reverse();
    const pedidos = [];
    for (let k = 0; k < 4; k++) {
      pedidos.push(receber(matriz, { idempotency_key: uuid(), items: k % 2 ? volta : ida }));
      pedidos.push(umProduto(matriz, ps[k], { quantity: 10 }));
    }
    const rs = await Promise.all(pedidos);
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201, 201, 201]);
    const { rows } = await q(`SELECT id, stock_qty FROM products WHERE id = ANY($1)`, [ps]);
    const estoque = Object.fromEntries(rows.map((r) => [r.id, num(r.stock_qty)]));
    ps.forEach((id, i) => expect(estoque[id]).toBe(100 + 4 + (i < 4 ? 10 : 0)));
  }, 30000);
});

// ── 4 e 5. Tudo ou nada; multi-CNPJ ────────────────────────────────
describe('tudo ou nada e multi-CNPJ', () => {
  test('um item de fora derruba a entrada inteira; a chave segue livre', async () => {
    const meu = await produto(filial, 'Da filial', { stock_qty: 1 });
    const soDaMatriz = await produto(matriz, 'Só da matriz', { stock_qty: 1 });
    const chave = uuid();
    const r = await receber(filial, { idempotency_key: chave, items: [{ product_id: meu, quantity: 2 }, { product_id: soDaMatriz, quantity: 2 }] });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'LINHAS_COM_ERRO', lines: [{ index: 1, product_id: soDaMatriz, error: 'Produto não encontrado' }] });
    expect((await retrato(meu)).produto.stock_qty).toBe(1);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM stock_receipts WHERE idempotency_key = $1`, [chave]);
    expect(rows[0].n).toBe(0);
    // corrigida, a mesma chave entra
    expect((await receber(filial, { idempotency_key: chave, items: [{ product_id: meu, quantity: 2 }] })).status).toBe(201);
    expect((await retrato(meu)).produto.stock_qty).toBe(3);
  });

  test('grade errada e fornecedor de fora do grupo: nada grava', async () => {
    const saia = await produto(matriz, 'Saia grade', { stock_qty: 0 });
    const v = await variantes(saia, [['U', 1]]);
    const simples = await produto(matriz, 'Meia simples', { stock_qty: 1 });
    const r = await receber(matriz, { idempotency_key: uuid(), items: [{ product_id: simples, quantity: 1 }, { product_id: saia, quantity: 3 }] });
    expect(r.status).toBe(400);
    expect(r.body.lines).toEqual([{ index: 1, product_id: saia, error: 'Esse produto tem cor/tamanho: informe quantas chegaram de cada' }]);
    const alheio = await fornecedor(deFora, 'Alheio');
    const r2 = await receber(matriz, { idempotency_key: uuid(), supplier_id: alheio, items: [{ product_id: saia, variants: [{ variant_id: v.U, quantity: 1 }] }] });
    expect(r2.status).toBe(404);
    expect((await retrato(simples)).produto.stock_qty).toBe(1);
    expect((await retrato(saia)).variantes).toEqual([['U', 1]]);
  });

  test('a filial dá entrada no compartilhado da matriz: um estoque só, movimento e cabeçalho da filial', async () => {
    const bolsa = await produto(matriz, 'Bolsa do grupo', { stock_qty: 5, cost_price: 40, is_group_shared: true });
    const forn = await fornecedor(matriz, 'Couros Grupo');
    const r = await receber(filial, { idempotency_key: uuid(), supplier_id: forn, items: [{ product_id: bolsa, quantity: 5, unit_cost: 50 }] });
    expect(r.status).toBe(201);
    const b = await retrato(bolsa);
    expect(b.produto).toMatchObject({ stock_qty: 10, weighted_avg_cost: 45 });
    expect(b.movimentos.map((m) => JSON.parse(m).company_id)).toEqual([filial]);
    const { rows: [cab] } = await q(`SELECT company_id FROM stock_receipts WHERE id = $1`, [r.body.receipt.id]);
    expect(cab.company_id).toBe(filial);
    // a loja de fora do grupo não acha o compartilhado
    const r2 = await receber(deFora, { idempotency_key: uuid(), items: [{ product_id: bolsa, quantity: 1 }] });
    expect(r2.status).toBe(400);
  });
});

// ── 6. Código do fornecedor ─────────────────────────────────────────
describe('código do fornecedor', () => {
  test('grava em product_suppliers, troca pelo novo, mantém quando não vem; GET /suppliers/:sid/codes', async () => {
    const forn = await fornecedor(matriz, 'Fornecedor com código');
    const a = await produto(matriz, 'Item A', { stock_qty: 0 });
    const b = await produto(matriz, 'Item B', { stock_qty: 0 });
    const daFilial = await produto(filial, 'Item da filial', { stock_qty: 0 });
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, supplier_code) VALUES ($1, $2, $3, 'F-9')`, [filial, daFilial, forn]);
    expect((await receber(matriz, { idempotency_key: uuid(), supplier_id: forn, items: [
      { product_id: a, quantity: 1, supplier_code: ' 123-A ' }, { product_id: b, quantity: 1 },
    ] })).status).toBe(201);
    expect((await receber(matriz, { idempotency_key: uuid(), supplier_id: forn, items: [
      { product_id: a, quantity: 1 }, { product_id: b, quantity: 1, supplier_code: '777' },
    ] })).status).toBe(201);
    const { rows } = await q(`SELECT product_id, supplier_code FROM product_suppliers WHERE supplier_id = $1 AND product_id = ANY($2)`, [forn, [a, b]]);
    expect(Object.fromEntries(rows.map((r) => [r.product_id, r.supplier_code]))).toEqual({ [a]: '123-A', [b]: '777' });

    const r = await http().get(`/companies/${matriz}/suppliers/${forn}/codes`);
    expect(r.status).toBe(200);
    expect(r.body.map).toEqual({ '123-A': a, 777: b });
    expect(r.body.items.map((i) => i.product_id)).not.toContain(daFilial); // não compartilhado da filial
    expect((await http().get(`/companies/${deFora}/suppliers/${forn}/codes`)).status).toBe(404);
  });

  test('sem fornecedor, o código é ignorado', async () => {
    const p = await produto(matriz, 'Sem fornecedor', { stock_qty: 0 });
    expect((await receber(matriz, { idempotency_key: uuid(), items: [{ product_id: p, quantity: 1, supplier_code: 'X' }] })).status).toBe(201);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM product_suppliers WHERE product_id = $1`, [p]);
    expect(rows[0].n).toBe(0);
  });
});

// ── 7. Custo oculto e consulta ──────────────────────────────────────
describe('quem não vê custo', () => {
  test('a linha entra sem custo (estoque soma, médio não muda) e a resposta sai sem custo', async () => {
    const p = await produto(matriz, 'Oculto', { stock_qty: 4, cost_price: 5 });
    const r = await receber(matriz, { idempotency_key: uuid(), items: [{ product_id: p, quantity: 6, unit_cost: 99 }] }, semCusto);
    expect(r.status).toBe(201);
    expect(r.body.lines[0]).not.toHaveProperty('unit_cost');
    expect(r.body.lines[0].before).not.toHaveProperty('avg_cost');
    expect(r.body.totals).not.toHaveProperty('total_cost');
    expect((await retrato(p)).produto).toMatchObject({ stock_qty: 10, cost_price: 5, weighted_avg_cost: null });
  });

  test('o perfil consulta leva 403 na escrita e na leitura', async () => {
    const p = await produto(matriz, 'Consulta', { stock_qty: 1 });
    expect((await receber(matriz, { idempotency_key: uuid(), items: [{ product_id: p, quantity: 1 }] }, consulta)).status).toBe(403);
    expect((await http(consulta).get(`/companies/${matriz}/products/stock-receipts?invoice_number=1`)).status).toBe(403);
    expect((await retrato(p)).produto.stock_qty).toBe(1);
  });
});

// ── 8. Nota já lançada ──────────────────────────────────────────────
describe('nota já lançada', () => {
  test('pela chave da NF-e, pelo número sem zeros + fornecedor, e o texto NF <n> das entradas antigas', async () => {
    const forn = await fornecedor(matriz, 'Fornecedor da nota');
    const outro = await fornecedor(matriz, 'Outro da nota');
    const p = await produto(matriz, 'Item da nota', { stock_qty: 0 });
    const chaveNfe = '35251111444777000161550010000045121000045120';
    const r = await receber(matriz, { idempotency_key: uuid(), supplier_id: forn, invoice_number: '007733', nfe_key: chaveNfe, origin: 'nota', items: [{ product_id: p, quantity: 1 }] });
    expect(r.status).toBe(201);
    // entrada antiga, de um produto, com outro número e outro fornecedor
    await umProduto(matriz, p, { supplier_id: outro, quantity: 1, invoice_number: '0991' });
    await umProduto(matriz, await produto(matriz, 'Item antigo 2'), { supplier_id: outro, quantity: 1, invoice_number: '991' });

    const busca = (qs, loja = matriz) => http().get(`/companies/${loja}/products/stock-receipts?${qs}`);
    const porChave = await busca(`nfe_key=${chaveNfe}`);
    expect(porChave.body.receipts).toHaveLength(1);
    expect(porChave.body.receipts[0]).toMatchObject({ id: r.body.receipt.id, supplier_name: 'Fornecedor da nota', lines: 1, origin: 'nota' });
    expect((await busca(`invoice_number=7733&supplier_id=${forn}`)).body.receipts).toHaveLength(1);
    expect((await busca('invoice_number=07733')).body.receipts).toHaveLength(1);
    expect((await busca(`invoice_number=7733&supplier_id=${outro}`)).body.receipts).toHaveLength(0);
    // as entradas novas não aparecem como antigas (têm reference_id)
    expect((await busca('invoice_number=7733')).body.legacy).toEqual([]);

    const antigas = await busca(`invoice_number=991&supplier_id=${outro}`);
    expect(antigas.status).toBe(200);
    expect(antigas.body.receipts).toEqual([]);
    expect(antigas.body.legacy).toHaveLength(1);
    expect(antigas.body.legacy[0]).toMatchObject({ supplier_id: outro, supplier_name: 'Outro da nota', products: 2 });
    // outra loja não vê
    expect((await busca(`nfe_key=${chaveNfe}`, filial)).body.receipts).toEqual([]);
    // pedido sem número nem chave, ou chave curta
    expect((await busca('')).status).toBe(400);
    expect((await busca('nfe_key=123')).status).toBe(400);
  });
});

// ── 9. Fornecedores: última entrega e produtos ligados ──────────────
describe('fornecedores', () => {
  test('last_delivery_at por loja na lista; linked_products com última compra na ficha', async () => {
    const forn = await fornecedor(matriz, 'Zeta Entregas');
    await fornecedor(matriz, 'Zeta Nunca');
    const a = await produto(matriz, 'Ligado A', { stock_qty: 0 });
    const b = await produto(matriz, 'Ligado B', { stock_qty: 0, is_group_shared: true });
    const escondido = await produto(filial, 'Da filial, não compartilhado', { stock_qty: 0 });
    await q(`INSERT INTO product_suppliers (company_id, product_id, supplier_id, is_main) VALUES ($1, $2, $3, true)`, [filial, escondido, forn]);
    await receber(matriz, { idempotency_key: uuid(), supplier_id: forn, items: [{ product_id: a, quantity: 2, unit_cost: 3 }] });
    await receber(filial, { idempotency_key: uuid(), supplier_id: forn, items: [{ product_id: b, quantity: 1 }] });

    const lista = await http().get(`/companies/${matriz}/suppliers?q=Zeta`);
    expect(lista.status).toBe(200);
    const z = Object.fromEntries(lista.body.suppliers.map((s) => [s.name, s]));
    expect(z['Zeta Entregas'].last_delivery_at).not.toBeNull();
    expect(z['Zeta Nunca'].last_delivery_at).toBeNull();
    expect(z['Zeta Entregas'].product_count).toBe(2); // conta como antes: onde ele é o principal (A e B)

    const ficha = await http().get(`/companies/${matriz}/suppliers/${forn}`);
    expect(ficha.status).toBe(200);
    const ligados = Object.fromEntries(ficha.body.linked_products.map((p) => [p.name, p]));
    expect(Object.keys(ligados).sort()).toEqual(['Ligado A', 'Ligado B']);
    expect(ligados['Ligado A']).toMatchObject({ is_main: true, supplier_code: null });
    expect(Number(ligados['Ligado A'].cost)).toBe(3);
    expect(ligados['Ligado A'].last_purchase_at).not.toBeNull();
  });
});

// ── 10. Limite e duração ────────────────────────────────────────────
describe('limite de linhas', () => {
  test('301 itens: 400 LIMITE_DE_LINHAS; 300 itens entram numa transação', async () => {
    const p = await produto(matriz, 'Limite', { stock_qty: 0 });
    const muitos = (n) => Array.from({ length: n }, () => ({ product_id: p, quantity: 1 }));
    const r = await receber(matriz, { idempotency_key: uuid(), items: muitos(301) });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'LIMITE_DE_LINHAS', limit: 300 });

    const { rows: novos } = await q(
      `INSERT INTO products (company_id, name, price, stock_qty, cost_price)
       SELECT $1, 'Lote ' || g, 10, 5, 2 FROM generate_series(1, 300) g RETURNING id`, [matriz]);
    const forn = await fornecedor(matriz, 'Fornecedor de 300');
    const inicio = Date.now();
    const r2 = await receber(matriz, { idempotency_key: uuid(), supplier_id: forn, items: novos.map((x, i) => ({ product_id: x.id, quantity: 1 + (i % 3), unit_cost: 3, supplier_code: `C${i}` })) });
    const ms = Date.now() - inicio;
    expect(r2.status).toBe(201);
    expect(r2.body.totals).toMatchObject({ lines: 300, products: 300 });
    const { rows: [{ n }] } = await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE reference_id = $1`, [r2.body.receipt.id]);
    expect(n).toBe(300);
    // banco local: só para pegar uma regressão grosseira (uma ida por linha)
    expect(ms).toBeLessThan(5000);
  }, 30000);
});
