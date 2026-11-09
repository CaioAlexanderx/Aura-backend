// ============================================================
// Editar venda (09/11/2026) — Postgres real
//
// O teste de rota (vendas.editarVenda.rota.test.js) usa banco de mentira e
// cobre o contrato e as travas. Aqui a conta de verdade:
//
//   A. dry_run não grava nada (fotografia das tabelas antes e depois)
//   B. venda dividida num caixa JÁ FECHADO: sale_payments na mesma sessão,
//      soma = total, Financeiro com o valor e a descrição novos, o
//      fechamento (caixa_fechamentos) intacto e o registro da edição
//   C. taxa da maquininha recalculada (pix -> crédito -> débito -> pix)
//   D. entra no crediário: carnê novo, razão e parcelas batendo, A Receber,
//      receita do Caixa sai, histórico da cliente
//   E. sai do crediário: cancelCreditSale, razão e parcelas zerados juntos
//   F. entrada + crediário
//   G. troca a cliente de uma venda fiada sem pagamento: a dívida vai junto,
//      histórico das duas clientes recalculado
//   H. parcela paga trava forma e cliente; nada no crediário muda
//   I. NFC-e autorizada: crediário recusado
//   J. vendedor(a): employee_id, contadores, Financeiro
//   K. outra empresa = 404; seller_id ausente não zera (pela rota)
//   L. bloqueio manual da cliente barra a entrada no crediário
//
// Tudo numa transação revertida no afterAll; cada teste num SAVEPOINT
// próprio. A rota roda de verdade: BEGIN/COMMIT/ROLLBACK dela viram
// savepoints dentro da transação do teste.
// ============================================================
'use strict';

// 1ª parcela dentro da janela do crediário (validateFirstDueDate: de hoje
// até 90 dias), calculada no dia do teste para nunca vencer.
const PRIMEIRA = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let ledger;
let ev;
let app;

const userId = uuid();
const companyId = uuid();
const outraEmpresa = uuid();
const ana = uuid();
const bia = uuid();
const cliA = uuid();
const cliB = uuid();
const productId = uuid();
const sessaoFechada = uuid();

const TUDO = { vendedor: true, dinheiro: true };
const QUANDO = '2026-11-07T18:42:00Z'; // 15:42 em São Paulo

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  // A rota abre a própria transação: aqui ela vira savepoint da do teste.
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = String(sql || '').trim();
      if (/^BEGIN/i.test(s)) return client.query('SAVEPOINT rota');
      if (/^COMMIT$/i.test(s)) return client.query('RELEASE SAVEPOINT rota');
      if (/^ROLLBACK$/i.test(s)) return client.query('ROLLBACK TO SAVEPOINT rota');
      return client.query(sql, params);
    },
    release: () => {},
  }));

  ledger = require('../src/services/credit/ledger');
  ev = require('../src/services/editarVenda');
  ev._resetCache();

  // Colunas que a produção tem e o CI não (diretório legado de migrations).
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS employee_id UUID`);
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS employee_name TEXT`);
  await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS total_sales INTEGER`);
  await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS total_revenue NUMERIC`);
  await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN`);
  await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_installments INTEGER`);
  await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`);

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Caio Fixture')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, pdv_settings)
     VALUES ($1, $2, 'Fixture Editar Venda', $3::jsonb), ($4, $2, 'Fixture Outra', '{}'::jsonb)`,
    [companyId, userId, JSON.stringify({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1 }), outraEmpresa]
  );
  for (const [id, nome, cpf] of [[ana, 'Ana', '111'], [bia, 'Bia', '222']]) {
    await client.query(
      `INSERT INTO employees (id, company_id, name, cpf, base_salary, admission_date, total_sales, total_revenue)
       VALUES ($1, $2, $3, $4, 0, '2026-01-01', 0, 0)`,
      [id, companyId, nome, cpf]
    );
  }
  for (const [id, nome] of [[cliA, 'Cliente A'], [cliB, 'Cliente B']]) {
    await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [id, companyId, nome]);
    await ledger._getOrCreateProfile(client, companyId, id);
  }
  await client.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Batom matte', 189.70, 10)`,
    [productId, companyId]
  );
  await client.query(
    `INSERT INTO caixa_sessoes (id, company_id, opened_by, closed_by, opened_at, closed_at, troco_inicial, status)
     VALUES ($1, $2, $3, $3, '2026-11-07T12:00:00Z', '2026-11-07T23:00:00Z', 0, 'fechada')`,
    [sessaoFechada, companyId, userId]
  );
  await client.query(
    `INSERT INTO caixa_fechamentos (sessao_id, dinheiro_esperado, dinheiro_contado, total_dinheiro, total_geral)
     VALUES ($1, 412, 412, 412, 412)`,
    [sessaoFechada]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; req.companyRole = 'owner'; next(); });
  app.use('/companies/:id/sales', require('../src/routes/sales'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(async () => { await client.query('SAVEPOINT caso'); });
afterEach(async () => { await client.query('ROLLBACK TO SAVEPOINT caso'); });

// ── fixtures ────────────────────────────────────────────────────────────────

// Venda à vista como o POST /pdv/sale grava: sales + item + sale_payments na
// sessão + receita pdv-sale-<id> + taxa da maquininha quando tem cartão.
async function vendaAvista({ formas, empresa = companyId, employee = ana, customer = null, sessao = sessaoFechada, total = 189.70 }) {
  const id = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, seller_id, employee_id, seller_name, total_amount, discount_amount, payment_method, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'completed', $9)`,
    [id, empresa, customer, userId, employee, employee === ana ? 'Ana' : (employee === bia ? 'Bia' : null), total, formas[0].method, QUANDO]
  );
  await client.query(
    `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, discount, total_price, product_name_snapshot)
     VALUES ($1, $2, 1, $3, 0, 0, $3, 'Batom matte')`,
    [id, productId, total]
  );
  for (const f of formas) {
    await client.query(
      `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, empresa, f.method, f.amount, sessao, QUANDO]
    );
  }
  await client.query(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'income', 'confirmed', $2, $3, 'Vendas', '2026-11-07', $4, $5, $6)`,
    [empresa, total, `Venda PDV - Batom matte (${formas[0].method})`, QUANDO, userId, 'pdv-sale-' + id]
  );
  if (employee) {
    await client.query(
      `UPDATE employees SET total_sales = total_sales + 1, total_revenue = total_revenue + $1 WHERE id = $2`,
      [total, employee]
    );
  }
  return id;
}

// Venda 100% no crediário como o Caixa grava (carnê próprio + createCreditSale).
async function vendaFiada({ customer, total = 189.70, parcelas = 2 }) {
  const id = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, seller_id, employee_id, seller_name, total_amount, discount_amount, payment_method, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'Ana', $6, 0, 'crediario', 'completed', $7)`,
    [id, companyId, customer, userId, ana, total, QUANDO]
  );
  await client.query(
    `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, discount, total_price, product_name_snapshot)
     VALUES ($1, $2, 1, $3, 0, 0, $3, 'Batom matte')`,
    [id, productId, total]
  );
  const carneAuto = require('../src/services/credit/carneAuto');
  const carne = await carneAuto.createAutoCarne(client, { companyId, customerId: customer, prefix: 'Compra', date: '2026-11-07' });
  await ledger.createCreditSale(client, {
    companyId, customerId: customer, saleId: id, amount: total, accountId: carne ? carne.id : null,
    installments: parcelas, firstDueDate: '2026-12-07', productNames: ['Batom matte'], createdBy: userId,
  });
  return id;
}

const patch = (saleId, body, empresa = companyId) =>
  request(app).patch(`/companies/${empresa}/sales/${saleId}`).send(body);

const one = async (sql, params) => (await client.query(sql, params)).rows[0];
const all = async (sql, params) => (await client.query(sql, params)).rows;

async function saldo(customerId) {
  const r = await one(
    `SELECT COALESCE((SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2), 0) AS s`,
    [companyId, customerId]
  );
  return Number(r.s);
}
async function abertas(customerId) {
  const r = await one(
    `SELECT COALESCE(SUM(amount_due - covered_amount), 0) AS s FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending', 'overdue')`,
    [companyId, customerId]
  );
  return Number(r.s);
}
async function aReceberPendente(saleId) {
  const r = await one(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
      WHERE company_id = $1 AND status = 'pending' AND idempotency_key LIKE $2`,
    [companyId, 'pdv-credit-receivable-' + saleId + '%']
  );
  return Number(r.s);
}
async function formas(saleId) {
  return (await all(`SELECT method, amount::float AS amount, sessao_id FROM sale_payments WHERE sale_id = $1 ORDER BY method`, [saleId]))
    .map((r) => ({ method: r.method, amount: Number(r.amount), sessao_id: r.sessao_id }));
}
async function receita(saleId) {
  return one(`SELECT amount::float AS amount, description, payment_method, employee_id FROM transactions WHERE idempotency_key = $1`, ['pdv-sale-' + saleId]);
}
async function taxa(saleId) {
  const r = await one(`SELECT amount FROM transactions WHERE idempotency_key = $1`, ['pdv-card-fee-' + saleId]);
  return r ? Number(r.amount) : null;
}

// Tudo o que uma edição poderia tocar, numa fotografia comparável.
async function fotografia(saleId) {
  const q = async (sql, p) => JSON.stringify(await all(sql, p));
  return [
    await q(`SELECT * FROM sales WHERE id = $1`, [saleId]),
    await q(`SELECT method, amount, sessao_id, created_at FROM sale_payments WHERE sale_id = $1 ORDER BY id`, [saleId]),
    await q(`SELECT id, amount, status, description, idempotency_key FROM transactions WHERE company_id = $1 ORDER BY id`, [companyId]),
    await q(`SELECT id, customer_id, type, amount, account_id FROM customer_credit_transactions WHERE company_id = $1 ORDER BY id`, [companyId]),
    await q(`SELECT id, status, amount_due, covered_amount FROM credit_installments WHERE company_id = $1 ORDER BY id`, [companyId]),
    await q(`SELECT id, name, status FROM credit_accounts WHERE company_id = $1 ORDER BY id`, [companyId]),
    await q(`SELECT id, total_purchases, total_spent FROM customers WHERE company_id = $1 ORDER BY id`, [companyId]),
    await q(`SELECT id, total_sales, total_revenue FROM employees WHERE company_id = $1 ORDER BY id`, [companyId]),
    await q(`SELECT COUNT(*) FROM sale_edits WHERE company_id = $1`, [companyId]),
  ];
}

async function planejar(saleId, body, perms = TUDO) {
  const ctx = await ev.carregarContexto(client, { companyId, saleId });
  return ev.planejar(client, ctx, body, perms);
}

// ── casos ───────────────────────────────────────────────────────────────────

test('A. dry_run não grava nada', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }] });
  const antes = await fotografia(saleId);

  const plan = await planejar(saleId, {
    customer_id: cliA, seller_id: bia,
    payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA,
  });
  expect(plan.changes).toEqual(['seller', 'customer', 'payments']);
  expect(plan.credit.action).toBe('enter');
  expect(plan.credit.to.account_name).toBe('Compra de 07/11');
  expect(plan.credit.to.schedule.map((p) => p.amount_due)).toEqual([63.23, 63.23, 63.24]);

  const res = await patch(saleId, { seller_id: bia, payments: [{ method: 'dinheiro', amount: 189.70 }], dry_run: true });
  expect(res.status).toBe(200);
  expect(res.body.dry_run).toBe(true);

  expect(await fotografia(saleId)).toEqual(antes);
});

test('B. dividida num caixa já fechado: mesma sessão, soma = total, fechamento intacto, registro', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'dinheiro', amount: 189.70 }] });
  const fechamentoAntes = await one(`SELECT * FROM caixa_fechamentos WHERE sessao_id = $1`, [sessaoFechada]);

  const res = await patch(saleId, {
    payments: [{ method: 'dinheiro', amount: 100 }, { method: 'pix', amount: 89.70 }],
    reason: 'Parte foi no Pix',
  });
  expect(res.status).toBe(200);
  expect(res.body.plan.warnings.map((w) => w.code)).toContain('CAIXA_CLOSED');

  const f = await formas(saleId);
  expect(f).toEqual([
    { method: 'dinheiro', amount: 100, sessao_id: sessaoFechada },
    { method: 'pix', amount: 89.70, sessao_id: sessaoFechada },
  ]);
  expect(f.reduce((a, p) => a + p.amount, 0)).toBeCloseTo(189.70, 2);

  const r = await receita(saleId);
  expect(r.amount).toBeCloseTo(189.70, 2);
  expect(r.description).toBe('Venda PDV - Batom matte (dinheiro + pix)');
  expect(r.payment_method).toBeNull();
  expect((await one(`SELECT payment_method FROM sales WHERE id = $1`, [saleId])).payment_method).toBe('dinheiro');

  expect(await one(`SELECT * FROM caixa_fechamentos WHERE sessao_id = $1`, [sessaoFechada])).toEqual(fechamentoAntes);

  const reg = await one(`SELECT * FROM sale_edits WHERE sale_id = $1`, [saleId]);
  expect(reg.edited_by).toBe(userId);
  expect(reg.edited_by_name).toBe('Caio Fixture');
  expect(reg.changes).toEqual(['payments']);
  expect(reg.reason).toBe('Parte foi no Pix');
  expect(reg.before.payments).toEqual([{ method: 'dinheiro', amount: 189.7 }]);
  expect(reg.after.payments).toEqual([{ method: 'dinheiro', amount: 100 }, { method: 'pix', amount: 89.7 }]);

  const det = await request(app).get(`/companies/${companyId}/sales/${saleId}`);
  expect(det.status).toBe(200);
  expect(det.body.payments).toEqual([{ method: 'dinheiro', amount: 100 }, { method: 'pix', amount: 89.7 }]);
  expect(det.body.last_edit.by_name).toBe('Caio Fixture');
});

test('C. taxa da maquininha acompanha a forma', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }] });
  expect(await taxa(saleId)).toBeNull();

  expect((await patch(saleId, { payments: [{ method: 'cartao', amount: 189.70 }] })).status).toBe(200);
  expect(await taxa(saleId)).toBeCloseTo(5.69, 2); // 3% do crédito
  expect((await receita(saleId)).payment_method).toBe('credit');

  expect((await patch(saleId, { payments: [{ method: 'debito', amount: 189.70 }] })).status).toBe(200);
  expect(await taxa(saleId)).toBeCloseTo(1.90, 2); // 1% do débito

  expect((await patch(saleId, { payments: [{ method: 'pix', amount: 189.70 }] })).status).toBe(200);
  expect(await taxa(saleId)).toBeNull();
});

test('D e E. entra e sai do crediário com razão e parcelas batendo', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }] });

  const entra = await patch(saleId, {
    customer_id: cliA,
    payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA,
  });
  expect(entra.status).toBe(200);
  expect(entra.body.result.credit.account_name).toBe('Compra de 07/11');
  expect(entra.body.result.credit.installments).toHaveLength(3);

  const debito = await one(`SELECT amount, account_id FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  expect(Number(debito.amount)).toBeCloseTo(189.70, 2);
  const parc = await all(`SELECT amount_due, account_id, status FROM credit_installments WHERE sale_id = $1 ORDER BY installment_number`, [saleId]);
  expect(parc).toHaveLength(3);
  expect(parc.reduce((a, p) => a + Number(p.amount_due), 0)).toBeCloseTo(189.70, 2);
  expect(parc.every((p) => p.account_id === debito.account_id)).toBe(true);
  expect(await saldo(cliA)).toBeCloseTo(189.70, 2);
  expect(await abertas(cliA)).toBeCloseTo(await saldo(cliA), 2);
  expect(await aReceberPendente(saleId)).toBeCloseTo(189.70, 2);
  expect(await formas(saleId)).toEqual([]);
  expect(await receita(saleId)).toBeUndefined();
  const venda = await one(`SELECT payment_method, customer_id, is_installment, total_installments FROM sales WHERE id = $1`, [saleId]);
  expect(venda).toMatchObject({ payment_method: 'crediario', customer_id: cliA, is_installment: true, total_installments: 3 });
  const a = await one(`SELECT total_purchases, total_spent FROM customers WHERE id = $1`, [cliA]);
  expect(Number(a.total_purchases)).toBe(1);
  expect(Number(a.total_spent)).toBeCloseTo(189.70, 2);

  // Sai do crediário: volta para Pix.
  const sai = await patch(saleId, { payments: [{ method: 'pix', amount: 189.70 }] });
  expect(sai.status).toBe(200);
  expect(sai.body.plan.credit.action).toBe('leave');
  expect(await one(`SELECT 1 FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId])).toBeUndefined();
  const ativas = await all(`SELECT 1 FROM credit_installments WHERE sale_id = $1 AND status <> 'cancelled'`, [saleId]);
  expect(ativas).toHaveLength(0);
  expect(await saldo(cliA)).toBeCloseTo(0, 2);
  expect(await abertas(cliA)).toBeCloseTo(0, 2);
  expect(await aReceberPendente(saleId)).toBeCloseTo(0, 2);
  expect((await one(`SELECT status FROM credit_accounts WHERE id = $1`, [debito.account_id])).status).toBe('cancelled');
  expect(await formas(saleId)).toEqual([{ method: 'pix', amount: 189.70, sessao_id: sessaoFechada }]);
  expect((await receita(saleId)).amount).toBeCloseTo(189.70, 2);
  const v2 = await one(`SELECT payment_method, is_installment, total_installments FROM sales WHERE id = $1`, [saleId]);
  expect(v2).toMatchObject({ payment_method: 'pix', is_installment: false, total_installments: null });
  expect(await all(`SELECT 1 FROM sale_edits WHERE sale_id = $1`, [saleId])).toHaveLength(2);
});

test('F. entrada no Pix + crediário em 2x', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'dinheiro', amount: 189.70 }], customer: cliA });
  const res = await patch(saleId, {
    payments: [{ method: 'pix', amount: 50 }, { method: 'crediario', amount: 139.70 }], installments: 2, first_due_date: PRIMEIRA,
  });
  expect(res.status).toBe(200);
  expect(await formas(saleId)).toEqual([{ method: 'pix', amount: 50, sessao_id: sessaoFechada }]);
  expect((await receita(saleId)).amount).toBeCloseTo(50, 2);
  expect(await saldo(cliA)).toBeCloseTo(139.70, 2);
  expect(await abertas(cliA)).toBeCloseTo(139.70, 2);
  expect((await one(`SELECT payment_method FROM sales WHERE id = $1`, [saleId])).payment_method).toBe('pix');

  const det = await request(app).get(`/companies/${companyId}/sales/${saleId}`);
  expect(det.body.payments).toEqual([{ method: 'pix', amount: 50 }, { method: 'crediario', amount: 139.7, installments: 2 }]);
});

test('G. troca a cliente de uma venda fiada sem pagamento: a dívida vai junto', async () => {
  const saleId = await vendaFiada({ customer: cliA });
  await client.query(`UPDATE sales SET status = status WHERE id = $1`, [saleId]); // dispara a trigger de métricas
  expect(await saldo(cliA)).toBeCloseTo(189.70, 2);

  const res = await patch(saleId, { customer_id: cliB });
  expect(res.status).toBe(200);
  expect(res.body.plan.credit.action).toBe('move');

  expect(await saldo(cliA)).toBeCloseTo(0, 2);
  expect(await abertas(cliA)).toBeCloseTo(0, 2);
  expect(await saldo(cliB)).toBeCloseTo(189.70, 2);
  expect(await abertas(cliB)).toBeCloseTo(189.70, 2);
  const parc = await all(`SELECT total_installments, due_date::text AS d FROM credit_installments WHERE sale_id = $1 AND status <> 'cancelled' ORDER BY installment_number`, [saleId]);
  expect(parc.map((p) => p.d)).toEqual(['2026-12-07', '2027-01-07']);
  const a = await one(`SELECT total_purchases, total_spent FROM customers WHERE id = $1`, [cliA]);
  const b = await one(`SELECT total_purchases, total_spent FROM customers WHERE id = $1`, [cliB]);
  expect(Number(a.total_purchases)).toBe(0);
  expect(Number(a.total_spent)).toBe(0);
  expect(Number(b.total_purchases)).toBe(1);
  expect(Number(b.total_spent)).toBeCloseTo(189.70, 2);
});

test('H. parcela paga trava forma e cliente; nada no crediário muda', async () => {
  const saleId = await vendaFiada({ customer: cliA });
  await ledger.applyPayment(client, { companyId, customerId: cliA, amount: 94.85, method: 'pix', createdBy: userId });
  const antes = await fotografia(saleId);

  await expect(planejar(saleId, { payments: [{ method: 'pix', amount: 189.70 }] }))
    .rejects.toMatchObject({ status: 409, code: 'CREDIT_HAS_PAYMENT' });
  const r1 = await patch(saleId, { customer_id: cliB });
  expect(r1.status).toBe(409);
  expect(r1.body.code).toBe('CREDIT_HAS_PAYMENT');
  expect(await fotografia(saleId)).toEqual(antes);

  const r2 = await patch(saleId, { seller_id: bia });
  expect(r2.status).toBe(200);
  const paga = await one(`SELECT status, covered_amount FROM credit_installments WHERE sale_id = $1 AND installment_number = 1`, [saleId]);
  expect(paga.status).toBe('paid');
  expect(Number(paga.covered_amount)).toBeCloseTo(94.85, 2);
});

test('I. NFC-e autorizada: crediário recusado, outra forma passa', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }], customer: cliA });
  await client.query(
    `INSERT INTO nfce_emissions (company_id, sale_id, tipo, status, numero, authorized_at) VALUES ($1, $2, 'nfce', 'autorizada', 2318, NOW())`,
    [companyId, saleId]
  );
  const r1 = await patch(saleId, { payments: [{ method: 'crediario', amount: 189.70 }] });
  expect(r1.status).toBe(422);
  expect(r1.body.code).toBe('NFCE_AUTHORIZED_NO_CREDIARIO');
  expect(await one(`SELECT 1 FROM customer_credit_transactions WHERE sale_id = $1`, [saleId])).toBeUndefined();

  const r2 = await patch(saleId, { payments: [{ method: 'cartao', amount: 189.70 }] });
  expect(r2.status).toBe(200);
  expect(r2.body.plan.nfce.numero).toBe(2318);
  expect(r2.body.plan.nfce.can_cancel).toBe(true);
});

test('J. vendedor(a): comissão, contadores e Financeiro', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }] });
  const res = await patch(saleId, { seller_id: bia });
  expect(res.status).toBe(200);
  const v = await one(`SELECT seller_id, employee_id, seller_name FROM sales WHERE id = $1`, [saleId]);
  expect(v).toEqual({ seller_id: userId, employee_id: bia, seller_name: 'Bia' });
  const emp = await all(`SELECT name, total_sales, total_revenue::float AS rev FROM employees WHERE company_id = $1 ORDER BY name`, [companyId]);
  expect(emp.map((e) => [e.name, Number(e.total_sales), Number(e.rev)])).toEqual([['Ana', 0, 0], ['Bia', 1, 189.7]]);
  expect((await receita(saleId)).employee_id).toBe(bia);
});

test('K. outra empresa = 404; seller_id ausente não zera o vendedor', async () => {
  const deOutra = await vendaAvista({ formas: [{ method: 'pix', amount: 50 }], empresa: outraEmpresa, employee: null, sessao: null, total: 50 });
  const r1 = await patch(deOutra, { seller_id: bia });
  expect(r1.status).toBe(404);
  // Na empresa dona da venda, vendedor(a) de outra empresa também não entra.
  const r1b = await patch(deOutra, { seller_id: bia }, outraEmpresa);
  expect(r1b.status).toBe(404);
  expect(r1b.body.code).toBe('SELLER_NOT_FOUND');

  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }] });
  const r2 = await patch(saleId, { customer_id: cliA });
  expect(r2.status).toBe(200);
  const v = await one(`SELECT employee_id, seller_name, customer_id FROM sales WHERE id = $1`, [saleId]);
  expect(v).toEqual({ employee_id: ana, seller_name: 'Ana', customer_id: cliA });
});

test('L. bloqueio manual barra a entrada no crediário', async () => {
  await client.query(`UPDATE customer_credit_profiles SET status = 'blocked', blocked_reason = 'Atraso' WHERE customer_id = $1`, [cliB]);
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }], customer: cliB });
  const res = await patch(saleId, { payments: [{ method: 'crediario', amount: 189.70 }] });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('CUSTOMER_BLOCKED');
  expect(await one(`SELECT 1 FROM customer_credit_transactions WHERE sale_id = $1`, [saleId])).toBeUndefined();
});

// ── Revisão de 09/11/2026 (Aura-backend#972) ────────────────────────────────

test('M. venda renegociada (cronograma novo sem venda no carnê) trava forma e cliente', async () => {
  const saleId = await vendaFiada({ customer: cliA });
  const deb = await one(`SELECT account_id FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  // O que o reschedule.js faz: cancela as parcelas da venda e cria o
  // cronograma novo com sale_id NULL no mesmo carnê.
  await client.query(`UPDATE credit_installments SET status = 'cancelled', covered_amount = 0 WHERE sale_id = $1`, [saleId]);
  await client.query(
    `INSERT INTO credit_installments (company_id, sale_id, customer_id, installment_number, total_installments, amount_due, due_date, status, covered_amount, account_id)
     VALUES ($1, NULL, $2, 1, 1, 189.70, '2027-01-07', 'paid', 189.70, $3)`,
    [companyId, cliA, deb.account_id]
  );
  const antes = await fotografia(saleId);
  const r1 = await patch(saleId, { payments: [{ method: 'pix', amount: 189.70 }] });
  expect(r1.status).toBe(409);
  expect(r1.body.code).toBe('CREDIT_RENEGOTIATED');
  const r2 = await patch(saleId, { customer_id: cliB });
  expect(r2.body.code).toBe('CREDIT_RENEGOTIATED');
  expect(await fotografia(saleId)).toEqual(antes);
  const ctx = await request(app).get(`/companies/${companyId}/sales/${saleId}/edit-context`);
  expect(ctx.body.locks.money.code).toBe('CREDIT_RENEGOTIATED');
});

test('N. recebimento entre a leitura e a gravação: a edição para e nada do recebimento some', async () => {
  const saleId = await vendaFiada({ customer: cliA });
  const ctx = await ev.carregarContexto(client, { companyId, saleId, lock: true });
  const plan = await ev.planejar(client, ctx, { payments: [{ method: 'pix', amount: 189.70 }] }, TUDO);
  expect(plan.credit.action).toBe('leave');

  // Entra um recebimento depois da leitura (o applyPayment não trava a venda).
  await ledger.applyPayment(client, { companyId, customerId: cliA, amount: 94.85, method: 'pix', createdBy: userId });
  const depoisDoRecebimento = await fotografia(saleId);

  await client.query('SAVEPOINT aplicar');
  await expect(ev.aplicar(client, ctx, plan, { userId, userName: 'Caio' }))
    .rejects.toMatchObject({ status: 409, code: 'CREDIT_HAS_PAYMENT' });
  await client.query('ROLLBACK TO SAVEPOINT aplicar');
  expect(await fotografia(saleId)).toEqual(depoisDoRecebimento);
  const sp = await all(`SELECT amount FROM sale_payments WHERE sale_id = $1`, [saleId]);
  expect(sp.map((r) => Number(r.amount))).toEqual([94.85]);
});

test('O. entrar no crediário dias depois: débito e A Receber com o instante da venda', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }], customer: cliA });
  const res = await patch(saleId, { payments: [{ method: 'crediario', amount: 189.70 }], installments: 2, first_due_date: PRIMEIRA });
  expect(res.status).toBe(200);
  const deb = await one(`SELECT created_at FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  const ar = await one(`SELECT created_at FROM transactions WHERE idempotency_key = $1`, ['pdv-credit-receivable-' + saleId]);
  expect(new Date(deb.created_at).toISOString()).toBe('2026-11-07T18:42:00.000Z');
  expect(new Date(ar.created_at).toISOString()).toBe('2026-11-07T18:42:00.000Z');
});

test('P. troca de cliente mantém os termos da venda (juros e periodicidade)', async () => {
  const saleId = await vendaFiada({ customer: cliA });
  await client.query(
    `UPDATE sales SET credit_plan_snapshot = $2::jsonb WHERE id = $1`,
    [saleId, JSON.stringify({ installments: 2, total_amount: 189.70, interest_rate: 0.1, period_unit: 'week', period_count: 2 })]
  );
  const prev = await patch(saleId, { customer_id: cliB, dry_run: true });
  expect(prev.body.plan.requires_confirmation).toBe(true);
  const res = await patch(saleId, { customer_id: cliB });
  expect(res.status).toBe(200);
  const deb = await one(`SELECT amount, account_id FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  expect(Number(deb.amount)).toBeCloseTo(208.67, 2); // 189,70 + 10%
  const carne = await one(`SELECT terms_snapshot FROM credit_accounts WHERE id = $1`, [deb.account_id]);
  expect(carne.terms_snapshot).toMatchObject({ interest_rate: 0.1, period_unit: 'week', period_count: 2 });
  const parc = await all(`SELECT due_date::text AS d FROM credit_installments WHERE sale_id = $1 AND status <> 'cancelled' ORDER BY installment_number`, [saleId]);
  expect(parc.map((p) => p.d)).toEqual(['2026-12-07', '2026-12-21']);
  expect(await saldo(cliB)).toBeCloseTo(await abertas(cliB), 2);
});

test('Q. taxa conciliada no extrato: a edição solta a conciliação e refaz a taxa', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'cartao', amount: 189.70 }] });
  await client.query(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'expense', 'confirmed', 5.69, 'Taxa da maquininha', 'Taxas de cartão', '2026-11-07', NOW(), $2, $3)`,
    [companyId, userId, 'pdv-card-fee-' + saleId]
  );
  const fee = await one(`SELECT id FROM transactions WHERE idempotency_key = $1`, ['pdv-card-fee-' + saleId]);
  const conta = await one(`INSERT INTO bank_accounts (company_id, bank_name) VALUES ($1, 'Banco Fixture') RETURNING id`, [companyId]);
  await client.query(
    `INSERT INTO bank_statement_entries (company_id, bank_account_id, date, description, amount, matched_transaction_id, match_status, matched_at)
     VALUES ($1, $2, '2026-11-08', 'Tarifa', -5.69, $3, 'manual', NOW())`,
    [companyId, conta.id, fee.id]
  );
  const res = await patch(saleId, { payments: [{ method: 'debito', amount: 189.70 }] });
  expect(res.status).toBe(200);
  expect(await taxa(saleId)).toBeCloseTo(1.90, 2);
  const entrada = await one(`SELECT matched_transaction_id, match_status, matched_at FROM bank_statement_entries WHERE bank_account_id = $1`, [conta.id]);
  expect(entrada).toEqual({ matched_transaction_id: null, match_status: 'pendente', matched_at: null });
});

test('R. NF-e 55 autorizada: crediário recusado', async () => {
  const saleId = await vendaAvista({ formas: [{ method: 'pix', amount: 189.70 }], customer: cliA });
  await client.query(
    `INSERT INTO nfce_emissions (company_id, sale_id, tipo, status, numero, authorized_at) VALUES ($1, $2, 'nfe', 'autorizada', 77, NOW())`,
    [companyId, saleId]
  );
  const res = await patch(saleId, { payments: [{ method: 'crediario', amount: 189.70 }] });
  expect(res.status).toBe(422);
  expect(res.body.code).toBe('NFCE_AUTHORIZED_NO_CREDIARIO');
  expect(res.body.error).toContain('NF-e 77');
});

test('S. Pix pela maquininha (card_fee_pix_pct): Pix -> dinheiro tira a taxa; dinheiro -> Pix cobra', async () => {
  await client.query(
    `UPDATE companies SET pdv_settings = pdv_settings || '{"card_fee_pix_pct": 1}'::jsonb WHERE id = $1`,
    [companyId]
  );
  const saleId = await vendaAvista({ formas: [{ method: 'dinheiro', amount: 189.70 }] });
  expect((await patch(saleId, { payments: [{ method: 'pix', amount: 189.70 }] })).status).toBe(200);
  expect(await taxa(saleId)).toBeCloseTo(1.90, 2);
  expect((await patch(saleId, { payments: [{ method: 'dinheiro', amount: 189.70 }] })).status).toBe(200);
  expect(await taxa(saleId)).toBeNull();
});

// ── Segunda revisão (09/11/2026) ─────────────────────────────────────────────
test('T1. venda 1x sem snapshot refeita em 3x: juros da loja no débito, nas parcelas e na prévia', async () => {
  await ledger._getOrCreatePlanConfig(client, companyId);
  await client.query(`UPDATE credit_plan_configs SET interest_rate = 0.1 WHERE company_id = $1`, [companyId]);
  const saleId = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, seller_id, total_amount, discount_amount, payment_method, status, created_at)
     VALUES ($1, $2, $3, $4, 189.70, 0, 'crediario', 'completed', $5)`,
    [saleId, companyId, cliA, userId, QUANDO]
  );
  // Como o Caixa grava a venda 1x: débito e A Receber, sem cronograma nem snapshot.
  await ledger.createCreditSale(client, { companyId, customerId: cliA, saleId, amount: 189.70, installments: 1, productNames: ['Batom'], createdBy: userId });
  expect((await one(`SELECT credit_plan_snapshot FROM sales WHERE id = $1`, [saleId])).credit_plan_snapshot).toBeNull();

  const prev = await patch(saleId, { payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA, dry_run: true });
  expect(prev.status).toBe(200);
  const somaPrevia = prev.body.plan.credit.to.schedule.reduce((a, p) => a + p.amount_due, 0);
  expect(somaPrevia).toBeCloseTo(208.67, 2);

  const res = await patch(saleId, { payments: [{ method: 'crediario', amount: 189.70 }], installments: 3, first_due_date: PRIMEIRA });
  expect(res.status).toBe(200);
  const deb = await one(`SELECT amount FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  expect(Number(deb.amount)).toBeCloseTo(208.67, 2);
  const parc = await all(`SELECT amount_due FROM credit_installments WHERE sale_id = $1 AND status <> 'cancelled'`, [saleId]);
  expect(parc.reduce((a, p) => a + Number(p.amount_due), 0)).toBeCloseTo(somaPrevia, 2);
  expect(await saldo(cliA)).toBeCloseTo(await abertas(cliA), 2);
});

test('T2. renegociação entre a leitura e a trava: a edição para e o cronograma novo fica intacto', async () => {
  const saleId = await vendaFiada({ customer: cliA });
  const ctx = await ev.carregarContexto(client, { companyId, saleId, lock: true });
  const plan = await ev.planejar(client, ctx, { payments: [{ method: 'pix', amount: 189.70 }] }, TUDO);
  expect(plan.credit.action).toBe('leave');

  // O que o reschedule.js grava depois da leitura: parcelas da venda
  // canceladas e cronograma novo sem venda no mesmo carnê.
  const deb = await one(`SELECT account_id FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  await client.query(`UPDATE credit_installments SET status = 'cancelled', covered_amount = 0 WHERE sale_id = $1`, [saleId]);
  await client.query(
    `INSERT INTO credit_installments (company_id, sale_id, customer_id, installment_number, total_installments, amount_due, due_date, status, covered_amount, account_id)
     VALUES ($1, NULL, $2, 1, 1, 189.70, $3, 'pending', 0, $4)`,
    [companyId, cliA, PRIMEIRA, deb.account_id]
  );
  const depois = await fotografia(saleId);

  await client.query('SAVEPOINT aplicar_reneg');
  await expect(ev.aplicar(client, ctx, plan, { userId, userName: 'Caio' }))
    .rejects.toMatchObject({ status: 409, code: 'CREDIT_RENEGOTIATED' });
  await client.query('ROLLBACK TO SAVEPOINT aplicar_reneg');
  expect(await fotografia(saleId)).toEqual(depois);
  const novo = await one(`SELECT status FROM credit_installments WHERE company_id = $1 AND sale_id IS NULL AND account_id = $2`, [companyId, deb.account_id]);
  expect(novo.status).toBe('pending');
});
