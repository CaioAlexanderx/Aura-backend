// ============================================================
// AURA. — Pedido da loja comum com peca personalizavel, no Postgres de
// verdade (p-184, loja unica 3.4b, 17/11/2026). Schema das migrations.
//
// A rota POST /storefront/:slug/order roda inteira contra o banco (so o
// Pix, o Mercado Pago e os avisos sao de mentira):
//   1. pedido misto: um pedido so, vertical 'studio', etapa 'pending_art',
//      o item personalizado com customization e triagem da arte, o de
//      prateleira com o INSERT de sempre; o personalizado com saldo 0 passa;
//   2. a etapa: arte ou texto em todo item -> 'pending_art'; item sem nada
//      -> 'awaiting_customization'; arte propria -> art_review_status
//      'pendente';
//   3. o job do Pix: o pedido com personalizado espera 72 h (texto das
//      72 h); o so de prateleira cancela em 48 h e nasce sem vertical;
//   4. insumos: o item personalizado desconta o insumo ao entrar
//      (trg_studio_consume_inputs_digital) e o cancelamento devolve
//      (trg_studio_restore_inputs_digital_cancel), pelo job e pela mao da
//      lojista. Sem a vertical (como era antes do p-184) o insumo nao
//      voltava: o caso fica aqui de testemunha.
//
// Mesmo arreio do lojaTemPersonalizavel.banco.test.js: uma transacao
// revertida no afterAll, fila unica, savepoint por consulta. A transacao
// do pedido vira um savepoint proprio (BEGIN/COMMIT/ROLLBACK da rota).
// ============================================================
'use strict';

jest.mock('../src/services/pixService', () => ({
  generatePix: jest.fn(async () => ({
    payment_id: null, qrcode: null, payload: '000201PIXDETESTE', expires_at: null, mode: 'manual',
  })),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(async () => {}),
  notifyManualPixOrder: jest.fn(async () => {}),
  notifyPedidoAAceitar: jest.fn(async () => {}),
}));
jest.mock('../src/services/mpGateway', () => ({ gatewayAtivo: jest.fn(async () => null) }));

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const express = require('express');
const request = require('supertest');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let qn = 0;

const dono = uuid();
const empresa = uuid();
const slug = `p184-${empresa.slice(0, 8)}`;
const ids = {};

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}

// Uma consulta "solta" (db.query): savepoint proprio, erro nao contamina.
async function soltaNoSavepoint(sql, params) {
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
const q = (sql, params) => naFila(() => soltaNoSavepoint(sql, params));

// O client da transacao da rota: BEGIN/COMMIT/ROLLBACK viram savepoint.
function clienteDaRota() {
  return {
    query: (sql, params) => naFila(async () => {
      const s = String(sql).trim();
      if (s === 'BEGIN') return client.query('SAVEPOINT pedido');
      if (s === 'COMMIT') return client.query('RELEASE SAVEPOINT pedido');
      if (s === 'ROLLBACK') {
        await client.query('ROLLBACK TO SAVEPOINT pedido');
        return client.query('RELEASE SAVEPOINT pedido');
      }
      return client.query(sql, params);
    }),
    release: () => {},
  };
}

/**
 * Em producao digital_orders.status e payment_status sao TEXT (conferido em
 * 17/11/2026, information_schema, so leitura). O banco do CI nasce das
 * migrations com os ENUM da 070, e a rota (CASE WHEN $10 = 'confirmed',
 * payment_status 'expired' do job) nao roda nele. Aqui, dentro da
 * transacao revertida, as duas colunas viram TEXT como em producao: as
 * views e os triggers que dependem delas saem e voltam com a mesma
 * definicao, lida do catalogo.
 */
async function statusComoEmProducao() {
  const { rows: tipos } = await q(
    `SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'digital_orders' AND column_name = 'status'`);
  if (!tipos.length || tipos[0].udt_name === 'text') return;
  const { rows: views } = await q(
    `SELECT DISTINCT c.relname AS nome, pg_get_viewdef(c.oid) AS def
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class c ON c.oid = r.ev_class
      WHERE d.refobjid = 'digital_orders'::regclass AND c.relname <> 'digital_orders'`);
  const { rows: gatilhos } = await q(
    `SELECT tgname AS nome, pg_get_triggerdef(oid) AS def
       FROM pg_trigger WHERE tgrelid = 'digital_orders'::regclass AND NOT tgisinternal`);
  // Indice parcial com o literal do ENUM no WHERE: volta com o literal TEXT.
  const { rows: indices } = await q(
    `SELECT indexname AS nome, indexdef AS def FROM pg_indexes
      WHERE tablename = 'digital_orders' AND indexdef LIKE '%::digital_order%'`);
  for (const v of views) await q(`DROP VIEW IF EXISTS ${v.nome} CASCADE`);
  for (const g of gatilhos) await q(`DROP TRIGGER ${g.nome} ON digital_orders`);
  for (const i of indices) await q(`DROP INDEX ${i.nome}`);
  await q(`ALTER TABLE digital_orders ALTER COLUMN status DROP DEFAULT, ALTER COLUMN payment_status DROP DEFAULT`);
  await q(`ALTER TABLE digital_orders ALTER COLUMN status TYPE text, ALTER COLUMN payment_status TYPE text`);
  await q(`ALTER TABLE digital_orders ALTER COLUMN status SET DEFAULT 'pending_payment',
                                     ALTER COLUMN payment_status SET DEFAULT 'pending'`);
  for (const i of indices) await q(i.def.replace(/::digital_order_(payment_)?status/g, '::text'));
  for (const g of gatilhos) await q(g.def);
  for (const v of views) await q(`CREATE VIEW ${v.nome} AS ${v.def.replace(/::digital_order_(payment_)?status/g, "::text")}`);
}

const CONFIG = JSON.stringify({
  fields: [
    { id: 'nome', type: 'text', label: 'Nome', required: false },
    { id: 'foto', type: 'image', label: 'Foto', required: false },
  ],
});

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => q(sql, params));
  db.connect.mockImplementation(async () => clienteDaRota());

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture p-184')`,
    [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture P184 LTDA', 'P184')`,
    [empresa, dono]);

  const produto = async (chave, { estoque = 5, personalizavel = false, config = null, preco = 50 } = {}) => {
    const { rows: [r] } = await q(
      `INSERT INTO products (company_id, name, sku, price, cost_price, is_active, stock_qty,
                             is_personalizable, customization_config)
       VALUES ($1, $2, $3, $4, 10, true, $5, $6, $7::jsonb) RETURNING id`,
      [empresa, `Peca P184 ${chave}`, `SKU-P184-${chave}-${uuid().slice(0, 8)}`, preco, estoque,
        personalizavel, config]);
    ids[chave] = r.id;
  };
  await produto('blusa', { estoque: 5 });
  await produto('caneca', { estoque: 0, personalizavel: true, config: CONFIG, preco: 40 });

  // Insumo da caneca: 10 em estoque, 1 por peca.
  const { rows: [insumo] } = await q(
    `INSERT INTO studio_inputs (company_id, name, stock_qty) VALUES ($1, 'Caneca branca P184', 10) RETURNING id`,
    [empresa]);
  ids.insumo = insumo.id;
  const { rows: [comp] } = await q(
    `INSERT INTO studio_compositions (company_id, product_id) VALUES ($1, $2) RETURNING id`,
    [empresa, ids.caneca]);
  await q(`INSERT INTO studio_composition_items (composition_id, input_id, qty_per_unit) VALUES ($1, $2, 1)`,
    [comp.id, ids.insumo]);

  // slug (migration 119 da loja) existe em producao mas nao tem .sql no
  // repo; criado aqui, dentro da transacao revertida.
  await q(`ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS slug text`);
  // Banco recriado do zero (CI): a 070 cria digital_order_sequences sem
  // updated_at e a next_digital_order_number() da 273 grava a coluna (ver
  // studio.converterOrcamento.banco.test.js). Em producao ela existe.
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await statusComoEmProducao();
  // variant_id do item existe em producao (uuid, conferido em 17/11/2026)
  // sem .sql no repo; o schema do CI nasce sem ela.
  await q(`ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS variant_id uuid`);
  await q(`INSERT INTO digital_channel_config (company_id, slug, is_published, pix_key, pickup_enabled)
           VALUES ($1, $2, true, 'chave@p184.test', true)`, [empresa, slug]);
});

afterAll(async () => {
  await fila;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/storefront', require('../src/routes/storefront'));
  return a;
}

const pedir = (items) => request(app()).post(`/storefront/${slug}/order`).send({
  customer_name: 'Cliente P184', customer_phone: '11999990184', delivery_type: 'pickup',
  payment_method: 'pix', items,
});

async function pedido(id) {
  const { rows: [o] } = await q(
    `SELECT vertical, studio_production_status, status, subtotal, total, notes, stock_deducted
       FROM digital_orders WHERE id = $1`, [id]);
  const { rows: itens } = await q(
    `SELECT product_id, variant_id, quantity, unit_price, subtotal, customization, art_review_status
       FROM digital_order_items WHERE order_id = $1 ORDER BY product_name`, [id]);
  return { ...o, itens };
}
async function insumo() {
  const { rows: [r] } = await q(`SELECT stock_qty FROM studio_inputs WHERE id = $1`, [ids.insumo]);
  return Number(r.stock_qty);
}
const envelhecer = (id, horas) => q(
  `UPDATE digital_orders SET created_at = NOW() - ($2 || ' hours')::interval WHERE id = $1`, [id, String(horas)]);

async function rodarJob() {
  const { tickCancelarPixVencido } = require('../src/jobs/lojaPixExpiradoJob');
  return tickCancelarPixVencido({
    db: { query: (sql, params) => q(sql, params) },
    lojaEvents: { emitLojaEvent: jest.fn(async () => null) },
  });
}

test('pedido misto: um pedido so, na Fila, com o personalizado de saldo 0', async () => {
  const antes = await insumo();
  const r = await pedir([
    { product_id: ids.blusa, quantity: 2 },
    { product_id: ids.caneca, quantity: 3, customization: { nome: 'Ana' } },
  ]);
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ personalizado: true, studio_production_status: 'pending_art', subtotal: 220 });
  expect(r.body.itens).toEqual([
    { product_id: ids.blusa, variant_id: null, unit_price: 50 },
    { product_id: ids.caneca, variant_id: null, unit_price: 40, subtotal: 120, personalizado: true },
  ]);

  const o = await pedido(r.body.order_id);
  expect(o).toMatchObject({ vertical: 'studio', studio_production_status: 'pending_art', status: 'pending_payment' });
  const [blusa, caneca] = o.itens;
  expect(blusa).toMatchObject({ product_id: ids.blusa, customization: null, art_review_status: null });
  expect(caneca).toMatchObject({
    product_id: ids.caneca, variant_id: null, quantity: 3, customization: { nome: 'Ana' }, art_review_status: null,
  });
  expect(Number(caneca.subtotal)).toBe(120);
  // O insumo saiu na entrada do item (3 canecas).
  expect(await insumo()).toBe(antes - 3);

  // 50 h: o so de prateleira ja teria caido; este espera as 72 h.
  await envelhecer(r.body.order_id, 50);
  await rodarJob();
  expect((await pedido(r.body.order_id)).status).toBe('pending_payment');

  // 73 h: cancela, com o texto das 72 h, e o insumo volta.
  await envelhecer(r.body.order_id, 73);
  await rodarJob();
  const cancelado = await pedido(r.body.order_id);
  expect(cancelado.status).toBe('cancelled');
  expect(cancelado.notes).toMatch(/Pix sem pagamento em 72 h/);
  expect(await insumo()).toBe(antes);
});

test('etapa: item sem arte nem texto -> awaiting_customization; arte propria -> triagem pendente', async () => {
  const semNada = await pedir([{ product_id: ids.caneca, quantity: 1, customization: {} }]);
  expect(semNada.status).toBe(201);
  expect(semNada.body.studio_production_status).toBe('awaiting_customization');
  expect((await pedido(semNada.body.order_id)).studio_production_status).toBe('awaiting_customization');

  const comArte = await pedir([
    { product_id: ids.caneca, quantity: 1, customization: { foto: 'https://cdn.test/arte.png' } },
  ]);
  expect(comArte.status).toBe(201);
  const o = await pedido(comArte.body.order_id);
  expect(o.studio_production_status).toBe('pending_art');
  expect(o.itens[0].art_review_status).toBe('pendente');
});

test('cancelamento pela lojista devolve o insumo do pedido da loja comum', async () => {
  const antes = await insumo();
  const r = await pedir([{ product_id: ids.caneca, quantity: 2, customization: { nome: 'Bia' } }]);
  expect(r.status).toBe(201);
  expect(await insumo()).toBe(antes - 2);
  await q(`UPDATE digital_orders SET status = 'cancelled' WHERE id = $1`, [r.body.order_id]);
  expect(await insumo()).toBe(antes);
});

test('so de prateleira: sem vertical, sem etapa, cancela em 48 h', async () => {
  const r = await pedir([{ product_id: ids.blusa, quantity: 1 }]);
  expect(r.status).toBe(201);
  expect(r.body).not.toHaveProperty('personalizado');
  const o = await pedido(r.body.order_id);
  expect(o).toMatchObject({ vertical: null, studio_production_status: null });
  expect(o.itens[0]).toMatchObject({ customization: null, art_review_status: null });

  await envelhecer(r.body.order_id, 49);
  await rodarJob();
  const cancelado = await pedido(r.body.order_id);
  expect(cancelado.status).toBe('cancelled');
  expect(cancelado.notes).toMatch(/Pix sem pagamento em 48 h/);
});

test('testemunha: sem a vertical (antes do p-184), o cancelamento nao devolvia o insumo', async () => {
  const antes = await insumo();
  const { rows: [o] } = await q(
    `INSERT INTO digital_orders (company_id, order_number, customer_name, customer_phone, subtotal, total,
                                 status, payment_method)
     VALUES ($1, next_digital_order_number($1), 'Antes', '11900000000', 40, 40, 'pending_payment', 'pix')
     RETURNING id`, [empresa]);
  await q(`INSERT INTO digital_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal)
           VALUES ($1, $2, 'Caneca', 40, 1, 40)`, [o.id, ids.caneca]);
  expect(await insumo()).toBe(antes - 1);
  await q(`UPDATE digital_orders SET status = 'cancelled' WHERE id = $1`, [o.id]);
  expect(await insumo()).toBe(antes - 1);
});
