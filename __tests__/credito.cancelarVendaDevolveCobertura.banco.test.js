// ============================================================
// AURA CREDITO -- tq-21: cancelar venda devolve a cobertura ao FIFO
// (Postgres real, 18/10/2026)
//
// Achado do t3-08 (Aura-backend#858): cancelCreditSale zerava a cobertura das
// parcelas da venda e o pagamento que estava nelas sumia das parcelas, mas
// continuava no razao. Resultado: saldo menor que as parcelas abertas das
// outras compras do cliente.
//
// Cada cenario num cliente proprio:
//   1. 2 vendas, pagamento quitou a 1a parcela da venda 1, cancela a venda 1
//      -> a cobertura vai para a venda 2; saldo = parcelas abertas; a
//      distribuicao do pagamento acompanha; desfazer o pagamento depois
//      continua fechando a conta
//   2. cobertura parcial (parcela paga + parcela pela metade)
//   3. teto: divida sem parcela (fiado) fica com o pagamento, nao cobre a
//      parcela de outra compra
//   4. nada mais aberto: vira credito no razao, sem erro
//   5. venda sem pagamento: nada muda alem do que ja mudava
//
// Tudo dentro de UMA transacao revertida no afterAll -- zero residuo. Os
// NUMERIC chegam como string neste Pool cru: toda leitura passa por Number().
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
let undoPayment;

const userId    = uuid();
const companyId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  ledger = require('../src/services/credit/ledger');
  ({ undoPayment } = require('../src/services/credit/undoPayment'));

  // Ver credito.desfazerRecebimento.banco.test.js: a coluna existe em
  // producao (diretorio legado de migrations), o CI nao a tem.
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture tq-21')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja tq-21')`,
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

async function cliente(nome) {
  const id = uuid();
  await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, companyId, nome]);
  await ledger._getOrCreateProfile(client, companyId, id);
  return id;
}

// Venda no crediario como o PDV grava (debito + A Receber + parcelas), montada
// a mao como em credito.desfazerRecebimento.banco.test.js.
async function venda(customerId, parcelas, firstDueDate) {
  const saleId = uuid();
  const amount = parcelas.reduce((a, b) => a + b, 0);
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount) VALUES ($1, $2, $3, $4)`,
    [saleId, companyId, customerId, amount]
  );
  await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, sale_id, type, amount, notes, created_by)
     VALUES ($1, $2, $3, 'debit', $4, 'Venda no crediario', $5)`,
    [companyId, customerId, saleId, amount, userId]
  );
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, created_by, idempotency_key)
     VALUES ($1, 'income', 'pending', $2, $3, 'Crediario - A Receber', $4::date, $5, $6)`,
    [companyId, amount, `Crediario - venda ${saleId}`, firstDueDate, userId, 'pdv-credit-receivable-' + saleId]
  );
  const ids = [];
  for (let i = 0; i < parcelas.length; i++) {
    const { rows } = await client.query(
      `INSERT INTO credit_installments
         (company_id, sale_id, customer_id, installment_number, total_installments,
          amount_due, due_date, status, covered_amount)
       VALUES ($1, $2, $3, $4, $5, $6, ($7::date + ($8::int * interval '1 month'))::date, 'pending', 0)
       RETURNING id`,
      [companyId, saleId, customerId, i + 1, parcelas.length, parcelas[i], firstDueDate, i]
    );
    ids.push(rows[0].id);
  }
  return { saleId, ids };
}

async function fiado(customerId, amount) {
  await client.query(
    `INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount, source, created_by)
     VALUES ($1, $2, 'debit', $3, 'manual', $4)`,
    [companyId, customerId, amount, userId]
  );
}

async function pagar(customerId, amount) {
  const r = await ledger.applyPayment(client, {
    companyId, customerId, amount, method: 'pix', createdBy: userId,
  });
  return r.transaction.id;
}

async function cancelar(saleId) {
  const r = await ledger.cancelCreditSale(client, { companyId, saleId });
  await client.query(`UPDATE sales SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [saleId]);
  return r;
}

async function saldo(customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE((SELECT balance FROM customer_credit_balances
                       WHERE company_id = $1 AND customer_id = $2), 0) AS s`,
    [companyId, customerId]
  );
  return Number(rows[0].s);
}

async function abertas(customerId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount_due - covered_amount), 0) AS s
       FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending', 'overdue')`,
    [companyId, customerId]
  );
  return Number(rows[0].s);
}

async function parcela(id) {
  const { rows } = await client.query(
    `SELECT status, covered_amount FROM credit_installments WHERE id = $1`, [id]);
  return { status: rows[0].status, covered: Number(rows[0].covered_amount) };
}

async function distribuicao(txId) {
  const { rows } = await client.query(
    `SELECT installment_id, principal_paid FROM credit_payment_allocations
      WHERE transaction_id = $1 ORDER BY installment_id`, [txId]);
  return Object.fromEntries(rows.map((r) => [r.installment_id, Number(r.principal_paid)]));
}

// ── cenarios ────────────────────────────────────────────────────────────────

describe('tq-21: cancelar venda devolve a cobertura ao FIFO', () => {
  test('1. pagamento da venda 1 vai para a venda 2; saldo e parcelas batem; desfazer o pagamento continua fechando', async () => {
    const c  = await cliente('Duas vendas');
    const v1 = await venda(c, [100, 100, 100], '2026-12-01');
    const v2 = await venda(c, [100, 100], '2026-12-15');

    const pg = await pagar(c, 100);
    expect(await parcela(v1.ids[0])).toEqual({ status: 'paid', covered: 100 });
    expect(await saldo(c)).toBe(400);
    expect(await abertas(c)).toBe(400);

    const r = await cancelar(v1.saleId);
    expect(r).toMatchObject({ ok: true, released_coverage: 100, reallocated_amount: 100, credit_left: 0 });

    // a parcela paga da venda cancelada sai; o dinheiro dela quita a 1a da venda 2
    expect(await parcela(v1.ids[0])).toEqual({ status: 'cancelled', covered: 0 });
    expect(await parcela(v1.ids[1])).toEqual({ status: 'cancelled', covered: 0 });
    expect(await parcela(v2.ids[0])).toEqual({ status: 'paid', covered: 100 });
    expect(await parcela(v2.ids[1])).toEqual({ status: 'pending', covered: 0 });

    // razao = 500 - 300 - 100 = 100 = parcelas abertas
    expect(await saldo(c)).toBe(100);
    expect(await abertas(c)).toBe(100);

    // a distribuicao do pagamento acompanhou o dinheiro (total igual)
    expect(await distribuicao(pg)).toEqual({ [v2.ids[0]]: 100 });

    // desfazer o pagamento depois: tira de onde o dinheiro esta
    await undoPayment(client, { companyId, transactionId: pg });
    expect(await parcela(v2.ids[0])).toEqual({ status: 'pending', covered: 0 });
    expect(await saldo(c)).toBe(200);
    expect(await abertas(c)).toBe(200);
  });

  test('2. cobertura parcial: parcela paga + parcela pela metade', async () => {
    const c  = await cliente('Parcial');
    const v1 = await venda(c, [100, 100], '2026-12-01');
    const v2 = await venda(c, [100, 100, 100], '2027-03-01'); // vence depois das duas da venda 1

    await pagar(c, 150);
    expect(await parcela(v1.ids[0])).toEqual({ status: 'paid', covered: 100 });
    expect(await parcela(v1.ids[1])).toEqual({ status: 'pending', covered: 50 });

    const r = await cancelar(v1.saleId);
    expect(r).toMatchObject({ released_coverage: 150, reallocated_amount: 150, credit_left: 0 });
    expect(await parcela(v2.ids[0])).toEqual({ status: 'paid', covered: 100 });
    expect(await parcela(v2.ids[1])).toEqual({ status: 'pending', covered: 50 });
    expect(await parcela(v2.ids[2])).toEqual({ status: 'pending', covered: 0 });
    expect(await saldo(c)).toBe(150);
    expect(await abertas(c)).toBe(150);
  });

  test('3. teto: divida sem parcela fica com o pagamento', async () => {
    const c  = await cliente('Fiado');
    const v1 = await venda(c, [100, 100], '2026-12-01');
    await fiado(c, 100);
    const v2 = await venda(c, [100], '2027-01-10');

    await pagar(c, 100); // FIFO das parcelas: 1a da venda 1
    expect(await parcela(v1.ids[0])).toEqual({ status: 'paid', covered: 100 });

    const r = await cancelar(v1.saleId);
    // razao: 200 + 100 + 100 - 100 - 200 = 100 (fiado 100 + venda 2 100 - pago 100)
    // parcelas abertas: 100 (venda 2) -> nao passam do saldo: nada a cobrir
    expect(r).toMatchObject({ released_coverage: 100, reallocated_amount: 0, credit_left: 100 });
    expect(await parcela(v2.ids[0])).toEqual({ status: 'pending', covered: 0 });
    expect(await saldo(c)).toBe(100);
    expect(await abertas(c)).toBe(100);
  });

  test('4. sem outra parcela aberta: vira credito no razao', async () => {
    const c  = await cliente('So uma venda');
    const v1 = await venda(c, [80, 80], '2026-12-01');
    await pagar(c, 80);

    const r = await cancelar(v1.saleId);
    expect(r).toMatchObject({ released_coverage: 80, reallocated_amount: 0, credit_left: 80 });
    expect(await parcela(v1.ids[0])).toEqual({ status: 'cancelled', covered: 0 });
    expect(await saldo(c)).toBe(-80);
    expect(await abertas(c)).toBe(0);
  });

  test('5. venda sem pagamento: cancela as parcelas e nao toca nas outras', async () => {
    const c  = await cliente('Sem pagamento');
    const v1 = await venda(c, [50, 50], '2026-12-01');
    const v2 = await venda(c, [70], '2026-12-05');

    const r = await cancelar(v1.saleId);
    expect(r).toMatchObject({ ok: true, released_coverage: 0, reallocated_amount: 0, credit_left: 0 });
    expect(await parcela(v1.ids[0])).toEqual({ status: 'cancelled', covered: 0 });
    expect(await parcela(v2.ids[0])).toEqual({ status: 'pending', covered: 0 });
    expect(await saldo(c)).toBe(70);
    expect(await abertas(c)).toBe(70);
  });
});
