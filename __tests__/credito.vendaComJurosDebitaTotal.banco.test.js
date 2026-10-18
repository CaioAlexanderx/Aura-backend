// ============================================================
// AURA CREDITO -- tq-22: venda no crediario com juros debita o total
// (Postgres real, 18/10/2026)
//
// createCreditSale debitava o PRINCIPAL e parcelava o total COM juros -- o
// mesmo defeito que a migration 367 corrigiu no lancamento manual em 07/10.
// Aqui, pelo caminho real (createCreditSale + applyPayment):
//   1. sem juros: debito = valor da venda = soma das parcelas (como hoje)
//   2. com juros (taxa do pedido): razao = soma das parcelas
//   3. com juros da config da loja: idem, centavo na ultima parcela
//   4. quem paga tudo fica com saldo ZERO e todas as parcelas quitadas --
//      sem o "credito" do tamanho dos juros (caso Kaio Cesar)
//   5. 1x sem data com juros na config: sem parcela e sem juros (como hoje)
//
// Tudo dentro de UMA transacao revertida no afterAll -- zero residuo.
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

const userId    = uuid();
const companyId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  ledger = require('../src/services/credit/ledger');

  // Colunas que existem em producao (diretorio legado de migrations) e o CI
  // nao tem. createCreditSale as toca e um 42703 abortaria a transacao unica
  // deste arquivo (ver credito.desfazerRecebimento.banco.test.js).
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN`);
  await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_installments INTEGER`);
  await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`);

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture tq-22')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja tq-22')`,
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

async function cliente(nome) {
  const id = uuid();
  await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, companyId, nome]);
  return id;
}

async function vender(customerId, amount, extra = {}) {
  const saleId = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount) VALUES ($1, $2, $3, $4)`,
    [saleId, companyId, customerId, amount]
  );
  const r = await ledger.createCreditSale(client, {
    companyId, customerId, saleId, amount, createdBy: userId, productNames: ['Blusa'], ...extra,
  });
  return { saleId, r };
}

async function taxaDaLoja(rate) {
  await ledger._getOrCreatePlanConfig(client, companyId);
  await client.query(`UPDATE credit_plan_configs SET interest_rate = $2 WHERE company_id = $1`, [companyId, rate]);
}

async function num(sql, params) {
  const { rows } = await client.query(sql, params);
  return Number(rows[0].v);
}
const debito = (saleId) => num(
  `SELECT COALESCE(SUM(amount), 0) AS v FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
const somaParcelas = (saleId) => num(
  `SELECT COALESCE(SUM(amount_due), 0) AS v FROM credit_installments WHERE sale_id = $1 AND status <> 'cancelled'`, [saleId]);
const saldo = (customerId) => num(
  `SELECT COALESCE((SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2), 0) AS v`,
  [companyId, customerId]);
const abertas = (customerId) => num(
  `SELECT COALESCE(SUM(amount_due - covered_amount), 0) AS v FROM credit_installments
    WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending', 'overdue')`, [companyId, customerId]);
const aReceber = (saleId) => num(
  `SELECT COALESCE(SUM(amount), 0) AS v FROM transactions WHERE company_id = $1 AND idempotency_key = $2`,
  [companyId, 'pdv-credit-receivable-' + saleId]);

describe('tq-22: venda no crediario com juros debita o total', () => {
  test('1. sem juros: debito = valor = soma das parcelas (como hoje)', async () => {
    await taxaDaLoja(0);
    const c = await cliente('Sem juros');
    const { saleId, r } = await vender(c, 300, { installments: 3, firstDueDate: '2026-12-01' });
    expect(await debito(saleId)).toBe(300);
    expect(await somaParcelas(saleId)).toBe(300);
    expect(Number(r.debited.amount)).toBe(300);
    expect(await saldo(c)).toBe(300);
    expect(await abertas(c)).toBe(300);
  });

  test('2. com juros do pedido: razao = soma das parcelas', async () => {
    await taxaDaLoja(0);
    const c = await cliente('Juros do pedido');
    const { saleId, r } = await vender(c, 300, { installments: 3, firstDueDate: '2026-12-01', interestRate: 0.10 });
    expect(await somaParcelas(saleId)).toBe(330);
    expect(await debito(saleId)).toBe(330);
    expect(Number(r.debited.amount)).toBe(330);
    expect(await saldo(c)).toBe(330);
    expect(await abertas(c)).toBe(330);
    // Financeiro fora do card: o A Receber continua pelo principal
    expect(await aReceber(saleId)).toBe(300);
  });

  test('3. com juros da config da loja: centavo na ultima parcela, razao igual', async () => {
    await taxaDaLoja(0.05);
    const c = await cliente('Juros da loja');
    const { saleId } = await vender(c, 101, { installments: 2, firstDueDate: '2026-12-01' });
    expect(await somaParcelas(saleId)).toBe(106.05);
    expect(await debito(saleId)).toBe(106.05);
    expect(await saldo(c)).toBe(await abertas(c));
  });

  test('4. quem paga tudo termina com saldo zero e parcelas quitadas (sem "credito" de juros)', async () => {
    await taxaDaLoja(0);
    const c = await cliente('Paga tudo');
    const { saleId } = await vender(c, 1000, { installments: 2, firstDueDate: '2026-12-01', interestRate: 0.30 });
    await ledger.applyPayment(client, { companyId, customerId: c, amount: 1300, method: 'pix', createdBy: userId });
    expect(await saldo(c)).toBe(0);
    expect(await abertas(c)).toBe(0);
    const { rows } = await client.query(
      `SELECT DISTINCT status FROM credit_installments WHERE sale_id = $1`, [saleId]);
    expect(rows.map((x) => x.status)).toEqual(['paid']);
  });

  test('5. 1x sem data com juros na config: sem parcela e sem juros (como hoje)', async () => {
    await taxaDaLoja(0.10);
    const c = await cliente('1x sem data');
    const { saleId } = await vender(c, 80);
    expect(await debito(saleId)).toBe(80);
    expect(await somaParcelas(saleId)).toBe(0);
    expect(await saldo(c)).toBe(80);
  });
});
