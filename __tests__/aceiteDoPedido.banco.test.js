// ============================================================
// AURA. — Pagar na entrega com aceite — Postgres real (tq-44, 29/10/2026)
// services/aceiteDoPedido.js
//
// Regra aprovada pela Nina (19/10):
//   1. pedido 'aguardando_aceite' nao baixou estoque nem lancou nada;
//   2. o ACEITE baixa o estoque e lanca A RECEBER na forma escolhida;
//   3. aceitar duas vezes — e dois aceites ao mesmo tempo — baixam UMA vez;
//   4. RECUSAR nao mexe em estoque nem no Financeiro;
//   5. ENTREGUE quita o a receber;
//   6. CANCELADO depois do aceite devolve o estoque e estorna o a receber.
//
// Fixtures com uuid proprio, apagadas no afterAll (padrao de
// canal.cancelarDevolveEstoque.banco.test.js). O cancelamento do item 6 e
// um UPDATE direto mais a devolucao e o estorno, como a rota faz — a rota
// mexe em payment_status, que no banco do CI ainda e o ENUM da 070.
// ============================================================
'use strict';

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
let aceite;
let devolverEstoqueDoPedido;

const userId = uuid();
const companyId = uuid();
const outraEmpresa = uuid();
// Loja com "pagar na entrega" ligado e SEM formas marcadas (fluxo de hoje).
const lojaSemFormas = uuid();
const produtoSemFormas = uuid();
const produto = uuid();
const clienteId = uuid();
let seq = 0;

async function saldo() {
  const { rows } = await pool.query('SELECT stock_qty FROM products WHERE id = $1', [produto]);
  return Number(rows[0].stock_qty);
}
async function pedido(id) {
  const { rows } = await pool.query(
    `SELECT status, stock_deducted, transaction_id, accepted_at, prep_minutes, cancel_kind, cancel_reason
       FROM digital_orders WHERE id = $1`, [id]);
  return rows[0];
}
async function lancamento(id) {
  const { rows } = await pool.query(
    'SELECT status, amount::numeric AS amount, paid_at, payment_method FROM transactions WHERE id = $1', [id]);
  return rows[0] ? { ...rows[0], amount: Number(rows[0].amount) } : null;
}

/**
 * Pedido pago online (Pix confirmado, baixa ja feita) ainda sem aceite.
 * naFila = o checkout o marcou (loja ja usava a fila quando ele nasceu);
 * false = pedido do historico, pago antes de a loja ligar as formas.
 */
async function criarPedidoPago({ qtd = 1, naFila = true, empresa = companyId, prod = produto } = {}) {
  const id = uuid();
  seq += 1;
  await pool.query(
    `INSERT INTO digital_orders
       (id, company_id, order_number, customer_name, customer_phone,
        subtotal, total, status, payment_status, payment_method, stock_deducted, aceite_na_fila, customer_id)
     VALUES ($1, $2, $3, 'Cliente Fixture', '11999990000',
             39, 39, 'confirmed', 'paid', 'pix', TRUE, $4, $5)`,
    [id, empresa, 'PX-' + String(seq).padStart(4, '0'), naFila ? true : null,
      empresa === companyId ? clienteId : null]
  );
  await pool.query(
    `INSERT INTO digital_order_items
       (order_id, product_id, product_name, unit_price, quantity, subtotal)
     VALUES ($1, $2, 'Cerveja', 39, $3, 39 * $3)`,
    [id, prod, qtd]
  );
  // A baixa do pagamento, como a confirmacao faria.
  await pool.query('UPDATE products SET stock_qty = stock_qty - $1 WHERE id = $2', [qtd, prod]);
  return id;
}

async function pedidoCompleto(id) {
  const { rows } = await pool.query(
    'SELECT status, accepted_at, cancel_kind, stock_deducted FROM digital_orders WHERE id = $1', [id]);
  return rows[0];
}

/** Pedido de pagar na entrega esperando aceite, com um item. */
async function criarPedido({ qtd = 2, forma = 'cash', trocoPara = 100 } = {}) {
  const id = uuid();
  seq += 1;
  // Cliente ja ligado: o assunto e baixa e lancamento, nao o cadastro.
  await pool.query(
    `INSERT INTO digital_orders
       (id, company_id, order_number, customer_name, customer_phone,
        subtotal, total, status, payment_method, customer_id,
        pay_on_delivery_method, change_for)
     VALUES ($1, $2, $3, 'Cliente Fixture', '11999990000',
             78, 78, 'aguardando_aceite', 'on_delivery', $4, $5, $6)`,
    [id, companyId, 'NE-' + String(seq).padStart(4, '0'), clienteId, forma, trocoPara]
  );
  await pool.query(
    `INSERT INTO digital_order_items
       (order_id, product_id, product_name, unit_price, quantity, subtotal)
     VALUES ($1, $2, 'Cerveja', 39, $3, 39 * $3)`,
    [id, produto, qtd]
  );
  return id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  aceite = require('../src/services/aceiteDoPedido');
  ({ devolverEstoqueDoPedido } = require('../src/services/devolucaoDoEstoqueDoPedido'));

  // Colunas que existem em producao e que nenhuma migration do repo cria
  // (o banco do CI e montado so pelas migrations). Idempotente.
  await pool.query('ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS variant_id UUID');
  await pool.query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method VARCHAR');

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Entrega')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Entrega'), ($3, $2, 'Outra Fixture'), ($4, $2, 'Loja Sem Formas')`,
    [companyId, userId, outraEmpresa, lojaSemFormas]
  );
  // A loja do piloto com as formas marcadas; a outra so com o pagar na
  // entrega de hoje (formas NULL).
  await pool.query(
    `INSERT INTO digital_channel_config (company_id, pay_on_delivery_enabled, pay_on_delivery_methods)
     VALUES ($1, TRUE, ARRAY['cash','card']), ($2, TRUE, NULL)`,
    [companyId, lojaSemFormas]
  );
  await pool.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Cerveja', 39, 20)`,
    [produtoSemFormas, lojaSemFormas]
  );
  await pool.query(
    `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Fixture')`,
    [clienteId, companyId]
  );
  await pool.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Cerveja', 39, 20)`,
    [produto, companyId]
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
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = $1)`, [lojaSemFormas]],
    [`DELETE FROM digital_orders WHERE company_id = $1`, [lojaSemFormas]],
    [`DELETE FROM digital_channel_config WHERE company_id IN ($1, $2)`, [companyId, lojaSemFormas]],
    [`DELETE FROM products WHERE company_id IN ($1, $2)`, [companyId, lojaSemFormas]],
    [`DELETE FROM companies WHERE id IN ($1, $2, $3)`, [companyId, outraEmpresa, lojaSemFormas]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI e descartavel */ }
  }
  await pool.end();
});

describe('pedido esperando aceite', () => {
  test('nasce sem baixa e sem lancamento', async () => {
    const antes = await saldo();
    const id = await criarPedido();
    expect(await saldo()).toBe(antes);
    expect(await pedido(id)).toMatchObject({ status: 'aguardando_aceite', stock_deducted: false, transaction_id: null });
  });
});

describe('aceite', () => {
  test('baixa o estoque e lanca a receber em dinheiro, com o tempo de preparo', async () => {
    const antes = await saldo();
    const id = await criarPedido({ qtd: 2 });

    const r = await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 45 });
    expect(r.jaAceito).toBe(false);
    expect(r.order.status).toBe('preparing');

    expect(await saldo()).toBe(antes - 2);
    const p = await pedido(id);
    expect(p).toMatchObject({ status: 'preparing', stock_deducted: true, prep_minutes: 45 });
    expect(p.accepted_at).toBeTruthy();
    expect(await lancamento(p.transaction_id)).toMatchObject({
      status: 'pending', amount: 78, paid_at: null, payment_method: 'dinheiro',
    });
  });

  test('cartao e Pix na entrega lancam na forma escolhida', async () => {
    const idCartao = await criarPedido({ forma: 'card', trocoPara: null });
    const idPix = await criarPedido({ forma: 'pix', trocoPara: null });
    await aceite.aceitarPedido({ orderId: idCartao, companyId, prepMinutes: 30 });
    await aceite.aceitarPedido({ orderId: idPix, companyId, prepMinutes: 30 });
    expect((await lancamento((await pedido(idCartao)).transaction_id)).payment_method).toBe('cartao');
    expect((await lancamento((await pedido(idPix)).transaction_id)).payment_method).toBe('pix');
  });

  test('aceitar duas vezes baixa uma vez e o segundo responde "ja aceito"', async () => {
    const antes = await saldo();
    const id = await criarPedido({ qtd: 1 });
    await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    const segundo = await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 60 });
    expect(segundo.jaAceito).toBe(true);
    expect(await saldo()).toBe(antes - 1);
    expect((await pedido(id)).prep_minutes).toBe(30);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, ['digital-order-' + id]);
    expect(rows[0].n).toBe(1);
  });

  test('dois aceites ao mesmo tempo baixam uma vez', async () => {
    const antes = await saldo();
    const id = await criarPedido({ qtd: 3 });
    const rs = await Promise.all([
      aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 }),
      aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 }),
    ]);
    expect(rs.filter((r) => r.jaAceito).length).toBe(1);
    expect(await saldo()).toBe(antes - 3);
  });

  test('outra empresa nao aceita o pedido', async () => {
    const id = await criarPedido();
    await expect(aceite.aceitarPedido({ orderId: id, companyId: outraEmpresa, prepMinutes: 30 }))
      .rejects.toMatchObject({ status: 404 });
    expect((await pedido(id)).status).toBe('aguardando_aceite');
  });

  test('tempo de preparo fora da faixa e recusado sem mexer em nada', async () => {
    const antes = await saldo();
    const id = await criarPedido();
    await expect(aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 2 }))
      .rejects.toMatchObject({ status: 400 });
    expect(await saldo()).toBe(antes);
    expect((await pedido(id)).status).toBe('aguardando_aceite');
  });
});

describe('recusa', () => {
  test('cancela com o motivo e nao mexe em estoque nem no Financeiro', async () => {
    const antes = await saldo();
    const id = await criarPedido();
    const o = await aceite.recusarPedido({ orderId: id, companyId, motivo: 'Acabou o gelo' });
    expect(o.status).toBe('cancelled');
    expect(await pedido(id)).toMatchObject({
      status: 'cancelled', cancel_kind: 'recusado_pela_loja', cancel_reason: 'Acabou o gelo',
      stock_deducted: false, transaction_id: null,
    });
    expect(await devolverEstoqueDoPedido(id)).toEqual({ devolvido: false, motivo: 'sem_baixa' });
    expect(await saldo()).toBe(antes);
  });

  test('pedido recusado nao pode ser aceito depois', async () => {
    const id = await criarPedido();
    await aceite.recusarPedido({ orderId: id, companyId, motivo: 'Fora da área' });
    await expect(aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 }))
      .rejects.toMatchObject({ status: 409 });
  });

  test('pedido ja aceito nao e recusado por engano', async () => {
    const id = await criarPedido();
    await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    await expect(aceite.recusarPedido({ orderId: id, companyId, motivo: 'x' }))
      .rejects.toMatchObject({ status: 409 });
    expect((await pedido(id)).status).toBe('preparing');
  });

  test('recusa sem motivo e barrada', async () => {
    const id = await criarPedido();
    await expect(aceite.recusarPedido({ orderId: id, companyId, motivo: '  ' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('entregue e cancelado depois do aceite', () => {
  test('entregue quita o a receber', async () => {
    const id = await criarPedido();
    const { order } = await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    await pool.query(`UPDATE digital_orders SET status = 'delivered' WHERE id = $1`, [id]);
    expect(await aceite.quitarNaEntrega(order)).toBe(true);
    const l = await lancamento(order.transaction_id);
    expect(l.status).toBe('confirmed');
    expect(l.paid_at).toBeTruthy();
    // Quitar de novo nao muda nada.
    expect(await aceite.quitarNaEntrega(order)).toBe(false);
  });

  test('cancelado depois do aceite devolve o estoque e estorna o a receber', async () => {
    const antes = await saldo();
    const id = await criarPedido({ qtd: 2 });
    const { order } = await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    expect(await saldo()).toBe(antes - 2);

    await pool.query(
      `UPDATE digital_orders SET status = 'cancelled', cancelled_at = NOW(), cancel_kind = 'cancelado_pela_loja'
        WHERE id = $1`, [id]);
    expect(await devolverEstoqueDoPedido(id)).toEqual({ devolvido: true, itens: 1 });
    expect(await aceite.estornarAReceber(order)).toBe(true);

    expect(await saldo()).toBe(antes);
    expect((await lancamento(order.transaction_id)).status).toBe('cancelled');
  });
});

// ── tq-47: fila do pedido ──────────────────────────────────
describe('fila do pedido (tq-47)', () => {
  test('Pix pago entra na fila: aceitar poe o tempo e nao baixa de novo', async () => {
    const id = await criarPedidoPago({ qtd: 2 });
    const antes = await saldo();
    const r = await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    expect(r.jaAceito).toBe(false);
    expect(await saldo()).toBe(antes);
    expect(await pedido(id)).toMatchObject({ status: 'preparing', prep_minutes: 30, stock_deducted: true });
  });

  test('Pix pago recusado: cancela e devolve o estoque', async () => {
    const id = await criarPedidoPago({ qtd: 2 });
    const antes = await saldo();
    await aceite.recusarPedido({ orderId: id, companyId, motivo: 'Acabou' });
    expect(await devolverEstoqueDoPedido(id)).toEqual({ devolvido: true, itens: 1 });
    expect(await saldo()).toBe(antes + 2);
    const o = await aceite.marcarDevolvido({ orderId: id, companyId });
    expect(o.refund_marked_at).toBeTruthy();
  });

  test('saiu para entrega: so depois do aceite, e duas vezes marca uma', async () => {
    const id = await criarPedido();
    await expect(aceite.saiuParaEntrega({ orderId: id, companyId })).rejects.toMatchObject({ status: 409 });
    await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    const r1 = await aceite.saiuParaEntrega({ orderId: id, companyId });
    expect(r1).toMatchObject({ jaSaiu: false, order: { status: 'out_for_delivery' } });
    expect(r1.order.out_for_delivery_at).toBeTruthy();
    const r2 = await aceite.saiuParaEntrega({ orderId: id, companyId });
    expect(r2.jaSaiu).toBe(true);
  });

  test('marcar devolvido em pedido em andamento: 409', async () => {
    const id = await criarPedido();
    await expect(aceite.marcarDevolvido({ orderId: id, companyId })).rejects.toMatchObject({ status: 409 });
  });
});

// ── revisao do #930: o historico nao vira "pago esperando aceite" ──
describe('pago sem aceite: so o que nasceu na fila, em loja que ainda usa a fila', () => {
  test('(1) loja sem formas marcadas: pedido pago nao e aceito nem recusado pela fila', async () => {
    const id = await criarPedidoPago({ empresa: lojaSemFormas, prod: produtoSemFormas, naFila: true });
    await expect(aceite.aceitarPedido({ orderId: id, companyId: lojaSemFormas, prepMinutes: 30 }))
      .rejects.toMatchObject({ status: 409 });
    await expect(aceite.recusarPedido({ orderId: id, companyId: lojaSemFormas, motivo: 'x' }))
      .rejects.toMatchObject({ status: 409 });
    expect(await pedidoCompleto(id)).toMatchObject({ status: 'confirmed', accepted_at: null, cancel_kind: null, stock_deducted: true });
  });

  test('(2) loja com formas: pedido pago ANTES de ligar as formas fica como esta', async () => {
    const antes = await saldo();
    const id = await criarPedidoPago({ naFila: false });
    const depoisDaBaixa = await saldo();
    await expect(aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 }))
      .rejects.toMatchObject({ status: 409 });
    await expect(aceite.recusarPedido({ orderId: id, companyId, motivo: 'x' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/não está esperando aceite/) });
    expect(await pedidoCompleto(id)).toMatchObject({ status: 'confirmed', accepted_at: null, cancel_kind: null });
    expect(await saldo()).toBe(depoisDaBaixa);
    expect(depoisDaBaixa).toBe(antes - 1);
  });

  test('a marca do checkout: marcarNaFila grava aceite_na_fila', async () => {
    const id = await criarPedidoPago({ naFila: false });
    expect(await aceite.marcarNaFila(id)).toBe(true);
    const { rows } = await pool.query('SELECT aceite_na_fila FROM digital_orders WHERE id = $1', [id]);
    expect(rows[0].aceite_na_fila).toBe(true);
    // Agora sim e "pago esperando aceite".
    const r = await aceite.aceitarPedido({ orderId: id, companyId, prepMinutes: 30 });
    expect(r.order.status).toBe('preparing');
  });
});
