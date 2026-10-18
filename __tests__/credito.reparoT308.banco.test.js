// ============================================================
// AURA CREDITO -- t3-08: razao x parcelas (Postgres real, 18/10/2026)
//
// Duas metades:
//   1. Codigo: o pagamento direcionado a carne ja quitado abate as parcelas
//      abertas dos outros carnes; renegociar com desconto em cima de parcela
//      sem lancamento nao grava estorno que o razao nunca cobrou.
//   2. Reparo de dado (scripts/reparo/t3-08-crediario-reparo.sql, que NAO e
//      migration): cada etapa faz so o que a linha prova, deixa o resto como
//      esta, e rodar duas vezes nao muda nada na segunda.
//
// Tudo numa transacao revertida no afterAll -- zero residuo. O BEGIN/COMMIT
// do proprio script e retirado para ele rodar dentro desta transacao.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const REPARO = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'reparo', 't3-08-crediario-reparo.sql'), 'utf8')
  .replace(/^BEGIN;$/m, '')
  .replace(/^COMMIT;$/m, '');

let pgPool;
let client;
let ledger;
let reschedule;

const userId = uuid();
const loja   = uuid();

const C = {
  orfaRefeita:   uuid(),
  orfaSemRefazer: uuid(),
  jurosRenegociado: uuid(),
  carneQuitado:  uuid(),
  sobraCodigo:   uuid(),
  renegociaOrfa: uuid(),
};
const ids = {};

async function cliente(id, nome) {
  await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, loja, nome]);
}
async function carne(customerId, nome) {
  const id = uuid();
  await client.query(
    `INSERT INTO credit_accounts (id, company_id, customer_id, name, status) VALUES ($1, $2, $3, $4, 'open')`,
    [id, loja, customerId, nome]);
  return id;
}
async function lanc(customerId, type, amount, { source = 'manual', accountId = null, at } = {}) {
  const id = uuid();
  await client.query(
    `INSERT INTO customer_credit_transactions
       (id, company_id, customer_id, type, amount, source, account_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [id, loja, customerId, type, amount, source, accountId, at]);
  return id;
}
async function parcela(customerId, amount, {
  status = 'pending', covered = 0, txId = null, accountId = null, at, upd = null,
  due = '2026-11-10', n = 1,
} = {}) {
  const id = uuid();
  await client.query(
    `INSERT INTO credit_installments
       (id, company_id, customer_id, installment_number, total_installments, amount_due,
        due_date, status, covered_amount, transaction_id, account_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $5, $6::date, $7, $8, $9, $10, $11::timestamptz,
             COALESCE($12::timestamptz, $11::timestamptz))`,
    [id, loja, customerId, n, amount, due, status, covered, txId, accountId, at, upd]);
  return id;
}
async function saldo(customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE((SELECT balance FROM customer_credit_balances
                       WHERE company_id = $1 AND customer_id = $2), 0)::float AS s`, [loja, customerId]);
  return rows[0].s;
}
async function inst(id) {
  const { rows } = await client.query(
    `SELECT status, covered_amount::float AS covered, amount_due::float AS due FROM credit_installments WHERE id = $1`, [id]);
  return rows[0];
}
async function fotografia() {
  const { rows: a } = await client.query(
    `SELECT id, status, covered_amount, amount_due FROM credit_installments WHERE company_id = $1 ORDER BY id`, [loja]);
  const { rows: b } = await client.query(
    `SELECT id, type, amount FROM customer_credit_transactions WHERE company_id = $1 ORDER BY id`, [loja]);
  return JSON.stringify({ a, b });
}

beforeAll(async () => {
  pgPool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pgPool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  ledger = require('../src/services/credit/ledger');
  reschedule = require('../src/services/credit/reschedule');

  // Ver credito.pagamentoDistribuicao.banco.test.js: a coluna existe em
  // producao (diretorio legado de migrations), o CI nao a tem.
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture t3-08')`,
    [userId, `fixture-${userId}@example.test`]);
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja t3-08')`,
    [loja, userId]);

  // (A) orfa refeita: parcela de R$600 sem debito; a lojista lancou de novo R$600.
  await cliente(C.orfaRefeita, 'Orfa Refeita');
  ids.orfaA = await parcela(C.orfaRefeita, 600, { at: '2026-08-04 21:30:41.105166+00' });
  const dA = await lanc(C.orfaRefeita, 'debit', 600, { at: '2026-08-04 21:36:48.808085+00' });
  ids.refeitaA = await parcela(C.orfaRefeita, 600, { txId: dA, at: '2026-08-04 21:36:48.808085+00' });

  // (A2) orfa SEM lancamento refeito: fica como esta (decisao da lojista).
  await cliente(C.orfaSemRefazer, 'Orfa Sem Refazer');
  ids.orfaA2 = await parcela(C.orfaSemRefazer, 1000, { at: '2026-08-07 00:33:45.565289+00' });

  // (B) juros fora do debito, renegociado sem mudar o total (Kaio Cesar).
  await cliente(C.jurosRenegociado, 'Juros Renegociado');
  ids.debB = await lanc(C.jurosRenegociado, 'debit', 500, { at: '2026-08-18 16:52:39.665257+00' });
  await parcela(C.jurosRenegociado, 650, {
    txId: ids.debB, status: 'cancelled',
    at: '2026-08-18 16:52:39.665257+00', upd: '2026-08-18 16:55:26.738090+00',
  });
  ids.vivaB = await parcela(C.jurosRenegociado, 650, { at: '2026-08-18 16:55:26.738090+00' });

  // (C) pagamento direcionado a carne ja quitado, gravado pelo codigo antigo.
  await cliente(C.carneQuitado, 'Carne Quitado');
  const cA = await carne(C.carneQuitado, 'Carne A');
  const cB = await carne(C.carneQuitado, 'Carne B');
  const dCa = await lanc(C.carneQuitado, 'debit', 300, { accountId: cA, at: '2026-09-01 12:00:00+00' });
  const iCa = await parcela(C.carneQuitado, 300, { txId: dCa, accountId: cA, status: 'paid', covered: 300, at: '2026-09-01 12:00:00+00' });
  const pLivre = await lanc(C.carneQuitado, 'payment', 300, { source: 'sale', at: '2026-09-16 12:00:00+00' });
  await client.query(
    `INSERT INTO credit_payment_allocations (company_id, transaction_id, installment_id, principal_paid, created_at)
     VALUES ($1, $2, $3, 300, '2026-09-16 12:00:00+00')`, [loja, pLivre, iCa]);
  const dCb = await lanc(C.carneQuitado, 'debit', 500, { accountId: cB, at: '2026-09-02 12:00:00+00' });
  ids.abertaC = await parcela(C.carneQuitado, 500, { txId: dCb, accountId: cB, at: '2026-09-02 12:00:00+00' });
  await lanc(C.carneQuitado, 'payment', 200, { source: 'sale', accountId: cA, at: '2026-09-24 19:18:52.521931+00' });

  // Codigo: sobra do pagamento direcionado.
  await cliente(C.sobraCodigo, 'Sobra Codigo');
  ids.carneX = await carne(C.sobraCodigo, 'Carne X');
  const cY = await carne(C.sobraCodigo, 'Carne Y');
  const dX = await lanc(C.sobraCodigo, 'debit', 100, { accountId: ids.carneX, at: '2026-10-01 12:00:00+00' });
  await parcela(C.sobraCodigo, 100, { txId: dX, accountId: ids.carneX, status: 'paid', covered: 100, at: '2026-10-01 12:00:00+00' });
  await lanc(C.sobraCodigo, 'payment', 100, { source: 'sale', accountId: ids.carneX, at: '2026-10-02 12:00:00+00' });
  const dY = await lanc(C.sobraCodigo, 'debit', 400, { accountId: cY, at: '2026-10-03 12:00:00+00' });
  ids.y1 = await parcela(C.sobraCodigo, 200, { txId: dY, accountId: cY, at: '2026-10-03 12:00:00+00', due: '2026-10-20', n: 1 });
  ids.y2 = await parcela(C.sobraCodigo, 200, { txId: dY, accountId: cY, at: '2026-10-03 12:00:00+00', due: '2026-11-20', n: 2 });

  // Codigo: renegociar parcela sem lancamento.
  await cliente(C.renegociaOrfa, 'Renegocia Orfa');
  await parcela(C.renegociaOrfa, 300, { at: '2026-08-01 17:36:17.069250+00' });
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pgPool) await pgPool.end();
});

describe('codigo', () => {
  test('pagamento no carne ja quitado abate a parcela aberta do outro carne', async () => {
    await ledger.applyPayment(client, {
      companyId: loja, customerId: C.sobraCodigo, amount: 150, method: 'pix', accountId: ids.carneX,
    });
    expect(await inst(ids.y1)).toMatchObject({ status: 'pending', covered: 150 });
    expect(await inst(ids.y2)).toMatchObject({ covered: 0 });
    // razao e parcelas contam a mesma historia: 400 - 150 = 250 nos dois
    expect(await saldo(C.sobraCodigo)).toBeCloseTo(250, 2);
  });

  test('renegociar parcela sem lancamento para menos nao cria credito no razao', async () => {
    const r = await reschedule.applyReschedule(client, {
      companyId: loja, customerId: C.renegociaOrfa, accountId: null,
      total: 100, installments: 1, firstDueDate: '2026-11-10',
    });
    expect(r.adjustment).toMatchObject({ type: 'discount', amount: 200, ledger_amount: 0 });
    expect(await saldo(C.renegociaOrfa)).toBe(0);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM customer_credit_transactions WHERE customer_id = $1`, [C.renegociaOrfa]);
    expect(rows[0].n).toBe(0);
  });
});

describe('reparo de dado (scripts/reparo/t3-08-crediario-reparo.sql)', () => {
  test('roda inteiro', async () => {
    await client.query(REPARO);
  });

  test('A: orfa refeita e cancelada; o lancamento refeito fica', async () => {
    expect((await inst(ids.orfaA)).status).toBe('cancelled');
    expect((await inst(ids.refeitaA)).status).toBe('pending');
    expect(await saldo(C.orfaRefeita)).toBe(600);
  });

  test('A: orfa sem lancamento refeito nao e tocada', async () => {
    expect((await inst(ids.orfaA2)).status).toBe('pending');
  });

  test('B: o debito sobe para o total com juros do cronograma vivo', async () => {
    const { rows } = await client.query(
      `SELECT amount::float AS amount FROM customer_credit_transactions WHERE id = $1`, [ids.debB]);
    expect(rows[0].amount).toBe(650);
    expect(await saldo(C.jurosRenegociado)).toBe(650);
  });

  test('C: o pagamento que nao abateu parcela passa a cobrir a parcela aberta', async () => {
    expect(await inst(ids.abertaC)).toMatchObject({ status: 'pending', covered: 200 });
    expect(await saldo(C.carneQuitado)).toBe(300);
  });

  test('trilha: cada linha alterada esta em crediario_reparo_t308', async () => {
    const { rows } = await client.query(
      `SELECT etapa, count(*)::int AS n FROM crediario_reparo_t308 WHERE company_id = $1 GROUP BY 1 ORDER BY 1`, [loja]);
    expect(rows).toEqual([
      { etapa: 'A', n: 1 },
      { etapa: 'B', n: 1 },
      { etapa: 'C', n: 1 },
    ]);
  });

  test('rodar de novo nao muda nada', async () => {
    const antes = await fotografia();
    await client.query(REPARO);
    expect(await fotografia()).toBe(antes);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM crediario_reparo_t308 WHERE company_id = $1`, [loja]);
    expect(rows[0].n).toBe(3);
  });
});
