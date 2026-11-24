// ============================================================
// AURA. — OS de ótica: parcelas do saldo (p-205), folha A4 (p-206) e
// receber o saldo no Caixa (p-208) — Postgres real
//
// O caminho do balcão, pelas rotas de verdade:
//   1. armação + lentes de R$ 180, sinal de R$ 100 no Pix e o saldo de R$ 80
//      em 2 parcelas (POST /pdv/sale-com-sinal, saldo_installments = 2);
//   2. a OS de ótica aponta para essa venda (deposit_sale_id);
//   3. os óculos ficam prontos e o cliente vem buscar: o Caixa recebe o saldo
//      e entrega (POST /service-orders/:id/receber-saldo).
//
// A regra que estes testes travam: receber o saldo QUITA as parcelas da venda
// do sinal e NUNCA cria segunda venda. Em todo caso de dinheiro conferimos o
// número de vendas, o razão do crediário, as parcelas, o A Receber e o caixa.
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

const ID = {
  dono: uuid(), loja: uuid(), outraLoja: uuid(),
  armacao: uuid(), cliente: uuid(), outroCliente: uuid(), sessao: uuid(),
};
const EMPRESAS = [ID.loja, ID.outraLoja];

let pool;
let app;
let hoje;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const q = (sql, params) => pool.query(sql, params);

async function apagarTudo() {
  for (const sql of [
    `DELETE FROM service_order_items WHERE service_order_id IN (SELECT id FROM service_orders WHERE company_id = ANY($1))`,
    `DELETE FROM service_orders WHERE company_id = ANY($1)`,
    `DELETE FROM optical_prescriptions WHERE company_id = ANY($1)`,
    `DELETE FROM credit_payment_allocations WHERE company_id = ANY($1)`,
    `DELETE FROM credit_installments WHERE company_id = ANY($1)`,
    `DELETE FROM customer_credit_transactions WHERE company_id = ANY($1)`,
    `DELETE FROM credit_accounts WHERE company_id = ANY($1)`,
    `DELETE FROM customer_credit_profiles WHERE company_id = ANY($1)`,
    `DELETE FROM credit_plan_configs WHERE company_id = ANY($1)`,
    `DELETE FROM sale_payments WHERE company_id = ANY($1)`,
    `DELETE FROM transactions WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM nfce_emissions WHERE company_id = ANY($1)`,
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
    `DELETE FROM sales WHERE company_id = ANY($1)`,
    `DELETE FROM caixa_movimentos WHERE sessao_id IN (SELECT id FROM caixa_sessoes WHERE company_id = ANY($1))`,
    `DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`,
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
}

async function limpar() {
  await apagarTudo();
  for (const sql of [
    `DELETE FROM customers WHERE company_id = ANY($1)`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM companies WHERE id = ANY($1)`,
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = $1`, [ID.dono]); } catch (_) { /* idem */ }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 8 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  // Colunas de producao que nao estao nas migrations (mesmo que os outros .banco).
  await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN DEFAULT false,
                             ADD COLUMN IF NOT EXISTS total_installments INTEGER,
                             ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`);
  await q(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT`);
  hoje = (await q(`SELECT ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::text AS d`)).rows[0].d;

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Otica')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, cnpj) VALUES ($1, $2, 'Fixture Otica LTDA', 'Otica Fixture', '00000000000100')`,
    [ID.loja, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Otica Filial', $3)`,
    [ID.outraLoja, ID.dono, ID.loja]);
  await q(`INSERT INTO products (id, company_id, name, price, cost_price, stock_qty) VALUES ($1, $2, 'Armacao acetato', 100, 40, 10)`,
    [ID.armacao, ID.loja]);
  await q(`INSERT INTO customers (id, company_id, name, phone, cpf_cnpj, street, number, city, state, zip_code) VALUES
             ($1, $3, 'Cliente Fixture Otica', '11900000077', '52998224725', 'Rua Modelo', '214', 'Cidade', 'SP', '01001000'),
             ($2, $3, 'Outro Cliente', '11900000078', NULL, NULL, NULL, NULL, NULL, NULL)`,
    [ID.cliente, ID.outroCliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
  app.use('/companies/:id/service-orders', require('../src/routes/serviceOrders'));
  app.use('/companies/:id/print', require('../src/routes/print'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(async () => {
  require('../src/services/caixaService')._resetCache();
  await apagarTudo();
  await q(`UPDATE products SET stock_qty = 10 WHERE company_id = $1`, [ID.loja]);
  await q(`UPDATE companies SET pdv_settings = '{"otica_enabled": true}'::jsonb, otica_settings = '{}'::jsonb WHERE id = $1`, [ID.loja]);
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  await limpar();
  await pool.end();
});

// ── ajudas ───────────────────────────────────────────────────
const base = (cid = ID.loja) => `/companies/${cid}`;

function addDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const OPTICAL = {
  prescription: {
    od: { sph: 1.5, add: 2.5, pd: 31, height: 22 },
    oe: { sph: 1.75, add: 2.5, pd: 31.5, height: 22 },
    prescriber_name: 'Dra. Fixture', prescriber_registry: 'CRM 00000/SP',
    issued_at: '2026-11-10', valid_until: '2027-11-10',
  },
  frame: { source: 'estoque', product_id: null, description: 'Armacao acetato' },
  lens: { type: 'surfacada', brand: 'Marca X', design: 'Multifocal', material: 'Resina 1,56', treatments: ['Antirreflexo'] },
  use: 'multifocal',
  quantity: 'par',
  service_type: 'lente_montagem',
};

async function vendaComSinal({ parcelas, sinal = 100, cliente = ID.cliente, due = addDias(hoje, 10) } = {}) {
  const body = {
    items: [
      { product_id: ID.armacao, quantity: 1, unit_price: 100 },
      { quantity: 1, unit_price: 80, product_name_snapshot: 'Lentes Marca X Multifocal' },
    ],
    customer_id: cliente,
    sinal: { method: 'pix', amount: sinal },
    saldo_due_date: due,
  };
  if (parcelas !== undefined) body.saldo_installments = parcelas;
  return request(app).post(`${base()}/pdv/sale-com-sinal`).send(body);
}

async function abrirOs({ depositSaleId = null, cliente = ID.cliente, optical = OPTICAL } = {}) {
  const res = await request(app).post(`${base()}/service-orders`).send({
    kind: 'otica', customer_id: cliente, optical, deposit_sale_id: depositSaleId,
    items: [
      { kind: 'peca', description: 'Armacao acetato', quantity: 1, unit_price: 100 },
      { kind: 'peca', description: 'Lentes Marca X', quantity: 1, unit_price: 80 },
    ],
  });
  expect(res.status).toBe(201);
  return res.body.order;
}

async function deixarPronta(osId) {
  await q(`UPDATE service_orders SET status = 'pronta', lab_status = 'recebida' WHERE id = $1`, [osId]);
}

async function retrato(saleId) {
  const [vendas, parcelas, razao, aReceber, pagamentos, saldo] = await Promise.all([
    q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja]),
    q(`SELECT installment_number, amount_due::numeric AS amount_due, covered_amount::numeric AS covered, status, due_date::text AS due
         FROM credit_installments WHERE sale_id = $1 ORDER BY installment_number`, [saleId]),
    q(`SELECT type, amount::numeric AS amount, payment_method FROM customer_credit_transactions
        WHERE company_id = $1 ORDER BY created_at, type`, [ID.loja]),
    q(`SELECT status, amount::numeric AS amount, category FROM transactions
        WHERE company_id = $1 AND category ILIKE 'Crediario%' ORDER BY created_at`, [ID.loja]),
    q(`SELECT method, amount::numeric AS amount, sessao_id FROM sale_payments WHERE sale_id = $1 ORDER BY created_at`, [saleId]),
    q(`SELECT COALESCE(balance, 0)::numeric AS balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
      [ID.loja, ID.cliente]),
  ]);
  return {
    vendas: vendas.rows[0].n,
    parcelas: parcelas.rows.map((p) => ({ ...p, amount_due: r2(p.amount_due), covered: r2(p.covered) })),
    razao: razao.rows.map((t) => ({ ...t, amount: r2(t.amount) })),
    aReceber: aReceber.rows.map((t) => ({ ...t, amount: r2(t.amount) })),
    pagamentos: pagamentos.rows.map((p) => ({ ...p, amount: r2(p.amount) })),
    saldo: r2(saldo.rows[0] && saldo.rows[0].balance),
  };
}

// ═════════════════════════════════════════════════════════════
// p-205: parcelas do saldo
// ═════════════════════════════════════════════════════════════
describe('p-205 · saldo do sinal em N parcelas', () => {
  test('sem o campo: 1 parcela na data combinada (a venda com sinal de sempre)', async () => {
    const due = addDias(hoje, 10);
    const res = await vendaComSinal({ due });
    expect(res.status).toBe(201);
    const t = await retrato(res.body.sale.id);
    expect(t.parcelas).toEqual([{ installment_number: 1, amount_due: 80, covered: 0, status: 'pending', due }]);
    expect(t.razao).toEqual([{ type: 'debit', amount: 80, payment_method: null }]);
    expect(t.pagamentos.map((p) => [p.method, p.amount])).toEqual([['pix', 100]]);
    expect(res.body.signal.installments).toHaveLength(1);
  });

  test('2 parcelas: 40 + 40, a 1a na data combinada e a 2a 30 dias depois, juros zero', async () => {
    const due = addDias(hoje, 10);
    const res = await vendaComSinal({ parcelas: 2, due });
    expect(res.status).toBe(201);
    const t = await retrato(res.body.sale.id);
    expect(t.parcelas).toEqual([
      { installment_number: 1, amount_due: 40, covered: 0, status: 'pending', due },
      { installment_number: 2, amount_due: 40, covered: 0, status: 'pending', due: addDias(due, 30) },
    ]);
    // Razao e A Receber pelo saldo (80), nunca pelo total, sem juros.
    expect(t.razao).toEqual([{ type: 'debit', amount: 80, payment_method: null }]);
    expect(t.aReceber).toEqual([{ status: 'pending', amount: 80, category: 'Crediario - A Receber' }]);
    expect(t.saldo).toBe(80);
    expect(res.body.signal.installments).toHaveLength(2);
    expect(t.vendas).toBe(1);
  });

  test('3 parcelas de 80: o centavo vai na ultima e a soma bate com o saldo', async () => {
    const res = await vendaComSinal({ parcelas: 3 });
    expect(res.status).toBe(201);
    const t = await retrato(res.body.sale.id);
    expect(t.parcelas.map((p) => p.amount_due)).toEqual([26.66, 26.66, 26.68]);
    expect(r2(t.parcelas.reduce((s, p) => s + p.amount_due, 0))).toBe(80);
  });

  test('juros do crediario da loja NAO entram no saldo parcelado', async () => {
    await q(`INSERT INTO credit_plan_configs (company_id, interest_rate, max_installments) VALUES ($1, 0.10, 12)
             ON CONFLICT (company_id) DO UPDATE SET interest_rate = 0.10, max_installments = 12`, [ID.loja]);
    const res = await vendaComSinal({ parcelas: 2 });
    expect(res.status).toBe(201);
    const t = await retrato(res.body.sale.id);
    expect(t.parcelas.map((p) => p.amount_due)).toEqual([40, 40]);
    expect(t.razao).toEqual([{ type: 'debit', amount: 80, payment_method: null }]);
  });

  test.each([[0], [25], [1.5], ['dois']])('saldo_installments=%p e recusado com 422, sem gravar nada', async (n) => {
    const res = await vendaComSinal({ parcelas: n });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SALDO_INSTALLMENTS_INVALIDO');
    expect((await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n).toBe(0);
  });

  test('saldo pequeno demais para N parcelas (parcela de zero centavo): 422, sem venda', async () => {
    const res = await vendaComSinal({ parcelas: 24, sinal: 179.9 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SALDO_INSTALLMENTS_INVALIDO');
    expect((await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n).toBe(0);
  });

  test('OS guarda quantidade e tipo de servico; valor fora da lista e 400', async () => {
    const os = await abrirOs();
    expect(os.optical.quantity).toBe('par');
    expect(os.optical.service_type).toBe('lente_montagem');
    const ruim = await request(app).post(`${base()}/service-orders`).send({
      kind: 'otica', customer_id: ID.cliente, optical: { ...OPTICAL, quantity: 'tres' },
    });
    expect(ruim.status).toBe(400);
    expect(ruim.body.code).toBe('QUANTIDADE_INVALIDA');
    const ruim2 = await request(app).post(`${base()}/service-orders`).send({
      kind: 'otica', customer_id: ID.cliente, optical: { ...OPTICAL, service_type: 'consulta' },
    });
    expect(ruim2.status).toBe(400);
    expect(ruim2.body.code).toBe('SERVICO_INVALIDO');
  });

  test('OS sem os campos novos abre como antes', async () => {
    const { quantity, service_type, ...semCampos } = OPTICAL; // eslint-disable-line no-unused-vars
    const os = await abrirOs({ optical: semCampos });
    expect(os.optical.quantity).toBeUndefined();
    expect(os.optical.service_type).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════
// p-208: receber o saldo no Caixa
// ═════════════════════════════════════════════════════════════
describe('p-208 · receber saldo e entregar', () => {
  async function cenario({ parcelas = 2 } = {}) {
    const venda = await vendaComSinal({ parcelas });
    expect(venda.status).toBe(201);
    const saleId = venda.body.sale.id;
    const os = await abrirOs({ depositSaleId: saleId });
    return { saleId, os };
  }
  const receber = (osId, body = {}, chave) => {
    const r = request(app).post(`${base()}/service-orders/${osId}/receber-saldo`);
    if (chave) r.set('Idempotency-Key', chave);
    return r.send({ method: 'pix', ...body });
  };

  test('quita as 2 parcelas, entrega, entra no caixa aberto e NAO cria segunda venda', async () => {
    const { saleId, os } = await cenario();
    await deixarPronta(os.id);
    await q(`INSERT INTO caixa_sessoes (id, company_id, opened_by) VALUES ($1, $2, $3)`, [ID.sessao, ID.loja, ID.dono]);

    const res = await receber(os.id, { method: 'dinheiro' }, 'chave-teste-0001');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paid: 80, method: 'dinheiro', remaining: 0, settled: true, delivered: true, replayed: false });
    expect(res.body.order.status).toBe('entregue');
    expect(res.body.order.sale_id).toBeNull(); // a venda da OS continua sendo a do sinal
    expect(res.body.receipt_url).toMatch(/\/print\/credit\/receipts\//);

    const t = await retrato(saleId);
    expect(t.vendas).toBe(1);
    expect(t.parcelas.every((p) => p.status === 'paid' && p.covered === p.amount_due)).toBe(true);
    expect(t.saldo).toBe(0);
    expect(t.razao.map((x) => [x.type, x.amount])).toEqual([['debit', 80], ['payment', 80]]);
    expect(t.aReceber).toEqual([{ status: 'confirmed', amount: 80, category: 'Crediario - Recebido' }]);
    // sinal (Pix, sem sessao) + saldo (dinheiro, na sessao aberta), na MESMA venda.
    expect(t.pagamentos.map((p) => [p.method, p.amount, p.sessao_id])).toEqual([
      ['pix', 100, null], ['dinheiro', 80, ID.sessao],
    ]);
  });

  test('mesma Idempotency-Key duas vezes: a segunda devolve o que ja foi gravado', async () => {
    const { saleId, os } = await cenario();
    await deixarPronta(os.id);
    const a = await receber(os.id, {}, 'chave-repetida-01');
    const b = await receber(os.id, {}, 'chave-repetida-01');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ replayed: true, paid: 80, remaining: 0, delivered: true });
    expect(b.body.transaction_id).toBe(a.body.transaction_id);
    const t = await retrato(saleId);
    expect(t.razao.filter((x) => x.type === 'payment')).toHaveLength(1);
    expect(t.pagamentos).toHaveLength(2);
  });

  test('dois cliques sem chave, ao mesmo tempo: recebe uma vez so', async () => {
    const { saleId, os } = await cenario();
    await deixarPronta(os.id);
    const [a, b] = await Promise.all([receber(os.id), receber(os.id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(r2(a.body.paid + b.body.paid)).toBe(80);
    const t = await retrato(saleId);
    expect(t.razao.filter((x) => x.type === 'payment').map((x) => x.amount)).toEqual([80]);
    expect(t.pagamentos.map((p) => p.amount)).toEqual([100, 80]);
    expect(t.vendas).toBe(1);
  });

  test('o pagamento fica preso a ESTA venda: o fiado mais antigo do cliente nao e tocado', async () => {
    // Fiado antigo do mesmo cliente, 1x com vencimento (tem parcela).
    const fiado = await request(app).post(`${base()}/pdv/sale`).send({
      items: [{ quantity: 1, unit_price: 50, product_name_snapshot: 'Estojo' }],
      customer_id: ID.cliente, payment_method: 'crediario', first_due_date: addDias(hoje, 1),
    });
    expect(fiado.status).toBe(201);
    const { saleId, os } = await cenario();
    await deixarPronta(os.id);
    const res = await receber(os.id);
    expect(res.status).toBe(200);
    const antigo = await q(`SELECT status, covered_amount::numeric AS c FROM credit_installments WHERE sale_id = $1`, [fiado.body.sale.id]);
    expect(antigo.rows.map((r) => [r.status, r2(r.c)])).toEqual([['pending', 0]]);
    const t = await retrato(saleId);
    expect(t.parcelas.every((p) => p.status === 'paid')).toBe(true);
    expect(t.saldo).toBe(50); // so o fiado antigo continua devendo
  });

  test('parcial: recebe 40 sem entregar; o resto fica no crediario', async () => {
    const { saleId, os } = await cenario();
    const res = await receber(os.id, { amount: 40, entregar: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paid: 40, remaining: 40, settled: false, delivered: false });
    const t = await retrato(saleId);
    expect(t.parcelas.map((p) => p.status)).toEqual(['paid', 'pending']);
    expect(t.saldo).toBe(40);
    expect(t.vendas).toBe(1);
  });

  test('valor acima do saldo: 422 e nada gravado', async () => {
    const { saleId, os } = await cenario();
    await deixarPronta(os.id);
    const res = await receber(os.id, { amount: 80.5 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_ACIMA_DO_SALDO');
    const t = await retrato(saleId);
    expect(t.razao.filter((x) => x.type === 'payment')).toHaveLength(0);
    expect((await q(`SELECT status FROM service_orders WHERE id = $1`, [os.id])).rows[0].status).toBe('pronta');
  });

  test('entregar com a OS ainda no laboratorio: 409 e nada gravado', async () => {
    const { saleId, os } = await cenario();
    const res = await receber(os.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OS_NAO_PRONTA');
    const t = await retrato(saleId);
    expect(t.razao.filter((x) => x.type === 'payment')).toHaveLength(0);
  });

  test('OS ja quitada pelo crediario: "receber e entregar" so entrega (recebe 0)', async () => {
    const { saleId, os } = await cenario();
    await receber(os.id, { entregar: false });
    await deixarPronta(os.id);
    const res = await receber(os.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paid: 0, delivered: true, transaction_id: null });
    const t = await retrato(saleId);
    expect(t.razao.filter((x) => x.type === 'payment')).toHaveLength(1);
  });

  test('OS sem sinal: 409 OS_SEM_SINAL (cobra como venda no Caixa)', async () => {
    const os = await abrirOs();
    await deixarPronta(os.id);
    const res = await receber(os.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OS_SEM_SINAL');
  });

  test('venda do sinal cancelada: 409, sem entregar', async () => {
    const { saleId, os } = await cenario();
    await deixarPronta(os.id);
    await q(`UPDATE sales SET status = 'cancelled' WHERE id = $1`, [saleId]);
    const res = await receber(os.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VENDA_DO_SINAL_CANCELADA');
    expect((await q(`SELECT status FROM service_orders WHERE id = $1`, [os.id])).rows[0].status).toBe('pronta');
  });

  test('OS de outra loja do grupo: 404 (a OS e da loja onde foi aberta)', async () => {
    const { os } = await cenario();
    await deixarPronta(os.id);
    await q(`UPDATE companies SET pdv_settings = '{"otica_enabled": true}'::jsonb WHERE id = $1`, [ID.outraLoja]);
    const res = await request(app).post(`${base(ID.outraLoja)}/service-orders/${os.id}/receber-saldo`).send({ method: 'pix' });
    expect(res.status).toBe(404);
  });

  test('forma invalida e otica desligada: recusa sem gravar', async () => {
    const { os } = await cenario();
    await deixarPronta(os.id);
    expect((await receber(os.id, { method: 'crediario' })).status).toBe(400);
    await q(`UPDATE companies SET pdv_settings = '{"otica_enabled": false}'::jsonb WHERE id = $1`, [ID.loja]);
    const res = await receber(os.id);
    expect(res.status).toBe(403);
    expect((await q(`SELECT COUNT(*)::int AS n FROM customer_credit_transactions WHERE company_id = $1 AND type = 'payment'`, [ID.loja])).rows[0].n).toBe(0);
  });
});

describe('p-208 · vinculo da venda e faixa do Caixa', () => {
  test('OS com sinal recusa vincular uma segunda venda (status e PATCH)', async () => {
    const venda = await vendaComSinal({});
    const os = await abrirOs({ depositSaleId: venda.body.sale.id });
    await deixarPronta(os.id);
    const outra = await request(app).post(`${base()}/pdv/sale`).send({
      items: [{ quantity: 1, unit_price: 80, product_name_snapshot: 'Saldo' }], customer_id: ID.cliente, payment_method: 'pix',
    });
    expect(outra.status).toBe(201);
    const st = await request(app).post(`${base()}/service-orders/${os.id}/status`).send({ status: 'entregue', sale_id: outra.body.sale.id });
    expect(st.status).toBe(409);
    expect(st.body.code).toBe('OS_JA_TEM_VENDA');
    const pt = await request(app).patch(`${base()}/service-orders/${os.id}`).send({ deposit_sale_id: outra.body.sale.id });
    expect(pt.status).toBe(409);
    expect((await q(`SELECT status, sale_id, deposit_sale_id FROM service_orders WHERE id = $1`, [os.id])).rows[0])
      .toEqual({ status: 'pronta', sale_id: null, deposit_sale_id: venda.body.sale.id });
  });

  test('OS sem sinal: a venda do Caixa do mesmo cliente vincula e entrega; de outro cliente, 409', async () => {
    const os = await abrirOs();
    await deixarPronta(os.id);
    const deOutro = await request(app).post(`${base()}/pdv/sale`).send({
      items: [{ quantity: 1, unit_price: 180, product_name_snapshot: 'Oculos' }], customer_id: ID.outroCliente, payment_method: 'pix',
    });
    const r1 = await request(app).post(`${base()}/service-orders/${os.id}/status`).send({ status: 'entregue', sale_id: deOutro.body.sale.id });
    expect(r1.status).toBe(409);
    expect(r1.body.code).toBe('VENDA_DE_OUTRO_CLIENTE');

    const certa = await request(app).post(`${base()}/pdv/sale`).send({
      items: [{ quantity: 1, unit_price: 180, product_name_snapshot: 'Oculos' }], customer_id: ID.cliente, payment_method: 'pix',
    });
    const r2b = await request(app).post(`${base()}/service-orders/${os.id}/status`).send({ status: 'entregue', sale_id: certa.body.sale.id });
    expect(r2b.status).toBe(200);
    expect(r2b.body.order).toMatchObject({ status: 'entregue', sale_id: certa.body.sale.id });
  });

  test('faixa: pronta ou com saldo; sem receita nem CPF na resposta', async () => {
    const v1 = await vendaComSinal({ parcelas: 2 });
    const comSaldo = await abrirOs({ depositSaleId: v1.body.sale.id }); // no laboratorio, com saldo
    const semSinalPronta = await abrirOs();
    await deixarPronta(semSinalPronta.id);
    await abrirOs(); // sem sinal, ainda no laboratorio: nao aparece
    const v2 = await vendaComSinal({});
    const quitada = await abrirOs({ depositSaleId: v2.body.sale.id });
    await request(app).post(`${base()}/service-orders/${quitada.id}/receber-saldo`).send({ method: 'pix', entregar: false });
    await q(`UPDATE service_orders SET status = 'entregue' WHERE id = $1`, [quitada.id]); // entregue e quitada: nao aparece

    const res = await request(app).get(`${base()}/service-orders/otica-no-caixa?customer_id=${ID.cliente}`);
    expect(res.status).toBe(200);
    const porId = Object.fromEntries(res.body.orders.map((o) => [o.id, o]));
    expect(Object.keys(porId).sort()).toEqual([comSaldo.id, semSinalPronta.id].sort());
    expect(porId[comSaldo.id]).toMatchObject({ open_amount: 80, open_installments: 2, total_installments: 2, sem_venda: false });
    expect(porId[semSinalPronta.id]).toMatchObject({ open_amount: 0, sem_venda: true });
    const texto = JSON.stringify(res.body);
    expect(texto).not.toMatch(/prescription|sph|52998224725|cpf/i);

    expect((await request(app).get(`${base()}/service-orders/otica-no-caixa?customer_id=xx`)).status).toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════
// p-206: folha A4
// ═════════════════════════════════════════════════════════════
describe('p-206 · folha A4 da OS de otica', () => {
  test('duas vias iguais: so o rotulo muda; valores, parcelas, CPF e endereco no papel', async () => {
    const venda = await vendaComSinal({ parcelas: 2 });
    const os = await abrirOs({ depositSaleId: venda.body.sale.id });
    const res = await request(app).get(`${base()}/print/os/${os.id}`);
    expect(res.status).toBe(200);
    const html = res.text;
    const folhas = html.split('<section class="folha">').slice(1);
    expect(folhas).toHaveLength(2);
    expect(folhas[0]).toContain('VIA DO LABORATÓRIO');
    expect(folhas[1]).toContain('VIA DO CLIENTE');
    const semRotulo = (f) => f.replace(/VIA DO (LABORATÓRIO|CLIENTE)/, 'VIA').replace(/<\/body>[\s\S]*$/, '');
    expect(semRotulo(folhas[0])).toBe(semRotulo(folhas[1]));
    expect(html).toContain('529.982.247-25');
    expect(html).toContain('Rua Modelo, 214');
    expect(html).toContain('R$ 180,00');
    expect(html).toContain('R$ 100,00');
    expect(html).toContain('2x R$ 40,00');
    expect(html).toContain('10/11/2026'); // data da receita, sem cair no dia anterior
    // Sem termos escritos pela loja, sem quadro de termos.
    expect(html).not.toContain('TERMOS DA VENDA');
  });

  test('com termos da loja: o quadro sai nas duas vias; ?vias=1 imprime uma folha', async () => {
    await q(`UPDATE companies SET otica_settings = '{"sale_terms": "Texto da loja <b>sem html</b>."}'::jsonb WHERE id = $1`, [ID.loja]);
    const os = await abrirOs();
    const res = await request(app).get(`${base()}/print/os/${os.id}`);
    expect(res.text.match(/TERMOS DA VENDA/g)).toHaveLength(2);
    expect(res.text).toContain('Texto da loja &lt;b&gt;sem html&lt;/b&gt;.');
    const uma = await request(app).get(`${base()}/print/os/${os.id}?vias=1&via=laboratorio`);
    expect(uma.text.split('<section class="folha">')).toHaveLength(2);
    expect(uma.text).toContain('VIA DO LABORATÓRIO');
    expect(uma.text).not.toContain('VIA DO CLIENTE');
  });
});
