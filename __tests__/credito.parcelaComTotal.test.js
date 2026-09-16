// ============================================================
// AURA CRÉDITO — prévia e baixa dizem QUAL parcela (15/09/2026)
//
// QA em produção: o painel "Pagamento registrado" mostrou "Parcela 1" duas
// vezes — a 1/1 de uma venda e a 1/3 de outra. As linhas de `applied`
// (GET /payments/preview e POST /payments) só traziam `number`. Passam a
// trazer `total_installments` e `due_date` como dia de calendário
// ('AAAA-MM-DD'), sem a meia-noite UTC que o driver do pg produz.
//
// Postgres real, tudo numa transação revertida (padrão de
// credito.pagamentoDistribuicao.test.js). A transação da própria rota vira
// SAVEPOINT: um COMMIT dela não pode fechar a transação do teste.
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
let router;

const userId     = uuid();
const companyId  = uuid();
const customerId = uuid();
const saleOld    = uuid();
const saleNew    = uuid();
const instOld    = uuid();
const instNew1   = uuid();
const instNew2   = uuid();
const instNew3   = uuid();

function routeClient() {
  const sp = 'sp_route_' + Math.random().toString(36).slice(2, 8);
  const map = (sql) => {
    const s = String(sql).trim().toUpperCase();
    if (s === 'BEGIN') return `SAVEPOINT ${sp}`;
    if (s === 'COMMIT') return `RELEASE SAVEPOINT ${sp}`;
    if (s === 'ROLLBACK') return `ROLLBACK TO SAVEPOINT ${sp}`;
    return sql;
  };
  return { query: (sql, params) => client.query(map(sql), params), release: () => {} };
}

function handler(path, method) {
  const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(path, method, req) {
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return this; },
    json(o) { out.body = o; return this; },
    setHeader() {},
  };
  await handler(path, method)({ params: { id: companyId, cid: customerId }, query: {}, body: {}, headers: {}, user: { id: userId }, ...req }, res);
  return out;
}

beforeAll(async () => {
  pgPool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pgPool.connect();
  await client.query('BEGIN');

  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  db.connect.mockImplementation(async () => routeClient());
  router = require('../src/routes/credit');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Parcela')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, pdv_settings)
     VALUES ($1, $2, 'Fixture Loja Parcela', '{"crediario_enabled": true}')`,
    [companyId, userId]
  );
  await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Annamaria Fixture')`, [customerId, companyId]);

  // applyPayment grava transactions.payment_method ao liquidar o recebível;
  // a coluna existe em produção (src/migrations/042), o CI não a aplica.
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);

  // O cenário do QA: uma venda antiga em 1x e uma nova em 3x, as duas com "Parcela 1".
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount) VALUES ($1, $3, $4, 30.00), ($2, $3, $4, 30.00)`,
    [saleOld, saleNew, companyId, customerId]
  );
  await client.query(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, idempotency_key)
     VALUES ($1, 'income', 'pending', 30.00, 'venda 1x', 'Crediario - A Receber', CURRENT_DATE, $2),
            ($1, 'income', 'pending', 30.00, 'venda 3x', 'Crediario - A Receber', CURRENT_DATE, $3)`,
    [companyId, 'pdv-credit-receivable-' + saleOld, 'pdv-credit-receivable-' + saleNew]
  );
  await client.query(
    `INSERT INTO credit_installments
       (id, company_id, sale_id, customer_id, installment_number, total_installments, amount_due, due_date, status)
     VALUES
       ($1, $5, $6, $8, 1, 1, 30.00, DATE '2026-09-22', 'pending'),
       ($2, $5, $7, $8, 1, 3, 10.00, DATE '2026-10-15', 'pending'),
       ($3, $5, $7, $8, 2, 3, 10.00, DATE '2026-11-15', 'pending'),
       ($4, $5, $7, $8, 3, 3, 10.00, DATE '2026-12-15', 'pending')`,
    [instOld, instNew1, instNew2, instNew3, companyId, saleOld, saleNew, customerId]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pgPool) await pgPool.end();
});

const pick = (a) => ({ number: a.number, total_installments: a.total_installments, due_date: a.due_date });

describe('linhas de applied identificam a parcela', () => {
  test('prévia: 1/1 e 1/3 saem distintas, com vencimento de calendário', async () => {
    const { status, body } = await call('/customers/:cid/payments/preview', 'get', { query: { amount: '35' } });
    expect(status).toBe(200);
    expect(body.applied.map(pick)).toEqual([
      { number: 1, total_installments: 1, due_date: '2026-09-22' },
      { number: 1, total_installments: 3, due_date: '2026-10-15' },
    ]);
  });

  test('baixa: mesmas parcelas, mesmos campos, e o id do pagamento', async () => {
    const { status, body } = await call('/customers/:cid/payments', 'post', { body: { amount: 35, method: 'dinheiro' } });
    expect(status).toBe(201);
    expect(body.transaction_id).toBeTruthy();
    const lines = [...body.applied].sort((a, b) => a.due_date.localeCompare(b.due_date));
    expect(lines.map(pick)).toEqual([
      { number: 1, total_installments: 1, due_date: '2026-09-22' },
      { number: 1, total_installments: 3, due_date: '2026-10-15' },
    ]);
    expect(lines.map(l => l.status_after)).toEqual(['paid', 'pending']);
  });

  test('a baixa ficou gravada dentro da transação do teste', async () => {
    const { rows } = await client.query(
      `SELECT status FROM credit_installments WHERE id = ANY($1::uuid[]) ORDER BY due_date`,
      [[instOld, instNew1]]
    );
    expect(rows.map(r => r.status)).toEqual(['paid', 'pending']);
  });
});
