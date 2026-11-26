// ============================================================
// AURA. — Venda condicional (C16): pecas para resolver — Postgres real
// GET  /companies/:id/condicionais/para-resolver
// POST /companies/:id/condicionais/itens/:itemId/resolver (+ /desfazer)
// (routes/condicionais.js, services/condicionalResolver.js), migrations 468/470.
//
// Provado aqui, no banco de verdade:
//   - a lista traz a peca (cor, tamanho), a cliente, o numero e a nota;
//   - voltar_estoque: a peca volta a livre (resolver_qty 0), o estoque fisico
//     nao muda e nao ha movimento; desfazer em poucos segundos a devolve para
//     "para resolver"; depois da janela, 409;
//   - baixa: estoque cai 1, UM movimento 'adjustment' com o motivo na nota,
//     e a mesma Idempotency-Key repetida nao baixa de novo;
//   - corrida: duas resolucoes ao mesmo tempo (chaves diferentes) -> uma
//     passa, a outra 409, estoque cai 1 so;
//   - peca resolvida nao resolve de novo; condicional encerrada resolve;
//   - trava CONDICIONAL_LIBERADA (404 para o lojista).
//
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid(), cliente: uuid(), blusa: uuid(), saia: uuid(), vestido: uuid(), varM: uuid(), extra: uuid() };
const EMPRESAS = [ID.loja];

let pool;
let app;
let usuario;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  const passos = [
    [`DELETE FROM stock_movements WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicionais WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicional_sequencias WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono]]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS ncm TEXT`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture C16')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture C16 Loja', 'Centro')`, [ID.loja, ID.dono]);
  const produto = (id, nome, preco, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, $4, $5)`, [id, ID.loja, nome, preco, estoque]);
  await produto(ID.blusa, 'Blusa Tricô', 90, 4);
  await produto(ID.saia, 'Saia Plissada', 120, 4);
  await produto(ID.extra, 'Cinto', 40, 4);
  await produto(ID.vestido, 'Vestido', 199.9, 0);
  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty, color_name, is_active) VALUES ($1, $2, 'AZ-M', 3, 'Azul', true)`,
    [ID.varM, ID.vestido]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'Marina Lopes', '(11) 98888-7777')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/condicionais', require('../src/routes/condicionais'));
  app.use('/companies/:id/products', require('../src/routes/products'));
});

beforeEach(() => {
  usuario = { id: ID.dono, role: 'client', is_staff: true, plan: 'negocio' };
  delete process.env.CONDICIONAL_LIBERADA;
});
afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

const chave = () => { seq += 1; return `teste-c16-${seq}-${uuid()}`; };
const base = `/companies/${ID.loja}/condicionais`;

/** Condicional com a peca marcada "voltou com defeito". Devolve { cond, item }. */
async function comDefeito(productId, { variantId, nota = 'Fio puxado na manga' } = {}) {
  const g = await request(app).post(base).set('Idempotency-Key', chave())
    .send({ customer_id: ID.cliente, items: [{ product_id: productId, ...(variantId ? { variant_id: variantId } : {}) }] });
  expect(g.status).toBe(201);
  const cond = g.body.condicional;
  const m = await request(app).patch(`${base}/${cond.id}/itens`)
    .send({ items: [{ item_id: cond.items[0].id, situacao: 'voltou_defeito', defect_note: nota }] });
  expect(m.status).toBe(200);
  return { cond, item: cond.items[0] };
}
const resolver = (item, body, k = chave()) =>
  request(app).post(`${base}/itens/${item.id}/resolver`).set('Idempotency-Key', k).send(body);
const desfazer = (item) => request(app).post(`${base}/itens/${item.id}/resolver/desfazer`).set('Idempotency-Key', chave()).send({});
const estoque = async (id) => Number((await q(`SELECT stock_qty FROM products WHERE id = $1`, [id])).rows[0].stock_qty);
const movimentos = async (productId) =>
  (await q(`SELECT * FROM stock_movements WHERE product_id = $1 AND reference_type = 'condicional_baixa'`, [productId])).rows;

async function produto(id) {
  process.env.CONDICIONAL_LIBERADA = 'true';
  const r = await request(app).get(`/companies/${ID.loja}/products?limit=100`);
  delete process.env.CONDICIONAL_LIBERADA;
  expect(r.status).toBe(200);
  return r.body.products.find((p) => p.id === id);
}

describe('lista', () => {
  test('traz a peca, a cliente, o numero e a nota; resolvida sai da lista', async () => {
    const { cond, item } = await comDefeito(ID.blusa);
    const r = await request(app).get(`${base}/para-resolver`);
    expect(r.status).toBe(200);
    const linha = r.body.pecas.find((p) => p.item_id === item.id);
    expect(linha).toMatchObject({
      condicional_id: cond.id, numero_exibicao: cond.numero_exibicao, customer_name: 'Marina Lopes',
      product_name: 'Blusa Tricô', nota: 'Fio puxado na manga',
    });
    expect(linha.voltou_em).toBeTruthy();
    expect(r.body.total).toBe(r.body.pecas.length);
    await resolver(item, { acao: 'voltar_estoque' });
    const depois = await request(app).get(`${base}/para-resolver`);
    expect(depois.body.pecas.find((p) => p.item_id === item.id)).toBeUndefined();
  });
});

describe('voltar ao estoque', () => {
  test('volta a livre, estoque fisico e movimentos intactos; a condicional encerrada aceita', async () => {
    const { cond, item } = await comDefeito(ID.saia);
    expect(cond.status).toBe('aberta');
    expect((await produto(ID.saia)).resolver_qty).toBe(1);
    const antes = await estoque(ID.saia);

    const r = await resolver(item, { acao: 'voltar_estoque' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ item_id: item.id, acao: 'voltar_estoque' });
    expect(r.body.condicional.items[0].resolved_at).toBeTruthy();
    expect(r.body.condicional.events.map((e) => e.tipo)).toContain('resolvida_voltou');
    expect((await produto(ID.saia)).resolver_qty).toBe(0);
    expect(await estoque(ID.saia)).toBe(antes);
    expect((await q(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id = $1`, [ID.saia])).rows[0].n).toBe(0);

    const de_novo = await resolver(item, { acao: 'voltar_estoque' });
    expect(de_novo.status).toBe(409);
    expect(de_novo.body.code).toBe('COND_PECA_JA_RESOLVIDA');
  });

  test('desfazer logo depois devolve a peca para resolver; depois da janela, 409', async () => {
    const { item } = await comDefeito(ID.saia);
    await resolver(item, { acao: 'voltar_estoque' });
    const d = await desfazer(item);
    expect(d.status).toBe(200);
    expect(d.body.condicional.items[0].resolved_at).toBeNull();
    expect((await produto(ID.saia)).resolver_qty).toBeGreaterThanOrEqual(1);

    await resolver(item, { acao: 'voltar_estoque' });
    await q(`UPDATE condicional_itens SET resolved_at = NOW() - interval '5 minutes' WHERE id = $1`, [item.id]);
    const tarde = await desfazer(item);
    expect(tarde.status).toBe(409);
    expect(tarde.body.code).toBe('COND_DESFAZER_EXPIRADO');
  });

  test('desfazer uma baixa: 409 e o estoque nao volta', async () => {
    const { item } = await comDefeito(ID.extra);
    await resolver(item, { acao: 'baixa', motivo: 'perda' });
    const d = await desfazer(item);
    expect(d.status).toBe(409);
    expect(d.body.code).toBe('COND_DESFAZER_BAIXA');
  });
});

describe('dar baixa', () => {
  test('baixa 1 unidade, um movimento com o motivo; a mesma chave nao baixa de novo', async () => {
    const { item } = await comDefeito(ID.blusa);
    const antes = await estoque(ID.blusa);
    const k = chave();
    const r = await resolver(item, { acao: 'baixa', motivo: 'sem_etiqueta' }, k);
    expect(r.status).toBe(200);
    expect(await estoque(ID.blusa)).toBe(antes - 1);
    const mov = (await movimentos(ID.blusa)).filter((m) => m.reference_id === item.id);
    expect(mov).toHaveLength(1);
    expect(mov[0]).toMatchObject({ type: 'adjustment', company_id: ID.loja });
    expect(Number(mov[0].quantity)).toBe(1);
    expect(mov[0].notes).toContain('Sem etiqueta');
    expect(mov[0].notes).toContain('Fio puxado na manga');

    const repetida = await resolver(item, { acao: 'baixa', motivo: 'sem_etiqueta' }, k);
    expect(repetida.status).toBe(200);
    expect(repetida.body.idempotent_replay).toBe(true);
    expect(await estoque(ID.blusa)).toBe(antes - 1);
    const outroCorpo = await resolver(item, { acao: 'baixa', motivo: 'perda' }, k);
    expect(outroCorpo.status).toBe(409);
    expect(outroCorpo.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('"Outro" pede o texto e ele vai na nota', async () => {
    const { item } = await comDefeito(ID.extra);
    const sem = await resolver(item, { acao: 'baixa', motivo: 'outro' });
    expect(sem.status).toBe(422);
    const ok = await resolver(item, { acao: 'baixa', motivo: 'outro', motivo_texto: 'Doada para brechó' });
    expect(ok.status).toBe(200);
    const mov = (await movimentos(ID.extra)).find((m) => m.reference_id === item.id);
    expect(mov.notes).toContain('Outro: Doada para brechó');
  });

  test('variante: baixa a variante, com variant_id no movimento', async () => {
    const { item } = await comDefeito(ID.vestido, { variantId: ID.varM });
    const r = await resolver(item, { acao: 'baixa', motivo: 'defeito' });
    expect(r.status).toBe(200);
    const { rows } = await q(`SELECT stock_qty FROM product_variants WHERE id = $1`, [ID.varM]);
    expect(Number(rows[0].stock_qty)).toBe(2);
    const mov = (await movimentos(ID.vestido))[0];
    expect(mov.variant_id).toBe(ID.varM);
  });

  test('corrida: duas resolucoes da mesma peca ao mesmo tempo, uma passa e o estoque cai 1 so', async () => {
    const { item } = await comDefeito(ID.saia);
    const antes = await estoque(ID.saia);
    const [a, b] = await Promise.all([
      resolver(item, { acao: 'baixa', motivo: 'defeito' }),
      resolver(item, { acao: 'baixa', motivo: 'defeito' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await estoque(ID.saia)).toBe(antes - 1);
    expect((await movimentos(ID.saia)).filter((m) => m.reference_id === item.id)).toHaveLength(1);
  });
});

describe('trava e erros', () => {
  test('CONDICIONAL_LIBERADA desligada e lojista comum: 404; peca de outra loja: 404', async () => {
    const { item } = await comDefeito(ID.extra);
    usuario = { id: ID.dono, role: 'client', is_staff: false, plan: 'negocio' };
    expect((await resolver(item, { acao: 'voltar_estoque' })).status).toBe(404);
    expect((await request(app).get(`${base}/para-resolver`)).status).toBe(404);
    usuario = { id: ID.dono, role: 'client', is_staff: true, plan: 'negocio' };
    const r = await request(app).post(`/companies/${uuid()}/condicionais/itens/${item.id}/resolver`)
      .set('Idempotency-Key', chave()).send({ acao: 'voltar_estoque' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('COND_PECA_NAO_ENCONTRADA');
  });
});
