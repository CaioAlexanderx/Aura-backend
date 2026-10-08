// ============================================================
// AURA CRÉDITO — editar e remover um recebimento pela timeline
// (Postgres real, 08/10/2026)
//
// O CASO REAL (Looks da Jenny): R$200 lançados na ficha da "Maria Eduarda"
// errada, com data de três dias atrás. Não havia botão para tirar, e o
// desfazer do backend recusava pagamento retroativo (a janela de 24h contava
// da data informada). Corrigido por SQL à mão.
//
// O que este arquivo cobre, cada cenário num cliente próprio:
//   1. editar o VALOR: o pagamento antigo some, o novo cai nas parcelas pelo
//      FIFO, Financeiro e caixa acompanham
//   2. mover para OUTRO CLIENTE (o caso da Jenny): a ficha errada volta ao
//      que era e a certa recebe
//   3. mudar a DATA para um dia anterior e a FORMA de pagamento
//   4. nada mudou / data no futuro / cliente inexistente: recusa e nada muda
//   5. pagamento sem distribuição gravada: 409 e nada muda
//   6. pagamento retroativo é removido (sem prazo) pela rota DELETE
//   7. o histórico devolve as parcelas de cada pagamento e can_edit
//
// Mesmo padrão de credito.desfazerRecebimento.banco.test.js: tudo dentro de
// UMA transação revertida no afterAll. As rotas pedem um client ao pool e
// abrem a própria transação: aqui o "client" delega ao da transação do teste
// e troca BEGIN/COMMIT/ROLLBACK por SAVEPOINT, para o COMMIT da rota não
// gravar nada de verdade.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: null }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

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
let editPayment;
let resolveChanges;
let app;

const userId    = uuid();
const companyId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  // Client das rotas: mesma conexão, transação da rota vira savepoint.
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));

  ledger = require('../src/services/credit/ledger');
  ({ editPayment, resolveChanges } = require('../src/services/credit/editPayment'));

  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Crediário')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, pdv_settings)
     VALUES ($1, $2, 'Fixture Loja Editar Pagamento', '{"crediario_enabled": true}'::jsonb)`,
    [companyId, userId]
  );

  app = express();
  app.use(express.json());
  app.use('/companies/:id/credit', require('../src/routes/credit'));
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

async function venda(customerId, amount, { installments = 1, firstDueDate = '2026-12-01' } = {}) {
  const saleId = uuid();
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
  const n = Math.max(1, installments);
  const base = Math.floor((amount / n) * 100) / 100;
  for (let i = 1; i <= n; i++) {
    const amt = i === n ? Math.round((amount - base * (n - 1)) * 100) / 100 : base;
    await client.query(
      `INSERT INTO credit_installments
         (company_id, sale_id, customer_id, installment_number, total_installments,
          amount_due, due_date, status, covered_amount)
       VALUES ($1, $2, $3, $4, $5, $6, ($7::date + ($8::int * interval '1 month'))::date, 'pending', 0)`,
      [companyId, saleId, customerId, i, n, amt, firstDueDate, i - 1]
    );
  }
  await ledger._getOrCreateProfile(client, companyId, customerId);
  await ledger._getOrCreatePlanConfig(client, companyId);
  await ledger._updateCreditUsed(client, companyId, customerId);
  return saleId;
}

async function pagamento(customerId, amount, extra = {}) {
  const r = await ledger.applyPayment(client, {
    companyId, customerId, amount, method: 'pix', createdBy: userId, ...extra,
  });
  return r.transaction.id;
}

async function parcelas(customerId) {
  const { rows } = await client.query(
    `SELECT status, covered_amount FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 ORDER BY installment_number ASC`,
    [companyId, customerId]
  );
  return rows.map((r) => ({ status: r.status, covered: Number(r.covered_amount) }));
}

async function saldo(customerId) {
  const { rows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  return Number(rows[0]?.balance || 0);
}

async function pagamentoRow(txid) {
  const { rows } = await client.query(
    `SELECT customer_id, amount, payment_method,
            to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia
       FROM customer_credit_transactions WHERE id = $1`, [txid]
  );
  return rows[0] ? { ...rows[0], amount: Number(rows[0].amount) } : null;
}

async function caixa(saleId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM sale_payments WHERE company_id = $1 AND sale_id = $2`,
    [companyId, saleId]
  );
  return Number(rows[0].s);
}

async function recebidoNoFinanceiro(saleId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
      WHERE company_id = $1 AND idempotency_key LIKE $2 AND status = 'confirmed'`,
    [companyId, 'pdv-credit-receivable-' + saleId + '%']
  );
  return Number(rows[0].s);
}

const deps = {
  findCustomer: async (c, cid, custId) => {
    const { rows } = await c.query(`SELECT id FROM customers WHERE id = $1 AND company_id = $2`, [custId, cid]);
    return rows[0] || null;
  },
  loadContext: async () => ({}),
};

const editar = (transactionId, changes) =>
  editPayment(client, { companyId, transactionId, changes, createdBy: userId, ...deps });

function ontem() {
  const d = new Date(Date.now() - 3 * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// ── cenários ───────────────────────────────────────────────────────────────

describe('resolveChanges (puro)', () => {
  const orig = { amount: '200.00', payment_method: 'pix', customer_id: uuid(), paid_day: '2026-09-26' };

  test('só o que muda entra em changed; data anterior a hoje é retroativa', () => {
    const r = resolveChanges(orig, { amount: 20, method: 'pix' }, '2026-10-08');
    expect(r).toMatchObject({ amount: 20, method: 'pix', changed: ['amount'], paidAt: '2026-09-26' });
  });

  test('data de hoje vira "agora" (paidAt null)', () => {
    expect(resolveChanges(orig, { paid_at: '2026-10-08' }, '2026-10-08').paidAt).toBeNull();
  });

  test('recusas: nada mudou, valor zero, data futura, data torta, forma vazia', () => {
    expect(() => resolveChanges(orig, {}, '2026-10-08')).toThrow(expect.objectContaining({ status: 400, code: 'NOTHING_TO_CHANGE' }));
    expect(() => resolveChanges(orig, { amount: 200 }, '2026-10-08')).toThrow(expect.objectContaining({ code: 'NOTHING_TO_CHANGE' }));
    expect(() => resolveChanges(orig, { amount: 0 }, '2026-10-08')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    expect(() => resolveChanges(orig, { paid_at: '2026-10-09' }, '2026-10-08')).toThrow(expect.objectContaining({ code: 'INVALID_DATE' }));
    expect(() => resolveChanges(orig, { paid_at: '26/09/2026' }, '2026-10-08')).toThrow(expect.objectContaining({ code: 'INVALID_DATE' }));
    expect(() => resolveChanges(orig, { method: ' ' }, '2026-10-08')).toThrow(expect.objectContaining({ code: 'INVALID_METHOD' }));
    expect(() => resolveChanges(orig, { customer_id: 'abc' }, '2026-10-08')).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('editPayment', () => {
  test('1. valor: R$200 vira R$20 — pagamento antigo some, parcelas, Financeiro e caixa acompanham', async () => {
    const cid  = await cliente('Valor Digitado Errado');
    const sale = await venda(cid, 300, { installments: 3 });
    const tx   = await pagamento(cid, 200);

    expect(await parcelas(cid)).toEqual([
      { status: 'paid', covered: 100 }, { status: 'paid', covered: 100 }, { status: 'pending', covered: 0 },
    ]);
    expect(await saldo(cid)).toBe(100);

    const r = await editar(tx, { amount: 20 });

    expect(r).toMatchObject({ edited: true, changed: ['amount'], moved: false, amount: 20, new_balance: 280, previous_transaction_id: tx });
    expect(r.transaction_id).toBeTruthy();
    expect(r.transaction_id).not.toBe(tx);
    expect(await pagamentoRow(tx)).toBeNull();
    expect(await pagamentoRow(r.transaction_id)).toMatchObject({ customer_id: cid, amount: 20, payment_method: 'pix' });
    expect(await parcelas(cid)).toEqual([
      { status: 'pending', covered: 20 }, { status: 'pending', covered: 0 }, { status: 'pending', covered: 0 },
    ]);
    expect(await saldo(cid)).toBe(280);
    expect(await recebidoNoFinanceiro(sale)).toBe(20);
    expect(await caixa(sale)).toBe(20);
  });

  test('2. cliente: pagamento sai da ficha errada e entra na certa (caso Looks da Jenny)', async () => {
    const errada = await cliente('Maria Eduarda Errada');
    const certa  = await cliente('Maria Eduarda Certa');
    const saleE  = await venda(errada, 166);
    const saleC  = await venda(certa, 500, { installments: 2 });
    const tx     = await pagamento(errada, 166);

    expect(await saldo(errada)).toBe(0);
    expect(await saldo(certa)).toBe(500);

    const r = await editar(tx, { customer_id: certa });

    expect(r).toMatchObject({
      moved: true, customer_id: certa, previous_customer_id: errada,
      new_balance: 334, previous_customer_balance: 166, changed: ['customer_id'],
    });
    // a ficha errada volta exatamente ao que era
    expect(await saldo(errada)).toBe(166);
    expect(await parcelas(errada)).toEqual([{ status: 'pending', covered: 0 }]);
    expect(await recebidoNoFinanceiro(saleE)).toBe(0);
    expect(await caixa(saleE)).toBe(0);
    // a certa recebe pelo FIFO dela
    expect(await saldo(certa)).toBe(334);
    expect(await parcelas(certa)).toEqual([{ status: 'pending', covered: 166 }, { status: 'pending', covered: 0 }]);
    expect(await recebidoNoFinanceiro(saleC)).toBe(166);
    expect(await pagamentoRow(r.transaction_id)).toMatchObject({ customer_id: certa, amount: 166 });
  });

  test('3. data e forma: o pagamento passa a valer no dia informado, em dinheiro', async () => {
    const cid = await cliente('Dia e Forma Errados');
    await venda(cid, 90);
    const tx  = await pagamento(cid, 90);
    const dia = ontem();

    const r = await editar(tx, { paid_at: dia, method: 'dinheiro' });

    expect(r.changed.sort()).toEqual(['method', 'paid_at']);
    expect(r).toMatchObject({ paid_at: dia, method: 'dinheiro', new_balance: 0 });
    expect(await pagamentoRow(r.transaction_id)).toMatchObject({ dia, payment_method: 'dinheiro', amount: 90 });
    expect(await parcelas(cid)).toEqual([{ status: 'paid', covered: 90 }]);
  });

  test('4. recusas não mexem em nada: nada mudou, data futura, cliente que não existe', async () => {
    const cid = await cliente('Nada Muda');
    await venda(cid, 70);
    const tx  = await pagamento(cid, 70);

    await expect(editar(tx, { amount: 70 })).rejects.toMatchObject({ status: 400, code: 'NOTHING_TO_CHANGE' });
    await expect(editar(tx, { paid_at: '2099-01-01' })).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
    await expect(editar(tx, { customer_id: uuid() })).rejects.toMatchObject({ status: 404, code: 'CUSTOMER_NOT_FOUND' });
    await expect(editar(uuid(), { amount: 10 })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    expect(await pagamentoRow(tx)).toMatchObject({ amount: 70 });
    expect(await parcelas(cid)).toEqual([{ status: 'paid', covered: 70 }]);
    expect(await saldo(cid)).toBe(0);
  });

  test('5. sem distribuição gravada: 409 e nada muda', async () => {
    const cid = await cliente('Pagamento Antigo');
    await venda(cid, 60);
    const tx  = await pagamento(cid, 60);
    await client.query(`DELETE FROM credit_payment_allocations WHERE transaction_id = $1`, [tx]);

    await expect(editar(tx, { amount: 30 })).rejects.toMatchObject({ status: 409, code: 'PAYMENT_WITHOUT_ALLOCATIONS' });
    expect(await pagamentoRow(tx)).toMatchObject({ amount: 60 });
    expect(await saldo(cid)).toBe(0);
  });
});

describe('rotas', () => {
  test('6. DELETE /payments/:txid remove pagamento RETROATIVO (sem prazo)', async () => {
    const cid = await cliente('Retroativo Lançado Errado');
    await venda(cid, 200);
    const tx  = await pagamento(cid, 200, { paidAt: ontem() });
    expect(await saldo(cid)).toBe(0);

    const res = await request(app).delete(`/companies/${companyId}/credit/payments/${tx}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ undone: true, new_balance: 200 });
    expect(await pagamentoRow(tx)).toBeNull();
    expect(await parcelas(cid)).toEqual([{ status: 'pending', covered: 0 }]);
  });

  test('7. PATCH /payments/:txid edita, e o histórico mostra as parcelas do pagamento novo', async () => {
    const cid = await cliente('Pela Rota');
    await venda(cid, 300, { installments: 3 });
    const tx  = await pagamento(cid, 250);

    const patch = await request(app)
      .patch(`/companies/${companyId}/credit/payments/${tx}`)
      .send({ amount: 150 });
    expect(patch.status).toBe(200);
    expect(patch.body).toMatchObject({ edited: true, amount: 150, new_balance: 150 });

    const vazio = await request(app).patch(`/companies/${companyId}/credit/payments/${patch.body.transaction_id}`).send({});
    expect(vazio.status).toBe(400);
    expect(vazio.body.code).toBe('NOTHING_TO_CHANGE');

    const hist = await request(app).get(`/companies/${companyId}/credit/customers/${cid}/history`);
    expect(hist.status).toBe(200);
    const pag = hist.body.events.filter((e) => e.type === 'payment');
    expect(pag).toHaveLength(1);
    expect(pag[0].id).toBe(patch.body.transaction_id);
    expect(pag[0].payment.can_edit).toBe(true);
    expect(pag[0].payment.allocations.map((a) => [a.number, a.total_installments, a.principal_paid, a.status_after]))
      .toEqual([[1, 3, 100, 'paid'], [2, 3, 50, 'pending']]);
    expect(pag[0].payment.allocations[0]).toMatchObject({ from_sale: true, account_id: null, due_date: '2026-12-01' });
  });
});
