// ============================================================
// AURA. — Concluir o pedido do balcao no Caixa (B5a / p-62c) — Postgres real
// De ponta a ponta, pelas rotas de verdade: POST /pedidos (B1/B4a),
// POST /pedidos/:oid/sinal (B4a/B4b), POST /pdv/sale com order_id (B5a),
// /caixa (B4b), /dashboard (Receita do Painel), /dre e o Faturamento
// (services/resultadoDoPeriodo.js).
//
// Cenario da Celia (secao 3 da estimativa): pedido de R$ 389,70, sinal de
// R$ 100 no Pix, saldo de R$ 289,70 em dinheiro + Pix, cada parte numa sessao
// de caixa. Repetido com o saldo no crediario 3x e com o sinal em dinheiro.
// Em cada momento: Faturamento, Receita do Painel, a receber e o dinheiro
// esperado do caixa. A regra (Caio 17/11, D-S1 = A):
//   - Faturamento so na conclusao, pelo valor cheio (389,70);
//   - Receita do Painel: 100 no sinal + 289,70 na conclusao = 389,70, uma vez;
//   - a receber: 389,70 -> 289,70 -> 0 (a conta vai a 'cancelled');
//   - caixa: cada sessao bate com a gaveta.
//
// Os momentos rodam no mesmo dia (o Painel e por mes; o teste nao pode
// depender da data em que roda). O ultimo teste muda o sinal para ONTEM e
// mostra o Faturamento e a Receita dia a dia.
//
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/placarDoDia', () => ({ dispararNoFechamento: jest.fn(async () => null) }));
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

jest.setTimeout(90000);

const ID = {
  dono: uuid(),
  loja: uuid(),
  vestido: uuid(), blusa: uuid(),
  cliente: uuid(),
};
const EMPRESAS = [ID.loja];

let pool;
let app;
let seq = 0;
let hoje;

const q = (sql, params) => pool.query(sql, params);
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const R = require('../src/services/resultadoDoPeriodo');

async function apagarTudo() {
  const passos = [
    `DELETE FROM caixa_fechamentos WHERE sessao_id IN (SELECT id FROM caixa_sessoes WHERE company_id = ANY($1))`,
    `DELETE FROM caixa_movimentos WHERE company_id = ANY($1)`,
    `DELETE FROM sale_payments WHERE company_id = ANY($1)`,
    `DELETE FROM credit_installments WHERE company_id = ANY($1)`,
    `DELETE FROM customer_credit_transactions WHERE company_id = ANY($1)`,
    `DELETE FROM credit_accounts WHERE company_id = ANY($1)`,
    `DELETE FROM customer_credit_balances WHERE company_id = ANY($1)`,
    `DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`,
    `DELETE FROM transactions WHERE company_id = ANY($1)`,
    `DELETE FROM studio_payments WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
    `DELETE FROM sales WHERE company_id = ANY($1)`,
    `DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`,
    `DELETE FROM digital_orders WHERE company_id = ANY($1)`,
  ];
  for (const sql of passos) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
}

async function limpar() {
  await apagarTudo();
  for (const [sql, params] of [
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ]) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 8 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  // Mesmas colunas de producao que o pdv.vendaRapida.banco cria no CI.
  await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN DEFAULT false,
                             ADD COLUMN IF NOT EXISTS total_installments INTEGER,
                             ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`);
  hoje = require('../src/services/pedidoBalcao').hojeSP();

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Conclusao')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja Conclusao')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $3, 'Vestido midi', 129.9, 10), ($2, $3, 'Blusa de linho', 129.9, 10)`,
    [ID.vestido, ID.blusa, ID.loja]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'Cliente Fixture Conclusao', '11900000077')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
  app.use('/companies/:id/caixa', require('../src/routes/caixa'));
  app.use('/companies/:id/dashboard', require('../src/routes/dashboard'));
  app.use('/companies/:id/dre', require('../src/routes/dre'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
});

beforeEach(async () => {
  delete process.env.PEDIDO_LIBERADO;
  require('../src/services/caixaService')._resetCache();
  await apagarTudo();
  await q(`UPDATE products SET stock_qty = 10 WHERE company_id = $1`, [ID.loja]);
  await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": true}'::jsonb WHERE id = $1`, [ID.loja]);
});

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 150));
  await limpar();
  await pool.end();
});

function chave(p = 'conclusao') { seq += 1; return `teste-${p}-${seq}-${uuid().slice(0, 8)}`; }
const respirar = () => new Promise((r) => setTimeout(r, 40));

// 2 x 129,90 + 1 x 129,90 = 389,70 (o pedido da Celia).
const ITENS_PEDIDO = [
  { product_id: ID.vestido, quantity: 2, unit_price: 129.9 },
  { product_id: ID.blusa, quantity: 1, unit_price: 129.9 },
];
const ITENS_VENDA = [
  { product_id: ID.vestido, quantity: 2, unit_price: 129.9 },
  { product_id: ID.blusa, quantity: 1, unit_price: 129.9 },
];

async function abrirCaixa(troco = 50) {
  const r = await request(app).post(`/companies/${ID.loja}/caixa/abrir`).send({ troco_inicial: troco });
  expect(r.status).toBe(201);
  return r.body.sessao ? r.body.sessao.id : r.body.id;
}
async function caixaAoVivo() {
  await respirar();
  const r = await request(app).get(`/companies/${ID.loja}/caixa/status`);
  expect(r.status).toBe(200);
  return r.body.sessao_ativa;
}
async function fecharCaixa(contado) {
  await respirar();
  const r = await request(app).post(`/companies/${ID.loja}/caixa/fechar`).send({ dinheiro_contado: contado });
  expect(r.status).toBe(200);
  return r.body.fechamento;
}

/** Os quatro numeros que a Celia confere, agora. */
async function numeros(oid) {
  const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool });
  const painel = await request(app).get(`/companies/${ID.loja}/dashboard`);
  expect(painel.status).toBe(200);
  const { rows: [conta] } = await q(
    `SELECT status::text AS status, amount::numeric AS amount FROM transactions WHERE idempotency_key = $1`, [`pedido-areceber-${oid}`]);
  return {
    faturamento: r2(res.faturamento),
    receita_painel: r2(painel.body.revenue),
    a_receber_pedido: conta && conta.status === 'pending' ? r2(conta.amount) : 0,
    a_receber_painel: r2(painel.body.pendingIncome),
  };
}

async function guardarPedido() {
  const r = await request(app).post(`/companies/${ID.loja}/pedidos`).set('Idempotency-Key', chave('pedido'))
    .send({ items: ITENS_PEDIDO, customer_id: ID.cliente });
  expect(r.status).toBe(201);
  return r.body.order.id;
}
async function pagarSinal(oid, method, amount = 100) {
  const r = await request(app).post(`/companies/${ID.loja}/pedidos/${oid}/sinal`).set('Idempotency-Key', chave('sinal'))
    .send({ amount, method });
  expect(r.status).toBe(201);
  return r.body;
}
function concluir(oid, extra) {
  return request(app).post(`/companies/${ID.loja}/pdv/sale`).set('Idempotency-Key', chave('venda'))
    .send({ items: ITENS_VENDA, order_id: oid, customer_id: ID.cliente, ...extra });
}

// Tabela que o relatorio do PR mostra (impressa no fim do arquivo).
const TABELA = [];
function anotar(cenario, momento, n, caixa) {
  TABELA.push({ cenario, momento, ...n, esperado_caixa: caixa });
}
afterAll(() => {
  if (!TABELA.length) return;
  const cab = 'cenario | momento | Faturamento | Receita do Painel | a receber (pedido) | a receber (Painel) | esperado do caixa';
  const linhas = TABELA.map((t) => [t.cenario, t.momento, t.faturamento, t.receita_painel, t.a_receber_pedido, t.a_receber_painel, t.esperado_caixa].join(' | '));
  process.stdout.write(`\n[numeros da Celia]\n${cab}\n${linhas.join('\n')}\n`);
});

describe('cenario da Celia: R$ 389,70, sinal de R$ 100 no Pix, saldo em dinheiro + Pix', () => {
  test('cada momento: Faturamento, Receita do Painel, a receber e o caixa', async () => {
    const C = 'Pix + (dinheiro+Pix)';
    // Sessao 1: guardar e sinal.
    await abrirCaixa(50);
    const oid = await guardarPedido();
    let n = await numeros(oid);
    expect(n).toEqual({ faturamento: 0, receita_painel: 0, a_receber_pedido: 389.7, a_receber_painel: 389.7 });
    anotar(C, '1. guardou o pedido', n, (await caixaAoVivo()).dinheiro_em_caixa);

    await pagarSinal(oid, 'pix');
    n = await numeros(oid);
    expect(n).toEqual({ faturamento: 0, receita_painel: 100, a_receber_pedido: 289.7, a_receber_painel: 289.7 });
    const s1 = await caixaAoVivo();
    expect(s1.totais_ao_vivo).toMatchObject({ pix: 100, dinheiro: 0, outros: 0, geral: 100 });
    expect(s1.dinheiro_em_caixa).toBe(50);
    anotar(C, '2. sinal de 100 no Pix', n, s1.dinheiro_em_caixa);

    const f1 = await fecharCaixa(50);
    expect(Number(f1.dinheiro_esperado)).toBe(50);
    expect(Number(f1.total_pix)).toBe(100);
    expect(Number(f1.diferenca)).toBe(0);
    expect(f1.total_vendas).toBe(0);

    // Sessao 2: a conclusao.
    await abrirCaixa(50);
    const v = await concluir(oid, { payments: [{ method: 'dinheiro', value: 200 }, { method: 'pix', value: 89.7 }] });
    expect(v.status).toBe(201);
    expect(Number(v.body.sale.total_amount)).toBe(389.7);
    expect(v.body.sale.order_id).toBe(oid);
    expect(v.body.pedido).toMatchObject({ status: 'delivered', total_pedido: 389.7, sinal_pago: 100, recebido_hoje: 289.7, no_crediario: 0 });

    n = await numeros(oid);
    expect(n).toEqual({ faturamento: 389.7, receita_painel: 389.7, a_receber_pedido: 0, a_receber_painel: 0 });
    const s2 = await caixaAoVivo();
    expect(s2.totais_ao_vivo).toMatchObject({ dinheiro: 200, pix: 89.7, outros: 0, geral: 289.7 });
    expect(s2.totais_ao_vivo.sinais_pedido).toBeUndefined();
    expect(s2.dinheiro_em_caixa).toBe(250);
    anotar(C, '3. concluiu (200 dinheiro + 89,70 Pix)', n, s2.dinheiro_em_caixa);

    const f2 = await fecharCaixa(250);
    expect(Number(f2.dinheiro_esperado)).toBe(250);
    expect(Number(f2.total_geral)).toBe(289.7);
    expect(f2.total_vendas).toBe(389.7);
    expect(Number(f2.diferenca)).toBe(0);

    // A conta a receber: quitada pela venda, nunca 'confirmed'.
    const { rows: [conta] } = await q(`SELECT status, notes, amount::numeric AS amount, original_amount::numeric AS original FROM transactions WHERE idempotency_key = $1`,
      [`pedido-areceber-${oid}`]);
    expect(conta.status).toBe('cancelled');
    expect(conta.notes).toMatch(/Quitada pela venda #\d+/);
    expect([Number(conta.amount), Number(conta.original)]).toEqual([289.7, 389.7]);

    // O pedido: entregue, ligado a venda, sem stock_deducted; o estoque baixou
    // uma vez so, pela venda.
    const { rows: [o] } = await q(`SELECT status::text AS status, sale_id, delivered_at, stock_deducted FROM digital_orders WHERE id = $1`, [oid]);
    expect(o).toMatchObject({ status: 'delivered', sale_id: v.body.sale.id, stock_deducted: false });
    expect(o.delivered_at).not.toBeNull();
    const estoque = (await q(`SELECT id, stock_qty FROM products WHERE company_id = $1 ORDER BY name`, [ID.loja])).rows.map((p) => Number(p.stock_qty));
    expect(estoque).toEqual([9, 8]); // Blusa 10 - 1, Vestido 10 - 2

    // DRE sem soma em dobro: o sinal (receita bruta) + a venda = 389,70.
    // dre.js filtra paid_at::date em UTC: depois das 21h de Sao Paulo o
    // lancamento de hoje ja e "amanha". O periodo vai um dia alem.
    const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const dre = await request(app).get(`/companies/${ID.loja}/dre`).query({ from: hoje.slice(0, 8) + '01', to: amanha });
    const total = dre.body.detail.reduce((s, d) => s + (d.group === 'Receita Bruta' || d.line === 'outros' ? d.total : 0), 0);
    expect(r2(total)).toBe(389.7);

    // Concluir de novo (caixa aberto): 409, nada muda.
    await abrirCaixa(50);
    const de_novo = await concluir(oid, { payment_method: 'pix' });
    expect(de_novo.status).toBe(409);
    expect(de_novo.body.code).toBe('PEDIDO_JA_CONCLUIDO');
    expect((await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n).toBe(1);

    // Editar venda nao mexe na forma de uma venda de pedido (recontaria o sinal).
    const { travaDoDinheiro } = require('../src/services/editarVenda');
    expect(travaDoDinheiro({ devolucoes: [], renegociada: false, pagamentos: {}, sale: { order_id: oid, payment_method: 'pix' } }, { dinheiro: true }))
      .toMatchObject({ code: 'ORDER_SALE', status: 409 });
  });
});

describe('o mesmo pedido com o saldo no crediario 3x', () => {
  test('a venda de 389,70; Receita so o sinal; o saldo vira A Receber do crediario', async () => {
    const C = 'Pix + crediario 3x';
    await abrirCaixa(50);
    const oid = await guardarPedido();
    await pagarSinal(oid, 'pix');
    anotar(C, '2. sinal de 100 no Pix', await numeros(oid), (await caixaAoVivo()).dinheiro_em_caixa);

    const v = await concluir(oid, { payment_method: 'crediario', installments: 3 });
    expect(v.status).toBe(201);
    expect(v.body.credit).toMatchObject({ debited: 289.7 });
    expect(v.body.credit.installments).toHaveLength(3);
    expect(v.body.pedido).toMatchObject({ sinal_pago: 100, recebido_hoje: 0, no_crediario: 289.7 });

    const n = await numeros(oid);
    expect(n).toMatchObject({ faturamento: 389.7, receita_painel: 100, a_receber_pedido: 0 });
    // O que falta mora agora no crediario (A Receber pendente), nao no pedido.
    const { rows: [cr] } = await q(
      `SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM transactions
        WHERE company_id = $1 AND type = 'income' AND status = 'pending' AND idempotency_key LIKE 'pdv-credit-receivable-%'`, [ID.loja]);
    expect(r2(cr.v)).toBe(289.7);
    expect(n.a_receber_painel).toBe(289.7);
    const s = await caixaAoVivo();
    expect(s.totais_ao_vivo).toMatchObject({ pix: 100, fiado: 289.7, dinheiro: 0 });
    expect(s.dinheiro_em_caixa).toBe(50);
    anotar(C, '3. concluiu (saldo 289,70 no crediario 3x)', n, s.dinheiro_em_caixa);

    const f = await fecharCaixa(50);
    expect(Number(f.dinheiro_esperado)).toBe(50);
    expect(f.total_vendas).toBe(389.7);
  });
});

describe('o mesmo pedido com o sinal em dinheiro, caixa aberto e fechamento', () => {
  test('o sinal entra na gaveta da sessao 1; o saldo em dinheiro na sessao 2', async () => {
    const C = 'dinheiro + dinheiro';
    await abrirCaixa(50);
    const oid = await guardarPedido();
    await pagarSinal(oid, 'dinheiro');
    let n = await numeros(oid);
    expect(n).toEqual({ faturamento: 0, receita_painel: 100, a_receber_pedido: 289.7, a_receber_painel: 289.7 });
    const s1 = await caixaAoVivo();
    expect(s1.totais_ao_vivo).toMatchObject({ dinheiro: 100, outros: 0 });
    expect(s1.dinheiro_em_caixa).toBe(150);
    anotar(C, '2. sinal de 100 em dinheiro', n, s1.dinheiro_em_caixa);
    const f1 = await fecharCaixa(150);
    expect(Number(f1.dinheiro_esperado)).toBe(150);
    expect(Number(f1.diferenca)).toBe(0);
    expect(f1.sinais_pedido).toMatchObject({ dinheiro: 100, total: 100 });

    await abrirCaixa(50);
    const v = await concluir(oid, { payment_method: 'dinheiro' });
    expect(v.status).toBe(201);
    n = await numeros(oid);
    expect(n).toEqual({ faturamento: 389.7, receita_painel: 389.7, a_receber_pedido: 0, a_receber_painel: 0 });
    const s2 = await caixaAoVivo();
    expect(s2.totais_ao_vivo).toMatchObject({ dinheiro: 289.7, geral: 289.7 });
    expect(s2.dinheiro_em_caixa).toBe(339.7);
    anotar(C, '3. concluiu (289,70 em dinheiro)', n, s2.dinheiro_em_caixa);
    const f2 = await fecharCaixa(339.7);
    expect(Number(f2.dinheiro_esperado)).toBe(339.7);
    expect(Number(f2.diferenca)).toBe(0);
  });
});

describe('dia a dia: o sinal ontem, a conclusao hoje', () => {
  test('Faturamento ontem 0 e hoje 389,70; Receita ontem 100 e hoje 289,70', async () => {
    const oid = await guardarPedido();
    await q(`UPDATE companies SET pdv_settings = NULL WHERE id = $1`, [ID.loja]);
    await pagarSinal(oid, 'pix');
    // O sinal passa a ser de ontem (data do lancamento e do pagamento).
    await q(`UPDATE transactions SET due_date = due_date - 1, paid_at = paid_at - INTERVAL '1 day' WHERE idempotency_key = $1`, [`pedido-sinal-${oid}`]);
    await q(`UPDATE studio_payments SET paid_at = paid_at - INTERVAL '1 day' WHERE order_id = $1`, [oid]);
    const v = await concluir(oid, { payment_method: 'pix' });
    expect(v.status).toBe(201);

    const { rows: [{ ontem }] } = await q(`SELECT ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 1)::text AS ontem`);
    const fat = async (dia) => r2((await R.resultadoDoPeriodo({ empresas: [ID.loja], de: dia, ate: dia, comProdutos: false, client: pool })).faturamento);
    // Receita do Painel por dia: a mesma regra do dashboard (receita
    // confirmada pela data do lancamento).
    const receita = async (dia) => r2((await q(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM transactions
        WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'
          AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) = $2::date`, [ID.loja, dia])).rows[0].v);
    expect({ ontem: await fat(ontem), hoje: await fat(hoje) }).toEqual({ ontem: 0, hoje: 389.7 });
    expect({ ontem: await receita(ontem), hoje: await receita(hoje) }).toEqual({ ontem: 100, hoje: 289.7 });
  });
});
