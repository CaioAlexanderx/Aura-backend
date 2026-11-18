// ============================================================
// AURA. — Cancelar o pedido do balcao (B6 / p-62e) — Postgres real
// POST /companies/:id/pedidos/:oid/cancelar (routes/pedidosDoBalcao.js,
// services/cancelarPedido.js), migration 461.
//
// Cenario da Celia, cancelamento com devolucao em dinheiro: pedido de
// R$ 389,70 com sinal de R$ 100 no Pix, cancelado com o sinal devolvido em
// dinheiro (caixa aberto).
//   - a conta "Pedido a receber" vai a 'cancelled';
//   - "Devolucao de sinal" de 100 (expense confirmado), saida
//     'devolucao_sinal' de 100 na sessao do caixa;
//   - Resultado do periodo: Faturamento 0 e Despesas 0 (os 100 NAO viram
//     despesa nem abatem faturamento);
//   - DRE: a linha de receita bruta fecha em 0 (sinal 100 − devolucao 100),
//     nenhuma linha de despesa;
//   - a reserva some (calculada), sem e-mail nem sino.
// E mais: credito na ficha (cliente cadastrada, sem crediario_enabled),
// caixa fechado (409), Pix e estorno so registram, pedido sem sinal, destino
// obrigatorio com sinal, cancelar duas vezes (e em paralelo), pedido
// concluido, multi-CNPJ e a trava.
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
  vestido: uuid(), blusa: uuid(),
  cliente: uuid(), sessao: uuid(),
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
    [`DELETE FROM caixa_movimentos WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customer_credit_transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM finance_categories WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
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
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  hoje = require('../src/services/pedidoBalcao').hojeSP();

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Cancelar')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja Cancelar')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial Cancelar', $3)`,
    [ID.filial, ID.dono, ID.loja]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $3, 'Vestido midi', 129.9, 50), ($2, $3, 'Blusa de linho', 129.9, 50)`,
    [ID.vestido, ID.blusa, ID.loja]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Fixture Cancelar')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
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

function chave() { seq += 1; return `teste-cancelar-${seq}-${uuid()}`; }

const ITENS_CELIA = [
  { product_id: ID.vestido, quantity: 2, unit_price: 129.9 },
  { product_id: ID.blusa, quantity: 1, unit_price: 129.9 },
];

async function pedido({ sinal, cliente = false, empresa = ID.loja } = {}) {
  const body = { items: empresa === ID.loja ? ITENS_CELIA : [{ product_name: 'Ajuste', quantity: 1, unit_price: 50 }] };
  if (cliente) body.customer_id = ID.cliente;
  if (sinal) body.sinal = sinal;
  const r = await request(app).post(`/companies/${empresa}/pedidos`).set('Idempotency-Key', chave()).send(body);
  expect(r.status).toBe(201);
  return r.body.order.id;
}

function cancelar(oid, body, empresa = ID.loja) {
  return request(app).post(`/companies/${empresa}/pedidos/${oid}/cancelar`).send(body || {});
}

async function lancamentosDoPedido(oid) {
  const { rows } = await q(
    `SELECT idempotency_key, type::text AS type, status::text AS status, amount::numeric AS amount, category, notes
       FROM transactions WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`, [`pedido-%${oid}`]);
  return Object.fromEntries(rows.map((r) => [r.idempotency_key.replace(`-${oid}`, ''), { ...r, amount: Number(r.amount) }]));
}

async function movimentos() {
  const { rows } = await q(`SELECT tipo, valor::numeric AS valor, motivo FROM caixa_movimentos WHERE company_id = $1 ORDER BY created_at`, [ID.loja]);
  return rows.map((r) => ({ ...r, valor: Number(r.valor) }));
}

async function zerar() {
  await q(`DELETE FROM caixa_movimentos WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM customer_credit_transactions WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`UPDATE companies SET pdv_settings = NULL WHERE id = ANY($1)`, [EMPRESAS]);
}

async function caixaAberto() {
  await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": true}'::jsonb WHERE id = $1`, [ID.loja]);
  await q(`INSERT INTO caixa_sessoes (id, company_id, opened_by, troco_inicial, status) VALUES ($1, $2, $3, 50, 'aberta')`,
    [ID.sessao, ID.loja, ID.dono]);
}

describe('cenario da Celia: cancelamento com devolucao em dinheiro', () => {
  let oid;
  let gavetaAntes;
  const caixaService = require('../src/services/caixaService');

  beforeAll(async () => {
    usuario = { id: ID.dono, role: 'client', is_staff: true };
    await zerar();
    await caixaAberto();
    oid = await pedido({ sinal: { amount: 100, method: 'pix' }, cliente: true });
    gavetaAntes = (await caixaService.getStatus(ID.loja)).sessao_ativa.dinheiro_em_caixa;
  });

  test('cancelar: pedido cancelado, conta a receber cancelada, devolucao de 100 e saida no caixa', async () => {
    const notify = require('../src/services/digitalOrderNotifications');
    const lojaEvents = require('../src/services/lojaEvents');
    notify.notifyStatusChange.mockClear();
    lojaEvents.emit.mockClear();

    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'dinheiro', reason: '  Cliente desistiu  ' });
    expect(r.status).toBe(200);
    expect(r.body.ja_estava).toBe(false);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: 'dinheiro', refund_method: 'dinheiro', valor: 100, credito_id: null, movimento_caixa: true });
    expect(r.body.order).toMatchObject({ status: 'cancelled', cancel_reason: 'Cliente desistiu', refund_kind: 'dinheiro', sinal_pago: 100 });
    expect(r.body.order.cancelled_at).toBeTruthy();

    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-areceber']).toMatchObject({ status: 'cancelled', amount: 289.7, notes: 'Pedido cancelado' });
    expect(l['pedido-sinal']).toMatchObject({ type: 'income', status: 'confirmed', amount: 100 });
    expect(l['pedido-devolucao']).toMatchObject({ type: 'expense', status: 'confirmed', amount: 100, category: 'Devolução de sinal' });
    expect(Object.values(l).some((t) => /^devolu..o$/i.test(t.category))).toBe(false);

    expect(await movimentos()).toEqual([{ tipo: 'devolucao_sinal', valor: 100, motivo: expect.stringContaining('Sinal devolvido') }]);
    const { rows: [o] } = await q(`SELECT cancel_kind, refund_marked_at, stock_deducted FROM digital_orders WHERE id = $1`, [oid]);
    expect(o.cancel_kind).toBe('cancelado_pela_loja');
    expect(o.refund_marked_at).not.toBeNull();
    expect(o.stock_deducted).toBe(false);

    expect(notify.notifyStatusChange).not.toHaveBeenCalled();
    expect(lojaEvents.emit).not.toHaveBeenCalled();
  });

  test('Resultado do periodo: Faturamento 0 e Despesas 0 (a devolucao nao vira despesa)', async () => {
    const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool });
    expect(res).toMatchObject({ faturamento: 0, vendas: 0, despesas: 0, trocas: { entrou: 0, devolvido: 0 } });
  });

  test('DRE: a linha de receita bruta fecha em 0, sem despesa', async () => {
    // dre.js filtra por paid_at::date em UTC: o fim vai um dia alem de hoje.
    const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const r = await request(app).get(`/companies/${ID.loja}/dre`).query({ from: hoje.slice(0, 8) + '01', to: amanha });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ receita_bruta: 0, outros: 0, lucro_liquido: 0 });
    expect(Math.abs(r.body.summary.despesa_variavel)).toBe(0);
    expect(r.body.detail).toEqual([{ group: 'Receita Bruta', line: 'receita_bruta', total: 0 }]);
    expect(r.body.expenses.total).toBe(0);
  });

  test('Painel (regime de caixa): entrou 100 e saiu 100', async () => {
    // O Painel soma todo income e todo expense confirmado (dashboard.js, nao
    // mexido): o sinal aparece como receita e a devolucao como saida. O
    // liquido do dia e 0.
    const r = await request(app).get(`/companies/${ID.loja}/dashboard`);
    expect(r.status).toBe(200);
    expect(r.body.revenue).toBe(100);
    expect(r.body.expenses).toBe(100);
  });

  // B4b (p-62b): o fechamento passou a ler a devolucao em dinheiro. O sinal
  // entrou no Pix (fica no Pix da sessao) e os 100 sairam da gaveta.
  test('B4b: a devolucao em dinheiro sai do dinheiro esperado; o sinal fica no Pix', async () => {
    const depois = (await caixaService.getStatus(ID.loja)).sessao_ativa;
    expect(depois.dinheiro_em_caixa).toBe(Math.round((gavetaAntes - 100) * 100) / 100);
    expect(depois.sangrias).toBe(0);
    expect(depois.totais_ao_vivo.pix).toBe(100);
    expect(depois.totais_ao_vivo.outros).toBe(0);
    expect(depois.totais_ao_vivo.sinais_pedido).toMatchObject({ pix: 100, dinheiro: 0, devolvido_dinheiro: 100, total: 100 });
  });

  test('a reserva some sozinha', async () => {
    const { lerReservas } = require('../src/services/reservaDoPedido');
    const reservas = await lerReservas(pool, ID.loja, [ID.vestido, ID.blusa]);
    expect(reservas.size).toBe(0);
  });

  test('depois da migracao de categorias: "Devolução de sinal" sem categoria viva, e o DRE e o Resultado seguem iguais', async () => {
    const cat = require('../src/services/financeCategories');
    await cat.aplicarMigracao(ID.loja);
    const { rows } = await q(
      `SELECT t.category, f.name AS categoria FROM transactions t
         LEFT JOIN finance_categories f ON f.id = t.category_id
        WHERE t.idempotency_key IN ($1, $2) ORDER BY t.category`,
      [`pedido-devolucao-${oid}`, `pedido-sinal-${oid}`]);
    expect(rows).toEqual([
      { category: 'Devolução de sinal', categoria: null },
      { category: 'Sinal de pedido', categoria: 'Vendas' },
    ]);

    // dre.js: a devolucao na linha do sinal com valor negativo; liquido 0.
    const amanha = new Date(Date.parse(hoje + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const r = await request(app).get(`/companies/${ID.loja}/dre`).query({ from: hoje.slice(0, 8) + '01', to: amanha });
    expect(r.status).toBe(200);
    expect(r.body.detail).toEqual([{ group: 'Receita Bruta', line: 'receita_bruta', total: 0 }]);
    expect(r.body.summary).toMatchObject({ receita_bruta: 0, outros: 0, lucro_liquido: 0 });
    // Linha a linha: +100 do sinal, -100 da devolucao.
    const { DEFAULT_LINE_MAP } = require('../src/routes/dre');
    expect(DEFAULT_LINE_MAP['devolução de sinal'].line).toBe(DEFAULT_LINE_MAP['sinal de pedido'].line);

    // Resultado do periodo: Faturamento 0 e Despesas 0.
    const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool });
    expect(res).toMatchObject({ faturamento: 0, despesas: 0, trocas: { entrou: 0, devolvido: 0 } });
  });

  test('cancelar de novo: 200 ja_estava, nada lancado de novo', async () => {
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'dinheiro' });
    expect(r.status).toBe(200);
    expect(r.body.ja_estava).toBe(true);
    expect(r.body.cancelamento).toEqual({ refund_kind: 'dinheiro' });
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, [`pedido-devolucao-${oid}`]);
    expect(rows[0].n).toBe(1);
    expect(await movimentos()).toHaveLength(1);
  });
});

describe('devolucao: caixa e formas', () => {
  beforeEach(async () => { await zerar(); });

  test('dinheiro com o caixa ligado e fechado: 409 CAIXA_REQUIRED e nada muda', async () => {
    const oid = await pedido({ sinal: { amount: 100, method: 'dinheiro' } });
    await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": true}'::jsonb WHERE id = $1`, [ID.loja]);
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'dinheiro' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CAIXA_REQUIRED');
    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-areceber'].status).toBe('pending');
    expect(l['pedido-devolucao']).toBeUndefined();
    const { rows: [o] } = await q(`SELECT status::text AS status FROM digital_orders WHERE id = $1`, [oid]);
    expect(o.status).toBe('confirmed');
  });

  test('dinheiro sem o modulo de caixa: so registra (sem movimento)', async () => {
    const oid = await pedido({ sinal: { amount: 40, method: 'dinheiro' } });
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'dinheiro' });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: 'dinheiro', movimento_caixa: false });
    expect((await lancamentosDoPedido(oid))['pedido-devolucao'].amount).toBe(40);
    expect(await movimentos()).toEqual([]);
  });

  test.each(['pix', 'estorno'])('%s com o caixa aberto: so registra', async (method) => {
    await caixaAberto();
    const oid = await pedido({ sinal: { amount: 60, method: 'cartao' } });
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: method });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: method, movimento_caixa: false });
    expect((await lancamentosDoPedido(oid))['pedido-devolucao']).toMatchObject({ amount: 60, category: 'Devolução de sinal' });
    expect(await movimentos()).toEqual([]);
  });

  test('devolucao sem forma: 422', async () => {
    const oid = await pedido({ sinal: { amount: 10, method: 'pix' } });
    const r = await cancelar(oid, { refund_kind: 'devolucao' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PEDIDO_DEVOLUCAO_FORMA');
  });
});

describe('taxa da maquininha do sinal no cartao (revisao da Celia)', () => {
  // Credito a 3,5%: sinal de R$ 100 no cartao paga R$ 3,50 de taxa.
  beforeEach(async () => {
    await zerar();
    await q(`UPDATE companies SET pdv_settings = $2::jsonb WHERE id = $1`,
      [ID.loja, JSON.stringify({ card_fee_enabled: true, card_fee_credit_pct: 3.5, card_fee_debit_pct: 1.5 })]);
  });

  async function despesasDeHoje() {
    return (await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool })).despesas;
  }

  test('estorno: a taxa sai junto (como o cancelamento de venda); Despesas 3,50 -> 0', async () => {
    const oid = await pedido({ sinal: { amount: 100, method: 'cartao' } });
    expect((await lancamentosDoPedido(oid))['pedido-sinal-taxa'].amount).toBe(3.5);
    expect(await despesasDeHoje()).toBe(3.5);
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'estorno' });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: 'estorno', valor: 100, taxa_estornada: 3.5 });
    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-sinal-taxa']).toBeUndefined();
    expect(l['pedido-devolucao'].amount).toBe(100);
    expect(await despesasDeHoje()).toBe(0);
  });

  test('estorno de sinal no debito: a taxa de 1,5% (R$ 3,00 sobre 200) sai junto', async () => {
    const oid = await pedido({ sinal: { amount: 200, method: 'debito' } });
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'estorno' });
    expect(r.body.cancelamento.taxa_estornada).toBe(3);
    expect((await lancamentosDoPedido(oid))['pedido-sinal-taxa']).toBeUndefined();
  });

  test.each(['dinheiro', 'pix'])('devolucao em %s de sinal no cartao: a taxa fica (Despesas 3,50)', async (method) => {
    const oid = await pedido({ sinal: { amount: 100, method: 'cartao' } });
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: method });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: method, taxa_estornada: 0 });
    expect((await lancamentosDoPedido(oid))['pedido-sinal-taxa']).toMatchObject({ status: 'confirmed', amount: 3.5 });
    expect(await despesasDeHoje()).toBe(3.5);
  });

  test('credito na ficha de sinal no cartao: a taxa fica (Despesas 3,50)', async () => {
    const oid = await pedido({ sinal: { amount: 100, method: 'cartao' }, cliente: true });
    const r = await cancelar(oid, { refund_kind: 'credito' });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: 'credito', taxa_estornada: 0 });
    expect((await lancamentosDoPedido(oid))['pedido-sinal-taxa']).toMatchObject({ status: 'confirmed', amount: 3.5 });
    expect(await despesasDeHoje()).toBe(3.5);
  });
});

describe('credito na ficha', () => {
  beforeEach(async () => { await zerar(); });

  test('com cliente cadastrada e sem crediario_enabled: credito livre, sem venda; o sinal fica como receita', async () => {
    const oid = await pedido({ sinal: { amount: 100, method: 'pix' }, cliente: true });
    const r = await cancelar(oid, { refund_kind: 'credito' });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: 'credito', valor: 100, movimento_caixa: false });
    const { rows: [c] } = await q(
      `SELECT company_id, customer_id, sale_id, type, amount::numeric AS amount, payment_method, source, idempotency_key
         FROM customer_credit_transactions WHERE id = $1`, [r.body.cancelamento.credito_id]);
    expect(c).toMatchObject({ company_id: ID.loja, customer_id: ID.cliente, sale_id: null, type: 'payment', payment_method: 'crediario_credito', source: 'pedido', idempotency_key: `pedido-credito-${oid}` });
    expect(Number(c.amount)).toBe(100);
    // Saldo negativo = credito a favor (view customer_credit_balances).
    const { rows: [saldo] } = await q(`SELECT balance::numeric AS b FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`, [ID.cliente, ID.loja]);
    expect(Number(saldo.b)).toBe(-100);

    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-areceber'].status).toBe('cancelled');
    expect(l['pedido-sinal']).toMatchObject({ status: 'confirmed', amount: 100 });
    expect(l['pedido-devolucao']).toBeUndefined();
    const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool });
    expect(res).toMatchObject({ faturamento: 0, despesas: 0 });
    expect(r.body.order.refund_kind).toBe('credito');
  });

  test('sem cliente cadastrada: 422 CREDITO_EXIGE_CLIENTE e nada muda', async () => {
    const oid = await pedido({ sinal: { amount: 100, method: 'pix' } });
    const r = await cancelar(oid, { refund_kind: 'credito' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('CREDITO_EXIGE_CLIENTE');
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM customer_credit_transactions WHERE company_id = $1`, [ID.loja]);
    expect(rows[0].n).toBe(0);
    expect((await lancamentosDoPedido(oid))['pedido-areceber'].status).toBe('pending');
  });
});

describe('regras do cancelamento', () => {
  beforeEach(async () => { await zerar(); });

  test('sem sinal: cancela sem perguntar o destino, a conta a receber vai a cancelled', async () => {
    const oid = await pedido();
    const r = await cancelar(oid, {});
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: null, valor: 0 });
    expect(r.body.order).toMatchObject({ status: 'cancelled', refund_kind: null, cancel_reason: null });
    const l = await lancamentosDoPedido(oid);
    expect(Object.keys(l)).toEqual(['pedido-areceber']);
    expect(l['pedido-areceber'].status).toBe('cancelled');
  });

  test('com sinal e sem destino: 422', async () => {
    const oid = await pedido({ sinal: { amount: 10, method: 'pix' } });
    for (const body of [{}, { refund_kind: 'nada' }]) {
      const r = await cancelar(oid, body);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PEDIDO_DESTINO_DO_SINAL');
    }
  });

  test('dois cancelamentos ao mesmo tempo: uma devolucao so', async () => {
    const oid = await pedido({ sinal: { amount: 30, method: 'pix' } });
    const body = { refund_kind: 'devolucao', refund_method: 'pix' };
    const [a, b] = await Promise.all([cancelar(oid, body), cancelar(oid, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.ja_estava, b.body.ja_estava].sort()).toEqual([false, true]);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, [`pedido-devolucao-${oid}`]);
    expect(rows[0].n).toBe(1);
  });

  test('pedido concluido (virou venda): 409, nada muda', async () => {
    const oid = await pedido({ sinal: { amount: 10, method: 'pix' } });
    await q(`UPDATE digital_orders SET status = 'delivered' WHERE id = $1`, [oid]);
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'pix' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PEDIDO_JA_CONCLUIDO');
    expect((await lancamentosDoPedido(oid))['pedido-devolucao']).toBeUndefined();
  });

  test('motivo longo e cortado em 200', async () => {
    const oid = await pedido();
    const r = await cancelar(oid, { reason: 'x'.repeat(300) });
    expect(r.body.order.cancel_reason).toHaveLength(200);
  });

  test('multi-CNPJ: pedido da filial nao cancela pela loja (404); pela filial, na filial', async () => {
    const oid = await pedido({ empresa: ID.filial, sinal: { amount: 20, method: 'pix' } });
    expect((await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'pix' })).status).toBe(404);
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'pix' }, ID.filial);
    expect(r.status).toBe(200);
    const { rows: [t] } = await q(`SELECT company_id FROM transactions WHERE idempotency_key = $1`, [`pedido-devolucao-${oid}`]);
    expect(t.company_id).toBe(ID.filial);
  });

  test('pedido da loja online nao cancela por aqui (404)', async () => {
    const id = uuid();
    await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status)
             VALUES ($1, $2, 'ON-0001', 'Cliente Loja', '', 10, 10, 'confirmed')`, [id, ID.loja]);
    expect((await cancelar(id, {})).status).toBe(404);
    const { rows: [o] } = await q(`SELECT status::text AS status FROM digital_orders WHERE id = $1`, [id]);
    expect(o.status).toBe('confirmed');
  });

  test('trava PEDIDO_LIBERADO: lojista recebe 404', async () => {
    const oid = await pedido();
    usuario = { id: ID.dono, role: 'client' };
    expect((await cancelar(oid, {})).status).toBe(404);
  });
});

describe('revisao do Fable (18/11)', () => {
  beforeEach(async () => {
    usuario = { id: ID.dono, role: 'client', is_staff: true };
    await zerar();
  });

  test.each(['dinheiro', 'pix'])('estorno de sinal pago em %s: 422 e nada muda', async (forma) => {
    const oid = await pedido({ sinal: { amount: 50, method: forma } });
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'estorno' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PEDIDO_ESTORNO_SEM_CARTAO');
    const l = await lancamentosDoPedido(oid);
    expect(l['pedido-devolucao']).toBeUndefined();
    expect(l['pedido-areceber'].status).toBe('pending');
    const { rows: [o] } = await q(`SELECT status::text AS status FROM digital_orders WHERE id = $1`, [oid]);
    expect(o.status).toBe('confirmed');
  });

  test('marco pago sem forma (fora do registrarSinal) nao conta como sinal: so o sinal de verdade e devolvido', async () => {
    const oid = await pedido({ sinal: { amount: 40, method: 'pix' } });
    // O que um marco do Studio gravaria (sem forma, sem dinheiro no Financeiro).
    await q(`INSERT INTO studio_payments (company_id, order_id, kind, amount, status, method, paid_at)
             VALUES ($1, $2, 'deposit', 500, 'paid', 'pix', NOW())`, [ID.loja, oid]);
    const r = await cancelar(oid, { refund_kind: 'devolucao', refund_method: 'pix' });
    expect(r.status).toBe(200);
    expect(r.body.cancelamento.valor).toBe(40);
    expect((await lancamentosDoPedido(oid))['pedido-devolucao'].amount).toBe(40);
  });

  test('pedido so com marco sem forma: cancela como pedido sem sinal, sem devolucao nem credito', async () => {
    const oid = await pedido({ cliente: true });
    await q(`INSERT INTO studio_payments (company_id, order_id, kind, amount, status, method, paid_at)
             VALUES ($1, $2, 'deposit', 80, 'paid', 'cash', NOW())`, [ID.loja, oid]);
    const r = await cancelar(oid, {});
    expect(r.status).toBe(200);
    expect(r.body.cancelamento).toMatchObject({ refund_kind: null, valor: 0 });
    expect((await lancamentosDoPedido(oid))['pedido-devolucao']).toBeUndefined();
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM customer_credit_transactions WHERE company_id = $1`, [ID.loja]);
    expect(rows[0].n).toBe(0);
  });
});
