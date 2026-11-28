// ============================================================
// AURA CREDITO -- cancelar ou devolver venda de carne JUNTADO / RENEGOCIADO
// (Postgres real, 28/11/2026)
//
// O caso real (Layali): "Juntar carnes" e "Renegociar" criam o cronograma novo
// com sale_id nulo e levam os debitos para o carne novo. Cancelar a venda
// apagava o debito do razao mas deixava vivas as parcelas do carne novo
// (orfas), e o carne travava com CARNE_DIVERGENTE. A devolucao tinha o mesmo
// padrao. Agora o valor sai das parcelas abertas do carne que guarda a divida.
//
// Cenarios (cada um num cliente proprio):
//   1. 2 vendas, junta, cancela 1 -> carne junto soma so a outra; razao = parcelas
//   2. renegociada e cancelada -> zera; o carne fecha
//   3. devolucao de venda junta -> reduz pelo valor devolvido; cancelar a
//      devolucao restaura
//   4. parcela ja coberta nao e tocada
//   5. juncao com carne divergente (parcela orfa) e recusada
//   6. venda simples cancelada segue igual (sem recibo de ajuste)
//
// Uma transacao revertida no afterAll -- zero residuo. NUMERIC chega como
// string neste Pool cru: toda leitura passa por Number().
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let ledger;
let refund;
let mergeCarnes;
let reschedule;

const userId    = uuid();
const companyId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  ledger = require('../src/services/credit/ledger');
  refund = require('../src/services/credit/refund');
  mergeCarnes = require('../src/services/credit/mergeCarnes');
  reschedule = require('../src/services/credit/reschedule');

  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture carne juntado')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja carne juntado')`,
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

// -- fixtures -----------------------------------------------------------------

async function cliente(nome) {
  const id = uuid();
  await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, companyId, nome]);
  await ledger._getOrCreateProfile(client, companyId, id);
  return id;
}

// Venda no crediario com carne proprio (um carne por compra), como o PDV grava.
async function venda(customerId, nome, parcelas) {
  const accountId = uuid();
  await client.query(
    `INSERT INTO credit_accounts (id, company_id, customer_id, name, status) VALUES ($1, $2, $3, $4, 'open')`,
    [accountId, companyId, customerId, nome]
  );
  const saleId = uuid();
  const amount = parcelas.reduce((a, b) => a + b, 0);
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount, payment_method, status, type)
     VALUES ($1, $2, $3, $4, 'crediario', 'completed', 'sale')`,
    [saleId, companyId, customerId, amount]
  );
  const itemId = uuid();
  await client.query(
    `INSERT INTO sale_items (id, sale_id, quantity, unit_price, total_price, product_name_snapshot)
     VALUES ($1, $2, 1, $3, $3, 'Item')`,
    [itemId, saleId, amount]
  );
  await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, sale_id, type, amount, notes, created_by, account_id)
     VALUES ($1, $2, $3, 'debit', $4, 'Venda no crediario', $5, $6)`,
    [companyId, customerId, saleId, amount, userId, accountId]
  );
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, created_by, idempotency_key)
     VALUES ($1, 'income', 'pending', $2, $3, 'Crediario - A Receber', CURRENT_DATE, $4, $5)`,
    [companyId, amount, `Crediario - venda ${saleId}`, userId, 'pdv-credit-receivable-' + saleId]
  );
  const ids = [];
  for (let i = 0; i < parcelas.length; i++) {
    const { rows } = await client.query(
      `INSERT INTO credit_installments
         (company_id, sale_id, customer_id, installment_number, total_installments,
          amount_due, due_date, status, covered_amount, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE + ($4::int * 30), 'pending', 0, $7)
       RETURNING id`,
      [companyId, saleId, customerId, i + 1, parcelas.length, parcelas[i], accountId]
    );
    ids.push(rows[0].id);
  }
  return { saleId, accountId, itemId, ids };
}

async function juntar(customerId, accountIds, installments) {
  return mergeCarnes.applyMerge(client, {
    companyId, customerId, accountIds, installments,
    firstDueDate: '2027-01-10', createdBy: userId,
  });
}

async function cancelar(saleId) {
  const r = await ledger.cancelCreditSale(client, { companyId, saleId });
  await client.query(`UPDATE sales SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [saleId]);
  return r;
}

async function pagar(customerId, amount) {
  return ledger.applyPayment(client, { companyId, customerId, amount, method: 'pix', createdBy: userId });
}

async function saldo(customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE(balance, 0) AS s FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]);
  return Number(rows[0] ? rows[0].s : 0);
}

async function abertas(customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_due - covered_amount), 0) AS s FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending', 'overdue')`,
    [companyId, customerId]);
  return Number(rows[0].s);
}

async function parcelasDoCarne(accountId) {
  const { rows } = await client.query(
    `SELECT installment_number AS n, status, amount_due::float AS due, covered_amount::float AS cov
       FROM credit_installments WHERE account_id = $1 ORDER BY installment_number`, [accountId]);
  return rows;
}

async function recibos(saleId) {
  const { rows } = await client.query(
    `SELECT result FROM credit_reschedule_receipts WHERE company_id = $1 AND idempotency_key LIKE $2`,
    [companyId, `carne-ajuste-%-${saleId}-%`]);
  return rows.map(r => r.result);
}

const r2 = (n) => Math.round(n * 100) / 100;

// -- cenarios -----------------------------------------------------------------

describe('cancelar/devolver venda de carne juntado ou renegociado', () => {
  test('1. duas vendas, junta, cancela uma: o carne junto soma so a outra e o razao bate', async () => {
    const c = await cliente('Juntada');
    const v1 = await venda(c, 'Compra 1', [100, 100]);   // 200
    const v2 = await venda(c, 'Compra 2', [150]);        // 150
    const j = await juntar(c, [v1.accountId, v2.accountId], 3);
    const destino = j.account.id;
    expect(r2(await abertas(c))).toBe(350);

    const r = await cancelar(v1.saleId);

    expect(r2(await saldo(c))).toBe(150);
    expect(r2(await abertas(c))).toBe(150);
    const vivas = (await parcelasDoCarne(destino)).filter(p => p.status !== 'cancelled');
    expect(r2(vivas.reduce((s, p) => s + p.due, 0))).toBe(150);
    expect(r.carne_ajuste).toHaveLength(1);
    expect(r.carne_ajuste[0].shrunk).toBe(200);
    const rec = await recibos(v1.saleId);
    expect(rec).toHaveLength(1);
    expect(rec[0].type).toBe('carne_ajuste');
    const canceladas = (await parcelasDoCarne(destino)).filter(p => p.status === 'cancelled');
    expect(canceladas.length).toBeGreaterThan(0);
  });

  test('2. renegociada e cancelada: zera o carne e ele fecha', async () => {
    const c = await cliente('Renegociada');
    const v = await venda(c, 'Compra R', [60, 60, 60]);
    await reschedule.applyReschedule(client, {
      companyId, customerId: c, accountId: v.accountId, total: 180,
      installments: 2, firstDueDate: '2027-02-10', createdBy: userId,
    });
    const { rows: novas } = await client.query(
      `SELECT id FROM credit_installments WHERE account_id = $1 AND sale_id IS NULL AND status = 'pending'`,
      [v.accountId]);
    expect(novas).toHaveLength(2);

    const r = await cancelar(v.saleId);

    expect(r2(await saldo(c))).toBe(0);
    expect(r2(await abertas(c))).toBe(0);
    expect(r.carne_ajuste[0].shrunk).toBe(180);
    const { rows: [acc] } = await client.query(`SELECT status FROM credit_accounts WHERE id = $1`, [v.accountId]);
    expect(acc.status).toBe('cancelled');
  });

  test('3. devolucao de venda junta reduz pelo valor devolvido; cancelar a devolucao restaura', async () => {
    const c = await cliente('Devolucao');
    const v1 = await venda(c, 'Compra D1', [100, 100]);
    const v2 = await venda(c, 'Compra D2', [100]);
    const j = await juntar(c, [v1.accountId, v2.accountId], 3);
    expect(r2(await abertas(c))).toBe(300);

    const dev = await refund.refundCreditSale(client, {
      companyId, saleId: v1.saleId, items: [{ sale_item_id: v1.itemId, quantity: 1 }], createdBy: userId,
    });
    expect(dev.refund_value).toBe(200);
    expect(dev.credit_generated).toBe(0);
    expect(r2(await saldo(c))).toBe(100);
    expect(r2(await abertas(c))).toBe(100);

    await refund.cancelDevolucao(client, { companyId, devolucaoSaleId: dev.devolucao_sale_id });
    expect(r2(await saldo(c))).toBe(300);
    expect(r2(await abertas(c))).toBe(300);
    expect((await parcelasDoCarne(j.account.id)).filter(p => p.status !== 'cancelled').length).toBeGreaterThan(0);
  });

  test('4. parcela ja coberta nao e tocada', async () => {
    const c = await cliente('Coberta');
    const v1 = await venda(c, 'Compra C1', [100]);
    const v2 = await venda(c, 'Compra C2', [100]);
    const j = await juntar(c, [v1.accountId, v2.accountId], 2); // 2 x 100
    await pagar(c, 100); // cobre a 1a parcela do carne junto
    const antes = await parcelasDoCarne(j.account.id);
    expect(antes[0].cov).toBe(100);

    await cancelar(v1.saleId); // tira 100 do aberto: a ultima parcela

    const depois = await parcelasDoCarne(j.account.id);
    expect(depois[0]).toMatchObject({ status: 'paid', cov: 100 });
    expect(depois[1].status).toBe('cancelled');
    expect(r2(await abertas(c))).toBe(0);
    expect(r2(await saldo(c))).toBe(0);
  });

  test('5. juncao com carne divergente (parcela orfa) e recusada', async () => {
    const c = await cliente('Divergente');
    const v1 = await venda(c, 'Compra X1', [100]);
    const v2 = await venda(c, 'Compra X2', [100]);
    // parcela orfa: o debito do carne sumiu do razao mas a parcela ficou
    await client.query(
      `DELETE FROM customer_credit_transactions WHERE sale_id = $1 AND company_id = $2`, [v1.saleId, companyId]);

    await expect(juntar(c, [v1.accountId, v2.accountId], 2)).rejects.toMatchObject({
      status: 409, code: 'CARNE_DIVERGENTE',
    });
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM credit_accounts WHERE company_id = $1 AND customer_id = $2`, [companyId, c]);
    expect(rows[0].n).toBe(2);
  });

  test('6. venda simples cancelada segue igual: sem ajuste, sem recibo', async () => {
    const c = await cliente('Simples');
    const v = await venda(c, 'Compra S', [50, 50]);
    const r = await cancelar(v.saleId);
    expect(r.carne_ajuste).toEqual([]);
    expect(r2(await saldo(c))).toBe(0);
    expect(r2(await abertas(c))).toBe(0);
    expect(await recibos(v.saleId)).toHaveLength(0);
    expect(r.cancelled_account_ids).toContain(v.accountId);
  });
});
