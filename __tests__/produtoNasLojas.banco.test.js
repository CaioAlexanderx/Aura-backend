// ============================================================
// AURA. — Em qual loja o produto entra (B1, 20/11/2026). Postgres real.
//
// O que este arquivo trava:
//   1. GET lojas-para-cadastro: lojas do grupo em que a pessoa mexe no
//      estoque, a ativa marcada, limite por loja; estoque unico (D12)
//   2. produto com grade: um produto privado por loja, mesmo codigo de
//      barras e mesmo master_sku, variantes com Cor/Tamanho (todas, mesmo
//      com 0), estoque so na variante, foto e categoria copiadas,
//      stock_movements de entrada so onde ha quantidade
//   3. repetir a chamada: ja_existia, sem produto novo nem estoque somado
//   4. D7: regime diferente nao leva o perfil tributario
//   5. D6: codigo de barras em outro produto: erro so daquela loja, a outra
//      loja e criada na mesma chamada
//   6. compartilhado recusado; funcionario "so consulta" na filial e loja
//      de fora do grupo viram SEM_ACESSO
//   7. a transferencia depois da copia acha o par (nao cria um terceiro)
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

const dono = uuid();
const consultaNaFilial = uuid();
const usuarios = [dono, consultaNaFilial];
const matriz = uuid();
const filial = uuid();
const filialMei = uuid();
const deFora = uuid();
const grupo2 = uuid();
const grupo2Filial = uuid();
const empresas = [filial, filialMei, deFora, grupo2Filial, matriz, grupo2];

const ids = {};
let colunasDeProduto = new Set();
let colunasDeEmpresa = new Set();

const q = (sql, params) => pool.query(sql, params);
async function produto(companyId, nome, extra = {}) {
  const campos = Object.fromEntries(Object.entries({ name: nome, price: 99.9, cost_price: 40, stock_qty: 0, ...extra })
    .filter(([k]) => colunasDeProduto.has(k)));
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [companyId, ...Object.values(campos)]
  );
  return rows[0].id;
}
async function variante(pid, { stock = 0, sku = null, barcode = null, cor = null, tamanho = null } = {}) {
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
const levar = (origem, pid, body, user = dono) =>
  request(app).post(`/companies/${origem}/products/${pid}/lojas`).set('x-user', user).send(body);
const doGrupo = (r, companyId) => r.body.resultados.find((x) => x.company_id === companyId);

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
  colunasDeEmpresa = new Set((await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'companies'`)).rows.map((c) => c.column_name));

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Lojas')`, [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime) VALUES ($1, $2, 'Matriz Fixture', 'Matriz', 'negocio', 'simples_nacional')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', 'Filial Centro', 'expansao', 'simples_nacional', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, tax_regime, billing_owner_company_id) VALUES ($1, $2, 'Filial MEI Fixture', 'Filial MEI', 'essencial', 'mei', $3)`, [filialMei, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Fixture')`, [deFora, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Grupo 2 Fixture')`, [grupo2, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Grupo 2 Filial', $3)`, [grupo2Filial, dono, grupo2]);
  if (colunasDeEmpresa.has('share_products_in_group')) {
    // grupo da matriz separou o estoque (o caso da decisao de 10/11); o grupo 2 nao
    await q(`UPDATE companies SET share_products_in_group = false WHERE id = $1`, [filial]);
  }
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, 'vendedor', 'active', true)`, [matriz, consultaNaFilial]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, 'vendedor', 'active', true, $3)`,
    [filial, consultaNaFilial, JSON.stringify({ estoque_consulta: true })]);

  const { rows: [roupas] } = await q(`INSERT INTO product_categories (company_id, type, name) VALUES ($1, 'product', 'Roupas') RETURNING id`, [matriz]);
  const { rows: [vestidos] } = await q(`INSERT INTO product_categories (company_id, type, name, parent_id) VALUES ($1, 'product', 'Vestidos', $2) RETURNING id`, [matriz, roupas.id]);

  ids.vestido = await produto(matriz, 'Vestido midi linho', {
    barcode: '7891234567895', sku: 'VM-001', ncm: '62044200', brand: 'Marca X', unit: 'un', stock_min: 3, tax_profile: 'simples_st',
  });
  await q(`INSERT INTO product_category_links (product_id, category_id, is_primary) VALUES ($1, $2, true)`, [ids.vestido, vestidos.id]);
  await q(`INSERT INTO product_images (company_id, product_id, url, position) VALUES ($1, $2, 'https://img.example.test/v.jpg', 0)`, [matriz, ids.vestido]);
  ids.vPretoP = await variante(ids.vestido, { stock: 2, sku: 'PRETO-P', barcode: '7891234567901', cor: '#000000', tamanho: 'p' });
  ids.vPretoM = await variante(ids.vestido, { stock: 3, sku: 'PRETO-M', barcode: '7891234567918', cor: '#000000', tamanho: 'm' });

  ids.blusa = await produto(matriz, 'Blusa canelada', { barcode: '7890000000028', sku: 'BL-002', stock_qty: 8 });
  ids.saia = await produto(matriz, 'Saia plissada', { barcode: '7890000000035', sku: 'SA-003', stock_qty: 6 });
  ids.saiaNaFilial = await produto(filial, 'Vestido linho bege', { barcode: '7890000000035', stock_qty: 1 });
  ids.compartilhado = await produto(matriz, 'Cinto', { barcode: '7890000000042', is_group_shared: true });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productsNasLojas'));
  app.use('/companies/:id/estoque/transferencias', require('../src/routes/estoqueTransferencias'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE origem_company_id = ANY($1))`,
    `DELETE FROM stock_transfers WHERE origem_company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_category_links WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM product_images WHERE company_id = ANY($1)`,
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

describe('GET lojas-para-cadastro', () => {
  test('dono: as tres lojas do grupo, a matriz ativa, limite por plano da loja', async () => {
    const res = await request(app).get(`/companies/${matriz}/products/lojas-para-cadastro`).set('x-user', dono);
    expect(res.status).toBe(200);
    expect(res.body.estoque_unico).toBe(colunasDeEmpresa.has('share_products_in_group') ? false : true);
    const porId = Object.fromEntries(res.body.lojas.map((l) => [l.company_id, l]));
    expect(Object.keys(porId).sort()).toEqual([matriz, filial, filialMei].sort());
    expect(res.body.lojas[0].company_id).toBe(matriz);
    expect(porId[matriz]).toMatchObject({ nome: 'Matriz', ativa: true, regime: 'simples_nacional', limite: { usados: 4, maximo: 7000 } });
    expect(porId[filial]).toMatchObject({ nome: 'Filial Centro', ativa: false, limite: { usados: 1, maximo: null } });
    expect(porId[filialMei]).toMatchObject({ regime: 'mei', limite: { usados: 0, maximo: 2000 } });
  });

  test('funcionario "so consulta" na filial nao a ve', async () => {
    const res = await request(app).get(`/companies/${matriz}/products/lojas-para-cadastro`).set('x-user', consultaNaFilial);
    expect(res.body.lojas.map((l) => l.company_id)).toEqual([matriz]);
  });

  test('D12: grupo que nao separou o estoque = estoque_unico', async () => {
    const res = await request(app).get(`/companies/${grupo2}/products/lojas-para-cadastro`).set('x-user', dono);
    expect(res.body.estoque_unico).toBe(true);
  });
});

describe('POST :pid/lojas', () => {
  test('produto com grade: um produto privado em cada loja, mesmo codigo e mesmo master_sku', async () => {
    const res = await levar(matriz, ids.vestido, {
      lojas: [
        { company_id: filial, variantes: [{ variant_id: ids.vPretoM, stock_qty: 2 }] },
        { company_id: filialMei, stock_qty: 0 },
      ],
    });
    expect(res.status).toBe(200);
    const { master_sku: masterSku } = res.body;
    expect(masterSku).toMatch(/^AURA-/);
    const { rows: [orig] } = await q(`SELECT * FROM products WHERE id = $1`, [ids.vestido]);
    expect(orig.master_sku).toBe(masterSku);

    const naFilial = doGrupo(res, filial);
    expect(naFilial).toMatchObject({ status: 'criado', nome: 'Filial Centro', stock_qty: 2, avisos: [] });
    ids.vestidoNaFilial = naFilial.product_id;
    const { rows: [copia] } = await q(`SELECT * FROM products WHERE id = $1`, [naFilial.product_id]);
    expect(copia.company_id).toBe(filial);
    expect(copia.is_group_shared).toBe(false);
    expect(copia.barcode).toBe('7891234567895');
    expect(copia.sku).toBe('VM-001');
    expect(copia.master_sku).toBe(masterSku);
    expect(copia.name).toBe('Vestido midi linho');
    expect(num(copia.price)).toBe(99.9);
    expect(num(copia.stock_qty)).toBe(0); // o estoque mora na variante
    for (const [k, v] of Object.entries({ ncm: '62044200', brand: 'Marca X', tax_profile: 'simples_st' })) {
      if (colunasDeProduto.has(k)) expect(copia[k]).toBe(v);
    }
    if (colunasDeProduto.has('stock_min')) expect(num(copia.stock_min)).toBe(3);

    const { rows: grade } = await q(
      `SELECT v.id, v.stock_qty, v.barcode, v.sku_suffix,
              (SELECT string_agg(attribute_name || '=' || value, ',' ORDER BY attribute_name) FROM product_variant_values WHERE variant_id = v.id) AS attrs
         FROM product_variants v WHERE v.product_id = $1 AND v.is_active = true ORDER BY v.sku_suffix`, [copia.id]);
    expect(grade.map((g) => [g.sku_suffix, num(g.stock_qty), g.barcode, g.attrs])).toEqual([
      ['PRETO-M', 2, '7891234567918', 'Cor=#000000,Tamanho=m'],
      ['PRETO-P', 0, '7891234567901', 'Cor=#000000,Tamanho=p'],
    ]);
    // a origem nao muda
    expect(num((await q(`SELECT stock_qty FROM product_variants WHERE id = $1`, [ids.vPretoM])).rows[0].stock_qty)).toBe(3);

    const { rows: fotos } = await q(`SELECT url FROM product_images WHERE product_id = $1`, [copia.id]);
    expect(fotos.map((f) => f.url)).toEqual(['https://img.example.test/v.jpg']);
    const { rows: cat } = await q(
      `SELECT c.name, p.name AS pai FROM product_category_links l JOIN product_categories c ON c.id = l.category_id
         LEFT JOIN product_categories p ON p.id = c.parent_id WHERE l.product_id = $1`, [copia.id]);
    expect(cat).toEqual([{ name: 'Vestidos', pai: 'Roupas' }]);

    const { rows: movs } = await q(
      `SELECT company_id, type, quantity, variant_id, reference_type, reference_id FROM stock_movements WHERE product_id = $1`, [copia.id]);
    expect(movs).toHaveLength(1);
    expect(movs[0]).toMatchObject({ company_id: filial, type: 'in', reference_type: 'cadastro_em_outra_loja', reference_id: ids.vestido });
    expect(num(movs[0].quantity)).toBe(2);
    expect(movs[0].variant_id).toBe(grade[0].id);

    // D7: a Filial MEI nao leva o perfil tributario do Simples
    const naMei = doGrupo(res, filialMei);
    expect(naMei.status).toBe('criado');
    expect(naMei.stock_qty).toBe(0);
    const { rows: [copiaMei] } = await q(`SELECT * FROM products WHERE id = $1`, [naMei.product_id]);
    expect(copiaMei.master_sku).toBe(masterSku);
    if (colunasDeProduto.has('tax_profile')) {
      expect(copiaMei.tax_profile).toBeNull();
      expect(naMei.avisos).toEqual(['fiscal_conferir']);
    }
    expect(num((await q(`SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = $1`, [naMei.product_id])).rows[0].n)).toBe(0);
  });

  test('repetir a chamada: ja_existia, sem produto novo nem estoque somado', async () => {
    const antes = num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = ANY($1)`, [[filial, filialMei]])).rows[0].n);
    const res = await levar(matriz, ids.vestido, { lojas: [{ company_id: filial, variantes: [{ variant_id: ids.vPretoM, stock_qty: 2 }] }, { company_id: filialMei }] });
    expect(res.status).toBe(200);
    expect(doGrupo(res, filial)).toMatchObject({ status: 'ja_existia', product_id: ids.vestidoNaFilial, stock_qty: 2 });
    expect(doGrupo(res, filialMei).status).toBe('ja_existia');
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = ANY($1)`, [[filial, filialMei]])).rows[0].n)).toBe(antes);
    expect(num((await q(`SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = $1`, [ids.vestidoNaFilial])).rows[0].n)).toBe(1);
  });

  test('produto sem grade: estoque no produto e movimento de entrada', async () => {
    const res = await levar(matriz, ids.blusa, { lojas: [{ company_id: filial, stock_qty: 5 }] });
    const r = doGrupo(res, filial);
    expect(r).toMatchObject({ status: 'criado', stock_qty: 5 });
    ids.blusaNaFilial = r.product_id;
    expect(num((await q(`SELECT stock_qty FROM products WHERE id = $1`, [r.product_id])).rows[0].stock_qty)).toBe(5);
    expect(num((await q(`SELECT stock_qty FROM products WHERE id = $1`, [ids.blusa])).rows[0].stock_qty)).toBe(8);
    const { rows: movs } = await q(`SELECT type, quantity, variant_id FROM stock_movements WHERE product_id = $1`, [r.product_id]);
    expect(movs).toEqual([{ type: 'in', quantity: expect.anything(), variant_id: null }]);
    expect(num(movs[0].quantity)).toBe(5);
  });

  test('D6: codigo de barras em outro produto da filial — so a filial falha', async () => {
    const res = await levar(matriz, ids.saia, { lojas: [{ company_id: filial, stock_qty: 1 }, { company_id: filialMei, stock_qty: 1 }] });
    expect(res.status).toBe(200);
    expect(doGrupo(res, filial)).toMatchObject({
      status: 'erro', product_id: null,
      erro: {
        code: 'BARCODE_EM_USO',
        message: 'O código 7890000000035 já está no produto "Vestido linho bege" desta loja.',
        produto_conflito: { id: ids.saiaNaFilial, name: 'Vestido linho bege' },
      },
    });
    expect(doGrupo(res, filialMei)).toMatchObject({ status: 'criado', stock_qty: 1 });
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = $1 AND barcode = '7890000000035'`, [filial])).rows[0].n)).toBe(1);
  });

  test('compartilhado: 409; consulta na filial e loja de fora: SEM_ACESSO', async () => {
    const shared = await levar(matriz, ids.compartilhado, { lojas: [{ company_id: filial }] });
    expect(shared.status).toBe(409);
    expect(shared.body.code).toBe('PRODUTO_COMPARTILHADO');

    const outro = await produto(matriz, 'Bolsa', { stock_qty: 1 });
    const res = await levar(matriz, outro, { lojas: [{ company_id: filial }, { company_id: deFora }] }, consultaNaFilial);
    expect(res.status).toBe(200);
    expect(doGrupo(res, filial).erro.code).toBe('SEM_ACESSO');
    expect(doGrupo(res, deFora).erro.code).toBe('SEM_ACESSO');
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = ANY($1) AND name = 'Bolsa'`, [[filial, deFora]])).rows[0].n)).toBe(0);
  });

  test('a transferencia depois da copia acha o par: soma no mesmo produto, nao cria outro', async () => {
    const res = await request(app).post(`/companies/${matriz}/estoque/transferencias`).set('x-user', dono)
      .send({ destino_company_id: filial, itens: [{ product_id: ids.blusa, quantidade: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.transferencia.itens[0]).toMatchObject({ destino_product_id: ids.blusaNaFilial, criado_no_destino: false });
    expect(num((await q(`SELECT stock_qty FROM products WHERE id = $1`, [ids.blusaNaFilial])).rows[0].stock_qty)).toBe(7);
  });
});
