// ============================================================
// AURA. — Devolução do crediário com desconto da venda (Postgres real)
// 17/11/2026 (INC-2026-11-17-03, item J, aprovado pelo Caio)
//
// Caso real: a venda f1048a5a, um conjunto de R$ 279,90 com 50% de desconto
// no total (R$ 139,95 no crediário), foi devolvida por R$ 279,90: o valor
// saía do total do item, sem o desconto da venda, e a cliente ficou com
// R$ 139,95 de crédito que nunca deixou na loja.
//
// Agora (services/credit/refund.js):
//   - o desconto da venda entra na devolução, proporcional ao item;
//   - a devolução nunca credita mais que o débito da venda na ficha;
//   - sem desconto, a resposta é a de antes.
// E a pergunta 3 do Teo (devolução de venda renegociada), documentada.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = req.user || { id: 'fixture' }; next(); },
  requireCompanyAccess: () => (_req, _res, next) => next(),
  requirePlan: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(120000);

const ID = { dono: uuid(), loja: uuid(), conjunto: uuid(), blusa: uuid(), cliente: uuid() };
const EMPRESAS = [ID.loja];
let pool;
let app;
const q = (sql, params) => pool.query(sql, params);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function apagarTudo() {
  for (const sql of [
    `DELETE FROM troca_returned_items WHERE troca_sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
    `DELETE FROM credit_installments WHERE company_id = ANY($1)`,
    `DELETE FROM customer_credit_transactions WHERE company_id = ANY($1)`,
    `DELETE FROM credit_accounts WHERE company_id = ANY($1)`,
    `DELETE FROM customer_credit_profiles WHERE company_id = ANY($1)`,
    `DELETE FROM credit_plan_configs WHERE company_id = ANY($1)`,
    `DELETE FROM sale_payments WHERE company_id = ANY($1)`,
    `DELETE FROM transactions WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
    `DELETE FROM sales WHERE company_id = ANY($1)`,
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN DEFAULT false,
                             ADD COLUMN IF NOT EXISTS total_installments INTEGER,
                             ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`);
  await apagarTudo();
  await q(`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]).catch(() => {});
  await q(`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]).catch(() => {});
  await q(`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]).catch(() => {});
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Devolucao')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, pdv_settings) VALUES ($1, $2, 'Fixture Loja Devolucao', '{"crediario_enabled": true}'::jsonb)`,
    [ID.loja, ID.dono]);
  await q(`INSERT INTO products (id, company_id, name, price, cost_price, stock_qty) VALUES
             ($1, $3, 'Conjunto', 279.9, 100, 10), ($2, $3, 'Blusa', 100, 40, 10)`, [ID.conjunto, ID.blusa, ID.loja]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'Cliente Fixture Devolucao', '11900000066')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
  app.use('/companies/:id/credit', require('../src/routes/creditRefund'));
  app.use('/companies/:id/credit', require('../src/routes/creditReschedule'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(apagarTudo);

afterAll(async () => {
  jest.restoreAllMocks();
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  await apagarTudo();
  await q(`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]).catch(() => {});
  await q(`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]).catch(() => {});
  await q(`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]).catch(() => {});
  await q(`DELETE FROM users WHERE id = $1`, [ID.dono]).catch(() => {});
  await pool.end();
});

async function vender(body) {
  const r = await request(app).post(`/companies/${ID.loja}/pdv/sale`).send({ customer_id: ID.cliente, ...body });
  expect(r.status).toBe(201);
  const { rows: itens } = await q(`SELECT id, product_id FROM sale_items WHERE sale_id = $1`, [r.body.sale.id]);
  return { id: r.body.sale.id, itens };
}
const devolver = (saleId, items) => request(app).post(`/companies/${ID.loja}/credit/sales/${saleId}/refund`).send({ items });
const ficha = async () => r2((await q(`SELECT balance FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`, [ID.cliente, ID.loja])).rows[0]?.balance);
const itemDe = (venda, pid) => venda.itens.find((i) => i.product_id === pid).id;
// A resposta sem os ids gerados na hora (para comparar com a de antes).
const semIds = (b) => JSON.parse(JSON.stringify(b).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>'));

const NUMEROS = [];

describe('devolução do crediário com desconto da venda', () => {
  test('sem desconto: a devolução é a de antes (valor do item, parcelas abatidas)', async () => {
    const v = await vender({ items: [{ product_id: ID.blusa, quantity: 1, unit_price: 100 }], payment_method: 'crediario', installments: 2 });
    const r = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.blusa), quantity: 1 }]);
    expect(r.status).toBe(201);
    // A mesma resposta que o refund.js de antes do J devolve neste caso.
    expect(semIds(r.body)).toEqual({
      devolucao_sale_id: '<id>',
      refund_value: 100,
      abated_installments: [
        { installment_id: '<id>', number: 2, action: 'cancelled', amount: 50 },
        { installment_id: '<id>', number: 1, action: 'cancelled', amount: 50 },
      ],
      credit_generated: 0,
      new_balance: 0,
      stock_restored: [{ product_id: '<id>', variant_id: null, quantity: 1 }],
    });
    NUMEROS.push({ caso: 'sem desconto (blusa 100)', venda: 100, devolvido: r.body.refund_value, ficha: await ficha() });
  });

  test('desconto no total (o caso f1048a5a): conjunto de 279,90 com 50% sai por 139,95, não por 279,90', async () => {
    const v = await vender({
      items: [{ product_id: ID.conjunto, quantity: 1, unit_price: 279.9 }],
      payment_method: 'crediario', installments: 2, discount_type: 'percent', discount_value: 50,
    });
    expect((await q(`SELECT total_amount::text FROM sales WHERE id = $1`, [v.id])).rows[0].total_amount).toBe('139.95');
    const r = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.conjunto), quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body.refund_value).toBe(139.95);
    expect(r.body.credit_generated).toBe(0);
    expect(await ficha()).toBe(0);
    const { rows: [dev] } = await q(`SELECT total_amount::text FROM sales WHERE id = $1`, [r.body.devolucao_sale_id]);
    expect(dev.total_amount).toBe('-139.95');
    NUMEROS.push({ caso: 'desconto de 50% no total (conjunto 279,90)', venda: 139.95, devolvido: r.body.refund_value, ficha: await ficha() });
  });

  test('desconto no item: o total do item já é líquido (279,90 − 79,90 = 200)', async () => {
    const v = await vender({
      items: [{ product_id: ID.conjunto, quantity: 1, unit_price: 279.9, item_discount: 79.9 }],
      payment_method: 'crediario',
    });
    const r = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.conjunto), quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body.refund_value).toBe(200);
    expect(await ficha()).toBe(0);
    NUMEROS.push({ caso: 'desconto de 79,90 no item (conjunto)', venda: 200, devolvido: r.body.refund_value, ficha: await ficha() });
  });

  test('desconto no total com dois itens: devolver um item leva a parte proporcional do desconto', async () => {
    // 100 + 279,90 = 379,90; 10% no total = 341,91. A blusa: 100 x 341,91 / 379,90 = 90.
    const v = await vender({
      items: [{ product_id: ID.blusa, quantity: 1, unit_price: 100 }, { product_id: ID.conjunto, quantity: 1, unit_price: 279.9 }],
      payment_method: 'crediario', discount_type: 'percent', discount_value: 10,
    });
    const a = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.blusa), quantity: 1 }]);
    expect(a.body.refund_value).toBe(90);
    expect(await ficha()).toBe(251.91);
    const b = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.conjunto), quantity: 1 }]);
    expect(b.body.refund_value).toBe(251.91);
    expect(await ficha()).toBe(0);
    NUMEROS.push({ caso: '10% no total, blusa + conjunto (341,91), um item por vez', venda: 341.91, devolvido: r2(a.body.refund_value + b.body.refund_value), ficha: await ficha() });
  });

  test('teto: a venda com parte no dinheiro devolve na ficha só o que ficou no crediário', async () => {
    const v = await vender({
      items: [{ product_id: ID.blusa, quantity: 1, unit_price: 100 }],
      payments: [{ method: 'dinheiro', value: 40 }, { method: 'crediario', value: 60 }],
    });
    const r = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.blusa), quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(r.body.refund_value).toBe(60);
    // Antes: 100 na ficha e a cliente com 40 de "credito" que saiu do dinheiro.
    expect(await ficha()).toBe(0);
    // Os 40 do dinheiro nao voltam sozinhos: a resposta avisa para a tela.
    expect(r.body.pago_fora_do_crediario).toBe(40);
    const { rows: tx } = await q(`SELECT type, category, amount::text FROM transactions WHERE company_id = $1 AND category NOT LIKE 'Crediario%' ORDER BY type`, [ID.loja]);
    expect(tx).toEqual([{ type: 'income', category: 'Vendas', amount: '40.00' }]);
    NUMEROS.push({ caso: 'blusa 100 = 40 no dinheiro + 60 no crediário', venda: 100, devolvido: r.body.refund_value, ficha: await ficha() });
  });
});

describe('conferência da Célia (18/11)', () => {
  test('cliente só com sobra de pagamento acima da dívida vende no crediário normalmente (sem o 422)', async () => {
    // Sobra de pagamento: um pagamento sem divida (saldo −80). O Caixa nao
    // oferece esse saldo (#1080), entao ele tambem nao trava o crediario.
    await q(`INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount, payment_method) VALUES ($1, $2, 'payment', 80, 'pix')`,
      [ID.loja, ID.cliente]);
    expect(await ficha()).toBe(-80);
    const r = await request(app).post(`/companies/${ID.loja}/pdv/sale`).send({
      customer_id: ID.cliente, items: [{ product_id: ID.blusa, quantity: 1, unit_price: 100 }], payment_method: 'crediario', installments: 2,
    });
    expect(r.status).toBe(201);
    expect(r.body.code).toBeUndefined();
    expect(await ficha()).toBe(20);
  });

  test('nada retroativo: a devolução inflada já gravada (o desenho da f1048a5a) fica como está', async () => {
    // O que a producao tem hoje: venda de 139,95 (279,90 com 50%) no crediario
    // e a devolucao antiga de 279,90 (credito de 139,95 a mais).
    const v = await vender({
      items: [{ product_id: ID.conjunto, quantity: 1, unit_price: 279.9 }],
      payment_method: 'crediario', discount_type: 'percent', discount_value: 50,
    });
    await q(`INSERT INTO customer_credit_transactions (company_id, customer_id, sale_id, type, amount, payment_method, notes, source)
             VALUES ($1, $2, $3, 'refund', 279.9, 'crediario_credito', 'Devolucao de venda (dev antiga)', 'refund')`, [ID.loja, ID.cliente, v.id]);
    const retrato = async () => (await q(
      `SELECT to_jsonb(t) AS r FROM customer_credit_transactions t WHERE company_id = $1 ORDER BY created_at, id`, [ID.loja])).rows.map((x) => x.r);
    const parcelas = async () => (await q(`SELECT to_jsonb(c) AS r FROM credit_installments c WHERE company_id = $1 ORDER BY id`, [ID.loja])).rows.map((x) => x.r);
    const antes = { razao: await retrato(), parcelas: await parcelas() };
    expect(await ficha()).toBe(-139.95);

    // O codigo novo passando por perto: devolver de novo a venda inflada
    // (o teto recusa, nada gravado) e uma venda nova com outra devolucao.
    const de_novo = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.conjunto), quantity: 1 }]);
    expect(de_novo.status).toBe(400);
    const w = await vender({ items: [{ product_id: ID.blusa, quantity: 1, unit_price: 100 }], payment_method: 'dinheiro' });
    expect(w.id).toBeTruthy();

    // As linhas antigas, byte a byte (o credito a mais continua na ficha).
    expect({ razao: await retrato(), parcelas: await parcelas() }).toEqual(antes);
    expect(await ficha()).toBe(-139.95);
  });
});

describe('pergunta 3: devolução de venda renegociada', () => {
  test('a devolução abate as parcelas da renegociação (nascem sem sale_id) pelo carnê que guarda a dívida', async () => {
    const v = await vender({
      items: [{ product_id: ID.conjunto, quantity: 1, unit_price: 279.9 }],
      payment_method: 'crediario', installments: 2, discount_type: 'percent', discount_value: 50,
    });
    const { rows: [deb] } = await q(`SELECT account_id FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [v.id]);
    const ren = await request(app)
      .post(`/companies/${ID.loja}/credit/customers/${ID.cliente}/accounts/${deb.account_id}/reschedule`)
      .send({ installments: 2, total: 159.9 });
    expect(ren.status).toBeLessThan(300);
    const abertas = async () => (await q(
      `SELECT sale_id IS NOT NULL AS da_venda, amount_due::text, status FROM credit_installments
        WHERE company_id = $1 AND status IN ('pending', 'overdue') ORDER BY installment_number`, [ID.loja])).rows;
    expect(await abertas()).toEqual([
      { da_venda: false, amount_due: '79.95', status: 'pending' },
      { da_venda: false, amount_due: '79.95', status: 'pending' },
    ]);
    const r = await devolver(v.id, [{ sale_item_id: itemDe(v, ID.conjunto), quantity: 1 }]);
    expect(r.status).toBe(201);
    // O passo 8 do refund.js so procura parcelas com sale_id da venda; o que
    // sobra sai das parcelas abertas do carne renegociado (shrinkMergedCarne),
    // das ultimas para as primeiras, e nao vira credito gerado.
    expect(r.body.abated_installments.length).toBeGreaterThan(0);
    expect(r.body.credit_generated).toBe(0);
    const restante = (await abertas()).reduce((s, p) => s + Number(p.amount_due), 0);
    expect(r2(restante)).toBe(r2(159.9 - r.body.refund_value));
  });
});

afterAll(() => {
  if (!NUMEROS.length) return;
  const linhas = NUMEROS.map((n) => `${n.caso} | ${n.venda} | ${n.devolvido} | ${n.ficha}`);
  process.stdout.write(`\n[devolucao do crediario]\ncaso | venda | devolvido na ficha | ficha depois\n${linhas.join('\n')}\n`);
});
