// ============================================================
// AURA CRÉDITO — desfazer um recebimento registrado em duplicidade
// (Postgres real, 07/10/2026)
//
// O CASO REAL (Valen / jackson ICL): o pagamento de R$260 entrou duas vezes
// e a segunda linha foi revertida por SQL à mão — parcela, Financeiro,
// sale_payments e credit_used, um a um. Em 90 dias havia 19 pares iguais.
//
// O que este arquivo cobre, cada cenário num cliente próprio, com a venda e
// o pagamento gravados pelo caminho real (createCreditSale + applyPayment):
//   1. recebimento simples: parcela quitada volta a 'pending', recebível
//      volta a 'A Receber', caixa e razão limpos
//   2. parcial: 2 parcelas, uma quitada e uma parcial; a linha '-rest-' do
//      Financeiro é reabsorvida pela original
//   3. com encargos: multa/mora saem da parcela, a linha de encargos e a
//      sobra '-legacy' saem do Financeiro, parcela vencida reabre 'overdue'
//   4. fora da janela de 24h: 409 PAYMENT_TOO_OLD, nada muda
//   5. sem distribuição gravada: 409 PAYMENT_WITHOUT_ALLOCATIONS
//   6. idempotência: segundo DELETE → 404
//   7. crédito de troca e débito não passam por aqui (409)
//   8. dois recebimentos retroativos no mesmo dia têm instantes distintos;
//      desfazer o segundo não toca o primeiro
//
// Mesmo padrão de credito.desfazerLancamentoSemParcelaOrfa.test.js: tudo
// dentro de UMA transação revertida no afterAll — zero resíduo. O pool do app
// é o mock global; aqui ele delega ao client da transação (as sondas do
// ledger — allocations, reference_*). Os NUMERIC chegam como string neste
// Pool cru: toda leitura passa por Number().
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

  // applyPayment grava transactions.payment_method ao liquidar o recebivel.
  // Em producao a coluna existe (src/migrations/042, diretorio legado), mas o
  // CI so aplica migrations/ e nao a tem. Criada aqui, dentro da transacao
  // revertida, como em credito.pagamentoDistribuicao.test.js.
  await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Crediário')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name)
     VALUES ($1, $2, 'Fixture Loja Desfazer Recebimento')`,
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

// Venda no crediario como o PDV grava: venda + debito no razao + recebivel em
// aberto + parcelas. Montada a mao (como em credito.pagamentoDistribuicao):
// createCreditSale toca colunas de sales que o CI nao tem e o 42703 engolido
// abortaria a transacao unica deste arquivo.
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

async function pagamento(customerId, amount, { config, profile } = {}) {
  const r = await ledger.applyPayment(client, {
    companyId, customerId, amount, method: 'pix', createdBy: userId, config, profile,
  });
  return r.transaction.id;
}

async function parcelas(customerId) {
  const { rows } = await client.query(
    `SELECT id, status, covered_amount, paid_at, late_fee, late_interest
       FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2
      ORDER BY installment_number ASC`,
    [companyId, customerId]
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, covered: Number(r.covered_amount), paid_at: r.paid_at,
    late_fee: Number(r.late_fee), late_interest: Number(r.late_interest),
  }));
}

async function saldo(customerId) {
  const { rows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
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

async function recebiveis(saleId) {
  const { rows } = await client.query(
    `SELECT status, category, amount, paid_at, idempotency_key
       FROM transactions
      WHERE company_id = $1 AND idempotency_key LIKE $2
      ORDER BY length(idempotency_key) ASC, idempotency_key ASC`,
    [companyId, 'pdv-credit-receivable-' + saleId + '%']
  );
  return rows.map((r) => ({
    status: r.status, category: r.category, amount: Number(r.amount), paid_at: r.paid_at,
    rest: r.idempotency_key.includes('-rest-'),
  }));
}

async function linhaPorChave(key) {
  const { rows } = await client.query(
    `SELECT amount FROM transactions WHERE company_id = $1 AND idempotency_key = $2`,
    [companyId, key]
  );
  return rows.length ? Number(rows[0].amount) : null;
}

async function caixa(saleId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM sale_payments WHERE company_id = $1 AND sale_id = $2`,
    [companyId, saleId]
  );
  return Number(rows[0].s);
}

async function pagamentoExiste(txid) {
  const { rows } = await client.query(
    `SELECT 1 FROM customer_credit_transactions WHERE id = $1`, [txid]
  );
  return rows.length > 0;
}

// Dentro de UMA transacao o NOW() e o mesmo para todos os pagamentos; em
// producao cada recebimento tem o seu instante. Empurra um pagamento (e o
// que ele gravou no Financeiro e no caixa, no instante dele) uma hora para tras.
async function envelhecer(txid) {
  await client.query(
    `UPDATE transactions t SET paid_at = p.created_at - interval '1 hour'
       FROM customer_credit_transactions p
      WHERE p.id = $2 AND t.company_id = $1 AND t.paid_at = p.created_at
        AND t.idempotency_key LIKE 'pdv-credit-receivable-%'`,
    [companyId, txid]
  );
  await client.query(
    `UPDATE sale_payments sp SET created_at = p.created_at - interval '1 hour'
       FROM customer_credit_transactions p
      WHERE p.id = $2 AND sp.company_id = $1 AND sp.created_at = p.created_at`,
    [companyId, txid]
  );
  await client.query(
    `UPDATE customer_credit_transactions SET created_at = created_at - interval '1 hour' WHERE id = $1`,
    [txid]
  );
}

async function alocacoes(txid) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM credit_payment_allocations WHERE transaction_id = $1`, [txid]
  );
  return rows[0].n;
}

// ── cenários ───────────────────────────────────────────────────────────────

describe('undoPayment', () => {
  test('1. recebimento simples: parcela quitada volta a pending, Financeiro e caixa voltam', async () => {
    const cid  = await cliente('Duplicidade Simples');
    const sale = await venda(cid, 260);
    const tx   = await pagamento(cid, 260);

    expect(await saldo(cid)).toBe(0);
    expect((await parcelas(cid))[0]).toMatchObject({ status: 'paid', covered: 260 });
    expect(await recebiveis(sale)).toEqual([
      expect.objectContaining({ status: 'confirmed', category: 'Crediario - Recebido', amount: 260 }),
    ]);
    expect(await caixa(sale)).toBe(260);
    expect(await alocacoes(tx)).toBe(1);

    const r = await undoPayment(client, { companyId, transactionId: tx });

    expect(r).toMatchObject({
      undone: true, customer_id: cid, new_balance: 260,
      installments_reopened: 1, financeiro_reverted: 1,
    });
    const [p] = await parcelas(cid);
    expect(p).toMatchObject({ status: 'pending', covered: 0, paid_at: null });
    expect(await recebiveis(sale)).toEqual([
      expect.objectContaining({ status: 'pending', category: 'Crediario - A Receber', amount: 260, paid_at: null }),
    ]);
    expect(await caixa(sale)).toBe(0);
    expect(await pagamentoExiste(tx)).toBe(false);
    expect(await alocacoes(tx)).toBe(0);
    expect(await saldo(cid)).toBe(260);
    expect(await creditUsed(cid)).toBe(260);
  });

  test('2. parcial: uma quitada e uma parcial; a sobra do Financeiro volta para a linha original', async () => {
    const cid  = await cliente('Duplicidade Parcial');
    const sale = await venda(cid, 200, { installments: 2 });
    // Outro pagamento, mais cedo, que NAO pode ser tocado.
    const txAntes = await pagamento(cid, 30);
    await envelhecer(txAntes);
    const tx = await pagamento(cid, 120);

    let ps = await parcelas(cid);
    expect(ps[0]).toMatchObject({ status: 'paid', covered: 100 });
    expect(ps[1]).toMatchObject({ status: 'pending', covered: 50 });
    // Recebivel de 200: 30 parcial (resto 170) e depois 120 parcial do resto (resto 50).
    expect(await recebiveis(sale)).toEqual([
      expect.objectContaining({ status: 'confirmed', amount: 30, rest: false }),
      expect.objectContaining({ status: 'confirmed', amount: 120, rest: true }),
      expect.objectContaining({ status: 'pending', amount: 50, rest: true }),
    ]);

    const r = await undoPayment(client, { companyId, transactionId: tx });

    expect(r).toMatchObject({ new_balance: 170, installments_reopened: 1, financeiro_reverted: 1 });
    ps = await parcelas(cid);
    expect(ps[0]).toMatchObject({ status: 'pending', covered: 30, paid_at: null });
    expect(ps[1]).toMatchObject({ status: 'pending', covered: 0 });
    // O de 30 segue intacto; a linha de 120 volta a 'A Receber' com os 50 reabsorvidos.
    expect(await recebiveis(sale)).toEqual([
      expect.objectContaining({ status: 'confirmed', amount: 30, rest: false }),
      expect.objectContaining({ status: 'pending', category: 'Crediario - A Receber', amount: 170, rest: true }),
    ]);
    expect(await caixa(sale)).toBe(30);
    expect(await pagamentoExiste(txAntes)).toBe(true);
    expect(await pagamentoExiste(tx)).toBe(false);
  });

  test('3. com encargos: multa/mora e sobra saem; parcela vencida reabre como overdue', async () => {
    const cid  = await cliente('Duplicidade Encargos');
    const sale = await venda(cid, 100, { firstDueDate: '2026-09-01' });
    // Carne antigo (fora da janela de conferencia) e loja que cobra encargos.
    await client.query(
      `UPDATE credit_installments SET created_at = '2026-08-01T15:00:00Z', status = 'overdue'
        WHERE company_id = $1 AND customer_id = $2`,
      [companyId, cid]
    );
    await client.query(
      `UPDATE credit_plan_configs SET late_charges_enabled = true, late_grace_days = 0 WHERE company_id = $1`,
      [companyId]
    );
    const { rows: cfg } = await client.query(
      `SELECT * FROM credit_plan_configs WHERE company_id = $1`, [companyId]
    );
    const { rows: prof } = await client.query(
      `SELECT * FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`, [companyId, cid]
    );

    // Paga mais que o devido: encargos + 100 de principal + sobra sem recebivel.
    const tx = await pagamento(cid, 150, { config: cfg[0], profile: prof[0] });

    let [p] = await parcelas(cid);
    expect(p.status).toBe('paid');
    expect(p.late_fee + p.late_interest).toBeGreaterThan(0);
    const encargos = await linhaPorChave('credit-charges-' + tx);
    expect(encargos).toBeGreaterThan(0);
    expect(await linhaPorChave('credit-payment-' + tx + '-legacy')).toBeCloseTo(50 - encargos, 2);
    expect(await saldo(cid)).toBe(-50);

    const r = await undoPayment(client, { companyId, transactionId: tx });

    expect(r).toMatchObject({ new_balance: 100, installments_reopened: 1, financeiro_reverted: 3 });
    [p] = await parcelas(cid);
    expect(p).toMatchObject({ status: 'overdue', covered: 0, paid_at: null, late_fee: 0, late_interest: 0 });
    expect(await linhaPorChave('credit-charges-' + tx)).toBeNull();
    expect(await linhaPorChave('credit-payment-' + tx + '-legacy')).toBeNull();
    expect(await recebiveis(sale)).toEqual([
      expect.objectContaining({ status: 'pending', category: 'Crediario - A Receber', amount: 100 }),
    ]);
    expect(await caixa(sale)).toBe(0);

    await client.query(
      `UPDATE credit_plan_configs SET late_charges_enabled = false WHERE company_id = $1`, [companyId]
    );
  });

  test('4. fora da janela de 24h: 409 e nada muda', async () => {
    const cid  = await cliente('Pagamento Velho');
    const sale = await venda(cid, 80);
    const tx   = await pagamento(cid, 80);
    await client.query(
      `UPDATE customer_credit_transactions SET created_at = NOW() - interval '25 hours' WHERE id = $1`, [tx]
    );

    await expect(
      undoPayment(client, { companyId, transactionId: tx })
    ).rejects.toMatchObject({ status: 409, code: 'PAYMENT_TOO_OLD' });

    expect(await pagamentoExiste(tx)).toBe(true);
    expect((await parcelas(cid))[0]).toMatchObject({ status: 'paid', covered: 80 });
    expect(await caixa(sale)).toBe(80);
    expect(await saldo(cid)).toBe(0);

    // A janela e configuravel: com 48h o mesmo pagamento passa.
    const r = await undoPayment(client, { companyId, transactionId: tx, windowHours: 48 });
    expect(r.undone).toBe(true);
    expect(await saldo(cid)).toBe(80);
  });

  test('5. sem distribuicao gravada: 409, nao se adivinha', async () => {
    const cid = await cliente('Pagamento Antigo Sem Allocations');
    await venda(cid, 90);
    const tx = await pagamento(cid, 90);
    await client.query(`DELETE FROM credit_payment_allocations WHERE transaction_id = $1`, [tx]);

    await expect(
      undoPayment(client, { companyId, transactionId: tx })
    ).rejects.toMatchObject({ status: 409, code: 'PAYMENT_WITHOUT_ALLOCATIONS' });

    expect(await pagamentoExiste(tx)).toBe(true);
    expect((await parcelas(cid))[0]).toMatchObject({ status: 'paid', covered: 90 });
  });

  test('6. idempotencia: segundo desfazer do mesmo recebimento e 404', async () => {
    const cid = await cliente('Desfaz Duas Vezes');
    await venda(cid, 40);
    const tx = await pagamento(cid, 40);

    await undoPayment(client, { companyId, transactionId: tx });
    await expect(
      undoPayment(client, { companyId, transactionId: tx })
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await saldo(cid)).toBe(40);
  });

  test('8. dois recebimentos retroativos no mesmo dia: cada um com o seu instante, desfaz so o segundo', async () => {
    // Antes de 07/10/2026 os dois ficavam em 12:00:00.000000 do dia informado e
    // o Financeiro nao sabia qual linha era de qual pagamento.
    const cid  = await cliente('Retroativos Mesmo Dia');
    const sale = await venda(cid, 300, { installments: 3 });
    const ontem = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const r1 = await ledger.applyPayment(client, { companyId, customerId: cid, amount: 100, method: 'pix', paidAt: ontem });
    await envelhecer(r1.transaction.id);
    const r2 = await ledger.applyPayment(client, { companyId, customerId: cid, amount: 100, method: 'pix', paidAt: ontem });

    const { rows: inst } = await client.query(
      `SELECT created_at::time(0) AS hora,
              (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
              EXTRACT(SECOND FROM created_at) > 0 AS tem_segundos
         FROM customer_credit_transactions WHERE id = $1`, [r2.transaction.id]
    );
    expect(inst[0].dia).toBe(ontem);
    expect(inst[0].tem_segundos).toBe(true);

    // Retroativo de ontem fica ao meio-dia de ontem: depois do meio-dia de hoje
    // ja passou das 24h. A janela aqui e so para o teste nao depender da hora.
    const r = await undoPayment(client, { companyId, transactionId: r2.transaction.id, windowHours: 48 });

    expect(r).toMatchObject({ new_balance: 200, installments_reopened: 1, financeiro_reverted: 1 });
    const ps = await parcelas(cid);
    expect(ps[0]).toMatchObject({ status: 'paid', covered: 100 });
    expect(ps[1]).toMatchObject({ status: 'pending', covered: 0 });
    expect(await recebiveis(sale)).toEqual([
      expect.objectContaining({ status: 'confirmed', amount: 100, rest: false }),
      expect.objectContaining({ status: 'pending', category: 'Crediario - A Receber', amount: 200, rest: true }),
    ]);
    expect(await caixa(sale)).toBe(100);
    expect(await pagamentoExiste(r1.transaction.id)).toBe(true);
  });

  test('7. credito de troca e debito nao passam por aqui', async () => {
    const cid = await cliente('Troca e Debito');
    const sale = await venda(cid, 70);
    const { rows: troca } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, type, amount, payment_method, created_by)
       VALUES ($1, $2, 'payment', 20, 'crediario_credito', $3) RETURNING id`,
      [companyId, cid, userId]
    );
    await expect(
      undoPayment(client, { companyId, transactionId: troca[0].id })
    ).rejects.toMatchObject({ status: 409, code: 'EXCHANGE_CREDIT' });

    const { rows: deb } = await client.query(
      `SELECT id FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [sale]
    );
    await expect(
      undoPayment(client, { companyId, transactionId: deb[0].id })
    ).rejects.toMatchObject({ status: 409, code: 'NOT_PAYMENT' });

    // Outra loja nao enxerga o recebimento.
    const tx = await pagamento(cid, 10);
    await expect(
      undoPayment(client, { companyId: uuid(), transactionId: tx })
    ).rejects.toMatchObject({ status: 404 });
    expect(await saldo(cid)).toBe(40);
  });
});
