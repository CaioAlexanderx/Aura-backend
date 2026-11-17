// ============================================================
// AURA. — Conta a receber e sinal do pedido do balcao (B4a / p-62a) — Postgres real
// POST /companies/:id/pedidos (com sinal) e POST /pedidos/:oid/sinal
// (routes/pedidosDoBalcao.js, services/sinalDoPedido.js), migration 460.
//
// A regra do sinal (Caio 17/11, D-S1 = A com os ajustes da Celia), em numeros.
// Cenario da Celia: pedido de R$ 389,70, sinal de R$ 100 no Pix, saldo de
// R$ 289,70.
//   - guardar: conta "Pedido a receber" pendente de 389,70. Faturamento 0.
//   - sinal: conta cai para 289,70 (original_amount 389,70); entrada
//     confirmada "Sinal de pedido" de 100, sem venda. Faturamento 0, Despesas
//     0, Receita do Painel 100, DRE receita bruta 100 (linha de vendas).
//   - conclusao (B5a, SIMULADA aqui com o que ela vai gravar): venda de
//     389,70 e pdv-sale de 289,70; a conta vai a 'cancelled'. Faturamento
//     389,70; Receita do Painel 100 + 289,70 = 389,70, uma vez so.
// E mais: sinal no mesmo POST, 422 acima do total, Idempotency-Key (repetir,
// em paralelo, outra chave = 409), taxa da maquininha no cartao e no debito,
// sinal = total quita a conta, pedido fechado, multi-CNPJ, trava, e a guarda
// do Financeiro (a conta do pedido nao se baixa a mao).
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

const ID = {
  dono: uuid(),
  loja: uuid(), filial: uuid(),
  vestido: uuid(), blusa: uuid(), daFilial: uuid(),
  cliente: uuid(),
};
const EMPRESAS = [ID.loja, ID.filial];

let pool;
let app;
let usuario;
let seq = 0;
let hoje;

const q = (sql, params) => pool.query(sql, params);
const R = require('../src/services/resultadoDoPeriodo');

async function limpar() {
  const passos = [
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM finance_categories WHERE company_id = ANY($1)`, [EMPRESAS]],
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
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 8 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  // Mesmo ajuste do pedidoBalcao.banco (CI: a 070 nao tem updated_at).
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  hoje = require('../src/services/pedidoBalcao').hojeSP();

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Sinal')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja Sinal')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial Sinal', $3)`,
    [ID.filial, ID.dono, ID.loja]);
  const produto = (id, empresa, nome, preco, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, $4, $5)`, [id, empresa, nome, preco, estoque]);
  await produto(ID.vestido, ID.loja, 'Vestido midi', 129.9, 50);
  await produto(ID.blusa, ID.loja, 'Blusa de linho', 129.9, 50);
  await produto(ID.daFilial, ID.filial, 'Saia da filial', 80, 20);
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Fixture Sinal')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  app.use('/companies/:id/dre', require('../src/routes/dre'));
  app.use('/companies/:id/dashboard', require('../src/routes/dashboard'));
});

beforeEach(() => {
  usuario = { id: ID.dono, role: 'client', is_staff: true };
  delete process.env.PEDIDO_LIBERADO;
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

function chave() { seq += 1; return `teste-sinal-${seq}-${uuid()}`; }

// 2 x 129,90 + 1 x 129,90 = 389,70 (o pedido da Celia).
const ITENS_CELIA = [
  { product_id: ID.vestido, quantity: 2, unit_price: 129.9 },
  { product_id: ID.blusa, quantity: 1, unit_price: 129.9 },
];

function guardar(body, empresa = ID.loja, k = chave()) {
  return request(app).post(`/companies/${empresa}/pedidos`).set('Idempotency-Key', k).send(body);
}
function sinal(oid, body, k = chave(), empresa = ID.loja) {
  const r = request(app).post(`/companies/${empresa}/pedidos/${oid}/sinal`);
  if (k) r.set('Idempotency-Key', k);
  return r.send(body);
}

async function lancamentosDoPedido(oid) {
  const { rows } = await q(
    `SELECT idempotency_key, type::text AS type, status::text AS status, amount::numeric AS amount,
            original_amount::numeric AS original_amount, category, notes, company_id
       FROM transactions WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`,
    [`pedido-%${oid}`]);
  return Object.fromEntries(rows.map((r) => [r.idempotency_key.replace(`-${oid}`, ''), {
    ...r, amount: Number(r.amount), original_amount: r.original_amount == null ? null : Number(r.original_amount),
  }]));
}

async function resultadoDeHoje(empresa = ID.loja) {
  return R.resultadoDoPeriodo({ empresas: [empresa], de: hoje, ate: hoje, comProdutos: false, client: pool });
}

async function dreDoMes(empresa = ID.loja) {
  const r = await request(app).get(`/companies/${empresa}/dre`).query({ from: hoje.slice(0, 8) + '01', to: hoje });
  expect(r.status).toBe(200);
  return r.body;
}

async function painel(empresa = ID.loja) {
  const r = await request(app).get(`/companies/${empresa}/dashboard`);
  expect(r.status).toBe(200);
  return r.body;
}

async function zerarFinanceiro() {
  await q(`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`, [EMPRESAS]);
  await q(`DELETE FROM sales WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`UPDATE companies SET pdv_settings = NULL WHERE id = ANY($1)`, [EMPRESAS]);
}

describe('cenario da Celia: R$ 389,70, sinal de R$ 100 no Pix', () => {
  let oid;

  beforeAll(async () => { await zerarFinanceiro(); });

  test('guardar: conta a receber de 389,70 pendente, nada no faturamento nem na receita', async () => {
    const r = await guardar({ items: ITENS_CELIA, customer_id: ID.cliente });
    expect(r.status).toBe(201);
    oid = r.body.order.id;
    expect(r.body.order).toMatchObject({ total: 389.7, sinal_pago: 0, falta: 389.7, sinal: null });

    const l = await lancamentosDoPedido(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber']);
    expect(l['pedido-areceber']).toMatchObject({ type: 'income', status: 'pending', amount: 389.7, original_amount: null, category: 'Pedido a receber' });

    const res = await resultadoDeHoje();
    expect(res).toMatchObject({ faturamento: 0, despesas: 0 });
    const p = await painel();
    expect(p.revenue).toBe(0);
  });

  test('sinal: conta cai para 289,70, entra 100 como "Sinal de pedido", sem venda', async () => {
    const vendasAntes = (await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n;
    const r = await sinal(oid, { amount: 100, method: 'pix' });
    expect(r.status).toBe(201);
    expect(r.body.sinal).toMatchObject({ valor: 100, forma: 'pix', forma_rotulo: 'Pix' });
    expect(r.body.sinal.pago_em).toBeTruthy();
    expect(r.body.taxa).toBe(0);
    expect(r.body.order).toMatchObject({ total: 389.7, sinal_pago: 100, falta: 289.7 });

    const l = await lancamentosDoPedido(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber', 'pedido-sinal']);
    expect(l['pedido-areceber']).toMatchObject({ status: 'pending', amount: 289.7, original_amount: 389.7 });
    expect(l['pedido-sinal']).toMatchObject({ type: 'income', status: 'confirmed', amount: 100, category: 'Sinal de pedido', company_id: ID.loja });

    const { rows: [sp] } = await q(
      `SELECT kind, status, amount::numeric AS amount, method, forma, paid_at FROM studio_payments WHERE order_id = $1`, [oid]);
    expect(sp).toMatchObject({ kind: 'deposit', status: 'paid', method: 'pix', forma: 'pix' });
    expect(Number(sp.amount)).toBe(100);
    expect(sp.paid_at).not.toBeNull();
    const { rows: [o] } = await q(`SELECT deposit_paid, status::text AS status, stock_deducted, sale_id FROM digital_orders WHERE id = $1`, [oid]);
    expect(o).toMatchObject({ deposit_paid: true, status: 'confirmed', stock_deducted: false, sale_id: null });
    expect((await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n).toBe(vendasAntes);
  });

  test('no dia do sinal: Faturamento 0 e Despesas 0; Receita do Painel 100; DRE receita bruta 100', async () => {
    const res = await resultadoDeHoje();
    expect(res).toMatchObject({ faturamento: 0, vendas: 0, despesas: 0 });

    const p = await painel();
    expect(p.revenue).toBe(100);
    expect(p.expenses).toBe(0);

    const dre = await dreDoMes();
    expect(dre.summary.receita_bruta).toBe(100);
    expect(dre.detail).toEqual([{ group: 'Receita Bruta', line: 'receita_bruta', total: 100 }]);
  });

  test('o mesmo sinal de novo (mesma chave e outra chave) nao lanca nada a mais', async () => {
    // A lista da aba Pedidos (B3) le o mesmo sinal.
    const lista = await request(app).get(`/companies/${ID.loja}/pedidos`);
    expect(lista.body.kpis).toMatchObject({ sinais_recebidos: 100, falta_receber: 289.7 });

    const outra = await sinal(oid, { amount: 50, method: 'dinheiro' });
    expect(outra.status).toBe(409);
    expect(outra.body.code).toBe('PEDIDO_SINAL_JA_PAGO');
    expect(Object.keys(await lancamentosDoPedido(oid))).toEqual(['pedido-areceber', 'pedido-sinal']);
  });

  test('conclusao (B5a simulado): Faturamento 389,70 e Receita do Painel 100 + 289,70, uma vez so', async () => {
    // O que o B5a vai gravar (fora deste PR): a venda pelo valor cheio, a
    // pdv-sale so com o saldo de hoje, e a conta a receber quitada pela venda
    // vai a 'cancelled'. Aqui so para provar que os numeros fecham.
    const vendaId = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount, payment_method, status, type, order_id)
             VALUES ($1, $2, 389.70, 'pix', 'completed', 'sale', $3)`, [vendaId, ID.loja, oid]);
    await q(`INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price, total_price, product_name_snapshot)
             VALUES ($1, $2, $3, 2, 129.90, 259.80, 'Vestido midi'), ($4, $2, $5, 1, 129.90, 129.90, 'Blusa de linho')`,
      [uuid(), vendaId, ID.vestido, uuid(), ID.blusa]);
    await q(`INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, idempotency_key)
             VALUES ($1, 'income', 'confirmed', 289.70, 'Venda PDV', 'Vendas', $2::date, NOW(), $3)`,
      [ID.loja, hoje, `pdv-sale-${vendaId}`]);
    await q(`UPDATE transactions SET status = 'cancelled', notes = 'quitado pela venda' WHERE idempotency_key = $1`,
      [`pedido-areceber-${oid}`]);

    const res = await resultadoDeHoje();
    expect(res).toMatchObject({ faturamento: 389.7, vendas: 389.7, despesas: 0 });
    const p = await painel();
    expect(p.revenue).toBe(389.7);

    // DRE de routes/dre.js: o sinal na linha de receita bruta (100). A
    // categoria 'Vendas' do Caixa NAO esta no mapa padrao desse arquivo e cai
    // em 'outros' desde antes deste card (o /dre nao tem tela no app; o mapa
    // vivo e finance_categories.dre_line). Nao mexemos: mudaria o DRE de toda
    // loja. No mapa vivo, as duas vao para "Vendas" (receita_vendas): ver o
    // teste do resolverTexto em sinalDoPedido.test.js.
    const dre = await dreDoMes();
    const linha = (l) => (dre.detail.find((d) => d.line === l) || { total: 0 }).total;
    expect(linha('receita_bruta')).toBe(100);
    expect(linha('outros')).toBe(289.7);
    expect(Math.round((linha('receita_bruta') + linha('outros')) * 100) / 100).toBe(389.7);
  });
});

describe('sinal no mesmo POST do pedido', () => {
  beforeAll(async () => { await zerarFinanceiro(); });

  test('guarda, lanca a conta e o sinal numa vez so', async () => {
    const r = await guardar({ items: ITENS_CELIA, sinal: { amount: 100, method: 'pix' } });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ total: 389.7, sinal_pago: 100, falta: 289.7 });
    expect(r.body.order.sinal).toMatchObject({ valor: 100, forma: 'pix' });
    const l = await lancamentosDoPedido(r.body.order.id);
    expect(l['pedido-areceber']).toMatchObject({ status: 'pending', amount: 289.7, original_amount: 389.7 });
    expect(l['pedido-sinal']).toMatchObject({ status: 'confirmed', amount: 100 });
  });

  test('repetir o POST (mesma chave) nao lanca o sinal de novo', async () => {
    const k = chave();
    const a = await guardar({ items: ITENS_CELIA, sinal: { amount: 50, method: 'dinheiro' } }, ID.loja, k);
    const b = await guardar({ items: ITENS_CELIA, sinal: { amount: 50, method: 'dinheiro' } }, ID.loja, k);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.order).toMatchObject({ id: a.body.order.id, sinal_pago: 50, falta: 339.7 });
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key LIKE $1`, [`pedido-sinal-${a.body.order.id}`]);
    expect(rows[0].n).toBe(1);
  });

  test('sinal maior que o total: 422 e nada e gravado', async () => {
    const k = chave();
    const r = await guardar({ items: ITENS_CELIA, sinal: { amount: 389.71, method: 'pix' } }, ID.loja, k);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PEDIDO_SINAL_MAIOR');
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE idempotency_key = $1`, [k]);
    expect(rows[0].n).toBe(0);
  });

  test('forma desconhecida: 422', async () => {
    const r = await guardar({ items: ITENS_CELIA, sinal: { amount: 10, method: 'boleto' } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PEDIDO_SINAL_FORMA');
  });
});

describe('POST /pedidos/:oid/sinal', () => {
  let n = 0;
  async function pedidoNovo(itens = ITENS_CELIA, empresa = ID.loja) {
    n += 1;
    const r = await guardar({ items: itens, customer_name: `Cliente ${n}` }, empresa);
    expect(r.status).toBe(201);
    return r.body.order.id;
  }

  beforeAll(async () => { await zerarFinanceiro(); });

  test('sinal maior que o total: 422 e a conta nao muda', async () => {
    const oid = await pedidoNovo();
    const r = await sinal(oid, { amount: 400, method: 'pix' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PEDIDO_SINAL_MAIOR');
    const l = await lancamentosDoPedido(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber']);
    expect(l['pedido-areceber']).toMatchObject({ amount: 389.7, original_amount: null });
  });

  test('sem valor ou valor negativo: 422', async () => {
    const oid = await pedidoNovo();
    expect((await sinal(oid, { method: 'pix' })).body.code).toBe('PEDIDO_SINAL_VALOR');
    expect((await sinal(oid, { amount: -5, method: 'pix' })).body.code).toBe('PEDIDO_SINAL_VALOR');
  });

  test('mesma chave: 200 com o mesmo sinal; dois toques em paralelo gravam um so', async () => {
    const oid = await pedidoNovo();
    const k = chave();
    const [a, b] = await Promise.all([sinal(oid, { amount: 80, method: 'dinheiro' }, k), sinal(oid, { amount: 80, method: 'dinheiro' }, k)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const repetido = a.status === 200 ? a : b;
    expect(repetido.headers['idempotent-replayed']).toBe('true');
    expect(repetido.body.sinal).toMatchObject({ valor: 80, forma: 'dinheiro' });
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM studio_payments WHERE order_id = $1`, [oid]);
    expect(rows[0].n).toBe(1);
    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-sinal'].amount).toBe(80);
    expect(l['pedido-areceber']).toMatchObject({ amount: 309.7, original_amount: 389.7 });
  });

  test('a mesma chave em outro pedido da loja: 409, nada gravado no segundo', async () => {
    const um = await pedidoNovo();
    const dois = await pedidoNovo();
    const k = chave();
    expect((await sinal(um, { amount: 10, method: 'pix' }, k)).status).toBe(201);
    const r = await sinal(dois, { amount: 10, method: 'pix' }, k);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(Object.keys(await lancamentosDoPedido(dois))).toEqual(['pedido-areceber']);
  });

  test('sinal igual ao total quita a conta (cancelled, com nota)', async () => {
    const oid = await pedidoNovo();
    const r = await sinal(oid, { amount: 389.7, method: 'dinheiro' });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ sinal_pago: 389.7, falta: 0 });
    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-areceber']).toMatchObject({ status: 'cancelled', amount: 389.7, notes: 'Quitada pelo sinal do pedido' });
    expect(l['pedido-sinal']).toMatchObject({ status: 'confirmed', amount: 389.7 });
  });

  test('pedido cancelado ou concluido: 409, sem lancamento', async () => {
    for (const status of ['cancelled', 'delivered']) {
      const oid = await pedidoNovo();
      // cancel_kind junto: e o que o cancelamento grava, e evita o CASE do
      // trigger da 359 (payment_status = 'expired' nao existe no ENUM do CI).
      await q(`UPDATE digital_orders SET status = $1, cancel_kind = $3 WHERE id = $2`,
        [status, oid, status === 'cancelled' ? 'cancelado_pela_loja' : null]);
      const r = await sinal(oid, { amount: 10, method: 'pix' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PEDIDO_FECHADO');
      expect(Object.keys(await lancamentosDoPedido(oid))).toEqual(['pedido-areceber']);
    }
  });

  test('taxa da maquininha: credito e debito pela aliquota da loja; Pix sem taxa configurada nao paga', async () => {
    await q(`UPDATE companies SET pdv_settings = $2::jsonb WHERE id = $1`,
      [ID.loja, JSON.stringify({ card_fee_enabled: true, card_fee_credit_pct: 3.5, card_fee_debit_pct: 1.5 })]);
    try {
      const credito = await pedidoNovo();
      const r1 = await sinal(credito, { amount: 100, method: 'cartao' });
      expect(r1.body.taxa).toBe(3.5);
      const debito = await pedidoNovo();
      const r2 = await sinal(debito, { amount: 200, method: 'debito' });
      expect(r2.body.taxa).toBe(3);
      const pix = await pedidoNovo();
      expect((await sinal(pix, { amount: 100, method: 'pix' })).body.taxa).toBe(0);

      const l1 = await lancamentosDoPedido(credito);
      expect(l1['pedido-sinal-taxa']).toMatchObject({ type: 'expense', status: 'confirmed', amount: 3.5, category: 'Taxas de cartão' });
      expect((await lancamentosDoPedido(debito))['pedido-sinal-taxa'].amount).toBe(3);
      expect((await lancamentosDoPedido(pix))['pedido-sinal-taxa']).toBeUndefined();
      const { rows: [sp] } = await q(`SELECT method, forma FROM studio_payments WHERE order_id = $1`, [debito]);
      expect(sp).toEqual({ method: 'card', forma: 'debito' });
    } finally {
      await q(`UPDATE companies SET pdv_settings = NULL WHERE id = $1`, [ID.loja]);
    }
  });

  test('multi-CNPJ: o sinal fica na loja do pedido; pedido de outra loja e 404', async () => {
    const daFilial = await pedidoNovo([{ product_id: ID.daFilial, quantity: 1, unit_price: 80 }], ID.filial);
    const errada = await sinal(daFilial, { amount: 20, method: 'pix' });
    expect(errada.status).toBe(404);
    const certa = await sinal(daFilial, { amount: 20, method: 'pix' }, chave(), ID.filial);
    expect(certa.status).toBe(201);
    const l = await lancamentosDoPedido(daFilial);
    expect(l['pedido-sinal'].company_id).toBe(ID.filial);
    expect(l['pedido-areceber']).toMatchObject({ company_id: ID.filial, amount: 60, original_amount: 80 });
  });

  test('pedido guardado antes da conta a receber (B1 sem B4a) ganha a conta no sinal', async () => {
    const oid = await pedidoNovo();
    await q(`UPDATE digital_orders SET transaction_id = NULL WHERE id = $1`, [oid]);
    await q(`DELETE FROM transactions WHERE idempotency_key = $1`, [`pedido-areceber-${oid}`]);
    expect((await sinal(oid, { amount: 89.7, method: 'pix' })).status).toBe(201);
    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-areceber']).toMatchObject({ status: 'pending', amount: 300, original_amount: 389.7 });
    const { rows: [o] } = await q(`SELECT transaction_id FROM digital_orders WHERE id = $1`, [oid]);
    expect(o.transaction_id).not.toBeNull();
  });

  test('trava PEDIDO_LIBERADO: lojista recebe 404', async () => {
    const oid = await pedidoNovo();
    usuario = { id: ID.dono, role: 'client' };
    const r = await sinal(oid, { amount: 10, method: 'pix' });
    expect(r.status).toBe(404);
    expect(Object.keys(await lancamentosDoPedido(oid))).toEqual(['pedido-areceber']);
  });
});

describe('categorias vivas: o script de migracao (aplicarMigracao) nos lancamentos do pedido', () => {
  test('"Sinal de pedido" e "Pedido a receber" ligam a Vendas; "Devolução de sinal" nao liga a nada nem vira categoria', async () => {
    await zerarFinanceiro();
    const r = await guardar({ items: ITENS_CELIA, sinal: { amount: 100, method: 'pix' } });
    expect(r.status).toBe(201);
    // A devolucao do B6, como ele grava.
    await q(`INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, idempotency_key)
             VALUES ($1, 'expense', 'confirmed', 100, 'Devolução do sinal', 'Devolução de sinal', $2::date, NOW(), $3)`,
      [ID.loja, hoje, `pedido-devolucao-${r.body.order.id}`]);
    const cat = require('../src/services/financeCategories');
    const plano = await cat.planejarMigracao(ID.loja);
    expect(plano.ligar.find((l) => /sinal de pedido/i.test(l.texto))).toMatchObject({ categoria: 'Vendas' });
    expect(plano.ligar.find((l) => /devolu/i.test(l.texto))).toBeUndefined();
    expect(plano.criar.find((c) => /devolu/i.test(c.name))).toBeUndefined();

    await cat.aplicarMigracao(ID.loja);
    const { rows } = await q(
      `SELECT t.category, f.name AS categoria, f.dre_line
         FROM transactions t LEFT JOIN finance_categories f ON f.id = t.category_id
        WHERE t.idempotency_key LIKE $1 ORDER BY t.category`, [`pedido-%${r.body.order.id}`]);
    expect(rows).toEqual([
      { category: 'Devolução de sinal', categoria: null, dre_line: null },
      { category: 'Pedido a receber', categoria: 'Vendas', dre_line: 'receita_vendas' },
      { category: 'Sinal de pedido', categoria: 'Vendas', dre_line: 'receita_vendas' },
    ]);
    const { rows: novas } = await q(`SELECT name FROM finance_categories WHERE company_id = $1 AND name_norm LIKE 'devolu%'`, [ID.loja]);
    expect(novas.map((x) => x.name)).toEqual([]);
  });
});

describe('Financeiro: a conta do pedido nao se baixa a mao', () => {
  test('marcar como recebido, mudar o valor ou pagar parcial: 409; descricao muda', async () => {
    const r = await guardar({ items: ITENS_CELIA, sinal: { amount: 100, method: 'pix' } });
    const l = await lancamentosDoPedido(r.body.order.id);
    const { rows: [conta] } = await q(`SELECT id FROM transactions WHERE idempotency_key = $1`, [`pedido-areceber-${r.body.order.id}`]);
    const { rows: [entrada] } = await q(`SELECT id FROM transactions WHERE idempotency_key = $1`, [`pedido-sinal-${r.body.order.id}`]);
    const patch = (id, body) => request(app).patch(`/companies/${ID.loja}/transactions/${id}`).send(body);

    for (const body of [{ status: 'confirmed' }, { amount: 10 }, { status: 'confirmed', paid_amount: 289.7 }]) {
      const x = await patch(conta.id, body);
      expect(x.status).toBe(409);
      expect(x.body.code).toBe('PEDIDO_LANCAMENTO_DERIVADO');
    }
    expect((await patch(entrada.id, { status: 'pending' })).status).toBe(409);
    expect((await patch(conta.id, { description: 'Pedido da vitrine', amount: 289.7 })).status).toBe(200);
    expect((await lancamentosDoPedido(r.body.order.id))['pedido-areceber']).toMatchObject({ status: 'pending', amount: 289.7 });
    expect(l['pedido-areceber'].status).toBe('pending');
  });
});
