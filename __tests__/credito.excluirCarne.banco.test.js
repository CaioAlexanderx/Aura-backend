// ============================================================
// AURA CRÉDITO — excluir um carnê inteiro (Postgres real, 09/11/2026)
//
// O INCIDENTE: a ficha não tinha botão para excluir um carnê. A lojista só
// conseguia desfazer lançamento por lançamento, e o carnê renegociado nem isso
// (o acréscimo da renegociação dá 409 RESCHEDULE_ADJUSTMENT).
//
// O que este arquivo cobre, cada cenário num cliente próprio:
//   1. carnê manual sem recebimento: o saldo cai exatamente o aberto, as
//      parcelas cancelam, o carnê vira 'cancelled', o outro carnê fica intacto
//   2. carnê renegociado com desconto e com acréscimo (applyReschedule real):
//      o par débito/estorno sai junto e nenhuma parcela antiga reabre
//   3. com recebimento (distribuição gravada e legado sem ela): 409
//      CARNE_TEM_RECEBIMENTO com a lista, nada muda
//   4. de venda do Caixa: 409 CARNE_DE_VENDA com o sale_id, nada muda
//   5. carnê de outra empresa ou de outro cliente: 404
//   6. idempotência: a segunda exclusão dá 409 CARNE_JA_EXCLUIDO e o saldo
//      não cai de novo
//   7. parcelas sem dívida no razão do carnê ("Parcelar saldo"): 409
//      CARNE_DIVERGENTE, nada muda
//
// Mesmo padrão de credito.desfazerLancamentoSemParcelaOrfa.test.js: tudo
// dentro de UMA transação revertida no afterAll — zero resíduo. Os NUMERIC
// chegam como string neste Pool cru: toda leitura passa por Number().
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
let deleteCarne;
let applyReschedule;

const userId     = uuid();
const companyId  = uuid();
const otherCoId  = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  ledger = require('../src/services/credit/ledger');
  ({ deleteCarne } = require('../src/services/credit/deleteCarne'));
  ({ applyReschedule } = require('../src/services/credit/reschedule'));

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Crediário')`,
    [userId, `fixture-${userId}@example.test`]
  );
  for (const [id, nome] of [[companyId, 'Fixture Loja Excluir Carne'], [otherCoId, 'Fixture Outra Loja']]) {
    await client.query(
      `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, $3)`,
      [id, userId, nome]
    );
  }
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

// ── helpers de fixture ─────────────────────────────────────────────────────

async function cliente(nome, co = companyId) {
  const id = uuid();
  await client.query(
    `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`,
    [id, co, nome]
  );
  await ledger._getOrCreateProfile(client, co, id);
  return id;
}

async function carne(customerId, nome, co = companyId) {
  const { rows } = await client.query(
    `INSERT INTO credit_accounts (company_id, customer_id, name, status)
     VALUES ($1, $2, $3, 'open') RETURNING id`,
    [co, customerId, nome]
  );
  return rows[0].id;
}

// Lançamento manual como o /manual-entry grava: débito no carnê + n parcelas
// com transaction_id.
async function lancamento(customerId, accountId, amount, { n = 1, co = companyId, saleId = null } = {}) {
  const { rows } = await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, sale_id, type, amount, notes, source, created_by, account_id)
     VALUES ($1, $2, $3, 'debit', $4, 'Lancamento', $5, $6, $7)
     RETURNING id`,
    [co, customerId, saleId, amount, saleId ? 'sale' : 'manual', userId, accountId]
  );
  const txId = rows[0].id;
  const base = Math.floor((amount / n) * 100) / 100;
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const amt = i === n ? Math.round((amount - base * (n - 1)) * 100) / 100 : base;
    const { rows: p } = await client.query(
      `INSERT INTO credit_installments
         (company_id, sale_id, customer_id, installment_number, total_installments,
          amount_due, due_date, status, covered_amount, account_id, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, ('2026-12-01'::date + ($7::int * interval '1 month'))::date,
               'pending', 0, $8, $9)
       RETURNING id`,
      [co, saleId, customerId, i, n, amt, i - 1, accountId, saleId ? null : txId]
    );
    ids.push(p[0].id);
  }
  await ledger._updateCreditUsed(client, co, customerId);
  return { txId, installmentIds: ids };
}

async function saldo(customerId, co = companyId) {
  const { rows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [co, customerId]
  );
  return Number(rows[0]?.balance || 0);
}

async function creditUsed(customerId) {
  const { rows } = await client.query(
    `SELECT credit_used FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  return Number(rows[0]?.credit_used || 0);
}

async function statusDoCarne(accountId) {
  const { rows } = await client.query(`SELECT status FROM credit_accounts WHERE id = $1`, [accountId]);
  return rows[0]?.status;
}

async function parcelasDoCarne(accountId) {
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS n FROM credit_installments WHERE account_id = $1 GROUP BY status`,
    [accountId]
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function lancamentosDoCarne(accountId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM customer_credit_transactions WHERE account_id = $1`, [accountId]
  );
  return rows[0].n;
}

async function abertoNasParcelas(customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_due - covered_amount), 0) AS s
       FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending','overdue')`,
    [companyId, customerId]
  );
  return Number(rows[0].s);
}

/** Roda deleteCarne e devolve o erro lançado (ou falha se não lançar). */
async function erroDe(args) {
  try {
    await deleteCarne(client, args);
  } catch (e) {
    return e;
  }
  throw new Error('deleteCarne deveria ter recusado');
}

// ── cenários ───────────────────────────────────────────────────────────────

describe('deleteCarne', () => {
  test('1. carnê manual sem recebimento: saldo cai o aberto, o outro carnê fica intacto', async () => {
    const cid = await cliente('Manual Fixture');
    const cA = await carne(cid, 'Lançamento de 01/11');
    const cB = await carne(cid, 'Lançamento de 02/11');
    await lancamento(cid, cA, 300, { n: 3 });
    const b = await lancamento(cid, cB, 200, { n: 2 });

    expect(await saldo(cid)).toBe(500);
    expect(await creditUsed(cid)).toBe(500);

    const r = await deleteCarne(client, { companyId, customerId: cid, accountId: cA });

    expect(r.deleted).toBe(true);
    expect(r.removed_amount).toBe(300);
    expect(r.cancelled_installments).toBe(3);
    expect(r.removed_transactions).toBe(1);
    expect(r.reallocated_amount).toBe(0);
    expect(r.new_balance).toBe(200);

    expect(await saldo(cid)).toBe(200);
    expect(await creditUsed(cid)).toBe(200);
    expect(await statusDoCarne(cA)).toBe('cancelled');
    expect(await parcelasDoCarne(cA)).toEqual({ cancelled: 3 });
    expect(await lancamentosDoCarne(cA)).toBe(0);

    // O outro carnê: aberto, débito e parcelas como estavam.
    expect(await statusDoCarne(cB)).toBe('open');
    expect(await parcelasDoCarne(cB)).toEqual({ pending: 2 });
    const { rows } = await client.query(
      `SELECT 1 FROM customer_credit_transactions WHERE id = $1`, [b.txId]);
    expect(rows.length).toBe(1);
    expect(await abertoNasParcelas(cid)).toBe(await saldo(cid));
  });

  test('2a. carnê renegociado com desconto: o par débito/estorno sai e nada reabre', async () => {
    const cid = await cliente('Renegociado Desconto');
    const cA = await carne(cid, 'Lançamento de 03/11');
    const cB = await carne(cid, 'Lançamento de 04/11');
    await lancamento(cid, cA, 600, { n: 2 });
    await lancamento(cid, cB, 80);

    // Renegocia o carnê A para 500 em 4x: estorno de 100 com source reschedule.
    const rs = await applyReschedule(client, {
      companyId, customerId: cid, accountId: cA, total: 500, installments: 4,
      firstDueDate: '2026-12-10', periodUnit: 'month', periodCount: 1, createdBy: userId,
    });
    expect(rs.adjustment).toEqual({ type: 'discount', amount: 100 });
    expect(await saldo(cid)).toBe(580);
    expect(await parcelasDoCarne(cA)).toEqual({ cancelled: 2, pending: 4 });

    const r = await deleteCarne(client, { companyId, customerId: cid, accountId: cA });

    expect(r.removed_amount).toBe(500);
    expect(r.cancelled_installments).toBe(4);
    expect(r.removed_transactions).toBe(2);   // débito 600 + estorno 100
    expect(await saldo(cid)).toBe(80);
    expect(await creditUsed(cid)).toBe(80);
    // As 2 parcelas que a renegociação cancelou continuam canceladas.
    expect(await parcelasDoCarne(cA)).toEqual({ cancelled: 6 });
    expect(await lancamentosDoCarne(cA)).toBe(0);
    expect(await statusDoCarne(cA)).toBe('cancelled');
    expect(await parcelasDoCarne(cB)).toEqual({ pending: 1 });
    expect(await abertoNasParcelas(cid)).toBe(80);
  });

  test('2b. carnê renegociado com acréscimo: o acréscimo sai junto com o débito', async () => {
    const cid = await cliente('Renegociado Acrescimo');
    const cA = await carne(cid, 'Lançamento de 05/11');
    await lancamento(cid, cA, 300, { n: 3 });

    const rs = await applyReschedule(client, {
      companyId, customerId: cid, accountId: cA, total: 360, installments: 2,
      firstDueDate: '2026-12-10', periodUnit: 'month', periodCount: 1, createdBy: userId,
    });
    expect(rs.adjustment).toEqual({ type: 'surcharge', amount: 60 });
    expect(await saldo(cid)).toBe(360);

    const r = await deleteCarne(client, { companyId, customerId: cid, accountId: cA });

    expect(r.removed_amount).toBe(360);
    expect(r.removed_transactions).toBe(2);   // débito 300 + acréscimo 60
    expect(await saldo(cid)).toBe(0);
    expect(await creditUsed(cid)).toBe(0);
    expect(await parcelasDoCarne(cA)).toEqual({ cancelled: 5 });
  });

  test('3a. com recebimento distribuído: 409 CARNE_TEM_RECEBIMENTO com a lista, nada muda', async () => {
    const cid = await cliente('Com Recebimento');
    const cA = await carne(cid, 'Lançamento de 06/11');
    const a = await lancamento(cid, cA, 300, { n: 3 });

    // Recebimento livre (sem carnê), como o FIFO grava: razão + parcela + distribuição.
    const { rows } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, payment_method, source, created_by)
       VALUES ($1, $2, 'payment', 100, 'pix', 'sale', $3) RETURNING id`,
      [companyId, cid, userId]
    );
    const payId = rows[0].id;
    await client.query(
      `UPDATE credit_installments SET covered_amount = 100, status = 'paid' WHERE id = $1`,
      [a.installmentIds[0]]
    );
    await client.query(
      `INSERT INTO credit_payment_allocations
         (company_id, transaction_id, installment_id, principal_paid, status_after)
       VALUES ($1, $2, $3, 100, 'paid')`,
      [companyId, payId, a.installmentIds[0]]
    );

    const e = await erroDe({ companyId, customerId: cid, accountId: cA });
    expect(e.status).toBe(409);
    expect(e.code).toBe('CARNE_TEM_RECEBIMENTO');
    expect(e.extra.receipts).toHaveLength(1);
    expect(e.extra.receipts[0].id).toBe(payId);
    expect(e.extra.receipts[0].amount).toBe(100);
    expect(e.extra.receipts[0].date).toBeTruthy();

    expect(await statusDoCarne(cA)).toBe('open');
    expect(await parcelasDoCarne(cA)).toEqual({ paid: 1, pending: 2 });
    expect(await saldo(cid)).toBe(200);
  });

  test('3b. cobertura antiga sem distribuição gravada também conta como recebimento', async () => {
    const cid = await cliente('Recebimento Legado');
    const cA = await carne(cid, 'Lançamento de 07/11');
    const a = await lancamento(cid, cA, 200, { n: 2 });
    await client.query(
      `UPDATE credit_installments SET covered_amount = 40 WHERE id = $1`, [a.installmentIds[0]]
    );

    const e = await erroDe({ companyId, customerId: cid, accountId: cA });
    expect(e.code).toBe('CARNE_TEM_RECEBIMENTO');
    expect(e.extra.receipts).toEqual([{ id: null, date: null, amount: 40 }]);
    expect(await statusDoCarne(cA)).toBe('open');
  });

  test('4. carnê de venda do Caixa: 409 CARNE_DE_VENDA com o sale_id, nada muda', async () => {
    const cid = await cliente('De Venda');
    const cA = await carne(cid, 'Compra de 08/11');
    const saleId = uuid();
    await client.query(
      `INSERT INTO sales (id, company_id, customer_id, total_amount) VALUES ($1, $2, $3, 250)`,
      [saleId, companyId, cid]
    );
    await lancamento(cid, cA, 250, { n: 2, saleId });

    const e = await erroDe({ companyId, customerId: cid, accountId: cA });
    expect(e.status).toBe(409);
    expect(e.code).toBe('CARNE_DE_VENDA');
    expect(e.extra.sale_id).toBe(saleId);

    expect(await statusDoCarne(cA)).toBe('open');
    expect(await parcelasDoCarne(cA)).toEqual({ pending: 2 });
    expect(await saldo(cid)).toBe(250);
  });

  test('5. carnê de outra empresa ou de outro cliente: 404, nada muda', async () => {
    const cid  = await cliente('Dono Do Carne');
    const outro = await cliente('Outro Cliente');
    const cA = await carne(cid, 'Lançamento de 09/11');
    await lancamento(cid, cA, 120);

    const deOutroCliente = await erroDe({ companyId, customerId: outro, accountId: cA });
    expect(deOutroCliente.status).toBe(404);
    expect(deOutroCliente.code).toBe('CARNE_NAO_ENCONTRADO');

    // A URL é de outra empresa (mesmo dono): o carnê não é dela.
    const deOutraEmpresa = await erroDe({ companyId: otherCoId, customerId: cid, accountId: cA });
    expect(deOutraEmpresa.status).toBe(404);

    const lixo = await erroDe({ companyId, customerId: cid, accountId: 'nao-e-uuid' });
    expect(lixo.status).toBe(404);

    expect(await statusDoCarne(cA)).toBe('open');
    expect(await saldo(cid)).toBe(120);
  });

  test('6. idempotência: excluir duas vezes dá 409 claro e o saldo não cai de novo', async () => {
    const cid = await cliente('Duas Vezes');
    const cA = await carne(cid, 'Lançamento de 10/11');
    const cB = await carne(cid, 'Lançamento de 11/11');
    await lancamento(cid, cA, 150);
    await lancamento(cid, cB, 90);

    await deleteCarne(client, { companyId, customerId: cid, accountId: cA });
    expect(await saldo(cid)).toBe(90);

    const e = await erroDe({ companyId, customerId: cid, accountId: cA });
    expect(e.status).toBe(409);
    expect(e.code).toBe('CARNE_JA_EXCLUIDO');
    expect(await saldo(cid)).toBe(90);
    expect(await parcelasDoCarne(cB)).toEqual({ pending: 1 });
  });

  test('7. parcelas sem dívida no razão do carnê: 409 CARNE_DIVERGENTE, nada muda', async () => {
    const cid = await cliente('Divergente');
    // Dívida fora de carnê; o cronograma mora no carnê A ("Parcelar saldo").
    await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, notes, source, created_by)
       VALUES ($1, $2, 'debit', 400, 'Lancamento', 'manual', $3)`,
      [companyId, cid, userId]
    );
    const cA = await carne(cid, 'Lançamento de 12/11');
    await client.query(
      `INSERT INTO credit_installments
         (company_id, customer_id, installment_number, total_installments,
          amount_due, due_date, status, covered_amount, account_id)
       VALUES ($1, $2, 1, 1, 400, '2026-12-01', 'pending', 0, $3)`,
      [companyId, cid, cA]
    );

    const e = await erroDe({ companyId, customerId: cid, accountId: cA });
    expect(e.status).toBe(409);
    expect(e.code).toBe('CARNE_DIVERGENTE');
    expect(e.extra).toEqual({ ledger_open: 0, installments_open: 400 });
    expect(await statusDoCarne(cA)).toBe('open');
    expect(await saldo(cid)).toBe(400);
  });

  test('carnê vazio (sem lançamento nem parcela) sai sem mexer no saldo', async () => {
    const cid = await cliente('Vazio');
    const cA = await carne(cid, 'Carnê vazio');
    const cB = await carne(cid, 'Lançamento de 13/11');
    await lancamento(cid, cB, 70);

    const r = await deleteCarne(client, { companyId, customerId: cid, accountId: cA });
    expect(r.removed_amount).toBe(0);
    expect(await statusDoCarne(cA)).toBe('cancelled');
    expect(await saldo(cid)).toBe(70);
  });
});
