// ============================================================
// AURA. — Promocao em lote De/Por — Postgres real (p-84, 08/11/2026)
//
// Contra o schema das migrations (inclui a 427):
//   1. previa (padrao) nao grava nada
//   2. aplicar grava so promo_* (produto e variante com preco proprio);
//      preco normal, custo, estoque e codigo intactos; audit_log
//   3. agendada / em promocao / vencida no GET /products e nas variantes
//   4. variante com price_override, variante que herda do produto
//   5. grupo: compartilhado da filial vale para as duas lojas
//   6. abaixo do custo sai sozinho; "Incluir" grava
//   7. substituir (a previa avisa) e encerrar (previa e de verdade)
//   8. GET /promotions por status
//   9. perfil "Estoque so consulta": 403 (middleware do #942/#947)
//  10. loja sem promocao: GET /products e variantes iguais as de antes,
//      so com os campos novos (nulos, false e preco_efetivo = price)
//  11. as funcoes SQL da 427 concordam com o modulo JS
//
// Mesmo arreio do reajusteDePreco.banco.test.js: uma transacao revertida
// no afterAll; BEGIN/COMMIT/ROLLBACK da rota viram savepoints; fila unica.
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
let papel = { id: null };

const dono = uuid();
const funcionario = uuid();
const matriz = uuid();
const filial = uuid();
const outraLoja = uuid();
const url = (cid = matriz, resto = '') => `/companies/${cid}/products/promotions${resto}`;
const FIM = new Date(Date.now() + 7 * 864e5).toISOString();

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}
const q = (sql, params) => naFila(() => client.query(sql, params));

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  let qn = 0;
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
  db.query.mockImplementation((sql, params) => naFila(() => noSavepoint(sql, params)));
  let sp = 0;
  db.connect.mockImplementation(async () => {
    let liberar = null;
    const soltar = () => { if (liberar) { const l = liberar; liberar = null; l(); } };
    return {
      query: async (sql, params) => {
        const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
        if (s === 'BEGIN') {
          const antes = fila;
          fila = antes.then(() => new Promise((r) => { liberar = r; }));
          await antes;
          sp += 1;
          return client.query(`SAVEPOINT rota_${sp}`);
        }
        if (s === 'COMMIT') {
          try { return await client.query(`RELEASE SAVEPOINT rota_${sp}`); } finally { soltar(); }
        }
        if (s === 'ROLLBACK') {
          try { return await client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); } finally { soltar(); }
        }
        return client.query(sql, params);
      },
      release: soltar,
    };
  });

  // As migrations do repo nao criam products.color/size/ncm (vieram do
  // baseline de producao, fora do repo); o GET /products le as tres. So
  // dentro desta transacao, revertida no fim.
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT,
             ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS ncm TEXT`);
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES
             ($1, $2, 'x', 'Fixture Dono'), ($3, $4, 'x', 'Fixture Funcionario')`,
    [dono, `fixture-${dono}@example.test`, funcionario, `fixture-${funcionario}@example.test`]);
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES
       ($1, $4, 'Fixture Matriz LTDA', 'Matriz'),
       ($2, $4, 'Fixture Filial LTDA', 'Filial'),
       ($3, $4, 'Fixture Outra LTDA', 'Outra')`,
    [matriz, filial, outraLoja, dono]
  );
  await q(`UPDATE companies SET billing_owner_company_id = $1 WHERE id = $2`, [matriz, filial]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, permissions)
           VALUES ($1, $2, 'employee', '{"estoque": true, "estoque_consulta": true}'::jsonb)`, [matriz, funcionario]);

  const { estoqueSoConsulta } = require('../src/middleware/estoqueSoConsulta');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: papel.id || dono, role: 'client', plan: 'negocio' }; next(); });
  app.use('/companies/:id/products', estoqueSoConsulta);
  app.use('/companies/:id/products', require('../src/routes/productPromotions'));
  app.use('/companies/:id/products', require('../src/routes/products'));
});

afterAll(async () => {
  await fila;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

afterEach(() => { papel = { id: null }; });

async function produto(nome, { empresa = matriz, price = 100, cost = 50, shared = false, stock = 7 } = {}) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, sku, barcode, price, cost_price, is_group_shared, is_active, stock_qty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8) RETURNING id`,
    [empresa, nome, `SKU-${nome}`, `789${Math.floor(Math.random() * 1e9)}`, price, cost, shared, stock]
  );
  return rows[0].id;
}

async function variante(pid, { override = null, rotulo = 'G' } = {}) {
  const { rows: [v] } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty) VALUES ($1, $2, $3, 3) RETURNING id`,
    [pid, rotulo, override]
  );
  await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', $2)`, [v.id, rotulo]);
  return v.id;
}

async function linha(pid) {
  const { rows } = await q(
    `SELECT price, cost_price, stock_qty, sku, barcode, promo_price, promo_starts_at, promo_ends_at FROM products WHERE id = $1`, [pid]);
  return rows[0];
}

// Tudo roda numa transacao so (NOW() parado): acha a auditoria pelo item.
async function auditoriaDe(pid) {
  await fila;
  const { rows } = await q(
    `SELECT action, metadata FROM audit_log
      WHERE company_id = $1 AND action = 'products.promotion_applied' AND metadata::text LIKE $2`,
    [matriz, `%${pid}%`]);
  return rows;
}

async function listado(pid, cid = matriz) {
  const r = await request(app).get(`/companies/${cid}/products`).query({ search: '' });
  expect(r.status).toBe(200);
  return r.body.products.find((p) => p.id === pid);
}

test('loja sem promocao: GET /products e variantes iguais, so com os campos novos', async () => {
  const pid = await produto('Sem promo', { price: 59.9 });
  const vid = await variante(pid, { override: 64.9 });
  const p = await listado(pid);
  const ANTES = ['id', 'name', 'sku', 'barcode', 'category', 'description', 'price', 'cost_price', 'stock_qty',
    'min_stock', 'stock_max', 'unit', 'purchase_unit', 'purchase_factor', 'weight_kg', 'cest', 'origem',
    'icms_st_paid', 'card_price', 'color', 'size', 'image_url', 'ncm', 'brand', 'material', 'medidas', 'cuidados',
    'duration_minutes', 'is_active', 'is_group_shared', 'supplier_id', 'supplier', 'stock_company_id', 'created_at',
    'has_variants', 'variants_stock_total', 'variant_barcodes'];
  const NOVOS = ['promo_price', 'promo_starts_at', 'promo_ends_at', 'em_promocao', 'preco_efetivo'];
  expect(Object.keys(p).sort()).toEqual([...ANTES, ...NOVOS].sort());
  expect(p).toMatchObject({ price: 59.9, promo_price: null, promo_starts_at: null, promo_ends_at: null, em_promocao: false, preco_efetivo: 59.9 });

  const um = await request(app).get(`/companies/${matriz}/products/${pid}/variants`);
  expect(um.status).toBe(200);
  expect(Object.keys(um.body.variants[0]).sort()).toEqual(
    ['id', 'sku_suffix', 'price_override', 'stock_qty', 'barcode', 'color_name', 'attributes', ...NOVOS].sort());
  expect(um.body.variants[0]).toMatchObject({ id: vid, price_override: '64.90', em_promocao: false, preco_efetivo: 64.9, promo_price: null });

  const lote = await request(app).get(`/companies/${matriz}/products/variants`).query({ product_ids: pid });
  expect(Object.keys(lote.body.variants_by_product[pid][0]).sort()).toEqual(
    ['id', 'product_id', 'sku_suffix', 'price_override', 'stock_qty', 'barcode', 'color_name', 'attributes',
      'color', 'size', 'price', 'is_active', ...NOVOS].sort());
});

test('previa (padrao) nao grava nada', async () => {
  const pid = await produto('Previa');
  const r = await request(app).post(url()).send({ targets: [{ product_id: pid }], modo: 'percent', valor: 20, ends_at: FIM });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ dry_run: true, fora: [] });
  expect(r.body.items[0]).toMatchObject({ product_id: pid, variant_id: null, nome: 'Previa', preco_de: 100, preco_por: 80, ja_em_promocao: false, abaixo_do_custo: false });
  expect((await linha(pid)).promo_price).toBeNull();
});

test('aplicar: produto e variante com preco proprio; preco normal, custo, estoque e codigo intactos', async () => {
  const pid = await produto('Aplicar', { price: 189.9, cost: 92 });
  const comPreco = await variante(pid, { override: 199.9, rotulo: 'G' });
  const herda = await variante(pid, { rotulo: 'P' });
  const antes = await linha(pid);

  const r = await request(app).post(url()).send({
    targets: [{ product_id: pid }], modo: 'percent', valor: 20, terminacao: '90', ends_at: FIM, dry_run: false,
  });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ dry_run: false, aplicados: 2 });
  // 151,92 e 159,92 sobem para ,90 (igual ao Ajustar preco).
  expect(r.body.items.map((i) => [i.variant_id, i.preco_por])).toEqual([[null, 152.9], [comPreco, 160.9]]);

  const depois = await linha(pid);
  expect(Number(depois.promo_price)).toBe(152.9);
  expect(depois.price).toBe(antes.price);
  expect(depois.cost_price).toBe(antes.cost_price);
  expect(depois.stock_qty).toBe(antes.stock_qty);
  expect(depois.sku).toBe(antes.sku);
  expect(depois.barcode).toBe(antes.barcode);

  const p = await listado(pid);
  expect(p).toMatchObject({ price: 189.9, promo_price: 152.9, em_promocao: true, preco_efetivo: 152.9 });

  const um = await request(app).get(`/companies/${matriz}/products/${pid}/variants`);
  const porId = Object.fromEntries(um.body.variants.map((v) => [v.id, v]));
  expect(porId[comPreco]).toMatchObject({ em_promocao: true, preco_efetivo: 160.9, promo_price: 160.9 });
  // Sem preco proprio: segue o produto, inclusive a promocao.
  expect(porId[herda]).toMatchObject({ em_promocao: true, preco_efetivo: 152.9 });

  const [log] = await auditoriaDe(pid);
  expect(log.metadata).toMatchObject({ modo: 'percent', items_count: 2, substituidas_count: 0 });
});

test('agendada e vencida: campos vem, preco que vale e o normal', async () => {
  const agendado = await produto('Agendado');
  const inicio = new Date(Date.now() + 2 * 864e5).toISOString();
  const r = await request(app).post(url()).send({
    targets: [{ product_id: agendado }], modo: 'preco', valor: 79.9, starts_at: inicio, ends_at: FIM, dry_run: false,
  });
  expect(r.status).toBe(200);
  expect(await listado(agendado)).toMatchObject({ price: 100, promo_price: 79.9, em_promocao: false, preco_efetivo: 100 });

  const vencido = await produto('Vencido');
  await q(`UPDATE products SET promo_price = 70, promo_starts_at = NOW() - INTERVAL '5 days', promo_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [vencido]);
  expect(await listado(vencido)).toMatchObject({ price: 100, promo_price: 70, em_promocao: false, preco_efetivo: 100 });
});

test('alvo variante com price_override: so ela entra', async () => {
  const pid = await produto('Variante alvo');
  const vid = await variante(pid, { override: 120 });
  const r = await request(app).post(url()).send({
    targets: [{ product_id: pid, variant_id: vid }], modo: 'fixed', valor: 30, ends_at: FIM, dry_run: false,
  });
  expect(r.body.items.map((i) => [i.variant_id, i.preco_de, i.preco_por])).toEqual([[vid, 120, 90]]);
  expect((await linha(pid)).promo_price).toBeNull();
  const lote = await request(app).get(`/companies/${matriz}/products/variants`).query({ product_ids: pid });
  expect(lote.body.variants_by_product[pid][0]).toMatchObject({ id: vid, price: 120, em_promocao: true, preco_efetivo: 90 });
  expect(await listado(pid)).toMatchObject({ em_promocao: false, preco_efetivo: 100 });
});

test('grupo: compartilhado da filial vale nas duas lojas; outra loja e nao encontrado', async () => {
  const daFilial = await produto('Da filial', { empresa: filial, shared: true });
  const deOutra = await produto('De outra', { empresa: outraLoja });
  const r = await request(app).post(url()).send({
    targets: [{ product_id: daFilial }, { product_id: deOutra }], modo: 'percent', valor: 10, ends_at: FIM, dry_run: false,
  });
  expect(r.body.items[0]).toMatchObject({ product_id: daFilial, group_shared: true, owner_is_other: true, preco_por: 90 });
  expect(r.body.fora).toEqual([{ product_id: deOutra, variant_id: null, nome: null, motivo: 'nao_encontrado' }]);
  expect(await listado(daFilial, matriz)).toMatchObject({ em_promocao: true, preco_efetivo: 90 });
  expect(await listado(daFilial, filial)).toMatchObject({ em_promocao: true, preco_efetivo: 90 });
  expect((await linha(deOutra)).promo_price).toBeNull();
});

test('abaixo do custo sai sozinho; com aceitar_abaixo_do_custo grava', async () => {
  const pid = await produto('Abaixo', { price: 100, cost: 80 });
  const r = await request(app).post(url()).send({ targets: [{ product_id: pid }], modo: 'percent', valor: 30, ends_at: FIM, dry_run: false });
  expect(r.body.items).toEqual([]);
  expect(r.body.fora[0]).toMatchObject({ product_id: pid, motivo: 'abaixo_do_custo', preco_por: 70 });
  expect((await linha(pid)).promo_price).toBeNull();

  const r2 = await request(app).post(url()).send({
    targets: [{ product_id: pid, aceitar_abaixo_do_custo: true }], modo: 'percent', valor: 30, ends_at: FIM, dry_run: false,
  });
  expect(r2.body.items[0]).toMatchObject({ abaixo_do_custo: true, preco_por: 70 });
  expect(Number((await linha(pid)).promo_price)).toBe(70);
});

test('substituir: a previa avisa e a nova promocao vale; audit guarda a anterior', async () => {
  const pid = await produto('Substituir');
  await request(app).post(url()).send({ targets: [{ product_id: pid }], modo: 'preco', valor: 90, ends_at: FIM, dry_run: false });
  const previa = await request(app).post(url()).send({ targets: [{ product_id: pid }], modo: 'preco', valor: 75, ends_at: FIM });
  expect(previa.body.items[0]).toMatchObject({ ja_em_promocao: true, promo_atual: { preco: 90, status: 'ativa' }, preco_por: 75 });
  expect(Number((await linha(pid)).promo_price)).toBe(90);
  await request(app).post(url()).send({ targets: [{ product_id: pid }], modo: 'preco', valor: 75, ends_at: FIM, dry_run: false });
  expect(await listado(pid)).toMatchObject({ promo_price: 75, preco_efetivo: 75 });
  const logs = await auditoriaDe(pid);
  expect(logs.map((l) => l.metadata.substituidas_count).sort()).toEqual([0, 1]);
  expect(logs.find((l) => l.metadata.substituidas_count === 1).metadata.substituidas[0][2]).toBe(90);
});

test('encerrar: previa nao mexe; de verdade limpa produto e variantes', async () => {
  const pid = await produto('Encerrar');
  const vid = await variante(pid, { override: 130 });
  await request(app).post(url()).send({ targets: [{ product_id: pid }], modo: 'percent', valor: 10, ends_at: FIM, dry_run: false });
  const semPromo = await produto('Nunca teve');

  const previa = await request(app).post(url(matriz, '/encerrar')).send({ targets: [{ product_id: pid }, { product_id: semPromo }] });
  expect(previa.status).toBe(200);
  expect(previa.body).toMatchObject({ dry_run: true });
  expect(previa.body.items.map((i) => [i.variant_id, i.status])).toEqual([[null, 'ativa'], [vid, 'ativa']]);
  expect(previa.body.fora).toEqual([{ product_id: semPromo, variant_id: null, nome: 'Nunca teve', motivo: 'sem_promocao' }]);
  expect((await linha(pid)).promo_price).not.toBeNull();

  const r = await request(app).post(url(matriz, '/encerrar')).send({ targets: [{ product_id: pid }], dry_run: false });
  expect(r.body).toMatchObject({ dry_run: false, encerrados: 2 });
  const l = await linha(pid);
  expect([l.promo_price, l.promo_starts_at, l.promo_ends_at]).toEqual([null, null, null]);
  const { rows: [v] } = await q(`SELECT promo_price FROM product_variants WHERE id = $1`, [vid]);
  expect(v.promo_price).toBeNull();
  expect(await listado(pid)).toMatchObject({ em_promocao: false, preco_efetivo: 100 });
});

test('GET /promotions por status, com resumo', async () => {
  const ativa = await produto('Lista ativa');
  const agendada = await produto('Lista agendada');
  const vencida = await produto('Lista vencida');
  await request(app).post(url()).send({ targets: [{ product_id: ativa }], modo: 'preco', valor: 80, ends_at: FIM, dry_run: false });
  await request(app).post(url()).send({
    targets: [{ product_id: agendada }], modo: 'preco', valor: 80, starts_at: new Date(Date.now() + 864e5).toISOString(), ends_at: FIM, dry_run: false,
  });
  await q(`UPDATE products SET promo_price = 70, promo_starts_at = NOW() - INTERVAL '5 days', promo_ends_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [vencida]);

  const todas = await request(app).get(url());
  expect(todas.status).toBe(200);
  expect(todas.body.resumo.ativa).toBeGreaterThanOrEqual(1);
  const st = (body, pid) => (body.items.find((i) => i.product_id === pid && i.variant_id === null) || {}).status;
  expect(st(todas.body, ativa)).toBe('ativa');
  expect(st(todas.body, agendada)).toBe('agendada');
  expect(st(todas.body, vencida)).toBe('encerrada');

  const so = await request(app).get(url()).query({ status: 'agendada' });
  expect(so.body.items.every((i) => i.status === 'agendada')).toBe(true);
  expect(so.body.items.find((i) => i.product_id === agendada)).toMatchObject({ preco_de: 100, preco_por: 80, em_promocao: false });
  expect(so.body.total).toBe(so.body.resumo.agendada);
  expect((await request(app).get(url()).query({ status: 'x' })).status).toBe(400);
});

test('perfil "Estoque so consulta": 403 na previa, no aplicar, no encerrar e na lista', async () => {
  const pid = await produto('Consulta');
  papel = { id: funcionario };
  const corpo = { targets: [{ product_id: pid }], modo: 'percent', valor: 10, ends_at: FIM };
  for (const r of [
    await request(app).post(url()).send(corpo),
    await request(app).post(url()).send({ ...corpo, dry_run: false }),
    await request(app).post(url(matriz, '/encerrar')).send({ targets: [{ product_id: pid }] }),
    await request(app).get(url()),
  ]) {
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ESTOQUE_SO_CONSULTA');
  }
  // E o GET /products dele nao traz preco de promocao (nem preco).
  const lista = await request(app).get(`/companies/${matriz}/products`);
  expect(lista.status).toBe(200);
  const p = lista.body.products.find((x) => x.id === pid);
  expect(p.promo_price).toBeUndefined();
  expect(p.preco_efetivo).toBeUndefined();
  expect(p.price).toBeUndefined();
  expect((await linha(pid)).promo_price).toBeNull();
});

test('as funcoes SQL da 427 concordam com o modulo JS', async () => {
  const { camposDoProduto } = require('../src/services/precoEfetivo');
  const agora = new Date('2026-11-28T15:00:00Z');
  const casos = [
    [100, null, null, null],
    [100, 80, '2026-11-27T00:00:00Z', '2026-11-30T00:00:00Z'],
    [100, 80, '2026-11-29T00:00:00Z', '2026-11-30T00:00:00Z'],
    [100, 80, '2026-11-20T00:00:00Z', '2026-11-28T15:00:00Z'],
    [100, 80, '2026-11-28T15:00:00Z', '2026-11-30T00:00:00Z'],
    [70, 80, '2026-11-27T00:00:00Z', '2026-11-30T00:00:00Z'],
    [80, 80, '2026-11-27T00:00:00Z', '2026-11-30T00:00:00Z'],
  ];
  for (const [base, promo, ini, fim] of casos) {
    const { rows: [r] } = await q(
      `SELECT aura_em_promocao($1, $2, $3, $4, $5) AS em, aura_preco_efetivo($1, $2, $3, $4, $5) AS efetivo`,
      [base, promo, ini, fim, agora]
    );
    const js = camposDoProduto({ price: base, promo_price: promo, promo_starts_at: ini, promo_ends_at: fim }, agora);
    expect([r.em, Number(r.efetivo)]).toEqual([js.em_promocao, js.preco_efetivo]);
  }
});

test('trava do banco: promocao incoerente nao grava', async () => {
  const pid = await produto('Trava');
  await expect(q(`SAVEPOINT trava; UPDATE products SET promo_price = 10 WHERE id = '${pid}'`)).rejects.toThrow();
  await q('ROLLBACK TO SAVEPOINT trava');
  await q('SAVEPOINT trava2');
  await expect(q(`UPDATE products SET promo_price = 10, promo_starts_at = NOW(), promo_ends_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [pid])).rejects.toThrow();
  await q('ROLLBACK TO SAVEPOINT trava2');
});
