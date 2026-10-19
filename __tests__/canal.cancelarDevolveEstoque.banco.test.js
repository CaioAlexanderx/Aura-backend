// ============================================================
// AURA. — Pedido do Canal cancelado devolve o estoque — Postgres real
// (19/10/2026, services/devolucaoDoEstoqueDoPedido.js)
//
// A baixa do pedido do Canal acontece na confirmacao (onOrderConfirmed) e
// nenhum cancelamento devolvia. Aqui, com o banco de verdade:
//   1. pedido pago e cancelado pelo painel devolve, com a entrada em
//      stock_movements apontando para o pedido;
//   2. Pix expirado (nunca baixou) nao devolve nada;
//   3. cancelar duas vezes — e dois cancelamentos ao mesmo tempo —
//      devolvem UMA vez;
//   4. item com variante devolve na variante, nao no produto pai.
//
// Fixtures com uuid proprio, apagadas no afterAll (padrao de
// vendas.idempotencia.banco.test.js).
//
// O cancelamento aqui e um UPDATE direto, e nao a rota nem o job: no banco
// do CI (montado so pelas migrations) digital_orders.status e
// payment_status ainda sao os ENUMs da 070, sem 'expired'/'confirmed' em
// payment_status; em producao as colunas sao text. O CASE da rota
// (`THEN 'confirmed'`) e o UPDATE do job (`payment_status = 'expired'`)
// quebram nesse schema antes de chegar no estoque. A ligacao rota/job ->
// devolucao esta em canal.cancelarDevolveEstoque.test.js (banco de mentira).
// ============================================================
'use strict';

// Efeitos colaterais que nao sao o assunto: sino, e-mail e NFC-e.
jest.mock('../src/services/lojaEvents', () => ({
  emit: jest.fn(), emitLojaEvent: jest.fn(async () => null),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/nfceEmissionService', () => ({
  emitForDigitalOrder: jest.fn(async () => ({ skipped: true, reason: 'teste' })),
}));

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let onOrderConfirmed;
let devolverEstoqueDoPedido;

const userId = uuid();
const companyId = uuid();
const produtoSimples = uuid();
const produtoComGrade = uuid();
const variante = uuid();
let seq = 0;

async function saldoDoProduto(id) {
  const { rows } = await pool.query('SELECT stock_qty FROM products WHERE id = $1', [id]);
  return Number(rows[0].stock_qty);
}
async function saldoDaVariante(id) {
  const { rows } = await pool.query('SELECT stock_qty FROM product_variants WHERE id = $1', [id]);
  return Number(rows[0].stock_qty);
}
async function pedido(id) {
  const { rows } = await pool.query('SELECT status, stock_deducted FROM digital_orders WHERE id = $1', [id]);
  return rows[0];
}
async function entradas(orderId) {
  const { rows } = await pool.query(
    `SELECT product_id, company_id, type, quantity::numeric AS quantity
       FROM stock_movements
      WHERE reference_type = 'digital_order_cancel' AND reference_id = $1`,
    [orderId]
  );
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
}

/** Cria um pedido com um item. `criadoHa` em horas (para o Pix vencido). */
async function criarPedido({ status, paymentMethod = 'pix', productId, variantId = null, qtd, criadoHa = 0 }) {
  const id = uuid();
  seq += 1;
  await pool.query(
    `INSERT INTO digital_orders
       (id, company_id, order_number, customer_name, customer_phone,
        subtotal, total, status, payment_method, created_at)
     VALUES ($1, $2, $3, 'Cliente Fixture', '11999990000',
             10, 10, $4, $5, NOW() - ($6 || ' hours')::interval)`,
    [id, companyId, 'FX-' + String(seq).padStart(4, '0'), status, paymentMethod, String(criadoHa)]
  );
  await pool.query(
    `INSERT INTO digital_order_items
       (order_id, product_id, variant_id, product_name, unit_price, quantity, subtotal)
     VALUES ($1, $2, $3, 'Fixture', 5, $4, 5 * $4)`,
    [id, productId, variantId, qtd]
  );
  return id;
}

// O que a rota e o job gravam, menos o payment_status (ver cabecalho).
// cancel_kind preenchido: e o que a rota grava, e evita o CASE do trigger
// da 359 que compara payment_status com 'expired'.
async function cancelar(orderId, kind = 'cancelado_pela_loja') {
  await pool.query(
    `UPDATE digital_orders SET status = 'cancelled', cancelled_at = NOW(), cancel_kind = $2
      WHERE id = $1 AND status <> 'cancelled'`,
    [orderId, kind]
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  ({ onOrderConfirmed } = require('../src/services/digitalOrderConfirmation'));
  ({ devolverEstoqueDoPedido } = require('../src/services/devolucaoDoEstoqueDoPedido'));

  // digital_order_items.variant_id existe em producao (o pedido com grade
  // grava) mas nenhuma migration do repo a cria: o banco do CI, montado
  // so pelas migrations, nao a tem. Idempotente; nao-op onde ja existe.
  await pool.query('ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS variant_id UUID');

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Canal')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Canal')`,
    [companyId, userId]
  );
  await pool.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Cerveja', 5, 10)`,
    [produtoSimples, companyId]
  );
  await pool.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Camiseta', 5, 7)`,
    [produtoComGrade, companyId]
  );
  await pool.query(
    `INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty) VALUES ($1, $2, 'AZ-M', 5)`,
    [variante, produtoComGrade]
  );

});

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  const limpar = [
    [`DELETE FROM stock_movements WHERE company_id = $1`, [companyId]],
    [`DELETE FROM transactions WHERE company_id = $1`, [companyId]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = $1)`, [companyId]],
    [`DELETE FROM digital_orders WHERE company_id = $1`, [companyId]],
    [`DELETE FROM customers WHERE company_id = $1`, [companyId]],
    [`DELETE FROM product_variants WHERE product_id IN ($1, $2)`, [produtoSimples, produtoComGrade]],
    [`DELETE FROM products WHERE company_id = $1`, [companyId]],
    [`DELETE FROM companies WHERE id = $1`, [companyId]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI e descartavel */ }
  }
  await pool.end();
});

describe('pedido pago e cancelado devolve o estoque', () => {
  let orderId;

  test('pago: a confirmacao baixa; cancelar devolve e registra a entrada', async () => {
    const antes = await saldoDoProduto(produtoSimples);
    orderId = await criarPedido({ status: 'confirmed', productId: produtoSimples, qtd: 2 });

    await onOrderConfirmed(orderId);
    expect(await saldoDoProduto(produtoSimples)).toBe(antes - 2);
    expect((await pedido(orderId)).stock_deducted).toBe(true);

    await cancelar(orderId);
    expect(await devolverEstoqueDoPedido(orderId)).toEqual({ devolvido: true, itens: 1 });

    expect(await saldoDoProduto(produtoSimples)).toBe(antes);
    expect(await pedido(orderId)).toEqual({ status: 'cancelled', stock_deducted: false });
    expect(await entradas(orderId)).toEqual([
      { product_id: produtoSimples, company_id: companyId, type: 'in', quantity: 2 },
    ]);
  });

  test('cancelar de novo nao devolve de novo', async () => {
    const saldo = await saldoDoProduto(produtoSimples);
    await cancelar(orderId);
    expect(await devolverEstoqueDoPedido(orderId)).toEqual({ devolvido: false, motivo: 'sem_baixa' });
    expect(await saldoDoProduto(produtoSimples)).toBe(saldo);
    expect(await entradas(orderId)).toHaveLength(1);
  });
});

describe('dois cancelamentos ao mesmo tempo devolvem uma vez', () => {
  test('a linha travada e o marcador zerado na mesma transacao', async () => {
    const antes = await saldoDoProduto(produtoSimples);
    const orderId = await criarPedido({ status: 'confirmed', paymentMethod: 'on_delivery', productId: produtoSimples, qtd: 3 });
    await onOrderConfirmed(orderId);
    expect(await saldoDoProduto(produtoSimples)).toBe(antes - 3);

    await cancelar(orderId);
    const resultados = await Promise.all([
      devolverEstoqueDoPedido(orderId), devolverEstoqueDoPedido(orderId), devolverEstoqueDoPedido(orderId),
    ]);

    expect(resultados.filter((x) => x.devolvido)).toHaveLength(1);
    expect(await saldoDoProduto(produtoSimples)).toBe(antes);
    expect(await entradas(orderId)).toHaveLength(1);
  });
});

describe('Pix expirado sem baixa nao devolve', () => {
  test('cancelado sem nunca ter sido pago: o saldo fica igual e nada entra em stock_movements', async () => {
    const antes = await saldoDoProduto(produtoSimples);
    const orderId = await criarPedido({ status: 'pending_payment', productId: produtoSimples, qtd: 4, criadoHa: 49 });

    await cancelar(orderId, 'pix_expirado');
    expect(await devolverEstoqueDoPedido(orderId)).toEqual({ devolvido: false, motivo: 'sem_baixa' });

    expect(await pedido(orderId)).toEqual({ status: 'cancelled', stock_deducted: false });
    expect(await saldoDoProduto(produtoSimples)).toBe(antes);
    expect(await entradas(orderId)).toEqual([]);
  });

  test('pedido ainda nao cancelado nunca devolve', async () => {
    const orderId = await criarPedido({ status: 'confirmed', productId: produtoSimples, qtd: 1 });
    await onOrderConfirmed(orderId);
    const saldo = await saldoDoProduto(produtoSimples);
    expect(await devolverEstoqueDoPedido(orderId)).toEqual({ devolvido: false, motivo: 'nao_cancelado' });
    expect(await saldoDoProduto(produtoSimples)).toBe(saldo);
  });
});

describe('variante devolve na variante', () => {
  test('a baixa e a devolucao mexem so na variante; a entrada aponta o produto', async () => {
    const pai = await saldoDoProduto(produtoComGrade);
    const antes = await saldoDaVariante(variante);
    const orderId = await criarPedido({ status: 'confirmed', productId: produtoComGrade, variantId: variante, qtd: 3 });

    await onOrderConfirmed(orderId);
    expect(await saldoDaVariante(variante)).toBe(antes - 3);
    expect(await saldoDoProduto(produtoComGrade)).toBe(pai);

    await cancelar(orderId);
    expect((await devolverEstoqueDoPedido(orderId)).devolvido).toBe(true);

    expect(await saldoDaVariante(variante)).toBe(antes);
    expect(await saldoDoProduto(produtoComGrade)).toBe(pai);
    expect(await entradas(orderId)).toEqual([
      { product_id: produtoComGrade, company_id: companyId, type: 'in', quantity: 3 },
    ]);
  });
});
