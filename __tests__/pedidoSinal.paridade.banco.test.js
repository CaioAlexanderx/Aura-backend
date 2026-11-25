// ============================================================
// AURA. — Paridade: loja sem pedido (B4a/B6, 17/11/2026) — Postgres real
//
// O sinal e o cancelamento do pedido do balcao mexem no mapa do DRE
// (routes/dre.js), nas categorias vivas (financeCategories.js), na taxa da
// maquininha (taxaDaMaquininha.js), na guarda do Financeiro
// (routes/transactions.js) e, no B6, nas Despesas do resultado do periodo
// (resultadoDoPeriodo.js). Para uma loja SEM pedido nada disso pode mudar
// um centavo. Aqui:
//   1. o Resultado do periodo de uma loja com as categorias de hoje (Vendas,
//      troca, devolucao, Fornecedores, Taxas de cartao, Aluguel) da os
//      numeros de sempre, conferidos a mao;
//   2. o Financeiro (/transactions summary), o DRE e o Painel dessa loja sao
//      os MESMOS antes e depois de outra loja do mesmo dono passar por
//      pedido, sinal no cartao, devolucao e credito;
//   3. o mapa padrao do DRE so ganhou chaves novas (as de antes estao iguais);
//   4. o lancamento comum continua editavel no Financeiro (a guarda e so do
//      pedido).
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

const ID = { dono: uuid(), semPedido: uuid(), comPedido: uuid(), produto: uuid(), cliente: uuid() };
const EMPRESAS = [ID.semPedido, ID.comPedido];

let pool;
let app;
let hoje;
const q = (sql, params) => pool.query(sql, params);
const R = require('../src/services/resultadoDoPeriodo');

async function limpar() {
  for (const [sql, params] of [
    [`DELETE FROM customer_credit_transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM sales WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ]) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

async function lancamento(empresa, type, category, amount, { status = 'confirmed', chave = null } = {}) {
  const { rows: [t] } = await q(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $5, $6::date, CASE WHEN $8::boolean THEN NOW() END, $7) RETURNING id`,
    [empresa, type, status, amount, category, hoje, chave, status === 'confirmed']);
  return t.id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 8 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  hoje = require('../src/services/pedidoBalcao').hojeSP();
  // Colunas de transactions que existem em producao (legado) e que nenhuma
  // migration do repo cria: o banco do CI nao as tem e a lista do
  // Financeiro as le. Idempotente; nao-op onde ja existem (mesmo ajuste de
  // aceiteDoPedido.banco).
  await q(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurrence_type TEXT,
                                   ADD COLUMN IF NOT EXISTS recurrence_group_id UUID,
                                   ADD COLUMN IF NOT EXISTS recurrence_index INTEGER,
                                   ADD COLUMN IF NOT EXISTS payment_method VARCHAR,
                                   ADD COLUMN IF NOT EXISTS employee_id UUID,
                                   ADD COLUMN IF NOT EXISTS employee_name TEXT`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Paridade Pedido')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $3, 'Loja Sem Pedido'), ($2, $3, 'Loja Com Pedido')`,
    [ID.semPedido, ID.comPedido, ID.dono]);
  await q(`UPDATE companies SET pdv_settings = '{"card_fee_enabled": true, "card_fee_credit_pct": 3}'::jsonb WHERE id = ANY($1)`, [EMPRESAS]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Camisa', 100, 50)`, [ID.produto, ID.comPedido]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Paridade')`, [ID.cliente, ID.comPedido]);

  // A loja sem pedido, com as categorias que o sistema grava hoje.
  const venda = uuid();
  await q(`INSERT INTO sales (id, company_id, total_amount, payment_method, status, type) VALUES ($1, $2, 500, 'cartao', 'completed', 'sale')`,
    [venda, ID.semPedido]);
  await q(`INSERT INTO sale_items (id, sale_id, quantity, unit_price, unit_cost, total_price, product_name_snapshot)
           VALUES ($1, $2, 5, 100, 40, 500, 'Camisa')`, [uuid(), venda]);
  await lancamento(ID.semPedido, 'income', 'Vendas', 500, { chave: `pdv-sale-${venda}` });
  await lancamento(ID.semPedido, 'income', 'Troca - Venda', 80);
  await lancamento(ID.semPedido, 'income', 'Serviços', 120);
  await lancamento(ID.semPedido, 'expense', 'Taxas de cartão', 15, { chave: `pdv-card-fee-${venda}` });
  await lancamento(ID.semPedido, 'expense', 'Aluguel', 300);
  await lancamento(ID.semPedido, 'expense', 'Fornecedores', 200);
  await lancamento(ID.semPedido, 'expense', 'devolucao', 50);
  await lancamento(ID.semPedido, 'expense', 'Troca - Devolucao', 30);
  await lancamento(ID.semPedido, 'income', 'Crediário - A Receber', 90, { status: 'pending' });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  app.use('/companies/:id/dre', require('../src/routes/dre'));
  app.use('/companies/:id/dashboard', require('../src/routes/dashboard'));
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

async function fotoDaLoja(empresa) {
  const res = await R.resultadoDoPeriodo({ empresas: [empresa], de: hoje, ate: hoje, comProdutos: false, client: pool });
  const fin = await request(app).get(`/companies/${empresa}/transactions`).query({ start: hoje, end: hoje });
  // dre.js filtra por paid_at::date em UTC: o fim vai um dia alem de hoje.
  const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const dre = await request(app).get(`/companies/${empresa}/dre`).query({ from: hoje.slice(0, 8) + '01', to: amanha });
  const painel = await request(app).get(`/companies/${empresa}/dashboard`);
  expect([fin.status, dre.status, painel.status]).toEqual([200, 200, 200]);
  return {
    resultado: res,
    financeiro: fin.body.summary || null,
    dre: { summary: dre.body.summary, detail: dre.body.detail, income: dre.body.income, expenses: dre.body.expenses },
    painel: { revenue: painel.body.revenue, expenses: painel.body.expenses, net: painel.body.net },
  };
}

test('1. resultado do periodo da loja sem pedido: os numeros de sempre', async () => {
  const r = await R.resultadoDoPeriodo({ empresas: [ID.semPedido], de: hoje, ate: hoje, comProdutos: false, client: pool });
  // Faturamento = vendas 500 + troca 80 − troca-devolucao 30 − devolucao 50.
  // Despesas = Taxas 15 + Aluguel 300 (Fornecedores e devolucoes fora).
  expect(r).toMatchObject({
    faturamento: 500, vendas: 500, custos: 200, lucro_bruto: 300,
    trocas: { entrou: 80, devolvido: 80 },
    despesas: 315, compras_pagas: { total: 200, lancamentos: 1 },
  });
});

test('2. Financeiro, DRE e Painel da loja sem pedido: iguais antes e depois do pedido na outra loja', async () => {
  const antes = await fotoDaLoja(ID.semPedido);
  expect(antes.painel).toMatchObject({ revenue: 700, expenses: 595 });
  expect(antes.financeiro).toMatchObject({ income: 700, expenses: 595 });
  expect(antes.dre.detail.length).toBeGreaterThan(0);

  // A outra loja do mesmo dono passa por tudo o que o pedido grava.
  const um = await request(app).post(`/companies/${ID.comPedido}/pedidos`).set('Idempotency-Key', `paridade-1-${uuid()}`)
    .send({ items: [{ product_id: ID.produto, quantity: 2, unit_price: 100 }], customer_id: ID.cliente, sinal: { amount: 50, method: 'cartao' } });
  expect(um.status).toBe(201);
  const dois = await request(app).post(`/companies/${ID.comPedido}/pedidos`).set('Idempotency-Key', `paridade-2-${uuid()}`)
    .send({ items: [{ product_id: ID.produto, quantity: 1, unit_price: 100 }] });
  expect(dois.status).toBe(201);
  const s = await request(app).post(`/companies/${ID.comPedido}/pedidos/${dois.body.order.id}/sinal`)
    .set('Idempotency-Key', `paridade-3-${uuid()}`).send({ amount: 30, method: 'pix' });
  expect(s.status).toBe(201);
  // Devolucao e credito do B6, gravados como o B6 grava (este teste roda
  // tambem no PR do B4a, que ainda nao tem a rota de cancelar).
  await lancamento(ID.comPedido, 'expense', 'Devolução de sinal', 30, { chave: `pedido-devolucao-${dois.body.order.id}` });
  await q(`INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount, payment_method, source, idempotency_key)
           VALUES ($1, $2, 'payment', 50, 'crediario_credito', 'pedido', $3)`, [ID.comPedido, ID.cliente, `pedido-credito-${um.body.order.id}`]);
  const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = $1 AND idempotency_key LIKE 'pedido-%'`, [ID.comPedido]);
  expect(rows[0].n).toBeGreaterThanOrEqual(5);

  const depois = await fotoDaLoja(ID.semPedido);
  expect(depois).toEqual(antes);
});

test('3. o mapa padrao do DRE so ganhou chaves novas', () => {
  const { DEFAULT_LINE_MAP } = require('../src/routes/dre');
  // O mapa de antes do pedido (origin/main de 17/11/2026), linha a linha.
  const ANTES = {
    venda: 'receita_bruta', servico: 'receita_bruta', servico_pj: 'receita_bruta', receita_diversa: 'outras_receitas',
    imposto: 'deducoes', das: 'deducoes', compra_produto: 'cmv', estoque: 'cmv', mercadoria: 'cmv',
    folha: 'despesa_pessoal', salario: 'despesa_pessoal', prolabore: 'despesa_pessoal', inss: 'despesa_pessoal', fgts: 'despesa_pessoal',
    aluguel: 'despesa_fixa', energia: 'despesa_fixa', internet: 'despesa_fixa', telefone: 'despesa_fixa', seguro: 'despesa_fixa', assinatura: 'despesa_fixa',
    marketing: 'despesa_variavel', comissao: 'despesa_variavel', frete: 'despesa_variavel', manutencao: 'despesa_variavel', fornecedor: 'despesa_variavel',
    juros: 'despesa_financeira', emprestimo: 'despesa_financeira', tarifa: 'despesa_financeira',
  };
  for (const [k, linha] of Object.entries(ANTES)) expect(DEFAULT_LINE_MAP[k].line).toBe(linha);
  const novas = Object.keys(DEFAULT_LINE_MAP).filter((k) => !(k in ANTES)).sort();
  // p-185 (25/11/2026): "saldo de pedido", o saldo do orcamento do Studio, na linha do sinal.
  expect(novas).toEqual(['devolucao de sinal', 'devolução de sinal', 'pedido a receber', 'saldo de pedido', 'sinal de pedido'].sort());
});

test('4. lancamento comum continua editavel no Financeiro (a guarda e so do pedido)', async () => {
  const id = await lancamento(ID.semPedido, 'income', 'Outros', 10, { status: 'pending' });
  const r = await request(app).patch(`/companies/${ID.semPedido}/transactions/${id}`).send({ status: 'confirmed' });
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('confirmed');
  await q(`DELETE FROM transactions WHERE id = $1`, [id]);
});
