// ============================================================
// AURA. Studio, evento em lote vira pedidos (POST /bulk-events/:eid/convert)
// — Postgres real
//
// O INSERT antigo omitia digital_orders.order_number e digital_order_items.subtotal
// (NOT NULL, sem default) e mandava customer_phone null quando o evento nao
// tinha telefone (NOT NULL): a conversao falhava SEMPRE (500). Em producao,
// em 18/10/2026: 3 eventos em lote de 1 loja, 0 pedidos gerados.
//
// So o Postgres prova isso. Fixtures com uuid proprio, apagadas no afterAll.
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

const userId = uuid();
const companyId = uuid();
const outraEmpresaId = uuid();

jest.setTimeout(30000);

const url = (eid) => `/companies/${companyId}/studio/bulk-events/${eid}/convert`;

async function novoEvento({ itens = 3, telefone = '11988887777', preco = 50, desconto = 10, status = 'draft', empresa = companyId } = {}) {
  const eid = uuid();
  await pool.query(
    `INSERT INTO studio_bulk_events (id, company_id, event_name, customer_name, customer_phone,
                                     product_name_snapshot, base_unit_price, discount_pct, total_qty, status)
     VALUES ($1, $2, 'Formatura fixture', 'Contratante Fixture', $3, 'Caneca fixture', $4, $5, $6, $7)`,
    [eid, empresa, telefone, preco, desconto, itens, status]
  );
  for (let i = 1; i <= itens; i++) {
    await pool.query(
      `INSERT INTO studio_bulk_event_items (event_id, line_number, recipient_name, customization)
       VALUES ($1, $2, $3, $4)`,
      [eid, i, i === 3 ? null : `Aluno ${i}`, JSON.stringify({ texto: `Nome ${i}` })]
    );
  }
  return eid;
}

async function pedidosDoEvento(eid) {
  const { rows } = await pool.query(
    `SELECT * FROM digital_orders WHERE studio_bulk_event_id = $1 ORDER BY order_number`,
    [eid]
  );
  return rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 10 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  // Mesmo ajuste de schema de teste do convert de orcamento: a 070 cria
  // digital_order_sequences sem updated_at e a 273 grava essa coluna.
  await pool.query(
    `ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Lote')`,
    [userId, `fixture-${userId}@example.test`]
  );
  for (const id of [companyId, outraEmpresaId]) {
    await pool.query(
      `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Lote')`,
      [id, userId]
    );
  }

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioBulkConvert'));
});

afterAll(async () => {
  if (!pool) return;
  const ids = [companyId, outraEmpresaId];
  const limpar = [
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [ids]],
    [`UPDATE studio_bulk_event_items SET digital_order_id = NULL WHERE event_id IN (SELECT id FROM studio_bulk_events WHERE company_id = ANY($1))`, [ids]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [ids]],
    [`DELETE FROM studio_bulk_events WHERE company_id = ANY($1)`, [ids]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [ids]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [ids]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI e descartavel */ }
  }
  await pool.end();
});

describe('converter evento em lote: grava de verdade no schema real', () => {
  test('N itens geram N pedidos com os campos obrigatorios, itens e ligacao de volta', async () => {
    const eid = await novoEvento({ itens: 3 });
    const r = await request(app).post(url(eid));
    expect(r.status).toBe(201);
    expect(r.body.converted).toBe(3);
    expect(r.body.order_ids).toHaveLength(3);

    const pedidos = await pedidosDoEvento(eid);
    expect(pedidos).toHaveLength(3);
    // order_number preenchido e sem colisao dentro do lote
    const numeros = pedidos.map((p) => p.order_number);
    expect(numeros.every(Boolean)).toBe(true);
    expect(new Set(numeros).size).toBe(3);

    for (const p of pedidos) {
      expect(p.company_id).toBe(companyId);
      expect(p.vertical).toBe('studio');
      expect(p.status).toBe('confirmed');
      expect(p.studio_production_status).toBe('pending_art');
      expect(p.customer_phone).toBe('11988887777');
      expect(Number(p.total)).toBe(45); // 50 com 10% de desconto
      expect(Number(p.subtotal)).toBe(45);
    }
    expect(pedidos.map((p) => p.customer_name).sort()).toEqual(['Aluno 1', 'Aluno 2', 'Contratante Fixture']);

    const { rows: itens } = await pool.query(
      `SELECT product_name, quantity, unit_price, subtotal, customization
         FROM digital_order_items WHERE order_id = ANY($1)`,
      [r.body.order_ids]
    );
    expect(itens).toHaveLength(3);
    for (const it of itens) {
      expect(it.product_name).toBe('Caneca fixture');
      expect(Number(it.quantity)).toBe(1);
      expect(Number(it.unit_price)).toBe(45);
      expect(Number(it.subtotal)).toBe(45);
      expect(it.customization.texto).toMatch(/^Nome \d$/);
    }

    // cada item aponta para o seu pedido; o evento entra em producao
    const { rows: linhas } = await pool.query(
      `SELECT digital_order_id FROM studio_bulk_event_items WHERE event_id = $1`, [eid]
    );
    expect(linhas.every((l) => l.digital_order_id)).toBe(true);
    expect(new Set(linhas.map((l) => l.digital_order_id)).size).toBe(3);
    const { rows: [ev] } = await pool.query(`SELECT status, converted_at FROM studio_bulk_events WHERE id = $1`, [eid]);
    expect(ev.status).toBe('in_production');
    expect(ev.converted_at).not.toBeNull();
  });

  test('evento sem telefone converte: customer_phone vira texto vazio (coluna NOT NULL)', async () => {
    const eid = await novoEvento({ itens: 2, telefone: null });
    const r = await request(app).post(url(eid));
    expect(r.status).toBe(201);
    expect(r.body.converted).toBe(2);
    const pedidos = await pedidosDoEvento(eid);
    expect(pedidos).toHaveLength(2);
    expect(pedidos.every((p) => p.customer_phone === '')).toBe(true);
  });

  test('numeracao continua a da empresa: lote nao repete numero de pedido ja existente', async () => {
    const a = await novoEvento({ itens: 2 });
    const b = await novoEvento({ itens: 2 });
    await request(app).post(url(a));
    await request(app).post(url(b));
    const { rows } = await pool.query(
      `SELECT order_number FROM digital_orders WHERE company_id = $1`, [companyId]
    );
    expect(new Set(rows.map((x) => x.order_number)).size).toBe(rows.length);
  });
});

describe('converter evento em lote: nao duplica', () => {
  test('rodar duas vezes seguidas: a segunda nao cria nada', async () => {
    const eid = await novoEvento({ itens: 3 });
    expect((await request(app).post(url(eid))).status).toBe(201);
    const r2 = await request(app).post(url(eid));
    expect(r2.status).toBe(200);
    expect(r2.body.converted).toBe(0);
    expect(await pedidosDoEvento(eid)).toHaveLength(3);
  });

  test('x6 ao mesmo tempo (clique duplo, duas abas): 3 pedidos so', async () => {
    const eid = await novoEvento({ itens: 3 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => request(app).post(url(eid))));
    expect(rs.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const pedidos = await pedidosDoEvento(eid);
    expect(pedidos).toHaveLength(3);
    expect(new Set(pedidos.map((p) => p.order_number)).size).toBe(3);
  });

  test('item novo adicionado depois: so ele vira pedido', async () => {
    const eid = await novoEvento({ itens: 2 });
    await request(app).post(url(eid));
    await pool.query(
      `INSERT INTO studio_bulk_event_items (event_id, line_number, recipient_name) VALUES ($1, 3, 'Aluno tardio')`,
      [eid]
    );
    const r = await request(app).post(url(eid));
    expect(r.status).toBe(201);
    expect(r.body.converted).toBe(1);
    expect(await pedidosDoEvento(eid)).toHaveLength(3);
  });
});

describe('converter evento em lote: recusas', () => {
  test('evento cancelado: 400 e nenhum pedido', async () => {
    const eid = await novoEvento({ status: 'cancelled' });
    expect((await request(app).post(url(eid))).status).toBe(400);
    expect(await pedidosDoEvento(eid)).toHaveLength(0);
  });

  test('evento de outra empresa: 404 e nenhum pedido', async () => {
    const eid = await novoEvento({ empresa: outraEmpresaId });
    expect((await request(app).post(url(eid))).status).toBe(404);
    expect(await pedidosDoEvento(eid)).toHaveLength(0);
  });
});
