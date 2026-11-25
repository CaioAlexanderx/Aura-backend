// ============================================================
// AURA. — O dinheiro do pedido de orcamento do Studio (p-185) — Postgres real
// POST /studio/quotes/:qid/aprovar (e /convert), POST /studio/payments/:pid/
// mark-paid, GET /studio/orders (Producao) e o cancelamento do pedido.
// services/financeiroDoOrcamento.js, pelo caminho de services/sinalDoPedido.js.
//
// Cenario: orcamento de R$ 100, sinal de R$ 30 no Pix, saldo de R$ 70.
//   - aprovar: conta "Pedido a receber" pendente de 100 (ligada no pedido),
//     marco do sinal 30 e marco do saldo 70, pendentes. Receita 0.
//   - sinal pago: entrada "Sinal de pedido" 30; a conta cai para 70
//     (original 100); deposit_paid. Pix sem taxa, mesmo com Pix com taxa na
//     loja. Repetir nao lanca de novo.
//   - saldo pago: entrada "Saldo de pedido" 70; a conta vai a 'cancelled'
//     ("Quitada pelo saldo do pedido"). Receita do Painel 100, DRE receita
//     bruta 100, Faturamento 0 (nao e venda), uma vez so.
// E mais: aprovar duas vezes e em paralelo, sinal 0, taxa do cartao no
// saldo, Producao com "falta receber", cancelamento, multi-CNPJ e a mesma
// Idempotency-Key em outro marco.
//
// Trava da frente: a loja do cenario e de teste
// (studio_settings.personalizados_teste). A loja semTrava nao e, e prova a
// paridade com o main: aprovar sem conta nem marco do saldo, mark-paid sem
// lancar, Producao sem os campos novos. A env da virada liga para qualquer loja.
//
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/middleware/auth', () => {
  const passa = (_req, _res, next) => next();
  return { requireAuth: passa, requirePlan: () => passa, requireRole: () => passa };
});

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid(), outra: uuid(), semTrava: uuid() };
const EMPRESAS = [ID.loja, ID.outra, ID.semTrava];

let pool;
let app;
let seq = 0;
let hoje;

const q = (sql, params) => pool.query(sql, params);
const R = require('../src/services/resultadoDoPeriodo');

async function limpar() {
  const passos = [
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM finance_categories WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_quote_items WHERE quote_id IN (SELECT id FROM studio_quotes WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM studio_quotes WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 10 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  // Mesmos ajustes de schema de studio.converterOrcamento.banco e
  // sinalDoPedido.banco (colunas de producao que o banco de CI nao tem).
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await q(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurrence_type TEXT,
                                   ADD COLUMN IF NOT EXISTS recurrence_group_id UUID,
                                   ADD COLUMN IF NOT EXISTS recurrence_index INTEGER,
                                   ADD COLUMN IF NOT EXISTS payment_method VARCHAR,
                                   ADD COLUMN IF NOT EXISTS employee_id UUID,
                                   ADD COLUMN IF NOT EXISTS employee_name TEXT`);
  hoje = require('../src/services/pedidoBalcao').hojeSP();

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Orcamento Financeiro')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  for (const id of EMPRESAS) {
    await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Orcamento Financeiro')`, [id, ID.dono]);
  }
  // Loja de teste da frente: a trava liga so para ela.
  await q(`UPDATE companies SET studio_settings = COALESCE(studio_settings, '{}'::jsonb) || '{"personalizados_teste": true}'::jsonb
            WHERE id = $1`, [ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioKdsApproval'));
  app.use('/companies/:id/studio', require('../src/routes/studioQuotes'));
  app.use('/companies/:id/studio', require('../src/routes/studioPayments'));
  app.use('/companies/:id/dre', require('../src/routes/dre'));
  app.use('/companies/:id/dashboard', require('../src/routes/dashboard'));
});

beforeEach(() => { delete process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO; });

afterAll(async () => {
  if (!pool) return;
  delete process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO;
  await limpar();
  await pool.end();
});

function chave() { seq += 1; return `teste-orc-${seq}-${uuid()}`; }

async function novoOrcamento({ total = 100, sinal = 30, empresa = ID.loja, status = 'draft' } = {}) {
  const qid = uuid();
  await q(
    `INSERT INTO studio_quotes (id, company_id, customer_name, customer_phone, status, subtotal, discount, total, deposit_amount)
     VALUES ($1, $2, 'Cliente Fixture', '11999990000', $3, $4, 0, $4, $5)`,
    [qid, empresa, status, total, sinal]
  );
  await q(
    `INSERT INTO studio_quote_items (quote_id, description, quantity, unit_price, sort_order)
     VALUES ($1, 'Caneca fixture', 1, $2, 0)`,
    [qid, total]
  );
  return qid;
}

const aprovar = (qid, empresa = ID.loja) => request(app).post(`/companies/${empresa}/studio/quotes/${qid}/aprovar`);

function pagar(pid, body = { method: 'pix' }, { empresa = ID.loja, k } = {}) {
  const r = request(app).post(`/companies/${empresa}/studio/payments/${pid}/mark-paid`);
  if (k) r.set('Idempotency-Key', k);
  return r.send(body);
}

// Lancamentos do pedido: chaves do pedido (pedido-*-<pedido>) e do saldo,
// que e por marco (pedido-saldo-<marco>, pedido-saldo-taxa-<marco>). O id
// some do nome: 'pedido-areceber', 'pedido-sinal', 'pedido-saldo'...
async function lancamentosCrus(oid) {
  const { rows } = await q(
    `SELECT t.idempotency_key, t.type::text AS type, t.status::text AS status, t.amount::numeric AS amount,
            t.original_amount::numeric AS original_amount, t.category, t.notes, t.company_id
       FROM transactions t
      WHERE t.idempotency_key LIKE $1
         OR t.idempotency_key IN (SELECT 'pedido-saldo-' || sp.id::text FROM studio_payments sp WHERE sp.order_id = $2
                                  UNION SELECT 'pedido-saldo-taxa-' || sp.id::text FROM studio_payments sp WHERE sp.order_id = $2)
      ORDER BY t.idempotency_key`,
    [`pedido-%${oid}`, oid]);
  return rows;
}

async function lancamentos(oid) {
  const rows = await lancamentosCrus(oid);
  const UUID = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return Object.fromEntries(rows.map((r) => [r.idempotency_key.replace(UUID, ''), {
    ...r, amount: Number(r.amount), original_amount: r.original_amount == null ? null : Number(r.original_amount),
  }]));
}

async function marcos(oid) {
  const { rows } = await q(
    `SELECT id, kind, status, amount::numeric AS amount, method, forma, company_id
       FROM studio_payments WHERE order_id = $1 ORDER BY kind`, [oid]);
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

async function zerarFinanceiro() {
  await q(`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`UPDATE companies SET pdv_settings = NULL WHERE id = ANY($1)`, [EMPRESAS]);
}

async function painel(empresa = ID.loja) {
  const r = await request(app).get(`/companies/${empresa}/dashboard`);
  expect(r.status).toBe(200);
  return r.body;
}

async function dreDoMes(empresa = ID.loja) {
  const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const r = await request(app).get(`/companies/${empresa}/dre`).query({ from: hoje.slice(0, 8) + '01', to: amanha });
  expect(r.status).toBe(200);
  return r.body;
}

async function naProducao(oid, empresa = ID.loja) {
  const r = await request(app).get(`/companies/${empresa}/studio/orders`);
  expect(r.status).toBe(200);
  return (r.body.orders || []).find((o) => o.digital_order_id === oid) || null;
}

describe('cenario: orcamento de R$ 100, sinal de R$ 30 no Pix, saldo de R$ 70', () => {
  let oid;
  let sinalId;
  let saldoId;

  beforeAll(async () => {
    await zerarFinanceiro();
    // Pix com taxa na loja: o "Registrar Pix recebido" caiu na chave, sem maquininha.
    await q(`UPDATE companies SET pdv_settings = $2::jsonb WHERE id = $1`,
      [ID.loja, JSON.stringify({ card_fee_enabled: true, card_fee_credit_pct: 3.5, card_fee_debit_pct: 1.5, card_fee_pix_pct: 1 })]);
  });
  afterAll(async () => { await q(`UPDATE companies SET pdv_settings = NULL WHERE id = $1`, [ID.loja]); });

  test('aprovar: conta a receber de 100 ligada no pedido + marcos do sinal (30) e do saldo (70)', async () => {
    const r = await aprovar(await novoOrcamento());
    expect(r.status).toBe(200);
    oid = r.body.order_id;

    const l = await lancamentos(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber']);
    expect(l['pedido-areceber']).toMatchObject({
      type: 'income', status: 'pending', amount: 100, original_amount: null, category: 'Pedido a receber', company_id: ID.loja,
    });
    const { rows: [o] } = await q(
      `SELECT o.transaction_id, t.id AS conta FROM digital_orders o
         JOIN transactions t ON t.idempotency_key = 'pedido-areceber-' || o.id::text WHERE o.id = $1`, [oid]);
    expect(o.transaction_id).toBe(o.conta);

    const m = await marcos(oid);
    expect(m.map((x) => [x.kind, x.status, x.amount])).toEqual([['balance', 'pending', 70], ['deposit', 'pending', 30]]);
    saldoId = m.find((x) => x.kind === 'balance').id;
    sinalId = m.find((x) => x.kind === 'deposit').id;

    expect((await painel()).revenue).toBe(0);
  });

  test('Producao: falta receber 100, com os dois marcos pendentes', async () => {
    const card = await naProducao(oid);
    expect(card).toBeTruthy();
    expect(card).toMatchObject({ orcamento_recebido: 0, orcamento_falta_receber: 100 });
    expect(card.orcamento_pagamentos_pendentes.map((p) => [p.kind, p.amount]).sort()).toEqual([['balance', 70], ['deposit', 30]]);
  });

  test('sinal pago no Pix: entra 30 como "Sinal de pedido", a conta cai para 70, sem taxa', async () => {
    const r = await pagar(sinalId, { method: 'pix' }, { k: chave() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, deposit_released: true, lancamento: 'sinal', taxa: 0, falta_receber: 70 });
    expect(r.body.payment).toMatchObject({ status: 'paid', method: 'pix', forma: 'pix' });

    const l = await lancamentos(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber', 'pedido-sinal']);
    expect(l['pedido-areceber']).toMatchObject({ status: 'pending', amount: 70, original_amount: 100 });
    expect(l['pedido-sinal']).toMatchObject({ type: 'income', status: 'confirmed', amount: 30, category: 'Sinal de pedido', company_id: ID.loja });
    const { rows: [o] } = await q(`SELECT deposit_paid FROM digital_orders WHERE id = $1`, [oid]);
    expect(o.deposit_paid).toBe(true);
  });

  test('o mesmo sinal de novo (com ou sem chave, e 4 toques em paralelo) nao lanca nada a mais', async () => {
    const de_novo = await pagar(sinalId, { method: 'pix' });
    expect(de_novo.status).toBe(200);
    expect(de_novo.body).toMatchObject({ ok: true, ja_pago: true });
    const rs = await Promise.all(Array.from({ length: 4 }, () => pagar(sinalId, { method: 'dinheiro' }, { k: chave() })));
    expect(rs.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(Object.keys(await lancamentos(oid))).toEqual(['pedido-areceber', 'pedido-sinal']);
    expect((await lancamentos(oid))['pedido-sinal'].amount).toBe(30);
  });

  test('saldo pago: entra 70 como "Saldo de pedido" e a conta e quitada', async () => {
    const r = await pagar(saldoId, { method: 'pix' }, { k: chave() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, deposit_released: false, lancamento: 'saldo', taxa: 0, falta_receber: 0 });

    const l = await lancamentos(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber', 'pedido-saldo', 'pedido-sinal']);
    expect(l['pedido-saldo']).toMatchObject({ type: 'income', status: 'confirmed', amount: 70, category: 'Saldo de pedido' });
    expect(l['pedido-areceber']).toMatchObject({ status: 'cancelled' });
    expect(l['pedido-areceber'].notes).toContain('Quitada pelo saldo do pedido');

    expect(await naProducao(oid)).toMatchObject({ orcamento_recebido: 100, orcamento_falta_receber: 0, orcamento_pagamentos_pendentes: [] });
  });

  test('os numeros fecham uma vez so: Receita do Painel 100, DRE receita bruta 100, Faturamento 0', async () => {
    expect((await painel()).revenue).toBe(100);
    const dre = await dreDoMes();
    expect(dre.summary.receita_bruta).toBe(100);
    const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool });
    expect(res).toMatchObject({ faturamento: 0, despesas: 0 });
  });
});

describe('aprovar', () => {
  test('aprovar duas vezes e 4 em paralelo: uma conta, dois marcos', async () => {
    const qid = await novoOrcamento({ total: 80, sinal: 20 });
    const rs = await Promise.all(Array.from({ length: 4 }, () => aprovar(qid)));
    expect(rs.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    const ids = new Set(rs.map((x) => x.body.order_id));
    expect(ids.size).toBe(1);
    const [oid] = [...ids];
    const de_novo = await aprovar(qid);
    expect(de_novo.body.order_id).toBe(oid);

    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, [`pedido-areceber-${oid}`]);
    expect(rows[0].n).toBe(1);
    expect((await marcos(oid)).map((m) => [m.kind, m.amount])).toEqual([['balance', 60], ['deposit', 20]]);
  });

  test('sinal 0: so o marco do saldo, pelo total', async () => {
    const r = await aprovar(await novoOrcamento({ total: 50, sinal: null }));
    const oid = r.body.order_id;
    expect((await marcos(oid)).map((m) => [m.kind, m.amount])).toEqual([['balance', 50]]);
    expect((await lancamentos(oid))['pedido-areceber']).toMatchObject({ status: 'pending', amount: 50 });
  });

  test('sinal maior que o total fica no total: so o marco do sinal', async () => {
    const r = await aprovar(await novoOrcamento({ total: 40, sinal: 90 }));
    expect((await marcos(r.body.order_id)).map((m) => [m.kind, m.amount])).toEqual([['deposit', 40]]);
  });

  test('convert do orcamento aceito lanca do mesmo jeito', async () => {
    const qid = await novoOrcamento({ total: 60, sinal: 10, status: 'accepted' });
    const r = await request(app).post(`/companies/${ID.loja}/studio/quotes/${qid}/convert`);
    expect(r.status).toBe(200);
    expect((await lancamentos(r.body.order_id))['pedido-areceber']).toMatchObject({ amount: 60 });
    expect((await marcos(r.body.order_id))).toHaveLength(2);
  });
});

describe('mark-paid', () => {
  test('saldo no credito: taxa da maquininha pela regra da venda', async () => {
    await q(`UPDATE companies SET pdv_settings = $2::jsonb WHERE id = $1`,
      [ID.loja, JSON.stringify({ card_fee_enabled: true, card_fee_credit_pct: 3.5, card_fee_debit_pct: 1.5 })]);
    try {
      const r = await aprovar(await novoOrcamento({ total: 100, sinal: null }));
      const oid = r.body.order_id;
      const [saldo] = await marcos(oid);
      const p = await pagar(saldo.id, { method: 'card' });
      expect(p.status).toBe(200);
      expect(p.body.taxa).toBe(3.5);
      const l = await lancamentos(oid);
      expect(l['pedido-saldo-taxa']).toMatchObject({ type: 'expense', status: 'confirmed', amount: 3.5 });
      expect(l['pedido-saldo']).toMatchObject({ amount: 100, status: 'confirmed' });
      expect(l['pedido-areceber'].status).toBe('cancelled');
      expect((await marcos(oid))[0]).toMatchObject({ method: 'card', forma: 'cartao' });
    } finally {
      await q(`UPDATE companies SET pdv_settings = NULL WHERE id = $1`, [ID.loja]);
    }
  });

  test("forma 'other': 422 e nada gravado", async () => {
    const r = await aprovar(await novoOrcamento({ total: 30, sinal: null }));
    const [saldo] = await marcos(r.body.order_id);
    const p = await pagar(saldo.id, { method: 'other' });
    expect(p.status).toBe(422);
    expect((await marcos(r.body.order_id))[0].status).toBe('pending');
    expect(Object.keys(await lancamentos(r.body.order_id))).toEqual(['pedido-areceber']);
  });

  test('marco a mais que passa do total: 422 e nada gravado', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: null }));
    const oid = r.body.order_id;
    const [saldo] = await marcos(oid);
    await pagar(saldo.id);
    const { rows: [extra] } = await q(
      `INSERT INTO studio_payments (company_id, order_id, kind, amount, status) VALUES ($1, $2, 'deposit', 10, 'pending') RETURNING id`,
      [ID.loja, oid]);
    const p = await pagar(extra.id);
    expect(p.status).toBe(422);
    expect(p.body.code).toBe('PEDIDO_PAGAMENTO_MAIOR');
    expect(Object.keys(await lancamentos(oid))).toEqual(['pedido-areceber', 'pedido-saldo']);
  });

  test('a mesma Idempotency-Key em outro marco: 409, nada gravado no segundo', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: 40 }));
    const oid = r.body.order_id;
    const m = await marcos(oid);
    const k = chave();
    expect((await pagar(m.find((x) => x.kind === 'deposit').id, { method: 'pix' }, { k })).status).toBe(200);
    const segundo = await pagar(m.find((x) => x.kind === 'balance').id, { method: 'pix' }, { k });
    expect(segundo.status).toBe(409);
    expect(segundo.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(Object.keys(await lancamentos(oid))).toEqual(['pedido-areceber', 'pedido-sinal']);
    expect((await marcos(oid)).find((x) => x.kind === 'balance').status).toBe('pending');
  });

  test('multi-CNPJ: marco de outra loja e 404 e nada muda; a Producao de outra loja nao ve o pedido', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: 30 }));
    const oid = r.body.order_id;
    const m = await marcos(oid);
    for (const x of m) {
      const p = await pagar(x.id, { method: 'pix' }, { empresa: ID.outra });
      expect(p.status).toBe(404);
    }
    expect((await marcos(oid)).every((x) => x.status === 'pending' && x.company_id === ID.loja)).toBe(true);
    expect(Object.keys(await lancamentos(oid))).toEqual(['pedido-areceber']);
    expect(await naProducao(oid, ID.outra)).toBeNull();
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = $1`, [ID.outra]);
    expect(rows[0].n).toBe(0);
    // Aprovar o orcamento pela outra loja: 404.
    const deOutra = await novoOrcamento({ empresa: ID.loja });
    expect((await aprovar(deOutra, ID.outra)).status).toBe(404);
  });

  test('pedido que nao saiu de orcamento segue como antes (marca pago, nao lanca)', async () => {
    const studio = uuid();
    await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, vertical)
             VALUES ($1, $2, 'ST-9101', 'Cliente Studio', '', 100, 100, 'confirmed', 'studio')`, [studio, ID.loja]);
    const c = await request(app).post(`/companies/${ID.loja}/studio/orders/${studio}/payments`).send({ kind: 'deposit', amount: 50 });
    expect(c.status).toBe(201);
    const p = await pagar(c.body.id);
    expect(p.status).toBe(200);
    expect(p.body.payment.status).toBe('paid');
    expect(Object.keys(await lancamentos(studio))).toEqual([]);
  });
});

describe('cancelamento do pedido de orcamento', () => {
  test('a conta pendente e os marcos pendentes vao a cancelled; o sinal que entrou fica; marcar pago depois e 409', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: 30 }));
    const oid = r.body.order_id;
    const m = await marcos(oid);
    await pagar(m.find((x) => x.kind === 'deposit').id);

    // A ligacao com o PATCH /status do Canal esta em canal.cancelarDevolveEstoque.test.js
    // (no banco do CI o payment_status ainda e o ENUM da 070, sem 'confirmed'
    // nem 'expired', e nem a rota nem o gatilho da 359 conseguem cancelar o
    // pedido). Aqui, o que o cancelamento grava no dinheiro.
    const F = require('../src/services/financeiroDoOrcamento');
    expect(await F.fecharNoCancelamento(pool, { companyId: ID.loja, orderId: oid })).toBe(true);
    // Outra loja nao fecha nada.
    expect(await F.fecharNoCancelamento(pool, { companyId: ID.outra, orderId: oid })).toBe(false);
    const l = await lancamentos(oid);
    expect(l['pedido-areceber'].status).toBe('cancelled');
    expect(l['pedido-areceber'].notes).toContain('Pedido cancelado');
    expect(l['pedido-sinal']).toMatchObject({ status: 'confirmed', amount: 30 });
    expect((await marcos(oid)).find((x) => x.kind === 'balance').status).toBe('cancelled');

    const depois = await pagar(m.find((x) => x.kind === 'balance').id);
    expect(depois.status).toBe(409);
    expect(depois.body.code).toBe('PAGAMENTO_CANCELADO');
    expect(Object.keys(await lancamentos(oid))).toEqual(['pedido-areceber', 'pedido-sinal']);
  });
});

describe('trava desligada: loja sem personalizados_teste e sem a env = o main de hoje', () => {
  test('aprovar: pedido e so o marco do sinal, sem conta a receber nem marco do saldo', async () => {
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    expect(r.status).toBe(200);
    const oid = r.body.order_id;
    expect(Object.keys(await lancamentos(oid))).toEqual([]);
    expect((await marcos(oid)).map((m) => [m.kind, m.status, m.amount])).toEqual([['deposit', 'pending', 30]]);
    const { rows: [o] } = await q(`SELECT transaction_id, deposit_paid FROM digital_orders WHERE id = $1`, [oid]);
    expect(o).toEqual({ transaction_id: null, deposit_paid: false });
  });

  test('sinal 0: nenhum marco (como antes)', async () => {
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 50, sinal: null }), ID.semTrava);
    expect(await marcos(r.body.order_id)).toEqual([]);
    expect(Object.keys(await lancamentos(r.body.order_id))).toEqual([]);
  });

  test('mark-paid: marca pago e libera o sinal, sem lancar nada no Financeiro', async () => {
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    const oid = r.body.order_id;
    const [sinal] = await marcos(oid);
    const p = await pagar(sinal.id, { method: 'pix' }, { empresa: ID.semTrava });
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ ok: true, payment: expect.objectContaining({ status: 'paid', method: 'pix' }), deposit_released: true });
    const { rows: [o] } = await q(`SELECT deposit_paid FROM digital_orders WHERE id = $1`, [oid]);
    expect(o.deposit_paid).toBe(true);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = $1`, [ID.semTrava]);
    expect(rows[0].n).toBe(0);
  });

  test('Producao sem os campos novos; cancelamento nao mexe em nada', async () => {
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    const oid = r.body.order_id;
    const card = await naProducao(oid, ID.semTrava);
    expect(card).toBeTruthy();
    expect(card).not.toHaveProperty('orcamento_falta_receber');
    expect(card).not.toHaveProperty('orcamento_pagamentos_pendentes');
    const F = require('../src/services/financeiroDoOrcamento');
    expect(await F.fecharNoCancelamento(pool, { companyId: ID.semTrava, orderId: oid })).toBe(false);
    expect((await marcos(oid))[0].status).toBe('pending');
  });

  test('a env da virada liga para qualquer loja', async () => {
    process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true';
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    const oid = r.body.order_id;
    expect((await lancamentos(oid))['pedido-areceber']).toMatchObject({ status: 'pending', amount: 100, company_id: ID.semTrava });
    expect((await marcos(oid)).map((m) => m.kind)).toEqual(['balance', 'deposit']);
  });
});

describe('revisao independente do #1106', () => {
  test('1. pedido aprovado antes da trava, sinal pago pelo caminho antigo: a conta nasce pelo que falta, sem lancar o de antes', async () => {
    // Aprovado sem a trava: so o marco do sinal, sem conta. Sinal 30 pago pelo
    // caminho antigo (sem entrada no Financeiro).
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    const oid = r.body.order_id;
    const [sinal] = await marcos(oid);
    expect((await pagar(sinal.id, { method: 'pix' }, { empresa: ID.semTrava })).status).toBe(200);
    expect(Object.keys(await lancamentos(oid))).toEqual([]);
    // O saldo vira marco e e pago depois da virada.
    const c = await request(app).post(`/companies/${ID.semTrava}/studio/orders/${oid}/payments`).send({ kind: 'balance', amount: 70 });
    expect(c.status).toBe(201);
    process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true';
    const p = await pagar(c.body.id, { method: 'pix' }, { empresa: ID.semTrava });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ lancamento: 'saldo', falta_receber: 0 });

    const l = await lancamentos(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber', 'pedido-saldo']);
    expect(l['pedido-areceber']).toMatchObject({ status: 'cancelled', amount: 70, category: 'Pedido a receber' });
    expect(l['pedido-areceber'].notes).toContain('Valor recebido antes no pedido fora do Financeiro: R$ 30,00');
    expect(l['pedido-areceber'].notes).toContain('Quitada pelo saldo do pedido');
    expect(l['pedido-saldo']).toMatchObject({ status: 'confirmed', amount: 70 });
    // Nada retroativo: so os 70 entraram.
    const { rows: [soma] } = await q(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM transactions WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'
          AND idempotency_key LIKE 'pedido-%'`, [ID.semTrava]);
    expect(Number(soma.v)).toBe(70);
  });

  test('1b. conta tardia com saldo em parte: nasce pelo que falta e cai pelo que entrou', async () => {
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    const oid = r.body.order_id;
    const [sinal] = await marcos(oid);
    await pagar(sinal.id, { method: 'pix' }, { empresa: ID.semTrava });
    const c = await request(app).post(`/companies/${ID.semTrava}/studio/orders/${oid}/payments`).send({ kind: 'balance', amount: 40 });
    process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true';
    const p = await pagar(c.body.id, { method: 'pix' }, { empresa: ID.semTrava });
    expect(p.body.falta_receber).toBe(30);
    expect((await lancamentos(oid))['pedido-areceber']).toMatchObject({ status: 'pending', amount: 30, original_amount: 70 });
  });

  test('2. marco gravado como card e pago sem corpo: credito, com a taxa da maquininha', async () => {
    await q(`UPDATE companies SET pdv_settings = $2::jsonb WHERE id = $1`,
      [ID.loja, JSON.stringify({ card_fee_enabled: true, card_fee_credit_pct: 3.5, card_fee_debit_pct: 1.5 })]);
    try {
      const r = await aprovar(await novoOrcamento({ total: 100, sinal: null }));
      const oid = r.body.order_id;
      const [saldo] = await marcos(oid);
      await q(`UPDATE studio_payments SET method = 'card' WHERE id = $1`, [saldo.id]);
      const p = await request(app).post(`/companies/${ID.loja}/studio/payments/${saldo.id}/mark-paid`).send({});
      expect(p.status).toBe(200);
      expect(p.body.taxa).toBe(3.5);
      expect((await marcos(oid))[0]).toMatchObject({ method: 'card', forma: 'cartao' });
      expect((await lancamentos(oid))['pedido-saldo-taxa']).toMatchObject({ type: 'expense', amount: 3.5 });
    } finally {
      await q(`UPDATE companies SET pdv_settings = NULL WHERE id = $1`, [ID.loja]);
    }
  });

  test('3. liga, aprova, desliga: o pedido com conta segue o caminho novo (paga baixa, cancelamento fecha)', async () => {
    process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true';
    const r = await aprovar(await novoOrcamento({ empresa: ID.semTrava, total: 100, sinal: 30 }), ID.semTrava);
    const oid = r.body.order_id;
    delete process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO;

    const m = await marcos(oid);
    const p = await pagar(m.find((x) => x.kind === 'deposit').id, { method: 'pix' }, { empresa: ID.semTrava });
    expect(p.status).toBe(200);
    expect(p.body.lancamento).toBe('sinal');
    const l = await lancamentos(oid);
    expect(l['pedido-sinal']).toMatchObject({ status: 'confirmed', amount: 30 });
    expect(l['pedido-areceber']).toMatchObject({ status: 'pending', amount: 70, original_amount: 100 });

    const F = require('../src/services/financeiroDoOrcamento');
    expect(await F.temContaDoOrcamento(pool, ID.semTrava, oid)).toBe(true);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await F.fecharNoCancelamento(client, { companyId: ID.semTrava, orderId: oid })).toBe(true);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await lancamentos(oid))['pedido-areceber'].status).toBe('cancelled');
    expect((await marcos(oid)).find((x) => x.kind === 'balance').status).toBe('cancelled');
  });

  test('4. o fechamento roda na transacao de quem chama: ROLLBACK desfaz conta e marcos', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: 30 }));
    const oid = r.body.order_id;
    const F = require('../src/services/financeiroDoOrcamento');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await F.fecharNoCancelamento(client, { companyId: ID.loja, orderId: oid })).toBe(true);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await lancamentos(oid))['pedido-areceber'].status).toBe('pending');
    expect((await marcos(oid)).every((x) => x.status === 'pending')).toBe(true);
  });

  test('5. saldo em 2 marcos: cada um com a sua entrada; o segundo quita', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: null }));
    const oid = r.body.order_id;
    const [saldo] = await marcos(oid);
    await q(`UPDATE studio_payments SET amount = 60 WHERE id = $1`, [saldo.id]);
    const c = await request(app).post(`/companies/${ID.loja}/studio/orders/${oid}/payments`).send({ kind: 'balance', amount: 40 });
    expect(c.status).toBe(201);

    const p1 = await pagar(saldo.id);
    expect(p1.body).toMatchObject({ lancamento: 'saldo', falta_receber: 40 });
    let conta = (await lancamentos(oid))['pedido-areceber'];
    expect(conta).toMatchObject({ status: 'pending', amount: 40, original_amount: 100 });

    const p2 = await pagar(c.body.id);
    expect(p2.status).toBe(200);
    expect(p2.body.falta_receber).toBe(0);
    const crus = await lancamentosCrus(oid);
    const saldos = crus.filter((t) => /^pedido-saldo-[0-9a-f-]{36}$/.test(t.idempotency_key));
    expect(saldos.map((t) => [t.idempotency_key, Number(t.amount)]).sort()).toEqual(
      [[`pedido-saldo-${saldo.id}`, 60], [`pedido-saldo-${c.body.id}`, 40]].sort());
    conta = (await lancamentos(oid))['pedido-areceber'];
    expect(conta.status).toBe('cancelled');
    expect(conta.notes).toContain('Quitada pelo saldo do pedido');

    // Um terceiro saldo passaria do total: 422.
    const c3 = await request(app).post(`/companies/${ID.loja}/studio/orders/${oid}/payments`).send({ kind: 'balance', amount: 1 });
    const p3 = await pagar(c3.body.id);
    expect(p3.status).toBe(422);
    expect(p3.body.code).toBe('PEDIDO_PAGAMENTO_MAIOR');
  });

  test('6. 23505: so o indice da Idempotency-Key vira IDEMPOTENCY_KEY_REUSED; entrada ja no Financeiro e PAGAMENTO_JA_LANCADO', async () => {
    const r = await aprovar(await novoOrcamento({ total: 100, sinal: 30 }));
    const oid = r.body.order_id;
    const m = await marcos(oid);
    // Uma entrada com a chave do sinal ja existe (estado inconsistente).
    await q(`INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, idempotency_key)
             VALUES ($1, 'income', 'confirmed', 30, 'fixture', 'Sinal de pedido', CURRENT_DATE, NOW(), $2)`,
      [ID.loja, `pedido-sinal-${oid}`]);
    const p = await pagar(m.find((x) => x.kind === 'deposit').id, { method: 'pix' }, { k: chave() });
    expect(p.status).toBe(409);
    expect(p.body.code).toBe('PAGAMENTO_JA_LANCADO');
    expect((await marcos(oid)).find((x) => x.kind === 'deposit').status).toBe('pending');
    expect((await lancamentos(oid))['pedido-areceber']).toMatchObject({ status: 'pending', amount: 100 });
  });
});
