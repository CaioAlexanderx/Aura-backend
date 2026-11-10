// ============================================================
// AURA. — Estoque por loja na visão consolidada — Postgres real
//
// O que este arquivo trava (GET /me/estoque/por-loja e /variantes):
//   1. agrupamento por barcode, por sku (com e sem barcode do outro lado)
//      e por nome normalizado (só quando não há código);
//   2. produto que só existe numa loja;
//   3. variantes: barcode e rótulo de atributos, e a que só existe numa loja;
//   4. produto compartilhado do grupo: estoque na dona, "compartilhado" na
//      outra, total sem contar duas vezes;
//   5. paginação (inclusive além do fim) e busca (nome e barcode de
//      variante) e categoria;
//   6. loja sem acesso (de outro dono) e loja onde o usuário é membro sem a
//      permissão de estoque não aparecem;
//   7. vínculo de transferência (stock_transfer_items, tabela de outra PR):
//      sem a tabela a lista sai; com ela, origem e destino viram um item.
//      A tabela entra como TEMP (pool de 1 conexão), então o teste vale
//      com ou sem a migration da transferência no banco de CI.
//
// Fixtures com uuid próprio, apagadas no afterAll.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.user || { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;
const svc = require('../src/services/estoquePorLoja');

const userId = uuid();
const outroDono = uuid();
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const semEstoque = uuid();
const empresas = [filial, matriz, deFora, semEstoque];
const sufixo = userId.slice(0, 8);
const B = (n) => `78${sufixo}${n}`; // barcode único por execução

const ids = {};

async function produto(companyId, nome, { stock = 0, barcode = null, sku = null, shared = false, category = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO products (company_id, name, price, cost_price, stock_qty, barcode, sku, is_group_shared, category)
     VALUES ($1, $2, 50, 20, $3, $4, $5, $6, $7) RETURNING id`,
    [companyId, nome, stock, barcode, sku, shared, category]
  );
  return rows[0].id;
}
async function variante(pid, { stock = 0, barcode = null, sku = null, cor = null, tamanho = null }) {
  const { rows } = await pool.query(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, barcode) VALUES ($1, $2, $3, $4) RETURNING id`,
    [pid, sku, stock, barcode]
  );
  const vid = rows[0].id;
  if (cor) await pool.query(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Cor', $2)`, [vid, cor]);
  if (tamanho) await pool.query(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', $2)`, [vid, tamanho]);
  return vid;
}

const lista = (qs = '') => request(app).get(`/me/estoque/por-loja${qs}`);
const porChave = (body, chave) => body.itens.find((i) => i.chave === chave);
const daLoja = (item, cid) => item.por_loja.filter((e) => e.company_id === cid);

beforeAll(async () => {
  // 1 conexão: a stock_transfer_items TEMP do bloco 7 precisa ser vista
  // por todas as queries da rota.
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 1 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  for (const [id, nome] of [[userId, 'Fixture Estoque Por Loja'], [outroDono, 'Fixture Outro Dono']]) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', $3)`,
      [id, `fixture-${id}@example.test`, nome]
    );
  }
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary) VALUES ($1, $2, 'Matriz Fixture', 'Matriz', true)`, [matriz, userId]);
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', 'Filial', $3)`,
    [filial, userId, matriz]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'De Fora Fixture')`, [deFora, outroDono]);
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Sem Estoque Fixture')`, [semEstoque, outroDono]);
  // Membro só do Caixa: entra no /me/* de vendas, mas não vê o Estoque.
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role_label, permissions, status, is_active)
     VALUES ($1, $2, 'vendedor', '{"pdv": true}'::jsonb, 'active', true)`,
    [semEstoque, userId]
  );

  // 1. barcode
  ids.m1 = await produto(matriz, 'Camiseta Básica', { stock: 12, barcode: B(1), category: 'Roupas' });
  ids.f1 = await produto(filial, 'Camiseta basica azul', { stock: 3, barcode: B(1) });
  // 1. sku (sem diferença de maiúscula)
  ids.m2 = await produto(matriz, 'Calça', { stock: 4, sku: `CAL-${sufixo}` });
  ids.f2 = await produto(filial, 'Calca', { stock: 1, sku: `cal-${sufixo}` });
  // 1. sku que aponta para um barcode só: o sem barcode entra no item do barcode
  ids.m3 = await produto(matriz, 'Tênis', { stock: 2, barcode: B(3), sku: `TEN-${sufixo}` });
  ids.f3 = await produto(filial, 'Tenis', { stock: 6, sku: `TEN-${sufixo}` });
  // 1. nome, sem código nenhum
  ids.m4 = await produto(matriz, 'Boné  Áspero', { stock: 1 });
  ids.f4 = await produto(filial, 'bone aspero', { stock: 2 });
  // 2. só numa loja
  ids.f5 = await produto(filial, 'Só da Filial', { stock: 9, barcode: B(5) });
  // 3. variantes (o estoque do pai fica nas variantes)
  ids.m6 = await produto(matriz, 'Vestido', { barcode: B(6) });
  ids.f6 = await produto(filial, 'Vestido', { barcode: B(6) });
  ids.vm6a = await variante(ids.m6, { stock: 2, barcode: B(61), sku: 'AZUL-M', cor: 'Azul (#0000FF)', tamanho: 'M' });
  ids.vm6b = await variante(ids.m6, { stock: 1, sku: 'PRETO-M', cor: 'Preto (#000000)', tamanho: 'M' });
  ids.vf6a = await variante(ids.f6, { stock: 4, barcode: B(61), sku: 'AZUL-M', cor: 'Azul (#0000FF)', tamanho: 'M' });
  ids.vf6b = await variante(ids.f6, { stock: 0, cor: '#000000', tamanho: 'm' });
  ids.vf6c = await variante(ids.f6, { stock: 5, sku: 'VERDE-G', cor: 'Verde (#00FF00)', tamanho: 'G' });
  // 4. compartilhado do grupo
  ids.m7 = await produto(matriz, 'Compartilhado', { stock: 7, barcode: B(7), shared: true });
  // 6. lojas sem acesso: mesmo barcode do item 1, não podem aparecer
  ids.x1 = await produto(deFora, 'Camiseta de fora', { stock: 100, barcode: B(1) });
  ids.s1 = await produto(semEstoque, 'Camiseta do caixa', { stock: 50, barcode: B(1) });
  // 7. transferência: códigos diferentes, só o vínculo junta
  ids.m9 = await produto(matriz, 'Bolsa origem', { stock: 3, barcode: B(9) });
  ids.f9 = await produto(filial, 'Bolsa transferida', { stock: 1, barcode: B(10) });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/me', require('../src/routes/meEstoquePorLoja'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM product_variant_values WHERE variant_id IN (SELECT pv.id FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE p.company_id = ANY($1))`,
    `DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM company_members WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await pool.query(sql, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  }
  for (const id of empresas) {
    try { await pool.query(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[userId, outroDono]]); } catch (e) { /* idem */ }
  await pool.end();
});

describe('sem o vínculo de transferência', () => {
  beforeAll(() => svc._resetMemo());

  test('lojas: só Matriz e Filial (principal primeiro); de fora e sem permissão ficam fora', async () => {
    const res = await lista('?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.lojas).toEqual([{ id: matriz, nome: 'Matriz' }, { id: filial, nome: 'Filial' }]);
    const todasAsLojas = res.body.itens.flatMap((i) => i.por_loja.map((e) => e.company_id));
    expect(todasAsLojas).not.toContain(deFora);
    expect(todasAsLojas).not.toContain(semEstoque);
  });

  test('barcode igual: uma linha, estoque de cada loja e total', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `barcode:${B(1)}`);
    expect(item.nome).toBe('Camiseta Básica');
    expect(item.por_loja).toEqual([
      { company_id: matriz, product_id: ids.m1, estoque: 12, compartilhado: false },
      { company_id: filial, product_id: ids.f1, estoque: 3, compartilhado: false },
    ]);
    expect(item.total).toBe(15);
    expect(item.tem_variantes).toBe(false);
  });

  test('sku igual (maiúscula não importa)', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `sku:CAL-${sufixo.toUpperCase()}`);
    expect(item.por_loja.map((e) => [e.product_id, e.estoque])).toEqual([[ids.m2, 4], [ids.f2, 1]]);
    expect(item.total).toBe(5);
  });

  test('sku que aponta para um barcode só junta o produto sem barcode', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `barcode:${B(3)}`);
    expect(item.por_loja.map((e) => e.product_id)).toEqual([ids.m3, ids.f3]);
    expect(item.total).toBe(8);
  });

  test('nome normalizado, sem código nenhum', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, 'nome:bone aspero');
    expect(item.por_loja.map((e) => e.product_id)).toEqual([ids.m4, ids.f4]);
    expect(item.total).toBe(3);
  });

  test('produto que só existe numa loja', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `barcode:${B(5)}`);
    expect(item.por_loja).toEqual([{ company_id: filial, product_id: ids.f5, estoque: 9, compartilhado: false }]);
    expect(item.total).toBe(9);
  });

  test('compartilhado: estoque na dona, "compartilhado" na outra, sem contar duas vezes', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `barcode:${B(7)}`);
    expect(item.por_loja).toEqual([
      { company_id: matriz, product_id: ids.m7, estoque: 7, compartilhado: false },
      { company_id: filial, product_id: ids.m7, estoque: null, compartilhado: true, dona_company_id: matriz },
    ]);
    expect(item.total).toBe(7);
  });

  test('sem vínculo, produtos de códigos diferentes ficam em linhas separadas', async () => {
    const { body } = await lista('?limit=200');
    expect(porChave(body, `barcode:${B(9)}`).por_loja).toHaveLength(1);
    expect(porChave(body, `barcode:${B(10)}`).por_loja).toHaveLength(1);
    expect(body.total_itens).toBe(9);
  });

  test('variantes: soma no item e casam por barcode e rótulo', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `barcode:${B(6)}`);
    expect(item.tem_variantes).toBe(true);
    expect(daLoja(item, matriz)[0].estoque).toBe(3);
    expect(daLoja(item, filial)[0].estoque).toBe(9);
    expect(item.total).toBe(12);

    const res = await request(app).get(`/me/estoque/por-loja/variantes?chave=${encodeURIComponent(item.chave)}`);
    expect(res.status).toBe(200);
    expect(res.body.lojas.map((l) => l.id)).toEqual([matriz, filial]);
    const v = Object.fromEntries(res.body.variantes.map((x) => [x.rotulo, x]));
    expect(Object.keys(v).sort()).toEqual(['Azul / M', 'Preto / M', 'Verde / G']);
    expect(v['Azul / M'].por_loja.map((e) => [e.variant_id, e.estoque])).toEqual([[ids.vm6a, 2], [ids.vf6a, 4]]);
    expect(v['Azul / M'].barcode).toBe(B(61));
    expect(v['Azul / M'].total).toBe(6);
    expect(v['Preto / M'].por_loja.map((e) => [e.variant_id, e.estoque])).toEqual([[ids.vm6b, 1], [ids.vf6b, 0]]);
    expect(v['Verde / G'].por_loja).toEqual([{ company_id: filial, variant_id: ids.vf6c, estoque: 5, compartilhado: false }]);
  });

  test('variantes de chave que não existe: 404', async () => {
    const res = await request(app).get('/me/estoque/por-loja/variantes?chave=barcode:nao-existe');
    expect(res.status).toBe(404);
  });

  test('paginação: páginas sem repetir e total_itens estável, inclusive além do fim', async () => {
    const p1 = (await lista('?limit=4&offset=0')).body;
    const p2 = (await lista('?limit=4&offset=4')).body;
    const p3 = (await lista('?limit=4&offset=8')).body;
    const fim = (await lista('?limit=4&offset=100')).body;
    expect(p1.itens).toHaveLength(4);
    expect(p2.itens).toHaveLength(4);
    expect(p3.itens).toHaveLength(1);
    const chaves = [...p1.itens, ...p2.itens, ...p3.itens].map((i) => i.chave);
    expect(new Set(chaves).size).toBe(9);
    expect([p1, p2, p3, fim].map((p) => p.total_itens)).toEqual([9, 9, 9, 9]);
    expect(fim.itens).toEqual([]);
    // ordem pelo nome
    expect(p1.itens[0].nome).toBe('Bolsa origem');
  });

  test('busca: pelo nome e pelo barcode de uma variante; item volta com todas as lojas', async () => {
    const porNome = (await lista('?q=calc')).body;
    expect(porNome.itens.map((i) => i.chave)).toEqual([`sku:CAL-${sufixo.toUpperCase()}`]);
    expect(porNome.itens[0].por_loja).toHaveLength(2);

    const porVariante = (await lista(`?q=${B(61)}`)).body;
    expect(porVariante.itens.map((i) => i.chave)).toEqual([`barcode:${B(6)}`]);
    expect(porVariante.total_itens).toBe(1);
  });

  test('categoria', async () => {
    const { body } = await lista('?categoria=Roupas');
    expect(body.itens.map((i) => i.chave)).toEqual([`barcode:${B(1)}`]);
    expect(body.itens[0].total).toBe(15);
  });
});

describe('com o vínculo de transferência (stock_transfer_items)', () => {
  beforeAll(async () => {
    await pool.query(
      `CREATE TEMP TABLE stock_transfer_items (
         ${svc.VINCULO.produtoOrigem} uuid, ${svc.VINCULO.produtoDestino} uuid,
         ${svc.VINCULO.varianteOrigem} uuid, ${svc.VINCULO.varianteDestino} uuid)`
    );
    await pool.query(
      `INSERT INTO stock_transfer_items (${svc.VINCULO.produtoOrigem}, ${svc.VINCULO.produtoDestino}) VALUES ($1, $2)`,
      [ids.m9, ids.f9]
    );
    svc._resetMemo();
  });
  afterAll(async () => {
    try { await pool.query('DROP TABLE IF EXISTS pg_temp.stock_transfer_items'); } catch (e) { /* idem */ }
  });

  test('origem e destino viram um item, com a chave da origem', async () => {
    const { body } = await lista('?limit=200');
    const item = porChave(body, `barcode:${B(9)}`);
    expect(item.por_loja.map((e) => [e.company_id, e.product_id, e.estoque])).toEqual([
      [matriz, ids.m9, 3], [filial, ids.f9, 1],
    ]);
    expect(item.total).toBe(4);
    expect(porChave(body, `barcode:${B(10)}`)).toBeUndefined();
    expect(body.total_itens).toBe(8);
  });
});
