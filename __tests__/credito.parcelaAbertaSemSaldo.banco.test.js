// ============================================================
// AURA CRÉDITO — parcela aberta acima do saldo do razão
// (Postgres real, 07/10/2026)
//
// O CASO REAL (Valen / jackson ICL): R$4.770 em parcelas abertas e saldo de
// -R$140 no razão — os débitos tinham sido apagados e as parcelas ficaram.
// A lista do Crediário saía do saldo (> 0) e o cliente sumiu da tela,
// inclusive da busca por nome. Outro cliente da mesma loja tinha R$25.000 em
// 36 parcelas e NENHUMA linha no razão.
//
// O que este arquivo cobre:
//   1. a lista traz quem tem parcela aberta com saldo <= 0 (e quem nem está
//      na view de saldo), sem trazer quem está quitado
//   2. a busca por nome acha esse cliente
//   3. o alarme (findLedgerMismatches) acusa o caso e não acusa conta sadia
//   4. a migration 367 iguala o débito manual com juros às parcelas dele, e
//      não toca em débito cujo cronograma foi reescrito
//
// Mesmo padrão de credito.desfazerLancamentoSemParcelaOrfa.test.js: tudo
// dentro de UMA transação revertida no afterAll — zero resíduo.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const { listBalanceRows } = require('../src/services/credit/balanceList');
const { findLedgerMismatches } = require('../src/services/credit/integrity');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const MIGRATION_367 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '367_crediario_debito_manual_com_juros.sql'), 'utf8');

let pool;
let client;

const userId    = uuid();
const companyId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Crediário')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name)
     VALUES ($1, $2, 'Fixture Loja Parcela Sem Saldo')`,
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

// ── helpers de fixture ─────────────────────────────────────────────────────

async function cliente(nome) {
  const id = uuid();
  await client.query(
    `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`,
    [id, companyId, nome]
  );
  return id;
}

async function lancamento(customerId, type, amount, { source = 'manual' } = {}) {
  const { rows } = await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, type, amount, notes, source, created_by)
     VALUES ($1, $2, $3, $4, 'Fixture', $5, $6)
     RETURNING id`,
    [companyId, customerId, type, amount, source, userId]
  );
  return rows[0].id;
}

async function parcela(customerId, amountDue, {
  transactionId = null, covered = 0, status = 'pending', number = 1, total = 1,
} = {}) {
  const { rows } = await client.query(
    `INSERT INTO credit_installments
       (company_id, sale_id, customer_id, installment_number, total_installments,
        amount_due, due_date, status, covered_amount, transaction_id)
     VALUES ($1, NULL, $2, $3, $4, $5, '2026-12-01', $6, $7, $8)
     RETURNING id`,
    [companyId, customerId, number, total, amountDue, status, covered, transactionId]
  );
  return rows[0].id;
}

async function valorDoDebito(id) {
  const { rows } = await client.query(
    `SELECT amount FROM customer_credit_transactions WHERE id = $1`, [id]
  );
  return Number(rows[0].amount);
}

const porId = (rows, id) => rows.find((r) => r.id === id || r.customer_id === id);

// ── cenários ───────────────────────────────────────────────────────────────

describe('parcela aberta acima do saldo do razão', () => {
  let sadio, quitado, saldoNegativo, semRazao;

  beforeAll(async () => {
    // Conta sadia: débito e parcela contam a mesma história.
    sadio = await cliente('Sadio Fixture');
    const dS = await lancamento(sadio, 'debit', 300);
    await parcela(sadio, 300, { transactionId: dS });

    // Quitado: nada em aberto em lugar nenhum.
    quitado = await cliente('Quitado Fixture');
    await lancamento(quitado, 'debit', 100);
    await lancamento(quitado, 'payment', 100, { source: 'sale' });
    await parcela(quitado, 100, { covered: 100, status: 'paid' });

    // O jackson: débitos apagados, pagamentos ficaram, parcelas abertas.
    saldoNegativo = await cliente('Jackson Fixture');
    await lancamento(saldoNegativo, 'debit', 130);
    await lancamento(saldoNegativo, 'payment', 270, { source: 'sale' });
    await parcela(saldoNegativo, 326.25, { covered: 63.75, number: 1, total: 2 });
    await parcela(saldoNegativo, 326.25, { number: 2, total: 2 });

    // O rodrigo: parcelas abertas e nenhuma linha no razão.
    semRazao = await cliente('Rodrigo Fixture');
    await parcela(semRazao, 694.44);
  });

  test('1. a lista de em aberto traz quem tem parcela aberta mesmo com saldo <= 0', async () => {
    const { rows } = await listBalanceRows(client, companyId, { onlyOpen: true });

    const j = porId(rows, saldoNegativo);
    expect(j).toBeDefined();
    expect(Number(j.balance)).toBe(-140);
    expect(Number(j.open_installments)).toBe(588.75);

    const r = porId(rows, semRazao);
    expect(r).toBeDefined();
    expect(Number(r.balance)).toBe(0);
    expect(Number(r.open_installments)).toBe(694.44);

    const s = porId(rows, sadio);
    expect(Number(s.balance)).toBe(300);
    expect(Number(s.open_installments)).toBe(300);

    expect(porId(rows, quitado)).toBeUndefined();
  });

  test('1b. com only_open=false o quitado volta, e ninguém aparece duas vezes', async () => {
    const { rows } = await listBalanceRows(client, companyId, { onlyOpen: false });
    expect(porId(rows, quitado)).toBeDefined();
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test('2. a busca por nome acha o cliente de saldo negativo', async () => {
    const { rows } = await listBalanceRows(client, companyId, { onlyOpen: true, q: 'jackson fix' });
    expect(rows.map((r) => r.id)).toEqual([saldoNegativo]);
  });

  test('3. o alarme acusa a divergência e não acusa conta sadia', async () => {
    const todos = await findLedgerMismatches(client, { limit: 100000 });
    const daLoja = todos.filter((m) => m.company_id === companyId);

    expect(daLoja.map((m) => m.customer_id).sort()).toEqual([saldoNegativo, semRazao].sort());

    const j = porId(daLoja, saldoNegativo);
    expect(j.gap).toBe(728.75);       // 588,75 em parcelas contra -140 de saldo
    expect(j.hidden).toBe(true);
    expect(j.open_count).toBe(2);
  });

  test('4. migration 367: débito manual com juros passa a valer o que as parcelas somam', async () => {
    // R$1.000 a 30% em 2x: débito de 1.000, parcelas somando 1.300.
    const comJuros = await cliente('Juros Fixture');
    const dJ = await lancamento(comJuros, 'debit', 1000);
    await parcela(comJuros, 650, { transactionId: dJ, number: 1, total: 2 });
    await parcela(comJuros, 650, { transactionId: dJ, number: 2, total: 2, covered: 650, status: 'paid' });

    // Cronograma reescrito (parcela cancelada): a soma não é mais "o que o
    // débito gerou" — fica como está.
    const renegociado = await cliente('Renegociado Fixture');
    const dR = await lancamento(renegociado, 'debit', 500);
    await parcela(renegociado, 650, { transactionId: dR, status: 'cancelled' });

    // Acréscimo de renegociação com parcela ligada: não é lançamento manual.
    const outro = await cliente('Outra Origem Fixture');
    const dO = await lancamento(outro, 'debit', 80, { source: 'reschedule' });
    await parcela(outro, 200, { transactionId: dO });

    await client.query(MIGRATION_367);

    expect(await valorDoDebito(dJ)).toBe(1300);
    expect(await valorDoDebito(dR)).toBe(500);
    expect(await valorDoDebito(dO)).toBe(80);

    // Idempotente: rodar de novo não muda nada.
    await client.query(MIGRATION_367);
    expect(await valorDoDebito(dJ)).toBe(1300);

    // E a conta com juros deixa de ser acusada pelo alarme.
    const todos = await findLedgerMismatches(client, { limit: 100000 });
    expect(porId(todos, comJuros)).toBeUndefined();
  });
});
