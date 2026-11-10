// ============================================================
// AURA. — Transferencia de estoque entre lojas do grupo (migration 444)
// Postgres real.
//
// O que este arquivo trava:
//   1. produto sem variante: copia no destino com o cadastro (NCM, marca,
//      nota_fiscal, categoria com a arvore, fotos), estoque 0 + transferido,
//      is_group_shared = false; stock_movements 'out'/'in' nas duas lojas
//   2. a segunda transferencia reaproveita o mesmo produto do destino, e a
//      volta (destino -> origem) cai no produto original
//   3. produto com variante: baixa na variante (o pai nao muda), variante
//      criada no destino com Cor/Tamanho; a mesma variante depois reaproveita
//   4. match por codigo de barras; variante achada pelos atributos
//   5. estoque insuficiente nao muda nada
//   6. loja de fora do grupo, mesma loja, quantidade e item invalidos
//   7. lock: venda segurando a linha faz a transferencia esperar e enxergar
//      o saldo novo; duas transferencias do mesmo saldo nao passam juntas
//   8. lote de 300 itens com numero fixo de queries
//   9. GET lista saidas e entradas com itens
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
let contarQueries = null;

const dono = uuid();
const soOrigem = uuid();        // membro so da origem
const consultaNoDestino = uuid(); // membro das duas, "so consulta" no destino
const usuarios = [dono, soOrigem, consultaNoDestino];
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const empresas = [filial, deFora, matriz];

const ids = {};

const q = (sql, params) => pool.query(sql, params);
async function produto(companyId, nome, extra = {}) {
  const campos = { name: nome, price: 99.9, cost_price: 40, stock_qty: 10, ...extra };
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [companyId, ...Object.values(campos)]
  );
  return rows[0].id;
}
async function variante(pid, { stock = 5, sku = null, barcode = null, cor = null, tamanho = null } = {}) {
  const { rows } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, barcode) VALUES ($1, $2, $3, $4) RETURNING id`,
    [pid, sku, stock, barcode]
  );
  const vid = rows[0].id;
  if (cor) await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Cor', $2)`, [vid, cor]);
  if (tamanho) await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', $2)`, [vid, tamanho]);
  return vid;
}
const num = (v) => Number(v);
const estoque = async (pid) => num((await q(`SELECT stock_qty FROM products WHERE id=$1`, [pid])).rows[0].stock_qty);
const estoqueVar = async (vid) => num((await q(`SELECT stock_qty FROM product_variants WHERE id=$1`, [vid])).rows[0].stock_qty);
const transferir = (origem, body, user = dono) =>
  request(app).post(`/companies/${origem}/estoque/transferencias`).set('x-user', user).send(body);
const item = (product_id, quantidade, variant_id = null) => ({ product_id, variant_id, quantidade });

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return {
      query: (...a) => { if (contarQueries) contarQueries.n += 1; return c.query(...a); },
      release: (...a) => c.release(...a),
    };
  });

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Transferencia')`,
      [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Matriz Fixture', 'Loja Centro')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', 'Loja Shopping', $3)`,
    [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Fixture')`, [deFora, dono]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, 'vendedor', 'active', true)`, [matriz, soOrigem]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, 'vendedor', 'active', true)`, [matriz, consultaNoDestino]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, 'vendedor', 'active', true, $3)`,
    [filial, consultaNoDestino, JSON.stringify({ estoque_consulta: true })]);

  // categoria Roupas > Blusas na matriz
  const { rows: [roupas] } = await q(`INSERT INTO product_categories (company_id, type, name) VALUES ($1, 'product', 'Roupas') RETURNING id`, [matriz]);
  const { rows: [blusas] } = await q(`INSERT INTO product_categories (company_id, type, name, parent_id) VALUES ($1, 'product', 'Blusas', $2) RETURNING id`, [matriz, roupas.id]);

  ids.semGrade = await produto(matriz, 'Blusa lisa', {
    sku: 'BL-001', ncm: '61061000', brand: 'Marca X', category: 'Blusas', nota_fiscal: 'nfce', unit: 'un', stock_qty: 10,
  });
  await q(`INSERT INTO product_category_links (product_id, category_id, is_primary) VALUES ($1, $2, true)`, [ids.semGrade, blusas.id]);
  await q(`INSERT INTO product_images (company_id, product_id, url, position) VALUES ($1, $2, 'https://img.example.test/a.jpg', 0)`, [matriz, ids.semGrade]);

  ids.comGrade = await produto(matriz, 'Vestido', { sku: 'VS-001', stock_qty: 0 });
  ids.vPretoM = await variante(ids.comGrade, { stock: 5, sku: 'PRETO-M', cor: '#000000', tamanho: 'm' });
  ids.vPretoG = await variante(ids.comGrade, { stock: 4, sku: 'PRETO-G', cor: '#000000', tamanho: 'g' });

  ids.comCodigo = await produto(matriz, 'Calça', { barcode: '7891000000017', stock_qty: 5 });
  ids.calcaNaFilial = await produto(filial, 'Calça (cadastro da filial)', { barcode: '7891000000017', stock_qty: 1 });

  // grade ja cadastrada na filial com outro sku_suffix: acha pelos atributos
  ids.saiaMatriz = await produto(matriz, 'Saia', { sku: 'SA-001', stock_qty: 0 });
  ids.saiaAzulP = await variante(ids.saiaMatriz, { stock: 6, sku: 'AZUL-P', cor: '#3B82F6', tamanho: 'p' });
  ids.saiaFilial = await produto(filial, 'Saia', { sku: 'SA-001', stock_qty: 0 });
  ids.saiaFilialAzulP = await variante(ids.saiaFilial, { stock: 1, sku: 'AZ-P', cor: '#3b82f6', tamanho: 'P' });

  ids.disputado = await produto(matriz, 'Bolsa', { stock_qty: 5 });
  ids.comVenda = await produto(matriz, 'Cinto', { stock_qty: 5 });
  ids.deFora = await produto(deFora, 'De outra loja', { stock_qty: 5 });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  app.use('/companies/:id/estoque/transferencias', require('../src/routes/estoqueTransferencias'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE origem_company_id = ANY($1))`,
    `DELETE FROM stock_transfers WHERE origem_company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_category_links WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM product_categories WHERE company_id = ANY($1) AND parent_id IS NOT NULL`,
    `DELETE FROM product_categories WHERE company_id = ANY($1)`,
    `DELETE FROM company_members WHERE company_id = ANY($1)`,
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

describe('produto sem variante', () => {
  test('cria a copia no destino com o cadastro, estoque 0 + transferido e is_group_shared false', async () => {
    const res = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.semGrade, 3)], observacao: 'abertura' });
    expect(res.status).toBe(201);
    const t = res.body.transferencia;
    expect(t.numero).toBe(1);
    expect(t.origem_company_id).toBe(matriz);
    expect(t.destino_company_id).toBe(filial);
    expect(t.criada_por).toBe(dono);
    expect(t.itens).toHaveLength(1);
    const it = t.itens[0];
    expect(it).toMatchObject({ product_id: ids.semGrade, variant_id: null, destino_variant_id: null, quantidade: 3, criado_no_destino: true });
    ids.copiaSemGrade = it.destino_product_id;

    expect(await estoque(ids.semGrade)).toBe(7);
    const { rows: [copia] } = await q(`SELECT * FROM products WHERE id = $1`, [ids.copiaSemGrade]);
    expect(copia.company_id).toBe(filial);
    expect(num(copia.stock_qty)).toBe(3);
    expect(copia.is_group_shared).toBe(false);
    expect(copia).toMatchObject({ name: 'Blusa lisa', sku: 'BL-001', ncm: '61061000', brand: 'Marca X', category: 'Blusas', nota_fiscal: 'nfce', unit: 'un' });
    expect(num(copia.price)).toBe(99.9);
    expect(num(copia.cost_price)).toBe(40);

    // categoria criada no destino pelo nome, com a mesma arvore
    const { rows: cats } = await q(
      `SELECT c.name, p.name AS pai, l.is_primary FROM product_category_links l
         JOIN product_categories c ON c.id = l.category_id
         LEFT JOIN product_categories p ON p.id = c.parent_id
        WHERE l.product_id = $1`, [ids.copiaSemGrade]);
    expect(cats).toEqual([{ name: 'Blusas', pai: 'Roupas', is_primary: true }]);
    const { rows: [{ n: catsFilial }] } = await q(`SELECT COUNT(*)::int AS n FROM product_categories WHERE company_id = $1`, [filial]);
    expect(catsFilial).toBe(2);
    const { rows: fotos } = await q(`SELECT company_id, url FROM product_images WHERE product_id = $1`, [ids.copiaSemGrade]);
    expect(fotos).toEqual([{ company_id: filial, url: 'https://img.example.test/a.jpg' }]);
  });

  test('stock_movements: out na origem e in no destino, com a referencia da transferencia', async () => {
    const { rows } = await q(
      `SELECT company_id, product_id, type, quantity, reference_type, reference_id
         FROM stock_movements WHERE reference_type = 'stock_transfer' AND company_id = ANY($1)
        ORDER BY type DESC`, [[matriz, filial]]);
    expect(rows).toHaveLength(2);
    const [out, inn] = rows;
    expect(out).toMatchObject({ company_id: matriz, product_id: ids.semGrade, type: 'out' });
    expect(inn).toMatchObject({ company_id: filial, product_id: ids.copiaSemGrade, type: 'in' });
    expect(num(out.quantity)).toBe(3);
    expect(num(inn.quantity)).toBe(3);
    expect(out.reference_id).toBe(inn.reference_id);
  });

  test('segunda transferencia reaproveita o mesmo produto do destino', async () => {
    const res = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.semGrade, 2)] });
    expect(res.status).toBe(201);
    expect(res.body.transferencia.numero).toBe(2);
    expect(res.body.transferencia.itens[0]).toMatchObject({ destino_product_id: ids.copiaSemGrade, criado_no_destino: false });
    expect(await estoque(ids.copiaSemGrade)).toBe(5);
    expect(await estoque(ids.semGrade)).toBe(5);
    const { rows: [{ n }] } = await q(`SELECT COUNT(*)::int AS n FROM products WHERE company_id = $1 AND name = 'Blusa lisa'`, [filial]);
    expect(n).toBe(1);
  });

  test('a volta (filial -> matriz) cai no produto original', async () => {
    const res = await transferir(filial, { destino_company_id: matriz, itens: [item(ids.copiaSemGrade, 1)] });
    expect(res.status).toBe(201);
    expect(res.body.transferencia.numero).toBe(3); // sequencia do grupo
    expect(res.body.transferencia.itens[0]).toMatchObject({ destino_product_id: ids.semGrade, criado_no_destino: false });
    expect(await estoque(ids.semGrade)).toBe(6);
    expect(await estoque(ids.copiaSemGrade)).toBe(4);
  });
});

describe('produto com variante', () => {
  test('baixa na variante, cria a variante no destino com os atributos; o pai nao muda', async () => {
    const res = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.comGrade, 2, ids.vPretoM)] });
    expect(res.status).toBe(201);
    const it = res.body.transferencia.itens[0];
    expect(it.criado_no_destino).toBe(true);
    expect(it.variant_id).toBe(ids.vPretoM);
    ids.copiaGrade = it.destino_product_id;
    ids.copiaPretoM = it.destino_variant_id;

    expect(await estoqueVar(ids.vPretoM)).toBe(3);
    expect(await estoque(ids.comGrade)).toBe(0);
    expect(await estoque(ids.copiaGrade)).toBe(0);
    expect(await estoqueVar(ids.copiaPretoM)).toBe(2);
    const { rows: vals } = await q(
      `SELECT attribute_name, value FROM product_variant_values WHERE variant_id = $1 ORDER BY attribute_name`, [ids.copiaPretoM]);
    expect(vals).toEqual([{ attribute_name: 'Cor', value: '#000000' }, { attribute_name: 'Tamanho', value: 'm' }]);
    const { rows: [v] } = await q(`SELECT sku_suffix, is_active FROM product_variants WHERE id = $1`, [ids.copiaPretoM]);
    expect(v).toEqual({ sku_suffix: 'PRETO-M', is_active: true });

    const { rows: movs } = await q(
      `SELECT company_id, variant_id, type FROM stock_movements WHERE reference_id = $1 ORDER BY type DESC`, [res.body.transferencia.id]);
    expect(movs).toEqual([
      { company_id: matriz, variant_id: ids.vPretoM, type: 'out' },
      { company_id: filial, variant_id: ids.copiaPretoM, type: 'in' },
    ]);
  });

  test('outra variante do mesmo produto entra no mesmo produto do destino; a mesma variante reaproveita', async () => {
    const res = await transferir(matriz, {
      destino_company_id: filial,
      itens: [item(ids.comGrade, 1, ids.vPretoG), item(ids.comGrade, 1, ids.vPretoM)],
    });
    expect(res.status).toBe(201);
    const [g, m] = res.body.transferencia.itens;
    expect(g.destino_product_id).toBe(ids.copiaGrade);
    expect(g.criado_no_destino).toBe(true);
    expect(m).toMatchObject({ destino_product_id: ids.copiaGrade, destino_variant_id: ids.copiaPretoM, criado_no_destino: false });
    expect(await estoqueVar(ids.copiaPretoM)).toBe(3);
    expect(await estoqueVar(g.destino_variant_id)).toBe(1);
    const { rows: [{ n }] } = await q(`SELECT COUNT(*)::int AS n FROM product_variants WHERE product_id = $1`, [ids.copiaGrade]);
    expect(n).toBe(2);
  });

  test('produto com grade sem variant_id e recusado', async () => {
    const res = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.comGrade, 1)] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ITEM_NAO_ENCONTRADO');
    expect(res.body.itens[0].motivo).toBe('informe_a_variante');
  });
});

describe('match no destino', () => {
  test('codigo de barras igual: usa o produto que a filial ja tinha', async () => {
    const res = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.comCodigo, 2)] });
    expect(res.status).toBe(201);
    expect(res.body.transferencia.itens[0]).toMatchObject({ destino_product_id: ids.calcaNaFilial, criado_no_destino: false });
    expect(await estoque(ids.calcaNaFilial)).toBe(3);
    expect(await estoque(ids.comCodigo)).toBe(3);
  });

  test('SKU igual e variante achada pela cor + tamanho (sem diferenciar caixa)', async () => {
    const res = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.saiaMatriz, 2, ids.saiaAzulP)] });
    expect(res.status).toBe(201);
    expect(res.body.transferencia.itens[0]).toMatchObject({
      destino_product_id: ids.saiaFilial, destino_variant_id: ids.saiaFilialAzulP, criado_no_destino: false,
    });
    expect(await estoqueVar(ids.saiaFilialAzulP)).toBe(3);
  });
});

describe('recusas sem mudar nada', () => {
  test('estoque insuficiente: lista o disponivel e nao grava nada', async () => {
    const antes = {
      semGrade: await estoque(ids.semGrade),
      vPretoM: await estoqueVar(ids.vPretoM),
      copia: await estoque(ids.copiaSemGrade),
    };
    const { rows: [{ n: transfAntes }] } = await q(`SELECT COUNT(*)::int AS n FROM stock_transfers WHERE origem_company_id = $1`, [matriz]);
    const { rows: [{ n: movAntes }] } = await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE company_id = ANY($1)`, [[matriz, filial]]);

    const res = await transferir(matriz, {
      destino_company_id: filial,
      itens: [item(ids.semGrade, 1), item(ids.comGrade, 999, ids.vPretoM)],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ESTOQUE_INSUFICIENTE');
    expect(res.body.itens).toEqual([
      expect.objectContaining({ product_id: ids.comGrade, variant_id: ids.vPretoM, quantidade: 999, disponivel: antes.vPretoM }),
    ]);

    expect(await estoque(ids.semGrade)).toBe(antes.semGrade);
    expect(await estoqueVar(ids.vPretoM)).toBe(antes.vPretoM);
    expect(await estoque(ids.copiaSemGrade)).toBe(antes.copia);
    const { rows: [{ n: transfDepois }] } = await q(`SELECT COUNT(*)::int AS n FROM stock_transfers WHERE origem_company_id = $1`, [matriz]);
    const { rows: [{ n: movDepois }] } = await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE company_id = ANY($1)`, [[matriz, filial]]);
    expect(transfDepois).toBe(transfAntes);
    expect(movDepois).toBe(movAntes);
  });

  test('loja de fora do grupo e recusada', async () => {
    const res = await transferir(matriz, { destino_company_id: deFora, itens: [item(ids.semGrade, 1)] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NAO_E_DO_GRUPO');
    const res2 = await transferir(deFora, { destino_company_id: matriz, itens: [item(ids.deFora, 1)] });
    expect(res2.body.code).toBe('NAO_E_DO_GRUPO');
  });

  test('sem acesso ao destino (ou so consulta la) e recusado', async () => {
    const a = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.semGrade, 1)] }, soOrigem);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('NAO_E_DO_GRUPO');
    const b = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.semGrade, 1)] }, consultaNoDestino);
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('NAO_E_DO_GRUPO');
  });

  test('mesma loja, quantidade invalida e item de outra loja', async () => {
    const mesma = await transferir(matriz, { destino_company_id: matriz, itens: [item(ids.semGrade, 1)] });
    expect(mesma.body.code).toBe('MESMA_LOJA');
    const zero = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.semGrade, 0)] });
    expect(zero.body.code).toBe('QUANTIDADE_INVALIDA');
    const outra = await transferir(matriz, { destino_company_id: filial, itens: [item(ids.deFora, 1)] });
    expect(outra.status).toBe(404);
    expect(outra.body.code).toBe('ITEM_NAO_ENCONTRADO');
  });
});

describe('concorrencia', () => {
  test('venda segurando a linha: a transferencia espera e enxerga o saldo depois da venda', async () => {
    const venda = await pool.connect();
    try {
      await venda.query('BEGIN');
      await venda.query(`UPDATE products SET stock_qty = stock_qty - 3 WHERE id = $1`, [ids.comVenda]);
      const pendente = transferir(matriz, { destino_company_id: filial, itens: [item(ids.comVenda, 4)] }).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      await venda.query('COMMIT');
      const res = await pendente;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ESTOQUE_INSUFICIENTE');
      expect(res.body.itens[0].disponivel).toBe(2);
    } finally {
      venda.release();
    }
    expect(await estoque(ids.comVenda)).toBe(2);
  });

  test('duas transferencias do mesmo saldo ao mesmo tempo: so uma passa', async () => {
    const [a, b] = await Promise.all([
      transferir(matriz, { destino_company_id: filial, itens: [item(ids.disputado, 4)] }),
      transferir(matriz, { destino_company_id: filial, itens: [item(ids.disputado, 4)] }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await estoque(ids.disputado)).toBe(1);
    const { rows: [{ n }] } = await q(`SELECT COUNT(*)::int AS n FROM products WHERE company_id = $1 AND name = 'Bolsa'`, [filial]);
    expect(n).toBe(1);
  });
});

describe('lote grande', () => {
  test('300 itens numa chamada, com numero fixo de queries', async () => {
    const pids = [];
    for (let i = 0; i < 150; i += 1) {
      pids.push(await produto(matriz, `Lote ${i}`, { sku: `LOTE-${i}`, stock_qty: 3 }));
    }
    const comGrade = [];
    for (let i = 0; i < 75; i += 1) {
      const pid = await produto(matriz, `Lote grade ${i}`, { stock_qty: 0 });
      const v1 = await variante(pid, { stock: 2, sku: `A-${i}`, cor: '#111111', tamanho: 'p' });
      const v2 = await variante(pid, { stock: 2, sku: `B-${i}`, cor: '#111111', tamanho: 'm' });
      comGrade.push([pid, v1], [pid, v2]);
    }
    const itens = [...pids.map((p) => item(p, 1)), ...comGrade.map(([p, v]) => item(p, 1, v))];
    expect(itens).toHaveLength(300);

    contarQueries = { n: 0 };
    const t0 = Date.now();
    const res = await transferir(matriz, { destino_company_id: filial, itens });
    const ms = Date.now() - t0;
    const n = contarQueries.n;
    contarQueries = null;

    expect(res.status).toBe(201);
    expect(res.body.transferencia.itens).toHaveLength(300);
    expect(res.body.transferencia.itens.every((i) => i.criado_no_destino)).toBe(true);
    expect(n).toBeLessThan(40);
    expect(ms).toBeLessThan(15000);
    const { rows: [{ n: copias }] } = await q(`SELECT COUNT(*)::int AS n FROM products WHERE company_id = $1 AND name LIKE 'Lote %'`, [filial]);
    expect(copias).toBe(225);
  });
});

describe('GET', () => {
  test('lista as transferencias da loja, saidas e entradas, com os itens', async () => {
    const naMatriz = await request(app).get(`/companies/${matriz}/estoque/transferencias?limit=50`);
    expect(naMatriz.status).toBe(200);
    expect(naMatriz.body.total).toBeGreaterThanOrEqual(8);
    const volta = naMatriz.body.transferencias.find((t) => t.numero === 3);
    expect(volta.sentido).toBe('entrada');
    expect(volta.origem_nome).toBe('Loja Shopping');
    expect(volta.itens).toHaveLength(1);
    const primeira = naMatriz.body.transferencias.find((t) => t.numero === 1);
    expect(primeira).toMatchObject({ sentido: 'saida', observacao: 'abertura', destino_nome: 'Loja Shopping' });
    expect(primeira.itens[0]).toMatchObject({ product_id: ids.semGrade, nome: 'Blusa lisa', quantidade: 3, criado_no_destino: true });

    const naFilial = await request(app).get(`/companies/${filial}/estoque/transferencias?limit=2&offset=0`);
    expect(naFilial.body.transferencias).toHaveLength(2);
    expect(naFilial.body.total).toBe(naMatriz.body.total);

    const deFora_ = await request(app).get(`/companies/${deFora}/estoque/transferencias`);
    expect(deFora_.body).toEqual({ transferencias: [], total: 0, limit: 20, offset: 0 });
  });
});
