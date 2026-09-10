// ============================================================
// AURA CRÉDITO — desfazer lançamento manual cancela as parcelas dele
// (Postgres real, 10/09/2026)
//
// O CASO REAL (Jenniffer / Ana Lucia, 08/07/2026): lançamento manual de
// R$739 desfeito pela timeline; o débito sumiu do ledger, a parcela de R$739
// continuou 'pending' e passou a receber pagamentos pelo FIFO. Dois meses
// depois a ficha dizia EM ABERTO R$199 com parcelas somando R$938.
//
// O que este arquivo cobre, cada cenário num cliente próprio:
//   1. vínculo novo (transaction_id): parcela cancelada, débito apagado, e o
//      saldo do ledger volta a bater com as parcelas abertas
//   2. legado sem vínculo, mesmo created_at (lançamento sem data retroativa)
//   3. legado com data retroativa: o grupo de parcelas achado pela soma
//   4. cobertura já aplicada não some: volta ao FIFO da outra parcela aberta
//   5. pagamento não pode ser desfeito por aqui (409 NOT_MANUAL_DEBIT)
//   6. acréscimo de renegociação (source='reschedule') não arrasta o
//      cronograma novo junto
//
// Mesmo padrão de credito.recebivelSaldoParcial.test.js: conecta direto no
// Postgres, tudo dentro de UMA transação revertida no afterAll — zero resíduo.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const { undoManualEntry } = require('../src/services/credit/undoManualEntry');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

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
     VALUES ($1, $2, 'Fixture Loja Crediário')`,
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

async function debito(customerId, amount, { source = 'manual', createdAt = null } = {}) {
  const { rows } = await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, type, amount, notes, source, created_by, created_at)
     VALUES ($1, $2, 'debit', $3, 'Lancamento manual', $4, $5, COALESCE($6::timestamptz, NOW()))
     RETURNING id, created_at`,
    [companyId, customerId, amount, source, userId, createdAt]
  );
  return rows[0];
}

async function pagamento(customerId, amount) {
  await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, type, amount, payment_method, source, created_by)
     VALUES ($1, $2, 'payment', $3, 'pix', 'sale', $4)`,
    [companyId, customerId, amount, userId]
  );
}

async function parcela(customerId, amountDue, {
  transactionId = null, covered = 0, createdAt = null, number = 1, total = 1, dueDate = '2026-12-01',
} = {}) {
  const { rows } = await client.query(
    `INSERT INTO credit_installments
       (company_id, sale_id, customer_id, installment_number, total_installments,
        amount_due, due_date, status, covered_amount, transaction_id, created_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', $7, $8, COALESCE($9::timestamptz, NOW()))
     RETURNING id`,
    [companyId, customerId, number, total, amountDue, dueDate, covered, transactionId, createdAt]
  );
  return rows[0].id;
}

async function parcelaLida(id) {
  const { rows } = await client.query(
    `SELECT status, covered_amount::numeric AS covered FROM credit_installments WHERE id = $1`, [id]
  );
  return { status: rows[0].status, covered: Number(rows[0].covered) };
}

async function saldo(customerId) {
  const { rows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  return Number(rows[0]?.balance || 0);
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

async function debitoExiste(id) {
  const { rows } = await client.query(
    `SELECT 1 FROM customer_credit_transactions WHERE id = $1`, [id]
  );
  return rows.length > 0;
}

// ── cenários ───────────────────────────────────────────────────────────────

describe('undoManualEntry', () => {
  test('1. vínculo novo: cancela a parcela, apaga o débito e ledger volta a bater', async () => {
    // A reprodução do caso Ana Lucia: R$919 (1 parcela) + R$739 (1 parcela),
    // e o R$739 é desfeito.
    const cid = await cliente('Ana Lucia Fixture');
    const d919 = await debito(cid, 919);
    const p919 = await parcela(cid, 919, { transactionId: d919.id, covered: 180, dueDate: '2026-10-08' });
    await pagamento(cid, 180);
    const d739 = await debito(cid, 739);
    const p739 = await parcela(cid, 739, { transactionId: d739.id, dueDate: '2026-10-07' });

    expect(await saldo(cid)).toBe(1478);
    expect(await abertoNasParcelas(cid)).toBe(1478);

    const r = await undoManualEntry(client, { companyId, transactionId: d739.id });

    expect(r.deleted).toBe(true);
    expect(r.cancelled_installments).toBe(1);
    expect(r.reallocated_amount).toBe(0);
    expect(r.credit_left).toBe(0);
    expect(r.new_balance).toBe(739);

    expect(await debitoExiste(d739.id)).toBe(false);
    expect(await parcelaLida(p739)).toEqual({ status: 'cancelled', covered: 0 });
    expect(await parcelaLida(p919)).toEqual({ status: 'pending', covered: 180 });
    // A régua do incidente: ledger e parcelas contam a mesma história.
    expect(await abertoNasParcelas(cid)).toBe(await saldo(cid));
  });

  test('2. legado sem vínculo, mesmo instante: acha as parcelas pelo created_at', async () => {
    const cid = await cliente('Legado Mesmo Instante');
    const t0 = '2026-06-16T19:18:49.882Z';
    const d = await debito(cid, 600, { createdAt: t0 });
    const p1 = await parcela(cid, 300, { createdAt: t0, number: 1, total: 2 });
    const p2 = await parcela(cid, 300, { createdAt: t0, number: 2, total: 2, dueDate: '2027-01-01' });
    // Parcela de OUTRO lançamento, noutro instante: tem que sobreviver.
    const dOutro = await debito(cid, 50, { createdAt: '2026-07-01T12:00:00Z' });
    const pOutro = await parcela(cid, 50, { createdAt: '2026-07-01T12:00:00Z' });

    const r = await undoManualEntry(client, { companyId, transactionId: d.id });

    expect(r.cancelled_installments).toBe(2);
    expect((await parcelaLida(p1)).status).toBe('cancelled');
    expect((await parcelaLida(p2)).status).toBe('cancelled');
    expect((await parcelaLida(pOutro)).status).toBe('pending');
    expect(await debitoExiste(dOutro.id)).toBe(true);
    expect(await saldo(cid)).toBe(50);
    expect(await abertoNasParcelas(cid)).toBe(50);
  });

  test('3. legado com data retroativa: acha o grupo cuja soma bate com o débito', async () => {
    const cid = await cliente('Legado Retroativo');
    // Débito com created_at = data informada (meio-dia SP); parcelas no NOW().
    const d = await debito(cid, 500, { createdAt: '2026-06-01T15:00:00Z' });
    const p1 = await parcela(cid, 250, { number: 1, total: 2 });
    const p2 = await parcela(cid, 250, { number: 2, total: 2, dueDate: '2027-01-01' });
    // Grupo de outro lançamento, soma diferente: não pode ser confundido.
    await debito(cid, 120, { createdAt: '2026-06-02T15:00:00Z' });
    const pOutro = await parcela(cid, 120, { createdAt: '2026-06-02T15:00:01Z' });

    const r = await undoManualEntry(client, { companyId, transactionId: d.id });

    expect(r.cancelled_installments).toBe(2);
    expect((await parcelaLida(p1)).status).toBe('cancelled');
    expect((await parcelaLida(p2)).status).toBe('cancelled');
    expect((await parcelaLida(pOutro)).status).toBe('pending');
    expect(await saldo(cid)).toBe(120);
    expect(await abertoNasParcelas(cid)).toBe(120);
  });

  test('4. cobertura já aplicada volta ao FIFO da outra parcela aberta', async () => {
    const cid = await cliente('Cobertura Realocada');
    const dA = await debito(cid, 300);
    const pA = await parcela(cid, 300, { transactionId: dA.id, covered: 100, dueDate: '2026-10-01' });
    const dB = await debito(cid, 200);
    const pB = await parcela(cid, 200, { transactionId: dB.id, dueDate: '2026-11-01' });
    await pagamento(cid, 100);
    expect(await saldo(cid)).toBe(400);

    const r = await undoManualEntry(client, { companyId, transactionId: dA.id });

    expect(r.cancelled_installments).toBe(1);
    expect(r.reallocated_amount).toBe(100);
    expect(r.credit_left).toBe(0);
    expect(r.new_balance).toBe(100);
    expect(await parcelaLida(pA)).toEqual({ status: 'cancelled', covered: 0 });
    expect(await parcelaLida(pB)).toEqual({ status: 'pending', covered: 100 });
    expect(await abertoNasParcelas(cid)).toBe(100);

    // Sem outra parcela aberta, o que sobra vira crédito no ledger (saldo negativo).
    const r2 = await undoManualEntry(client, { companyId, transactionId: dB.id });
    expect(r2.credit_left).toBe(100);
    expect(r2.new_balance).toBe(-100);
    expect((await parcelaLida(pB)).status).toBe('cancelled');
  });

  test('5. pagamento não pode ser desfeito por aqui', async () => {
    const cid = await cliente('Pagamento Protegido');
    await debito(cid, 100);
    const { rows } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, payment_method, source, created_by)
       VALUES ($1, $2, 'payment', 40, 'pix', 'sale', $3) RETURNING id`,
      [companyId, cid, userId]
    );
    await expect(
      undoManualEntry(client, { companyId, transactionId: rows[0].id })
    ).rejects.toMatchObject({ status: 409, code: 'NOT_MANUAL_DEBIT' });
    expect(await saldo(cid)).toBe(60);
  });

  test('6. acréscimo de renegociação não arrasta o cronograma novo', async () => {
    const cid = await cliente('Renegociacao');
    const t0 = '2026-08-01T14:00:00Z';
    // applyReschedule grava o cronograma novo e o delta no mesmo NOW().
    const delta = await debito(cid, 30, { source: 'reschedule', createdAt: t0 });
    const p1 = await parcela(cid, 115, { createdAt: t0, number: 1, total: 2 });
    const p2 = await parcela(cid, 115, { createdAt: t0, number: 2, total: 2, dueDate: '2027-01-01' });

    const r = await undoManualEntry(client, { companyId, transactionId: delta.id });

    expect(r.cancelled_installments).toBe(0);
    expect((await parcelaLida(p1)).status).toBe('pending');
    expect((await parcelaLida(p2)).status).toBe('pending');
  });

  test('lançamento inexistente: 404', async () => {
    await expect(
      undoManualEntry(client, { companyId, transactionId: uuid() })
    ).rejects.toMatchObject({ status: 404 });
  });
});
