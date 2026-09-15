// ============================================================
// AURA CRÉDITO — recibo lista as parcelas que o pagamento cobriu (15/09/2026)
//
// Feedback de lojista: o recibo saía "sobre o valor, e não sobre a parcela",
// e o "Saldo restante" mudava sempre que o cliente comprava mais.
//
// applyPayment passa a gravar credit_payment_allocations (migration 335) e o
// recibo lê de lá. Os testes unitários cobrem a ordem das queries com mock;
// este cobre o SQL em Postgres real: o INSERT com unnest, os tipos, a
// constraint de unicidade e o JOIN do recibo.
//
// Mesmo padrão de credito.recebivelSaldoParcial.test.js: tudo dentro de UMA
// transação revertida no afterAll — zero resíduo. O pool do app é o mock do
// jest.setup; aqui ele delega para o client real da transação.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pgPool;
let client;
let db;
let ledger;
let router;

const userId     = uuid();
const companyId  = uuid();
const customerId = uuid();
const saleId     = uuid();
const inst1 = uuid();
const inst2 = uuid();
const inst3 = uuid();

beforeAll(async () => {
  pgPool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pgPool.connect();
  await client.query('BEGIN');

  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  ledger = require('../src/services/credit/ledger');
  router = require('../src/routes/print');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Recibo')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name)
     VALUES ($1, $2, 'Fixture Loja Recibo')`,
    [companyId, userId]
  );
  await client.query(
    `INSERT INTO customers (id, company_id, name)
     VALUES ($1, $2, 'Veronica Fixture')`,
    [customerId, companyId]
  );
  // applyPayment grava transactions.payment_method ao liquidar o recebível.
  // Em produção a coluna existe (src/migrations/042, diretório legado), mas o
  // CI só aplica migrations/ e não a tem. Criada aqui, dentro da transação
  // revertida, para o banco de teste espelhar produção. A trava do DDL dura
  // só este arquivo: o CI roda a suíte com --runInBand.
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);

  // Venda no crediário como o PDV cria: venda + recebível em aberto + parcelas.
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount)
     VALUES ($1, $2, $3, 50.00)`,
    [saleId, companyId, customerId]
  );
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, idempotency_key)
     VALUES ($1, 'income', 'pending', 50.00, 'venda crediario', 'Crediario - A Receber', CURRENT_DATE, $2)`,
    [companyId, 'pdv-credit-receivable-' + saleId]
  );
  await client.query(
    `INSERT INTO credit_installments
       (id, company_id, sale_id, customer_id, installment_number, total_installments, amount_due, due_date, status)
     VALUES
       ($1, $4, $6, $5, 1, 3, 16.66, DATE '2026-10-14', 'pending'),
       ($2, $4, $6, $5, 2, 3, 16.66, DATE '2026-11-14', 'pending'),
       ($3, $4, $6, $5, 3, 3, 16.68, DATE '2026-12-14', 'pending')`,
    [inst1, inst2, inst3, companyId, customerId, saleId]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pgPool) await pgPool.end();
});

function receiptHandler() {
  const layer = router.stack.find(l => l.route && l.route.path === '/credit/receipts/:transactionId');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function renderReceipt(transactionId) {
  let html = null;
  let status = 200;
  const res = {
    setHeader() {},
    status(c) { status = c; return this; },
    json(o) { html = JSON.stringify(o); },
    send(h) { html = h; },
  };
  await receiptHandler()({ params: { id: companyId, transactionId } }, res);
  return { status, html };
}

describe('pagamento grava a distribuição e o recibo a lê', () => {
  let paymentTx;

  test('R$25 quita a 1ª parcela e abate parte da 2ª', async () => {
    const result = await ledger.applyPayment(client, {
      companyId, customerId, amount: 25, method: 'dinheiro',
    });
    paymentTx = result.transaction;
    expect(paymentTx && paymentTx.id).toBeTruthy();

    const { rows } = await client.query(
      `SELECT installment_id, principal_paid::float AS principal_paid,
              charges_paid::float AS charges_paid, status_after
         FROM credit_payment_allocations
        WHERE transaction_id = $1
        ORDER BY principal_paid DESC`,
      [paymentTx.id]
    );
    expect(rows).toEqual([
      { installment_id: inst1, principal_paid: 16.66, charges_paid: 0, status_after: 'paid' },
      { installment_id: inst2, principal_paid: 8.34,  charges_paid: 0, status_after: 'pending' },
    ]);
  });

  test('regravar a mesma distribuição não duplica (constraint única)', async () => {
    const r = await client.query(
      `INSERT INTO credit_payment_allocations
         (company_id, transaction_id, installment_id, principal_paid, charges_paid, status_after)
       VALUES ($1, $2, $3, 16.66, 0, 'paid')
       ON CONFLICT (transaction_id, installment_id) DO NOTHING`,
      [companyId, paymentTx.id, inst1]
    );
    expect(r.rowCount).toBe(0);
  });

  test('o recibo lista as parcelas pagas e não mostra saldo', async () => {
    const { status, html } = await renderReceipt(paymentTx.id);
    expect(status).toBe(200);
    expect(html).toContain('Parcelas pagas');
    expect(html).toContain('14/10/2026');
    expect(html).toContain('R$16.66');
    expect(html).toContain('Quitada');
    expect(html).toContain('14/11/2026');
    expect(html).toContain('R$8.34');
    expect(html).toContain('Parcial');
    expect(html).not.toMatch(/Saldo restante/i);
  });

  test('uma compra nova depois do pagamento não muda o recibo', async () => {
    const before = (await renderReceipt(paymentTx.id)).html;
    await client.query(
      `INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount)
       VALUES ($1, $2, 'debit', 300.00)`,
      [companyId, customerId]
    );
    const after = (await renderReceipt(paymentTx.id)).html;
    const strip = (h) => h.replace(/Emitido em:[^<]*/g, '');
    expect(strip(after)).toBe(strip(before));
  });
});
