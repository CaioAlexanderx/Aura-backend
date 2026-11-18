// ============================================================
// AURA. — Sinal do pedido no caixa (B4b / p-62b) — Postgres real
// services/sinalDoPedido.js (registrarSinal) + services/caixaService.js.
//
// O que este card promete, provado no banco:
//   - sinal em DINHEIRO com o caixa ligado e fechado: 409 CAIXA_REQUIRED (o
//     mesmo codigo da venda) e nada e gravado, no POST /pedidos com sinal e no
//     POST /pedidos/:oid/sinal. Pix e cartao nao exigem caixa;
//   - com o caixa aberto, o dinheiro vira o movimento 'sinal_pedido' da
//     sessao e entra no dinheiro esperado; o Pix, o credito e o debito entram
//     na forma deles. O sinal sai de "outras entradas" (total_outros);
//   - a devolucao em dinheiro (B6) sai do dinheiro esperado;
//   - o fechamento grava o snapshot com o sinal na forma certa e devolve a
//     linha `sinais_pedido`; o detalhe da sessao tambem;
//   - o movimento do sinal nao se apaga pela gaveta;
//   - a loja SEM pedido: a resposta nao ganha chave nenhuma e os numeros sao
//     os de sempre (venda, sangria, suprimento, receita manual em outros).
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

jest.setTimeout(60000);

const ID = {
  dono: uuid(),
  loja: uuid(), semPedido: uuid(),
  vestido: uuid(), blusa: uuid(), caneca: uuid(),
  cliente: uuid(), sessao: uuid(), sessaoSemPedido: uuid(),
};
const EMPRESAS = [ID.loja, ID.semPedido];

let pool;
let app;
let usuario;
let seq = 0;

const q = (sql, params) => pool.query(sql, params);
const r2 = (n) => Math.round(n * 100) / 100;

async function limpar() {
  const passos = [
    [`DELETE FROM caixa_fechamentos WHERE sessao_id IN (SELECT id FROM caixa_sessoes WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM caixa_movimentos WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM sale_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`, [EMPRESAS]],
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

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Caixa Sinal')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja Caixa Sinal'), ($3, $2, 'Fixture Loja Sem Pedido')`,
    [ID.loja, ID.dono, ID.semPedido]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES
             ($1, $4, 'Vestido midi', 129.9, 50), ($2, $4, 'Blusa de linho', 129.9, 50), ($3, $5, 'Caneca', 10, 50)`,
    [ID.vestido, ID.blusa, ID.caneca, ID.loja, ID.semPedido]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Fixture Caixa')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/companies/:id/caixa', require('../src/routes/caixa'));
  app.use('/companies/:id/dashboard', require('../src/routes/dashboard'));
  app.use('/companies/:id/dre', require('../src/routes/dre'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
});

beforeEach(async () => {
  usuario = { id: ID.dono, role: 'client', is_staff: true };
  delete process.env.PEDIDO_LIBERADO;
  require('../src/services/caixaService')._resetCache();
  await q(`DELETE FROM caixa_fechamentos WHERE sessao_id IN (SELECT id FROM caixa_sessoes WHERE company_id = ANY($1))`, [EMPRESAS]);
  await q(`DELETE FROM caixa_movimentos WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM sale_payments WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`, [EMPRESAS]);
  await q(`DELETE FROM sales WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]);
  await q(`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]);
  await q(`UPDATE companies SET pdv_settings = NULL WHERE id = ANY($1)`, [EMPRESAS]);
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

function chave() { seq += 1; return `teste-caixa-sinal-${seq}-${uuid()}`; }

const ITENS_CELIA = [
  { product_id: ID.vestido, quantity: 2, unit_price: 129.9 },
  { product_id: ID.blusa, quantity: 1, unit_price: 129.9 },
];

function guardar(body) {
  return request(app).post(`/companies/${ID.loja}/pedidos`).set('Idempotency-Key', chave()).send(body);
}
async function pedidoSemSinal() {
  const r = await guardar({ items: ITENS_CELIA, customer_id: ID.cliente });
  expect(r.status).toBe(201);
  return r.body.order.id;
}
function sinal(oid, body) {
  return request(app).post(`/companies/${ID.loja}/pedidos/${oid}/sinal`).set('Idempotency-Key', chave()).send(body);
}
async function ligarCaixa(empresa = ID.loja) {
  await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": true}'::jsonb WHERE id = $1`, [empresa]);
}
async function abrirCaixa(empresa = ID.loja, sessao = ID.sessao, troco = 50) {
  await ligarCaixa(empresa);
  await q(`INSERT INTO caixa_sessoes (id, company_id, opened_by, troco_inicial, status, opened_at)
           VALUES ($1, $2, $3, $4, 'aberta', NOW() - INTERVAL '1 minute')`, [sessao, empresa, ID.dono, troco]);
}
async function movimentos() {
  const { rows } = await q(`SELECT id, tipo, valor::numeric AS valor, sessao_id FROM caixa_movimentos WHERE company_id = $1 ORDER BY created_at`, [ID.loja]);
  return rows.map((r) => ({ ...r, valor: Number(r.valor) }));
}
async function contar(sql, params) { return (await q(sql, params)).rows[0].n; }
const status = async (empresa = ID.loja) => {
  await respirar();
  const r = await request(app).get(`/companies/${empresa}/caixa/status`);
  expect(r.status).toBe(200);
  return r.body.sessao_ativa;
};
const fechar = async (empresa = ID.loja, dinheiro_contado = 0) => {
  await respirar();
  const r = await request(app).post(`/companies/${empresa}/caixa/fechar`).send({ dinheiro_contado });
  expect(r.status).toBe(200);
  return r.body.fechamento;
};
// O relogio do Node e o do Postgres: o lancamento gravado agora tem de ficar
// antes do "ate" da janela que o caixa le.
const respirar = () => new Promise((r) => setTimeout(r, 40));

describe('sinal em dinheiro com o caixa ligado e fechado', () => {
  test('POST /pedidos/:oid/sinal: 409 CAIXA_REQUIRED e nada gravado', async () => {
    const oid = await pedidoSemSinal();
    await ligarCaixa();
    const r = await sinal(oid, { amount: 100, method: 'dinheiro' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Abra o caixa antes de receber o sinal em dinheiro.', code: 'CAIXA_REQUIRED' });
    expect(await contar(`SELECT COUNT(*)::int AS n FROM studio_payments WHERE order_id = $1`, [oid])).toBe(0);
    expect(await contar(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, [`pedido-sinal-${oid}`])).toBe(0);
    const { rows: [conta] } = await q(`SELECT amount::numeric AS amount, status FROM transactions WHERE idempotency_key = $1`, [`pedido-areceber-${oid}`]);
    expect({ amount: Number(conta.amount), status: conta.status }).toEqual({ amount: 389.7, status: 'pending' });
    expect(await movimentos()).toEqual([]);
  });

  test('POST /pedidos com sinal em dinheiro: 409 e o pedido nem e guardado', async () => {
    await ligarCaixa();
    const r = await guardar({ items: ITENS_CELIA, sinal: { amount: 100, method: 'dinheiro' } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CAIXA_REQUIRED');
    expect(await contar(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1`, [ID.loja])).toBe(0);
    expect(await contar(`SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = $1`, [ID.loja])).toBe(0);
  });

  test('Pix, credito e debito nao exigem caixa', async () => {
    await ligarCaixa();
    for (const method of ['pix', 'cartao', 'debito']) {
      const oid = await pedidoSemSinal();
      const r = await sinal(oid, { amount: 50, method });
      expect(r.status).toBe(201);
    }
    expect(await movimentos()).toEqual([]);
  });

  test('sem o modulo de caixa, o dinheiro so e registrado (sem movimento), como antes', async () => {
    const oid = await pedidoSemSinal();
    const r = await sinal(oid, { amount: 100, method: 'dinheiro' });
    expect(r.status).toBe(201);
    expect(await movimentos()).toEqual([]);
  });
});

describe('chave do caixa desligada com sessao aberta: a regra da venda (revisao do Fable)', () => {
  test('o sinal em dinheiro entra na sessao aberta; a devolucao em dinheiro sai dela', async () => {
    await abrirCaixa(); // liga, abre a sessao...
    await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": false}'::jsonb WHERE id = $1`, [ID.loja]); // ...e desliga
    const r = await guardar({ items: ITENS_CELIA, customer_id: ID.cliente, sinal: { amount: 100, method: 'dinheiro' } });
    expect(r.status).toBe(201);
    const oid = r.body.order.id;
    expect(await movimentos()).toEqual([expect.objectContaining({ tipo: 'sinal_pedido', valor: 100, sessao_id: ID.sessao })]);

    // A venda faz o mesmo: grava a forma na sessao aberta com a chave desligada.
    const caixaService = require('../src/services/caixaService');
    await respirar();
    const totais = await (async () => {
      const { rows: [s] } = await q(`SELECT opened_at FROM caixa_sessoes WHERE id = $1`, [ID.sessao]);
      return caixaService._calcularTotais(ID.loja, ID.sessao, s.opened_at, null);
    })();
    expect(totais).toMatchObject({ dinheiro: 100, outros: 0 });

    const c = await request(app).post(`/companies/${ID.loja}/pedidos/${oid}/cancelar`)
      .send({ refund_kind: 'devolucao', refund_method: 'dinheiro' });
    expect(c.status).toBe(200);
    expect(c.body.cancelamento.movimento_caixa).toBe(true);
    expect((await movimentos()).map((m) => [m.tipo, m.valor, m.sessao_id]).sort())
      .toEqual([['devolucao_sinal', 100, ID.sessao], ['sinal_pedido', 100, ID.sessao]]);
  });

  test('chave desligada e sem sessao: o sinal em dinheiro so e registrado (sem 409, sem movimento)', async () => {
    await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": false}'::jsonb WHERE id = $1`, [ID.loja]);
    const oid = await pedidoSemSinal();
    expect((await sinal(oid, { amount: 100, method: 'dinheiro' })).status).toBe(201);
    expect(await movimentos()).toEqual([]);
  });
});

describe('cenario da Celia com sinal em dinheiro: caixa aberto, fechamento', () => {
  test('o sinal entra na gaveta, sai de "outras entradas" e o fechamento bate', async () => {
    await abrirCaixa(); // troco 50
    const antes = await status();
    expect(antes.dinheiro_em_caixa).toBe(50);
    expect(antes.totais_ao_vivo.sinais_pedido).toBeUndefined();

    const oid = await pedidoSemSinal();
    const r = await sinal(oid, { amount: 100, method: 'dinheiro' });
    expect(r.status).toBe(201);
    expect(await movimentos()).toEqual([expect.objectContaining({ tipo: 'sinal_pedido', valor: 100, sessao_id: ID.sessao })]);

    const s = await status();
    expect(s.totais_ao_vivo).toMatchObject({ dinheiro: 100, pix: 0, outros: 0, geral: 100 });
    expect(s.totais_ao_vivo.sinais_pedido).toEqual({
      dinheiro: 100, pix: 0, cartao_credito: 0, cartao_debito: 0, total: 100, devolvido_dinheiro: 0, devolvido_pix: 0, devolvido_cartao_credito: 0, devolvido_cartao_debito: 0,
    });
    expect(s.dinheiro_em_caixa).toBe(150);
    expect(s.suprimentos).toBe(0);

    // A sangria enxerga o dinheiro do sinal (150 na gaveta).
    const sangria = await request(app).post(`/companies/${ID.loja}/caixa/movimentos`).send({ tipo: 'sangria', valor: 140 });
    expect(sangria.status).toBe(201);
    expect(sangria.body.dinheiro_em_caixa).toBe(10);

    // O movimento do sinal nao se apaga pela gaveta.
    const [mov] = (await movimentos()).filter((m) => m.tipo === 'sinal_pedido');
    const apagar = await request(app).delete(`/companies/${ID.loja}/caixa/movimentos/${mov.id}`);
    expect(apagar.status).toBe(404);
    expect((await movimentos()).filter((m) => m.tipo === 'sinal_pedido')).toHaveLength(1);

    const f = await fechar(ID.loja, 10);
    expect(Number(f.dinheiro_esperado)).toBe(10);
    expect(Number(f.total_dinheiro)).toBe(100);
    expect(Number(f.total_outros)).toBe(0);
    expect(Number(f.total_geral)).toBe(100);
    expect(Number(f.diferenca)).toBe(0);
    expect(f.total_vendas).toBe(0); // sinal nao e venda
    expect(f.sinais_pedido).toMatchObject({ dinheiro: 100, total: 100 });

    const det = await request(app).get(`/companies/${ID.loja}/caixa/sessao/${ID.sessao}`);
    expect(det.status).toBe(200);
    expect(det.body.sessao.sinais_pedido).toMatchObject({ dinheiro: 100, total: 100 });
    expect(det.body.sessao.movimentos.map((m) => m.tipo).sort()).toEqual(['sangria', 'sinal_pedido']);
  });
});

describe('Pix, credito e debito: na forma deles', () => {
  test('cada forma no seu balde; total_outros sem o sinal; receita manual continua em outros', async () => {
    await abrirCaixa();
    const formas = [['pix', 100], ['cartao', 60], ['debito', 40]];
    for (const [method, amount] of formas) {
      const oid = await pedidoSemSinal();
      expect((await sinal(oid, { amount, method })).status).toBe(201);
    }
    // Receita manual do Financeiro: continua em "outras entradas".
    await q(`INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at)
             VALUES ($1, 'income', 'confirmed', 25, 'Receita manual', 'Outros', CURRENT_DATE, NOW())`, [ID.loja]);

    const s = await status();
    expect(s.totais_ao_vivo).toMatchObject({ pix: 100, cartao_credito: 60, cartao_debito: 40, dinheiro: 0, outros: 25, geral: 225 });
    expect(s.totais_ao_vivo.sinais_pedido).toEqual({
      dinheiro: 0, pix: 100, cartao_credito: 60, cartao_debito: 40, total: 200, devolvido_dinheiro: 0, devolvido_pix: 0, devolvido_cartao_credito: 0, devolvido_cartao_debito: 0,
    });
    expect(s.dinheiro_em_caixa).toBe(50);

    const f = await fechar(ID.loja, 50);
    expect(Number(f.total_pix)).toBe(100);
    expect(Number(f.total_cartao_credito)).toBe(60);
    expect(Number(f.total_cartao_debito)).toBe(40);
    expect(Number(f.total_outros)).toBe(25);
    expect(Number(f.dinheiro_esperado)).toBe(50);
  });

  test('sinal Pix recebido com o caixa fechado nao cai na sessao aberta depois', async () => {
    await ligarCaixa();
    const oid = await pedidoSemSinal();
    expect((await sinal(oid, { amount: 100, method: 'pix' })).status).toBe(201);
    await q(`INSERT INTO caixa_sessoes (id, company_id, opened_by, troco_inicial, status, opened_at)
             VALUES ($1, $2, $3, 0, 'aberta', NOW() + INTERVAL '1 second')`, [ID.sessao, ID.loja, ID.dono]);
    const s = await status();
    expect(s.totais_ao_vivo.pix).toBe(0);
    expect(s.totais_ao_vivo.outros).toBe(0);
    expect(s.totais_ao_vivo.sinais_pedido).toBeUndefined();
  });
});

describe('devolucao do sinal em dinheiro (B6) sai da gaveta', () => {
  test('sinal em dinheiro e devolucao em dinheiro na mesma sessao: gaveta volta ao troco', async () => {
    await abrirCaixa();
    const r = await guardar({ items: ITENS_CELIA, customer_id: ID.cliente, sinal: { amount: 100, method: 'dinheiro' } });
    expect(r.status).toBe(201);
    const oid = r.body.order.id;
    expect((await status()).dinheiro_em_caixa).toBe(150);

    const c = await request(app).post(`/companies/${ID.loja}/pedidos/${oid}/cancelar`)
      .send({ refund_kind: 'devolucao', refund_method: 'dinheiro' });
    expect(c.status).toBe(200);
    expect(c.body.cancelamento.movimento_caixa).toBe(true);

    const s = await status();
    expect(s.dinheiro_em_caixa).toBe(50);
    expect(s.totais_ao_vivo).toMatchObject({ dinheiro: 0, outros: 0, geral: 0 });
    expect(s.totais_ao_vivo.sinais_pedido).toMatchObject({ dinheiro: 100, devolvido_dinheiro: 100, total: 100 });
    const f = await fechar(ID.loja, 50);
    expect(Number(f.dinheiro_esperado)).toBe(50);
    expect(Number(f.diferenca)).toBe(0);
  });
});

describe('loja sem pedido: o caixa responde como sempre', () => {
  test('venda em dinheiro e Pix, suprimento, sangria e receita manual: mesmos numeros, nenhuma chave nova', async () => {
    await abrirCaixa(ID.semPedido, ID.sessaoSemPedido, 100);
    const venda = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount, payment_method, status) VALUES ($1, $2, 30, 'dinheiro', 'completed')`, [venda, ID.semPedido]);
    await q(`INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id) VALUES ($1, $2, 'dinheiro', 20, $3), ($1, $2, 'pix', 10, $3)`,
      [venda, ID.semPedido, ID.sessaoSemPedido]);
    await q(`INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, idempotency_key)
             VALUES ($1, 'income', 'confirmed', 30, 'Venda PDV', 'Vendas', CURRENT_DATE, NOW(), $2),
                    ($1, 'income', 'confirmed', 7, 'Receita manual', 'Outros', CURRENT_DATE, NOW(), NULL)`,
      [ID.semPedido, `pdv-sale-${venda}`]);
    await request(app).post(`/companies/${ID.semPedido}/caixa/movimentos`).send({ tipo: 'suprimento', valor: 15 });
    await request(app).post(`/companies/${ID.semPedido}/caixa/movimentos`).send({ tipo: 'sangria', valor: 5 });

    const s = await status(ID.semPedido);
    expect(Object.keys(s.totais_ao_vivo).sort()).toEqual(
      ['cartao_credito', 'cartao_debito', 'devolucoes', 'dinheiro', 'fiado', 'geral', 'outros', 'pix'].sort());
    expect(s.totais_ao_vivo).toEqual({
      pix: 10, cartao_debito: 0, cartao_credito: 0, dinheiro: 20, fiado: 0, outros: 7, geral: 37, devolucoes: 0,
    });
    expect(s.dinheiro_em_caixa).toBe(r2(100 + 20 + 15 - 5));

    const f = await fechar(ID.semPedido, 130);
    expect(f).not.toHaveProperty('sinais_pedido');
    expect(Number(f.dinheiro_esperado)).toBe(130);
    expect(Number(f.total_geral)).toBe(37);
    const det = await request(app).get(`/companies/${ID.semPedido}/caixa/sessao/${ID.sessaoSemPedido}`);
    expect(det.body.sessao).not.toHaveProperty('sinais_pedido');
  });
});

describe('devolucao do sinal em Pix ou estorno: abate a forma na sessao em que acontece (decisao da Celia, 18/11)', () => {
  const R = require('../src/services/resultadoDoPeriodo');
  const hoje = () => require('../src/services/pedidoBalcao').hojeSP();
  const cancelarDevolvendo = (oid, refund_method) => request(app)
    .post(`/companies/${ID.loja}/pedidos/${oid}/cancelar`).send({ refund_kind: 'devolucao', refund_method });
  async function financeiro() {
    const d = hoje();
    const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: d, ate: d, comProdutos: false, client: pool });
    const painel = await request(app).get(`/companies/${ID.loja}/dashboard`);
    const amanha = new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    const dre = await request(app).get(`/companies/${ID.loja}/dre`).query({ from: d.slice(0, 8) + '01', to: amanha });
    const receitaBruta = (dre.body.detail.find((x) => x.line === 'receita_bruta') || { total: 0 }).total;
    return {
      faturamento: r2(res.faturamento), despesas: r2(res.despesas),
      painel_receita: r2(painel.body.revenue), painel_despesas: r2(painel.body.expenses),
      dre_receita_bruta: r2(receitaBruta),
    };
  }

  test('sinal Pix 100 e devolucao Pix 100 na mesma sessao: Pix 0; Faturamento, Despesas e DRE zerados', async () => {
    await abrirCaixa();
    const oid = await pedidoSemSinal();
    expect((await sinal(oid, { amount: 100, method: 'pix' })).status).toBe(201);
    expect((await status()).totais_ao_vivo.pix).toBe(100);
    expect((await cancelarDevolvendo(oid, 'pix')).status).toBe(200);

    const s = await status();
    expect(s.totais_ao_vivo).toMatchObject({ pix: 0, outros: 0, geral: 0 });
    expect(s.totais_ao_vivo.sinais_pedido).toMatchObject({ pix: 100, devolvido_pix: 100, total: 100 });
    expect(s.dinheiro_em_caixa).toBe(50);
    const f = await financeiro();
    // Resultado (p-81/p-82) e DRE: o sinal e a devolucao se anulam. O Painel
    // de hoje soma receita e despesa sem compensar (100 e 100), regra do B6.
    expect(f).toMatchObject({ faturamento: 0, despesas: 0, dre_receita_bruta: 0 });
    process.stdout.write(`
[devolucao Pix mesma sessao] ${JSON.stringify(f)}
`);
    const fe = await fechar(ID.loja, 50);
    expect(Number(fe.total_pix)).toBe(0);
    expect(Number(fe.diferenca)).toBe(0);
  });

  test('em duas sessoes: +100 no Pix da primeira e -100 no Pix da segunda; a primeira nao muda', async () => {
    await abrirCaixa();
    const oid = await pedidoSemSinal();
    expect((await sinal(oid, { amount: 100, method: 'pix' })).status).toBe(201);
    const f1 = await fechar(ID.loja, 50);
    expect(Number(f1.total_pix)).toBe(100);

    const sessao2 = uuid();
    await q(`INSERT INTO caixa_sessoes (id, company_id, opened_by, troco_inicial, status, opened_at)
             VALUES ($1, $2, $3, 50, 'aberta', NOW())`, [sessao2, ID.loja, ID.dono]);
    await respirar();
    expect((await cancelarDevolvendo(oid, 'pix')).status).toBe(200);
    const s2 = await status();
    expect(s2.totais_ao_vivo).toMatchObject({ pix: -100, geral: -100 });
    expect(s2.totais_ao_vivo.sinais_pedido).toMatchObject({ pix: 0, devolvido_pix: 100, total: 0 });
    const f2 = await fechar(ID.loja, 50);
    expect(Number(f2.total_pix)).toBe(-100);
    expect(Number(f2.dinheiro_esperado)).toBe(50);

    const d1 = await request(app).get(`/companies/${ID.loja}/caixa/sessao/${ID.sessao}`);
    expect(Number(d1.body.sessao.total_pix)).toBe(100);
    expect(d1.body.sessao.sinais_pedido).toMatchObject({ pix: 100, devolvido_pix: 0 });
  });

  test('estorno no cartao: abate o cartao do sinal (debito no debito, credito no credito)', async () => {
    await abrirCaixa();
    const deb = await pedidoSemSinal();
    const cre = await pedidoSemSinal();
    expect((await sinal(deb, { amount: 60, method: 'debito' })).status).toBe(201);
    expect((await sinal(cre, { amount: 40, method: 'cartao' })).status).toBe(201);
    expect((await cancelarDevolvendo(deb, 'estorno')).status).toBe(200);
    expect((await cancelarDevolvendo(cre, 'estorno')).status).toBe(200);
    const s = await status();
    expect(s.totais_ao_vivo).toMatchObject({ cartao_debito: 0, cartao_credito: 0, geral: 0 });
    expect(s.totais_ao_vivo.sinais_pedido).toMatchObject({ devolvido_cartao_debito: 60, devolvido_cartao_credito: 40 });
  });
});
