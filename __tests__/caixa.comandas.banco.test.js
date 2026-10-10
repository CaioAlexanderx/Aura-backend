// ============================================================
// AURA. — Comandas do Caixa (migration 368) — Postgres real
//
// A adega pendura o consumo no numero da comanda e cobra no fim. O que este
// arquivo cobre:
//   1. chave desligada: lancar e recusado (403), listar continua respondendo
//   2. lancar abre a comanda; lancar de novo cai na MESMA comanda
//   3. numero invalido e lista vazia: 400
//   4. tirar um item, cancelar a comanda, e o numero volta a ficar livre
//   5. a venda com comanda_id fecha a comanda; cobrar de novo e 409; comanda
//      de outra loja e 404; venda sem comanda_id nao toca em nada
//   6. cancelar a venda reabre a comanda — salvo se o numero ja foi reaberto
//
// Mesmo padrao de credito.editarPagamento.banco.test.js: tudo dentro de UMA
// transacao revertida no afterAll; o client das rotas delega ao da transacao
// do teste e troca BEGIN/COMMIT/ROLLBACK por SAVEPOINT.
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
let hooks;
let app;

const userId    = uuid();
const companyId = uuid();
const outraLoja = uuid();
const base = `/companies/${companyId}/comandas`;

async function ligar(valor) {
  await client.query(
    `UPDATE companies SET pdv_settings = jsonb_build_object('comanda_enabled', $2::boolean) WHERE id = $1`,
    [companyId, valor]
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));

  hooks = require('../src/services/comandaSaleHooks');
  hooks._resetCache();

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Comandas')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $3, 'Fixture Adega'), ($2, $3, 'Fixture Outra Loja')`,
    [companyId, outraLoja, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/comandas', require('../src/routes/comandas'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const COPAO = { product_id: null, name: 'Copão Gin + Energético', unit: 'un', quantity: 2, unit_price: 25 };
const DOSE  = { product_id: 'nao-e-uuid', name: 'Dose Whisky', quantity: 1, unit_price: 18.5 };

async function venda(empresa = companyId) {
  const id = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, total_amount) VALUES ($1, $2, 68.5)`, [id, empresa]
  );
  return { id };
}

async function estado(comandaId) {
  const { rows } = await client.query(
    `SELECT status, sale_id, closed_at, service_fee_pct FROM pdv_comandas WHERE id = $1`, [comandaId]
  );
  return rows[0];
}

describe('comandas — rotas', () => {
  test('1. chave desligada: lancar e 403, listar continua respondendo', async () => {
    await ligar(false);
    const post = await request(app).post(`${base}/12/items`).send({ items: [COPAO] });
    expect(post.status).toBe(403);
    expect(post.body.code).toBe('COMANDA_DISABLED');
    const lista = await request(app).get(base);
    expect(lista.status).toBe(200);
    expect(lista.body.comandas).toEqual([]);
  });

  test('2. lancar abre a comanda; lancar de novo cai na mesma, e a conta soma', async () => {
    await ligar(true);
    const a = await request(app).post(`${base}/12/items`).send({ items: [COPAO] });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ opened: true, added: 1 });
    expect(a.body.comanda).toMatchObject({ number: 12, status: 'open', items_count: 1, subtotal: 50 });

    // "012" e 12: o operador digita como esta no cartao.
    const b = await request(app).post(`${base}/012/items`).send({ items: [DOSE] });
    expect(b.status).toBe(201);
    expect(b.body.opened).toBe(false);
    expect(b.body.comanda.id).toBe(a.body.comanda.id);
    expect(b.body.comanda).toMatchObject({ items_count: 2, subtotal: 68.5 });
    // product_id que nao e uuid vira null em vez de derrubar o lancamento
    expect(b.body.comanda.items[1]).toMatchObject({ name: 'Dose Whisky', product_id: null, quantity: 1, unit_price: 18.5, total: 18.5 });

    const get = await request(app).get(`${base}/12`);
    expect(get.status).toBe(200);
    expect(get.body.comanda.items.map((i) => i.name)).toEqual(['Copão Gin + Energético', 'Dose Whisky']);

    const lista = await request(app).get(base);
    expect(lista.body.comandas).toEqual([
      expect.objectContaining({ number: 12, items_count: 2, subtotal: 68.5 }),
    ]);
  });

  test('3. recusas: numero invalido, sem itens, quantidade zero, comanda que nao existe', async () => {
    for (const n of ['0', 'abc', '10000', '1.5']) {
      const r = await request(app).post(`${base}/${n}/items`).send({ items: [COPAO] });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('COMANDA_NUMBER_INVALID');
    }
    expect((await request(app).post(`${base}/7/items`).send({ items: [] })).status).toBe(400);
    expect((await request(app).post(`${base}/7/items`).send({ items: [{ ...COPAO, quantity: 0 }] })).status).toBe(400);
    expect((await request(app).post(`${base}/7/items`).send({ items: [{ ...COPAO, name: ' ' }] })).status).toBe(400);
    const get = await request(app).get(`${base}/7`);
    expect(get.status).toBe(404);
    expect(get.body.code).toBe('COMANDA_NOT_FOUND');
  });

  test('4. tirar um item, cancelar, e o numero volta a ficar livre', async () => {
    const aberta = (await request(app).get(`${base}/12`)).body.comanda;
    const dose = aberta.items.find((i) => i.name === 'Dose Whisky');

    const del = await request(app).delete(`${base}/12/items/${dose.id}`);
    expect(del.status).toBe(200);
    expect(del.body.comanda).toMatchObject({ items_count: 1, subtotal: 50 });
    expect((await request(app).delete(`${base}/12/items/${dose.id}`)).status).toBe(404);

    const cancel = await request(app).post(`${base}/12/cancel`);
    expect(cancel.status).toBe(200);
    expect((await request(app).get(`${base}/12`)).status).toBe(404);
    expect((await request(app).post(`${base}/12/cancel`)).status).toBe(404);

    // o cartao 12 vai para outro cliente: comanda NOVA, vazia do consumo antigo
    const nova = await request(app).post(`${base}/12/items`).send({ items: [DOSE] });
    expect(nova.body.opened).toBe(true);
    expect(nova.body.comanda.id).not.toBe(aberta.id);
    expect(nova.body.comanda).toMatchObject({ items_count: 1, subtotal: 18.5 });
    await request(app).post(`${base}/12/cancel`);
  });
});

describe('comandas — ganchos da venda', () => {
  test('5. a venda fecha a comanda; cobrar de novo, outra loja e venda comum', async () => {
    const c = (await request(app).post(`${base}/30/items`).send({ items: [COPAO, DOSE] })).body.comanda;

    // venda comum: nada acontece
    expect(await hooks.afterSaleInsert(client, { companyId, sale: await venda(), body: {} })).toBeNull();
    expect((await estado(c.id)).status).toBe('open');

    // comanda de outra loja: 404, e a comanda continua aberta
    await expect(
      hooks.afterSaleInsert(client, { companyId: outraLoja, sale: await venda(outraLoja), body: { comanda_id: c.id } })
    ).rejects.toMatchObject({ statusCode: 404, code: 'COMANDA_NOT_FOUND' });
    await expect(
      hooks.afterSaleInsert(client, { companyId, sale: await venda(), body: { comanda_id: 'x' } })
    ).rejects.toMatchObject({ statusCode: 400, code: 'COMANDA_INVALID' });
    expect((await estado(c.id)).status).toBe('open');

    const sale = await venda();
    const r = await hooks.afterSaleInsert(client, {
      companyId, sale, body: { comanda_id: c.id, comanda_service_fee_pct: 10 },
    });
    expect(r).toEqual({ comanda_id: c.id, comanda_number: 30 });
    const e = await estado(c.id);
    expect(e.status).toBe('closed');
    expect(e.sale_id).toBe(sale.id);
    expect(e.closed_at).not.toBeNull();
    expect(Number(e.service_fee_pct)).toBe(10);
    const { rows } = await client.query(`SELECT comanda_id FROM sales WHERE id = $1`, [sale.id]);
    expect(rows[0].comanda_id).toBe(c.id);

    // fechada some da lista de abertas e nao se cobra duas vezes
    expect((await request(app).get(`${base}/30`)).status).toBe(404);
    await expect(
      hooks.afterSaleInsert(client, { companyId, sale: await venda(), body: { comanda_id: c.id } })
    ).rejects.toMatchObject({ statusCode: 409, code: 'COMANDA_NOT_OPEN' });
  });

  test('6. cancelar a venda reabre a comanda — salvo se o numero ja foi reaberto', async () => {
    // (a) reabre
    const a = (await request(app).post(`${base}/40/items`).send({ items: [COPAO] })).body.comanda;
    const vendaA = await venda();
    await hooks.afterSaleInsert(client, { companyId, sale: vendaA, body: { comanda_id: a.id, comanda_service_fee_pct: 10 } });
    expect(await hooks.afterSaleCancel(client, { companyId, saleId: vendaA.id })).toEqual({ comandas_reopened: 1 });
    const ea = await estado(a.id);
    expect(ea).toMatchObject({ status: 'open', sale_id: null, closed_at: null });
    expect(Number(ea.service_fee_pct)).toBe(0);
    expect((await request(app).get(`${base}/40`)).body.comanda).toMatchObject({ id: a.id, subtotal: 50 });

    // (b) o numero 41 foi reaberto para outro cliente antes do cancelamento
    const b = (await request(app).post(`${base}/41/items`).send({ items: [COPAO] })).body.comanda;
    const vendaB = await venda();
    await hooks.afterSaleInsert(client, { companyId, sale: vendaB, body: { comanda_id: b.id } });
    const nova = (await request(app).post(`${base}/41/items`).send({ items: [DOSE] })).body.comanda;
    expect(nova.id).not.toBe(b.id);
    expect(await hooks.afterSaleCancel(client, { companyId, saleId: vendaB.id })).toEqual({ comandas_reopened: 0 });
    expect((await estado(b.id)).status).toBe('cancelled');
    expect((await request(app).get(`${base}/41`)).body.comanda.id).toBe(nova.id);

    // venda sem comanda: nada
    expect(await hooks.afterSaleCancel(client, { companyId, saleId: (await venda()).id })).toEqual({ comandas_reopened: 0 });
  });
});
