// ============================================================
// AURA. — Conferencia de estoque (card p-108, migration 446)
// Postgres real.
//
// O que este arquivo trava:
//   1. snapshot so no primeiro bipe; venda feita DEPOIS do bipe (sem
//      stock_movements, como o Caixa) fica mantida ao aplicar
//   2. piso 0: o ajuste nunca deixa estoque negativo e grava o efetivo
//   3. nao contado so vai a 0 com "zerar nao contados"
//   4. variante: ajuste na variante, pai intocado; lancamento 'adjustment'
//   5. as cegas: GET em rascunho sem estoque; com as_cegas false, com
//   6. desfazer: inverso do aplicado sobre o estoque atual, uma vez so,
//      so dentro de 7 dias
//   7. 409 fora de rascunho; clique duplo no aplicar aplica uma vez
//   8. grupo compartilhado: so na loja dona; produto de outra loja 409
//   9. permissoes: consulta conta mas nao aplica (403) e nao ve custo;
//      estoque desligado leva 403
//  10. escopo por categoria (com subcategoria) e "com estoque"
//  11. transferencia com stock_count_id (da origem) e sem o campo
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
const consulta = uuid();      // membro "estoque so consulta" na matriz
const semEstoque = uuid();    // membro com estoque desligado na matriz
const usuarios = [dono, consulta, semEstoque];
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const empresas = [filial, deFora, matriz];
const ids = {};

const q = (sql, params) => pool.query(sql, params);
let colunasDeProduto = new Set();
async function produto(companyId, nome, extra = {}) {
  const campos = Object.fromEntries(Object.entries({ name: nome, price: 50, cost_price: 20, stock_qty: 10, ...extra })
    .filter(([k]) => colunasDeProduto.has(k)));
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [companyId, ...Object.values(campos)]
  );
  return rows[0].id;
}
async function variante(pid, stock, sku) {
  const { rows } = await q(`INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, $2, $3) RETURNING id`, [pid, sku, stock]);
  return rows[0].id;
}
const num = (v) => Number(v);
const estoque = async (pid) => num((await q(`SELECT stock_qty FROM products WHERE id=$1`, [pid])).rows[0].stock_qty);
const estoqueVar = async (vid) => num((await q(`SELECT stock_qty FROM product_variants WHERE id=$1`, [vid])).rows[0].stock_qty);
const base = (loja) => `/companies/${loja}/estoque/conferencias`;
const http = (user = dono) => ({
  post: (url, body = {}) => request(app).post(url).set('x-user', user).send(body),
  put: (url, body) => request(app).put(url).set('x-user', user).send(body),
  get: (url) => request(app).get(url).set('x-user', user),
  del: (url) => request(app).delete(url).set('x-user', user),
});
async function nova(loja = matriz, body = { escopo: { tipo: 'loja_toda' } }, user = dono) {
  const r = await http(user).post(base(loja), body);
  expect(r.status).toBe(201);
  return r.body.conferencia;
}
const bipar = (loja, countId, body, user = dono) => http(user).put(`${base(loja)}/${countId}/itens`, body);

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

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Conferencia')`, [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Matriz Fixture', 'Loja Centro')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', 'Loja Shopping', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Fixture')`, [deFora, dono]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, 'vendedor', 'active', true, $3)`,
    [matriz, consulta, JSON.stringify({ estoque_consulta: true, painel: false })]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, 'caixa', 'active', true, $3)`,
    [matriz, semEstoque, JSON.stringify({ estoque: false, pdv: true })]);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  app.use('/companies/:id/estoque/conferencias', require('../src/routes/estoqueConferencias'));
  app.use('/companies/:id/estoque/transferencias', require('../src/routes/estoqueTransferencias'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE origem_company_id = ANY($1))`,
    `DELETE FROM stock_transfers WHERE origem_company_id = ANY($1)`,
    `DELETE FROM stock_counts WHERE company_id = ANY($1)`,
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

describe('regra do ajuste', () => {
  test('snapshot no primeiro bipe; venda depois do bipe fica mantida; numero sequencial', async () => {
    ids.camisa = await produto(matriz, 'Camisa', { stock_qty: 10, cost_price: 25 });
    const c1 = await nova();
    const c2 = await nova();
    expect(c2.numero).toBe(c1.numero + 1);
    expect(c1.status).toBe('rascunho');
    expect(c1.as_cegas).toBe(true);

    let r = await bipar(matriz, c1.id, { product_id: ids.camisa, quantidade: 1, modo: 'somar' });
    expect(r.status).toBe(200);
    expect(r.body.primeiro_registro).toBe(true);
    expect(r.body.item.contado).toBe(1);
    expect(r.body.item).not.toHaveProperty('estoque_no_bipe');
    await bipar(matriz, c1.id, { product_id: ids.camisa, quantidade: 1, modo: 'somar' });

    // venda no Caixa depois do bipe: baixa sem stock_movements
    await q(`UPDATE products SET stock_qty = 8 WHERE id = $1`, [ids.camisa]);
    r = await bipar(matriz, c1.id, { product_id: ids.camisa, quantidade: 1, modo: 'somar' });
    expect(r.body.primeiro_registro).toBe(false);
    expect(r.body.item.contado).toBe(3);
    const { rows: [it] } = await q(`SELECT contado, estoque_no_bipe, custo_no_bipe FROM stock_count_items WHERE stock_count_id = $1`, [c1.id]);
    expect(num(it.estoque_no_bipe)).toBe(10); // o snapshot nao mudou
    expect(num(it.custo_no_bipe)).toBe(25);

    const d = await http().get(`${base(matriz)}/${c1.id}/diferencas`);
    expect(d.status).toBe(200);
    const linha = d.body.itens.find((x) => x.product_id === ids.camisa);
    expect(linha).toMatchObject({ contado: 3, estoque_no_bipe: 10, estoque_atual: 8, diferenca: -7, estoque_depois: 1, custo: 25, valor: -175, grupo: 'faltam' });

    const a = await http().post(`${base(matriz)}/${c1.id}/aplicar`, {});
    expect(a.status).toBe(200);
    expect(a.body.conferencia.status).toBe('aplicada');
    expect(a.body.conferencia.pode_desfazer).toBe(true);
    expect(await estoque(ids.camisa)).toBe(1); // 8 + (3 - 10): as 2 vendidas ficam vendidas
    const { rows: mov } = await q(
      `SELECT type, quantity, reference_type, reference_id, unit_cost, notes, variant_id FROM stock_movements WHERE product_id = $1`, [ids.camisa]);
    expect(mov).toHaveLength(1);
    expect(mov[0]).toMatchObject({ type: 'adjustment', reference_type: 'stock_count', reference_id: c1.id, variant_id: null });
    expect(num(mov[0].quantity)).toBe(7);
    expect(num(mov[0].unit_cost)).toBe(25);
    expect(mov[0].notes).toBe(`Conferência nº ${c1.numero}`);
    const { rows: [depois] } = await q(`SELECT diferenca_aplicada FROM stock_count_items WHERE stock_count_id = $1`, [c1.id]);
    expect(num(depois.diferenca_aplicada)).toBe(-7);
    ids.c1 = c1.id;
    await http().del(`${base(matriz)}/${c2.id}`);
  });

  test('piso 0: o estoque nao fica negativo e grava o efetivo', async () => {
    const pid = await produto(matriz, 'Bermuda', { stock_qty: 5 });
    const c = await nova();
    await bipar(matriz, c.id, { product_id: pid, quantidade: 0, modo: 'definir' });
    await q(`UPDATE products SET stock_qty = 2 WHERE id = $1`, [pid]); // vendeu 3 depois
    const a = await http().post(`${base(matriz)}/${c.id}/aplicar`, { motivo: 'Inventário do mês' });
    expect(a.status).toBe(200);
    expect(await estoque(pid)).toBe(0); // GREATEST(0, 2 - 5)
    const { rows: [it] } = await q(`SELECT diferenca_aplicada FROM stock_count_items WHERE stock_count_id = $1`, [c.id]);
    expect(num(it.diferenca_aplicada)).toBe(-2);
    const { rows: [m] } = await q(`SELECT quantity, notes FROM stock_movements WHERE product_id = $1`, [pid]);
    expect(num(m.quantity)).toBe(2);
    expect(m.notes).toBe(`Conferência nº ${c.numero} · Inventário do mês`);
  });

  test('nao contado: fica como esta, so zera com a escolha', async () => {
    const contada = await produto(matriz, 'Meia', { stock_qty: 3 });
    const esquecida = await produto(matriz, 'Cinto', { stock_qty: 4 });
    const zerada = await produto(matriz, 'Bone', { stock_qty: 0 });

    const sem = await nova();
    await bipar(matriz, sem.id, { product_id: contada, quantidade: 3, modo: 'definir' });
    const d = await http().get(`${base(matriz)}/${sem.id}/diferencas`);
    expect(d.body.nao_contados.map((x) => x.product_id)).toContain(esquecida);
    expect(d.body.nao_contados.map((x) => x.product_id)).not.toContain(zerada); // estoque 0 nao muda nada
    await http().post(`${base(matriz)}/${sem.id}/aplicar`, {});
    expect(await estoque(esquecida)).toBe(4);

    const com = await nova();
    await bipar(matriz, com.id, { product_id: contada, quantidade: 3, modo: 'definir' });
    const a = await http().post(`${base(matriz)}/${com.id}/aplicar`, { zerar_nao_contados: true });
    expect(a.status).toBe(200);
    expect(a.body.conferencia.zerou_nao_contados).toBe(true);
    expect(await estoque(esquecida)).toBe(0);
    expect(await estoque(contada)).toBe(3);
    const { rows: [nc] } = await q(
      `SELECT nao_contado, contado, estoque_no_bipe, diferenca_aplicada FROM stock_count_items WHERE stock_count_id = $1 AND product_id = $2`, [com.id, esquecida]);
    expect(nc.nao_contado).toBe(true);
    expect(num(nc.diferenca_aplicada)).toBe(-4);
    ids.zerou = com.id;
    ids.esquecida = esquecida;
  });

  test('variante: ajusta a variante e o pai nao muda', async () => {
    const pid = await produto(matriz, 'Vestido', { stock_qty: 0 });
    const vm = await variante(pid, 5, 'PRETO-M');
    await variante(pid, 2, 'PRETO-G');
    const c = await nova();
    const sem = await bipar(matriz, c.id, { product_id: pid, quantidade: 1 });
    expect(sem.status).toBe(400);
    expect(sem.body.code).toBe('INFORME_A_VARIANTE');
    const r = await bipar(matriz, c.id, { product_id: pid, variant_id: vm, quantidade: 7, modo: 'definir' });
    expect(r.status).toBe(200);
    expect(r.body.item.variante).toBe('PRETO-M');
    await http().post(`${base(matriz)}/${c.id}/aplicar`, {});
    expect(await estoqueVar(vm)).toBe(7);
    expect(await estoque(pid)).toBe(0);
    const { rows: [m] } = await q(`SELECT type, quantity, variant_id FROM stock_movements WHERE product_id = $1`, [pid]);
    expect(m).toMatchObject({ type: 'adjustment', variant_id: vm });
    expect(num(m.quantity)).toBe(2);
  });
});

describe('as cegas', () => {
  test('GET em rascunho nao devolve estoque; sem as cegas devolve', async () => {
    const pid = await produto(matriz, 'Saia', { stock_qty: 6 });
    const cega = await nova();
    await bipar(matriz, cega.id, { product_id: pid, quantidade: 2, modo: 'definir' });
    const g = await http().get(`${base(matriz)}/${cega.id}`);
    expect(g.status).toBe(200);
    expect(g.body.itens[0]).not.toHaveProperty('estoque_no_bipe');
    expect(g.body.itens[0]).not.toHaveProperty('estoque_atual');
    expect(JSON.stringify(g.body.itens)).not.toMatch(/estoque/);
    const lista = await http().get(base(matriz));
    const naLista = lista.body.find((x) => x.id === cega.id);
    expect(naLista.itens_contados).toBe(1);
    expect(naLista.faltam).toBeNull();
    expect(naLista.valor_faltam).toBeNull();

    const aberta = await nova(matriz, { escopo: { tipo: 'loja_toda' }, as_cegas: false });
    await bipar(matriz, aberta.id, { product_id: pid, quantidade: 2, modo: 'definir' });
    const g2 = await http().get(`${base(matriz)}/${aberta.id}`);
    expect(g2.body.itens[0]).toMatchObject({ estoque_no_bipe: 6, estoque_atual: 6, contado: 2 });
    await http().del(`${base(matriz)}/${cega.id}`);
    await http().del(`${base(matriz)}/${aberta.id}`);
  });
});

describe('fora de rascunho e clique duplo', () => {
  test('PUT, DELETE item e aplicar de novo: 409', async () => {
    const pid = await produto(matriz, 'Jaqueta', { stock_qty: 1 });
    const put = await bipar(matriz, ids.c1, { product_id: pid, quantidade: 1 });
    expect(put.status).toBe(409);
    expect(put.body.code).toBe('CONFERENCIA_FECHADA');
    const { rows: [it] } = await q(`SELECT id FROM stock_count_items WHERE stock_count_id = $1 LIMIT 1`, [ids.c1]);
    const del = await http().del(`${base(matriz)}/${ids.c1}/itens/${it.id}`);
    expect(del.status).toBe(409);
    const ap = await http().post(`${base(matriz)}/${ids.c1}/aplicar`, {});
    expect(ap.status).toBe(409);
    expect(ap.body.code).toBe('JA_APLICADA');
    const desc = await http().del(`${base(matriz)}/${ids.c1}`);
    expect(desc.status).toBe(409);
  });

  test('dois cliques juntos aplicam uma vez', async () => {
    const pid = await produto(matriz, 'Colete', { stock_qty: 10 });
    const c = await nova();
    await bipar(matriz, c.id, { product_id: pid, quantidade: 4, modo: 'definir' });
    const [a, b] = await Promise.all([
      http().post(`${base(matriz)}/${c.id}/aplicar`, {}),
      http().post(`${base(matriz)}/${c.id}/aplicar`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await estoque(pid)).toBe(4);
    const { rows } = await q(`SELECT 1 FROM stock_movements WHERE product_id = $1`, [pid]);
    expect(rows).toHaveLength(1);
  });

  test('remover item e descartar rascunho', async () => {
    const pid = await produto(matriz, 'Lenço', { stock_qty: 1 });
    const c = await nova();
    const r = await bipar(matriz, c.id, { product_id: pid, quantidade: 1 });
    const del = await http().del(`${base(matriz)}/${c.id}/itens/${r.body.item.id}`);
    expect(del.status).toBe(200);
    expect((await http().get(`${base(matriz)}/${c.id}`)).body.itens).toHaveLength(0);
    const desc = await http().del(`${base(matriz)}/${c.id}`);
    expect(desc.status).toBe(200);
    expect(desc.body.conferencia.status).toBe('descartada');
    expect((await http().get(base(matriz))).body.map((x) => x.id)).not.toContain(c.id);
    expect((await q(`SELECT 1 FROM stock_counts WHERE id = $1`, [c.id])).rows).toHaveLength(1); // nao apaga
  });
});

describe('desfazer', () => {
  test('inverso do aplicado sobre o estoque atual, uma vez so', async () => {
    // c1: camisa foi de 8 para 1 (aplicada -7). Vendeu mais 1 depois.
    await q(`UPDATE products SET stock_qty = 0 WHERE id = $1`, [ids.camisa]);
    const r = await http().post(`${base(matriz)}/${ids.c1}/desfazer`);
    expect(r.status).toBe(200);
    expect(r.body.conferencia.status).toBe('desfeita');
    expect(r.body.conferencia.pode_desfazer).toBe(false);
    expect(await estoque(ids.camisa)).toBe(7); // 0 - (-7)
    const { rows: [m] } = await q(
      `SELECT type, quantity, notes FROM stock_movements WHERE product_id = $1 AND reference_type = 'stock_count_undo'`, [ids.camisa]);
    expect(m.type).toBe('adjustment');
    expect(num(m.quantity)).toBe(7);
    expect(m.notes).toMatch(/^Desfeito: conferência nº \d+$/);

    const deNovo = await http().post(`${base(matriz)}/${ids.c1}/desfazer`);
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.code).toBe('JA_DESFEITA');
    expect(await estoque(ids.camisa)).toBe(7);
  });

  test('desfazer o zerar nao contados devolve o estoque', async () => {
    const r = await http().post(`${base(matriz)}/${ids.zerou}/desfazer`);
    expect(r.status).toBe(200);
    expect(await estoque(ids.esquecida)).toBe(4);
  });

  test('depois de 7 dias: 409 PRAZO_ENCERRADO e nada muda; rascunho: 409 NAO_APLICADA', async () => {
    const pid = await produto(matriz, 'Polo', { stock_qty: 3 });
    const c = await nova();
    await bipar(matriz, c.id, { product_id: pid, quantidade: 5, modo: 'definir' });
    await http().post(`${base(matriz)}/${c.id}/aplicar`, {});
    expect(await estoque(pid)).toBe(5);
    await q(`UPDATE stock_counts SET aplicada_em = NOW() - INTERVAL '8 days' WHERE id = $1`, [c.id]);
    const r = await http().post(`${base(matriz)}/${c.id}/desfazer`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PRAZO_ENCERRADO');
    expect(await estoque(pid)).toBe(5);
    const lista = await http().get(base(matriz));
    expect(lista.body.find((x) => x.id === c.id).pode_desfazer).toBe(false);

    const rasc = await nova();
    const r2 = await http().post(`${base(matriz)}/${rasc.id}/desfazer`);
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('NAO_APLICADA');
    await http().del(`${base(matriz)}/${rasc.id}`);
  });
});

describe('grupo compartilhado e outra loja', () => {
  test('compartilhado da filial: 409 na matriz com a loja dona; entra na conferencia da filial', async () => {
    const pid = await produto(filial, 'Perfume do grupo', { stock_qty: 9, is_group_shared: true });
    const naMatriz = await nova(matriz);
    const r = await bipar(matriz, naMatriz.id, { product_id: pid, quantidade: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PRODUTO_DE_OUTRA_LOJA');
    expect(r.body.loja_dona).toEqual({ id: filial, nome: 'Loja Shopping' });
    expect(r.body.error).toMatch(/Loja Shopping/);
    const g = await http().get(`${base(matriz)}/${naMatriz.id}`);
    expect(g.body.compartilhados_de_outra_loja).toBeGreaterThanOrEqual(1);

    const naFilial = await nova(filial);
    const ok = await bipar(filial, naFilial.id, { product_id: pid, quantidade: 8, modo: 'definir' });
    expect(ok.status).toBe(200);
    await http().post(`${base(filial)}/${naFilial.id}/aplicar`, {});
    expect(await estoque(pid)).toBe(8);
    await http().del(`${base(matriz)}/${naMatriz.id}`);
  });

  test('produto de outra loja (sem compartilhar): 409 sem nome; conferencia de outra loja: 404', async () => {
    const pid = await produto(deFora, 'Produto de fora', { stock_qty: 1 });
    const c = await nova(matriz);
    const r = await bipar(matriz, c.id, { product_id: pid, quantidade: 1 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PRODUTO_DE_OUTRA_LOJA');
    expect(r.body.loja_dona).toBeUndefined();
    const outra = await http().get(`${base(filial)}/${c.id}`);
    expect(outra.status).toBe(404);
    await http().del(`${base(matriz)}/${c.id}`);
  });
});

describe('permissoes', () => {
  test('estoque so consulta: conta, ve as diferencas sem custo, nao aplica nem desfaz', async () => {
    const pid = await produto(matriz, 'Regata', { stock_qty: 4, cost_price: 10 });
    const c = await nova(matriz, { escopo: { tipo: 'loja_toda' } }, consulta);
    expect(c.criada_por).toBe(consulta);
    const r = await bipar(matriz, c.id, { product_id: pid, quantidade: 3, modo: 'definir' }, consulta);
    expect(r.status).toBe(200);
    const d = await http(consulta).get(`${base(matriz)}/${c.id}/diferencas`);
    expect(d.status).toBe(200);
    expect(d.body.custos_ocultos).toBe(true);
    const linha = d.body.itens.find((x) => x.product_id === pid);
    expect(linha.custo).toBeNull();
    expect(linha.valor).toBeNull();
    expect(d.body.resumo.valor_faltam).toBeNull();
    const ap = await http(consulta).post(`${base(matriz)}/${c.id}/aplicar`, {});
    expect(ap.status).toBe(403);
    expect(ap.body.code).toBe('SEM_PERMISSAO_DE_EDITAR');
    expect(await estoque(pid)).toBe(4);
    // o dono aplica a contagem do funcionario
    const dono1 = await http().post(`${base(matriz)}/${c.id}/aplicar`, {});
    expect(dono1.status).toBe(200);
    expect(await estoque(pid)).toBe(3);
    const desf = await http(consulta).post(`${base(matriz)}/${c.id}/desfazer`);
    expect(desf.status).toBe(403);
  });

  test('estoque desligado: 403 em tudo', async () => {
    const r = await http(semEstoque).get(base(matriz));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SEM_ACESSO_AO_ESTOQUE');
    const p = await http(semEstoque).post(base(matriz), { escopo: { tipo: 'loja_toda' } });
    expect(p.status).toBe(403);
  });
});

describe('escopo', () => {
  test('categoria (com subcategoria) e "com estoque"; escopo invalido 400', async () => {
    const { rows: [roupas] } = await q(`INSERT INTO product_categories (company_id, type, name) VALUES ($1, 'product', 'Roupas') RETURNING id`, [filial]);
    const { rows: [blusas] } = await q(`INSERT INTO product_categories (company_id, type, name, parent_id) VALUES ($1, 'product', 'Blusas', $2) RETURNING id`, [filial, roupas.id]);
    const a = await produto(filial, 'Blusa A', { stock_qty: 2 });
    const b = await produto(filial, 'Calca B', { stock_qty: 0 });
    await produto(filial, 'Fora da categoria', { stock_qty: 5 });
    await q(`INSERT INTO product_category_links (product_id, category_id, is_primary) VALUES ($1, $2, true)`, [a, blusas.id]);
    await q(`INSERT INTO product_category_links (product_id, category_id, is_primary) VALUES ($1, $2, true)`, [b, roupas.id]);

    const cat = await nova(filial, { escopo: { tipo: 'categoria', category_ids: [roupas.id] } });
    const g = await http().get(`${base(filial)}/${cat.id}`);
    expect(g.body.escopo_total).toBe(2);
    const d = await http().get(`${base(filial)}/${cat.id}/diferencas`);
    expect(d.body.nao_contados.map((x) => x.product_id)).toEqual([a]); // b tem estoque 0

    const total = (await http().get(`${base(filial)}/${(await nova(filial)).id}`)).body.escopo_total;
    const comEstoque = await nova(filial, { escopo: { tipo: 'com_estoque' } });
    const g2 = await http().get(`${base(filial)}/${comEstoque.id}`);
    expect(g2.body.escopo_total).toBeLessThan(total);

    for (const escopo of [null, { tipo: 'x' }, { tipo: 'categoria' }, { tipo: 'categoria', category_ids: ['nao-uuid'] }]) {
      const r = await http().post(base(filial), { escopo });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('ESCOPO_INVALIDO');
    }
    const deOutra = await http().post(base(matriz), { escopo: { tipo: 'categoria', category_ids: [roupas.id] } });
    expect(deOutra.status).toBe(400);
  });
});

describe('transferencia a partir da conferencia', () => {
  test('com stock_count_id grava o vinculo e aparece no GET; sem o campo, nulo; de outra loja, 400', async () => {
    const pid = await produto(matriz, 'Tenis', { stock_qty: 5, barcode: '7891000000999' });
    const c = await nova(matriz);
    const t = await request(app).post(`/companies/${matriz}/estoque/transferencias`).set('x-user', dono)
      .send({ destino_company_id: filial, itens: [{ product_id: pid, quantidade: 2 }], stock_count_id: c.id });
    expect(t.status).toBe(201);
    expect(t.body.transferencia.stock_count_id).toBe(c.id);
    const { rows: [row] } = await q(`SELECT stock_count_id FROM stock_transfers WHERE id = $1`, [t.body.transferencia.id]);
    expect(row.stock_count_id).toBe(c.id);
    const g = await http().get(`${base(matriz)}/${c.id}`);
    expect(g.body.transferencias).toHaveLength(1);
    expect(g.body.transferencias[0]).toMatchObject({ id: t.body.transferencia.id, destino_company_id: filial, destino_nome: 'Loja Shopping', total_pecas: 2 });

    const sem = await request(app).post(`/companies/${matriz}/estoque/transferencias`).set('x-user', dono)
      .send({ destino_company_id: filial, itens: [{ product_id: pid, quantidade: 1 }] });
    expect(sem.status).toBe(201);
    expect(sem.body.transferencia).not.toHaveProperty('stock_count_id');
    const { rows: [row2] } = await q(`SELECT stock_count_id FROM stock_transfers WHERE id = $1`, [sem.body.transferencia.id]);
    expect(row2.stock_count_id).toBeNull();

    const daFilial = await nova(filial);
    const errada = await request(app).post(`/companies/${matriz}/estoque/transferencias`).set('x-user', dono)
      .send({ destino_company_id: filial, itens: [{ product_id: pid, quantidade: 1 }], stock_count_id: daFilial.id });
    expect(errada.status).toBe(400);
    expect(errada.body.code).toBe('CONFERENCIA_INVALIDA');
    expect(await estoque(pid)).toBe(2);

    // transferiu depois do bipe: a regra do ajuste mantem a saida
    const c2 = await nova(matriz);
    await bipar(matriz, c2.id, { product_id: pid, quantidade: 2, modo: 'definir' }); // snapshot 2, contou 2
    await request(app).post(`/companies/${matriz}/estoque/transferencias`).set('x-user', dono)
      .send({ destino_company_id: filial, itens: [{ product_id: pid, quantidade: 1 }], stock_count_id: c2.id });
    await http().post(`${base(matriz)}/${c2.id}/aplicar`, {});
    expect(await estoque(pid)).toBe(1); // diferenca 0 sobre o 1 que ficou
  });
});
