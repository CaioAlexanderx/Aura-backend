// ============================================================
// AURA CRÉDITO — cancelar a devolução desfaz a devolução
// (Postgres real, 16/09/2026)
//
// O CASO REAL (MHT / Karina Quadros): o lojista removeu o Vans 42/43 pelo
// "Editar lançamento" (vira devolução no crediário), cancelou a devolução,
// removeu de novo, cancelou de novo. Cancelar só marcava a linha: ficaram
// R$ 240 de crédito fantasma e 2 tênis a mais no estoque.
//
// O que este arquivo cobre, cada cenário num cliente próprio:
//   1. devolução que abateu parcela e A Receber: cancelar devolve TUDO ao
//      estado anterior (estoque, crédito, parcelas, A Receber, saldo)
//   2. parcela paga depois da devolução não é atropelada
//   3. devolução antiga (sem registro) em venda COM parcela: 409
//   4. devolução antiga em venda SEM parcela (o caso da Karina): desfaz
//   5. activeReturnsOf enxerga a devolução só enquanto ela está ativa
//
// Tudo dentro de UMA transação revertida no afterAll — zero resíduo.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let refund;

const userId    = uuid();
const companyId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  // O pool global é mock no Jest; as sondagens de coluna (refund_abatement,
  // reference_*) passam pelo mesmo client da transação.
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  refund = require('../src/services/credit/refund');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Devolução')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja Devolução')`,
    [companyId, userId]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function produto(nome, estoque) {
  const id = uuid();
  await client.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, 120, $4)`,
    [id, companyId, nome, estoque]
  );
  return id;
}

/**
 * Venda no crediário já fechada: itens, débito, A Receber e parcelas.
 * @param parcelas  lista de valores (vazia = venda sem parcela, "Conta geral")
 */
async function vendaCrediario({ itens, parcelas }) {
  const customerId = uuid();
  await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente')`, [customerId, companyId]);
  const saleId = uuid();
  const total = itens.reduce((a, i) => a + i.preco, 0);
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount, payment_method, status, type)
     VALUES ($1, $2, $3, $4, 'crediario', 'completed', 'sale')`,
    [saleId, companyId, customerId, total]
  );
  const itemIds = [];
  for (const i of itens) {
    const id = uuid();
    await client.query(
      `INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price, total_price, product_name_snapshot)
       VALUES ($1, $2, $3, 1, $4, $4, $5)`,
      [id, saleId, i.productId, i.preco, i.nome]
    );
    itemIds.push(id);
  }
  await client.query(
    `INSERT INTO customer_credit_transactions (company_id, customer_id, sale_id, type, amount, notes, source)
     VALUES ($1, $2, $3, 'debit', $4, 'Venda no crediario', 'sale')`,
    [companyId, customerId, saleId, total]
  );
  await client.query(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, idempotency_key)
     VALUES ($1, 'income', 'pending', $2, 'Crediario', 'Crediario - A Receber', CURRENT_DATE, $3)`,
    [companyId, total, 'pdv-credit-receivable-' + saleId]
  );
  const instIds = [];
  for (let n = 0; n < parcelas.length; n++) {
    const { rows } = await client.query(
      `INSERT INTO credit_installments
         (company_id, customer_id, sale_id, installment_number, total_installments, amount_due, covered_amount, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0, CURRENT_DATE + ($4 * 30), 'pending') RETURNING id`,
      [companyId, customerId, saleId, n + 1, parcelas.length, parcelas[n]]
    );
    instIds.push(rows[0].id);
  }
  return { customerId, saleId, itemIds, instIds };
}

async function devolver(saleId, saleItemId) {
  return refund.refundCreditSale(client, {
    companyId, saleId, items: [{ sale_item_id: saleItemId, quantity: 1 }],
    reason: 'Devolucao pela edicao do lancamento',
  });
}

async function cancelar(devolucaoSaleId) {
  const r = await refund.cancelDevolucao(client, { companyId, devolucaoSaleId });
  await client.query(`UPDATE sales SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [devolucaoSaleId]);
  return r;
}

const saldo = async (customerId) => {
  const { rows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  return parseFloat(rows[0]?.balance ?? 0);
};
const estoque = async (productId) =>
  parseFloat((await client.query(`SELECT stock_qty FROM products WHERE id = $1`, [productId])).rows[0].stock_qty);
const parcelas = async (saleId) =>
  (await client.query(
    `SELECT installment_number AS n, status, amount_due::float AS due, covered_amount::float AS cov
       FROM credit_installments WHERE sale_id = $1 ORDER BY installment_number`, [saleId]
  )).rows;
const aReceber = async (saleId) =>
  parseFloat((await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
      WHERE company_id = $1 AND status = 'pending' AND idempotency_key LIKE $2`,
    [companyId, 'pdv-credit-receivable-' + saleId + '%']
  )).rows[0].s);

// ── cenários ────────────────────────────────────────────────────────────────

test('1. desfaz estoque, crédito, parcelas e A Receber', async () => {
  const vans = await produto('VANS 42/43', 0);
  const sand = await produto('SANDALIA', 0);
  const v = await vendaCrediario({
    itens: [{ productId: vans, preco: 120, nome: 'VANS 42/43' }, { productId: sand, preco: 180, nome: 'SANDALIA' }],
    parcelas: [100, 100, 100],
  });

  const dev = await devolver(v.saleId, v.itemIds[0]);
  // A devolução abateu: 3a cancelada, 2a reduzida para 80; registro gravado.
  expect(await parcelas(v.saleId)).toEqual([
    { n: 1, status: 'pending', due: 100, cov: 0 },
    { n: 2, status: 'pending', due: 80, cov: 0 },
    { n: 3, status: 'cancelled', due: 100, cov: 0 },
  ]);
  expect(await estoque(vans)).toBe(1);
  expect(await saldo(v.customerId)).toBe(180);
  expect(await aReceber(v.saleId)).toBe(180);
  const { rows: [reg] } = await client.query(`SELECT refund_abatement FROM sales WHERE id = $1`, [dev.devolucao_sale_id]);
  expect(reg.refund_abatement.installments).toHaveLength(2);
  expect(reg.refund_abatement.receivables).toHaveLength(1);

  const r = await cancelar(dev.devolucao_sale_id);

  expect(r.credit_removed).toBe(120);
  expect(r.installments_skipped).toEqual([]);
  expect(await parcelas(v.saleId)).toEqual([
    { n: 1, status: 'pending', due: 100, cov: 0 },
    { n: 2, status: 'pending', due: 100, cov: 0 },
    { n: 3, status: 'pending', due: 100, cov: 0 },
  ]);
  expect(await estoque(vans)).toBe(0);
  expect(await saldo(v.customerId)).toBe(300);
  expect(await aReceber(v.saleId)).toBe(300);
  const { rows: mov } = await client.query(
    `SELECT type, quantity::float AS q FROM stock_movements WHERE reference_id = $1 ORDER BY created_at, type`,
    [dev.devolucao_sale_id]
  );
  expect(mov).toEqual(expect.arrayContaining([{ type: 'in', q: 1 }, { type: 'out', q: 1 }]));

  // Com a devolução cancelada, a mesma peça pode ser devolvida de novo --
  // e dessa vez o crédito não dobra.
  const dev2 = await devolver(v.saleId, v.itemIds[0]);
  expect(await saldo(v.customerId)).toBe(180);
  await cancelar(dev2.devolucao_sale_id);
  expect(await saldo(v.customerId)).toBe(300);
  expect(await estoque(vans)).toBe(0);
});

test('2. parcela paga depois da devolução não é atropelada', async () => {
  const vans = await produto('VANS 40/41', 0);
  const v = await vendaCrediario({
    itens: [{ productId: vans, preco: 120, nome: 'VANS 40/41' }, { productId: vans, preco: 180, nome: 'VANS 40/41 b' }],
    parcelas: [100, 100, 100],
  });
  const dev = await devolver(v.saleId, v.itemIds[0]);
  // Cliente pagou a 2a (já reduzida para 80) depois da devolução.
  await client.query(`UPDATE credit_installments SET status = 'paid', covered_amount = 80 WHERE id = $1`, [v.instIds[1]]);

  const r = await cancelar(dev.devolucao_sale_id);

  expect(r.installments_restored).toEqual([v.instIds[2]]);
  expect(r.installments_skipped).toEqual([v.instIds[1]]);
  const ps = await parcelas(v.saleId);
  expect(ps[1]).toEqual({ n: 2, status: 'paid', due: 80, cov: 80 });
  expect(ps[2]).toEqual({ n: 3, status: 'pending', due: 100, cov: 0 });
});

test('3. devolução antiga (sem registro) em venda com parcela: recusa', async () => {
  const vans = await produto('VANS 38/39', 0);
  const v = await vendaCrediario({
    itens: [{ productId: vans, preco: 120, nome: 'VANS 38/39' }],
    parcelas: [60, 60],
  });
  const dev = await devolver(v.saleId, v.itemIds[0]);
  await client.query(`UPDATE sales SET refund_abatement = NULL WHERE id = $1`, [dev.devolucao_sale_id]);

  await client.query('SAVEPOINT antes_da_recusa');
  await expect(refund.cancelDevolucao(client, { companyId, devolucaoSaleId: dev.devolucao_sale_id }))
    .rejects.toMatchObject({ status: 409, body: { code: 'DEVOLUCAO_SEM_REGISTRO' } });
  await client.query('ROLLBACK TO SAVEPOINT antes_da_recusa');

  // Nada mudou.
  expect(await estoque(vans)).toBe(1);
  expect(await saldo(v.customerId)).toBe(0);
});

test('4. devolução antiga em venda sem parcela (caso Karina): desfaz', async () => {
  const vans = await produto('VANS 42/43 K', 0);
  const v = await vendaCrediario({
    itens: [{ productId: vans, preco: 120, nome: 'VANS 42/43' }],
    parcelas: [],
  });
  const dev = await devolver(v.saleId, v.itemIds[0]);
  await client.query(`UPDATE sales SET refund_abatement = NULL WHERE id = $1`, [dev.devolucao_sale_id]);
  expect(await saldo(v.customerId)).toBe(0);

  const r = await cancelar(dev.devolucao_sale_id);

  expect(r.credit_removed).toBe(120);
  expect(await saldo(v.customerId)).toBe(120);
  expect(await estoque(vans)).toBe(0);
});

test('5. activeReturnsOf só enxerga devolução ativa', async () => {
  const vans = await produto('VANS 36/37', 0);
  const v = await vendaCrediario({
    itens: [{ productId: vans, preco: 120, nome: 'VANS 36/37' }],
    parcelas: [120],
  });
  const dev = await devolver(v.saleId, v.itemIds[0]);

  const ativas = await refund.activeReturnsOf(client, { companyId, saleId: v.saleId });
  expect(ativas.map((a) => a.id)).toEqual([dev.devolucao_sale_id]);
  expect(ativas[0].type).toBe('devolucao');

  await cancelar(dev.devolucao_sale_id);
  expect(await refund.activeReturnsOf(client, { companyId, saleId: v.saleId })).toEqual([]);
});
