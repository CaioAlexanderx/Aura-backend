// ============================================================
// AURA. — /me/studio/orders e /me/studio/quotes (p-186) — Postgres real
//
// O que este arquivo trava, com a view studio_orders da migration 454:
//   1. o usuário vê os pedidos e os orçamentos das lojas dele com o plano
//      Negócio (dono) e da loja onde é membro com personalizados.access;
//   2. NÃO vê: loja de outro dono, loja dele no Essencial, loja onde é
//      membro sem a permissão. O outro dono também não vê as do usuário;
//   3. ?company_id= de loja de outro dono: 403; de loja dele no Essencial:
//      vazio, sem erro;
//   4. filtro por etapa/situação, paginação (total e offset) e breakdown;
//   5. só leitura: a contagem das tabelas não muda.
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
let comoUsuario;
let comoOutroDono;

const userId = uuid();
const outroDono = uuid();
const matriz = uuid();       // do usuário, Negócio
const essencial = uuid();    // do usuário, Essencial: fica fora
const membroCom = uuid();    // de outro dono, usuário é membro com personalizados.access
const membroSem = uuid();    // de outro dono, usuário é membro só do Caixa
const deFora = uuid();       // de outro dono, Negócio, sem vínculo com o usuário
const empresas = [matriz, essencial, membroCom, membroSem, deFora];

let seq = 0;
async function pedido(companyId, etapa, criadoHaDias = 1) {
  seq += 1;
  const id = uuid();
  await pool.query(
    `INSERT INTO digital_orders
       (id, company_id, order_number, customer_name, customer_phone,
        subtotal, total, status, payment_status, payment_method,
        vertical, studio_production_status, created_at)
     VALUES ($1, $2, $3, 'Cliente Fixture', '11999990000',
             50, 50, 'confirmed', 'paid', 'pix',
             'studio', $4, NOW() - make_interval(days => $5::int))`,
    [id, companyId, 'MS-' + String(seq).padStart(4, '0'), etapa, criadoHaDias]
  );
  return id;
}

async function orcamento(companyId, status, criadoHaDias = 1) {
  const { rows } = await pool.query(
    `INSERT INTO studio_quotes (company_id, customer_name, status, subtotal, total, created_at)
     VALUES ($1, 'Cliente Fixture', $2, 80, 80, NOW() - make_interval(days => $3::int))
     RETURNING id`,
    [companyId, status, criadoHaDias]
  );
  return rows[0].id;
}

async function contagens() {
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM digital_orders WHERE company_id = ANY($1))::int AS pedidos,
            (SELECT COUNT(*) FROM studio_quotes  WHERE company_id = ANY($1))::int AS orcamentos`,
    [empresas]
  );
  return rows[0];
}

const ids = {};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 2 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  for (const [id, nome] of [[userId, 'Fixture Me Studio'], [outroDono, 'Fixture Outro Dono Studio']]) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', $3)`,
      [id, `fixture-${id}@example.test`, nome]
    );
  }
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, is_primary)
     VALUES ($1, $2, 'Matriz Studio Fixture', 'Matriz', 'negocio', true)`,
    [matriz, userId]
  );
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, plan)
     VALUES ($1, $2, 'Essencial Studio Fixture', 'Essencial', 'essencial')`,
    [essencial, userId]
  );
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, plan) VALUES
       ($1, $4, 'Membro Com Fixture', 'Membro com', 'negocio'),
       ($2, $4, 'Membro Sem Fixture', 'Membro sem', 'negocio'),
       ($3, $4, 'De Fora Studio Fixture', 'De fora', 'negocio')`,
    [membroCom, membroSem, deFora, outroDono]
  );
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role_label, permissions, status, is_active) VALUES
       ($1, $3, 'vendedor', '{"personalizados.access": true}'::jsonb, 'active', true),
       ($2, $3, 'vendedor', '{"pdv": true}'::jsonb, 'active', true)`,
    [membroCom, membroSem, userId]
  );

  ids.m1 = await pedido(matriz, 'pending_art', 1);
  ids.m2 = await pedido(matriz, 'in_production', 2);
  ids.m3 = await pedido(matriz, 'ready', 4);
  ids.mVelho = await pedido(matriz, 'ready', 60); // fora dos 30 dias padrão
  ids.c1 = await pedido(membroCom, 'pending_art', 3);
  ids.e1 = await pedido(essencial, 'pending_art', 1);
  ids.s1 = await pedido(membroSem, 'pending_art', 1);
  ids.f1 = await pedido(deFora, 'pending_art', 1);

  ids.qm1 = await orcamento(matriz, 'sent', 1);
  ids.qm2 = await orcamento(matriz, 'draft', 2);
  ids.qc1 = await orcamento(membroCom, 'sent', 1);
  ids.qe1 = await orcamento(essencial, 'sent', 1);
  ids.qs1 = await orcamento(membroSem, 'sent', 1);
  ids.qf1 = await orcamento(deFora, 'sent', 1);

  const montar = (uid) => {
    const app = express();
    app.use((req, res, next) => { req.user = { id: uid }; next(); });
    app.use('/me', require('../src/routes/meStudio'));
    return app;
  };
  comoUsuario = montar(userId);
  comoOutroDono = montar(outroDono);
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    `DELETE FROM studio_quotes WHERE company_id = ANY($1)`,
    `DELETE FROM digital_orders WHERE company_id = ANY($1)`,
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

describe('GET /me/studio/orders', () => {
  test('lojas que entram: Matriz (dono, Negócio) e a loja onde é membro com a permissão', async () => {
    const antes = await contagens();
    const res = await request(comoUsuario).get('/me/studio/orders');
    expect(res.status).toBe(200);
    const vistos = res.body.orders.map((o) => o.id);
    // mais novo primeiro, as duas lojas misturadas
    expect(vistos).toEqual([ids.m1, ids.m2, ids.c1, ids.m3]);
    for (const fora of [ids.e1, ids.s1, ids.f1, ids.mVelho]) expect(vistos).not.toContain(fora);
    expect(res.body.total).toBe(4);
    expect(res.body.company_count).toBe(2);
    expect(res.body.breakdown).toEqual([
      { company_id: matriz, company_name: 'Matriz', is_primary: true, total: 3 },
      { company_id: membroCom, company_name: 'Membro com', is_primary: false, total: 1 },
    ]);
    const m1 = res.body.orders.find((o) => o.id === ids.m1);
    expect(m1).toMatchObject({
      company_id: matriz, company_name: 'Matriz', source: 'digital',
      digital_order_id: ids.m1, studio_production_status: 'pending_art',
      card_customization: null,
    });
    expect(m1).toHaveProperty('balance_amount');
    expect(m1).toHaveProperty('item_count');
    expect(await contagens()).toEqual(antes);
  });

  test('autorização: o outro dono não vê as lojas do usuário (e vê as dele)', async () => {
    const res = await request(comoOutroDono).get('/me/studio/orders');
    expect(res.status).toBe(200);
    const lojas = new Set(res.body.orders.map((o) => o.company_id));
    expect(lojas.has(matriz)).toBe(false);
    expect(lojas.has(essencial)).toBe(false);
    expect(res.body.orders.map((o) => o.id)).toEqual(expect.arrayContaining([ids.c1, ids.s1, ids.f1]));
  });

  test('?company_id= de loja de outro dono sem vínculo: 403', async () => {
    const res = await request(comoUsuario).get(`/me/studio/orders?company_id=${deFora}`);
    expect(res.status).toBe(403);
  });

  test('?company_id= de loja do usuário no Essencial: vazio, sem erro', async () => {
    const res = await request(comoUsuario).get(`/me/studio/orders?company_id=${essencial}`);
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('filtro por loja e por etapa', async () => {
    let res = await request(comoUsuario).get(`/me/studio/orders?company_id=${membroCom}`);
    expect(res.body.orders.map((o) => o.id)).toEqual([ids.c1]);
    expect(res.body.filtered_company_id).toBe(membroCom);
    res = await request(comoUsuario).get('/me/studio/orders?status=ready');
    expect(res.body.orders.map((o) => o.id)).toEqual([ids.m3]);
    res = await request(comoUsuario).get('/me/studio/orders?status=ready&days=90');
    expect(res.body.orders.map((o) => o.id)).toEqual([ids.m3, ids.mVelho]);
  });

  test('paginação: limit e offset, total sem mudar', async () => {
    const p1 = await request(comoUsuario).get('/me/studio/orders?limit=2&offset=0');
    const p2 = await request(comoUsuario).get('/me/studio/orders?limit=2&offset=2');
    const p3 = await request(comoUsuario).get('/me/studio/orders?limit=2&offset=4');
    expect(p1.body.orders).toHaveLength(2);
    expect(p2.body.orders).toHaveLength(2);
    expect(p3.body.orders).toHaveLength(0);
    expect(p1.body.total).toBe(4);
    expect(p3.body.total).toBe(4);
    const todos = [...p1.body.orders, ...p2.body.orders].map((o) => o.id);
    expect(new Set(todos).size).toBe(4);
  });
});

describe('GET /me/studio/quotes', () => {
  test('mesmas lojas, com o nome da loja e os campos da rota por empresa', async () => {
    const antes = await contagens();
    const res = await request(comoUsuario).get('/me/studio/quotes');
    expect(res.status).toBe(200);
    const vistos = res.body.quotes.map((q) => q.id);
    expect(vistos).toEqual(expect.arrayContaining([ids.qm1, ids.qm2, ids.qc1]));
    expect(vistos).toHaveLength(3);
    expect(res.body.total).toBe(3);
    const q = res.body.quotes.find((x) => x.id === ids.qm1);
    expect(q).toMatchObject({ company_id: matriz, company_name: 'Matriz', status: 'sent', tem_video: false });
    expect(q).toHaveProperty('versao');
    expect(await contagens()).toEqual(antes);
  });

  test('autorização: o outro dono não vê os orçamentos do usuário', async () => {
    const res = await request(comoOutroDono).get('/me/studio/quotes');
    const vistos = res.body.quotes.map((x) => x.id);
    expect(vistos).not.toContain(ids.qm1);
    expect(vistos).not.toContain(ids.qm2);
    expect(vistos).not.toContain(ids.qe1);
    expect(vistos).toEqual(expect.arrayContaining([ids.qc1, ids.qs1, ids.qf1]));
  });

  test('filtro por situação e por loja; 403 para loja de fora', async () => {
    let res = await request(comoUsuario).get('/me/studio/quotes?status=sent');
    expect(res.body.quotes.map((x) => x.id).sort()).toEqual([ids.qm1, ids.qc1].sort());
    res = await request(comoUsuario).get(`/me/studio/quotes?company_id=${matriz}&status=draft`);
    expect(res.body.quotes.map((x) => x.id)).toEqual([ids.qm2]);
    res = await request(comoUsuario).get(`/me/studio/quotes?company_id=${deFora}`);
    expect(res.status).toBe(403);
  });
});
