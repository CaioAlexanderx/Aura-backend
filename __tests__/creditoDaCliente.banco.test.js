// ============================================================
// AURA. — INC-2026-11-17-03: o crédito da troca abatido no Caixa (Postgres real)
//
// Relato: "Quando o mesmo cliente vai fazer outra compra, o lojista não está
// conseguindo visualizar esse crédito [que ficou de uma troca] para abater no
// caixa."
//
// O caminho do relato, pelas rotas de verdade:
//   1. venda de um casaco de R$ 50 no Pix, com a cliente;
//   2. troca: o casaco volta e o valor fica como "Crédito para" a cliente
//      (refund_splits crediario_credito) -> ficha da cliente em −50;
//   3. a cliente volta e leva um vestido de R$ 200.
//
// Antes da correção, no passo 3 só existia a forma crediário, e ela não lia o
// saldo: o "A Receber" e as parcelas nasciam pelos R$ 200 cheios (o teste
// "antes" abaixo documenta). Agora o Caixa abate com a forma credito_cliente:
//   venda de 200 = 50 de crédito + 150 no Pix
//   -> Faturamento +200, Receita do Painel +150, ficha −50 -> 0, caixa Pix +150.
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
  dono: uuid(), loja: uuid(), filial: uuid(),
  casaco: uuid(), vestido: uuid(), cliente: uuid(), outra: uuid(),
};
const EMPRESAS = [ID.loja, ID.filial];
const R = require('../src/services/resultadoDoPeriodo');

let pool;
let app;
let hoje;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const q = (sql, params) => pool.query(sql, params);

async function apagarTudo() {
  for (const sql of [
    `DELETE FROM troca_payouts WHERE company_id = ANY($1)`,
    `DELETE FROM troca_returned_items WHERE troca_sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`,
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
    `DELETE FROM caixa_fechamentos WHERE company_id = ANY($1)`,
    `DELETE FROM caixa_sessoes WHERE company_id = ANY($1)`,
    `DELETE FROM troca_idempotency WHERE company_id = ANY($1)`,
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
  // Mesmas colunas de producao que o pdv.vendaRapida.banco cria.
  await q(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN DEFAULT false,
                             ADD COLUMN IF NOT EXISTS total_installments INTEGER,
                             ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`);
  hoje = (await q(`SELECT ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::text AS d`)).rows[0].d;

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Credito')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja Credito')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial Credito', $3)`,
    [ID.filial, ID.dono, ID.loja]);
  await q(`INSERT INTO products (id, company_id, name, price, cost_price, stock_qty) VALUES
             ($1, $3, 'Casaco', 50, 20, 10), ($2, $3, 'Vestido', 200, 80, 10)`, [ID.casaco, ID.vestido, ID.loja]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES
             ($1, $3, 'Cliente Fixture Credito', '11900000088'), ($2, $3, 'Outra Cliente', '11900000089')`,
    [ID.cliente, ID.outra, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
  app.use('/companies/:id/caixa', require('../src/routes/caixa'));
  app.use('/companies/:id/dashboard', require('../src/routes/dashboard'));
  app.use('/companies/:id/sales', require('../src/routes/sales'));
  app.use('/companies/:id/credit', require('../src/routes/credit'));
  app.use('/companies/:id/print', require('../src/routes/print'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

beforeEach(async () => {
  require('../src/services/caixaService')._resetCache();
  await apagarTudo();
  await q(`UPDATE products SET stock_qty = 10 WHERE company_id = $1`, [ID.loja]);
  await q(`UPDATE companies SET pdv_settings = '{"caixa_enabled": true}'::jsonb WHERE id = $1`, [ID.loja]);
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  await limpar();
  await pool.end();
});

const respirar = () => new Promise((r) => setTimeout(r, 40));
const vender = (body, loja = ID.loja) => request(app).post(`/companies/${loja}/pdv/sale`).send(body);
const VESTIDO = [{ product_id: ID.vestido, quantity: 1, unit_price: 200 }];

async function abrirCaixa(troco = 50) {
  const r = await request(app).post(`/companies/${ID.loja}/caixa/abrir`).send({ troco_inicial: troco });
  expect(r.status).toBe(201);
}
async function caixa() {
  await respirar();
  const r = await request(app).get(`/companies/${ID.loja}/caixa/status`);
  expect(r.status).toBe(200);
  return r.body.sessao_ativa;
}
async function ficha(customerId = ID.cliente, loja = ID.loja) {
  const { rows } = await q(`SELECT balance FROM customer_credit_balances WHERE customer_id = $1 AND company_id = $2`, [customerId, loja]);
  return r2(rows[0] ? rows[0].balance : 0);
}
async function numeros() {
  const res = await R.resultadoDoPeriodo({ empresas: [ID.loja], de: hoje, ate: hoje, comProdutos: false, client: pool });
  const painel = await request(app).get(`/companies/${ID.loja}/dashboard`);
  expect(painel.status).toBe(200);
  const cx = await caixa();
  return {
    faturamento: r2(res.faturamento),
    receita_painel: r2(painel.body.revenue),
    a_receber_painel: r2(painel.body.pendingIncome),
    ficha: await ficha(),
    caixa_pix: r2(cx.totais_ao_vivo.pix),
    caixa_fiado: r2(cx.totais_ao_vivo.fiado),
  };
}
const delta = (depois, antes) => Object.fromEntries(Object.keys(depois).map((k) => [k, r2(depois[k] - antes[k])]));

/** Passos 1 e 2 do relato: venda do casaco e troca com "Crédito para". */
async function trocaComCredito() {
  const venda = await vender({ items: [{ product_id: ID.casaco, quantity: 1, unit_price: 50 }], payment_method: 'pix', customer_id: ID.cliente });
  expect(venda.status).toBe(201);
  const [item] = (await q(`SELECT id FROM sale_items WHERE sale_id = $1`, [venda.body.sale.id])).rows;
  const troca = await request(app).post(`/companies/${ID.loja}/pdv/troca`).send({
    original_sale_ids: [venda.body.sale.id],
    returned_items: [{ original_sale_id: venda.body.sale.id, original_sale_item_id: item.id, product_id: ID.casaco, quantity: 1, unit_price: 50 }],
    new_items: [],
    refund_splits: [{ method: 'crediario_credito', amount: 50 }],
    customer_id: ID.cliente,
    nfce_strategy: 'none',
  });
  expect(troca.status).toBe(201);
  return { vendaOriginal: venda.body.sale.id, troca: troca.body.sale.id };
}

const TABELA = [];

describe('o caminho do relato', () => {
  test('a troca grava o crédito na ficha da cliente (razão), nesta loja', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const { rows } = await q(
      `SELECT type, payment_method, amount::text FROM customer_credit_transactions WHERE customer_id = $1`, [ID.cliente]);
    expect(rows).toEqual([{ type: 'payment', payment_method: 'crediario_credito', amount: '50.00' }]);
    expect(await ficha()).toBe(-50);
    // O Caixa le o saldo a favor pela rota nova (vale sem o plano Negocio).
    const r = await request(app).get(`/companies/${ID.loja}/pdv/clientes/${ID.cliente}/credito`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ customer_id: ID.cliente, saldo_a_favor: 50 });
    // Na filial do mesmo dono o credito nao existe: e da cliente NA loja.
    const f = await request(app).get(`/companies/${ID.filial}/pdv/clientes/${ID.cliente}/credito`);
    expect(f.body.saldo_a_favor).toBe(0);
  });

  test('antes da correção: o único jeito era o crediário, que ignora o saldo (A Receber de 200 com a ficha em 150)', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const antes = await numeros();
    const r = await vender({ items: VESTIDO, payment_method: 'crediario', customer_id: ID.cliente });
    expect(r.status).toBe(201);
    const depois = await numeros();
    const { rows: [ar] } = await q(
      `SELECT amount::numeric AS amount FROM transactions WHERE idempotency_key = $1`, [`pdv-credit-receivable-${r.body.sale.id}`]);
    // A ficha abate (−50 + 200 = 150), mas o Financeiro cobra os 200 cheios.
    expect(depois.ficha).toBe(150);
    expect(r2(ar.amount)).toBe(200);
    expect(delta(depois, antes)).toMatchObject({ faturamento: 200, receita_painel: 0, a_receber_painel: 200 });
  });

  test('venda de 200 com 50 de crédito e 150 no Pix: Faturamento 200, Receita 150, ficha −50 -> 0, caixa Pix 150', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const antes = await numeros();
    const r = await vender({
      items: VESTIDO, payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.credito_cliente).toEqual({ usado: 50, saldo_antes: 50, saldo_depois: 0 });
    expect(r.body.credit).toBeNull();
    const depois = await numeros();
    const d = delta(depois, antes);
    TABELA.push({ momento: 'antes da venda', ...antes }, { momento: 'depois da venda', ...depois }, { momento: 'diferença', ...d });
    expect(d).toEqual({ faturamento: 200, receita_painel: 150, a_receber_painel: 0, ficha: 50, caixa_pix: 150, caixa_fiado: 0 });
    expect(antes.ficha).toBe(-50);
    expect(depois.ficha).toBe(0);

    const saleId = r.body.sale.id;
    const { rows: [venda] } = await q(`SELECT total_amount::text, payment_method FROM sales WHERE id = $1`, [saleId]);
    expect(venda).toEqual({ total_amount: '200.00', payment_method: 'pix' });
    const { rows: formas } = await q(`SELECT method, amount::text FROM sale_payments WHERE sale_id = $1`, [saleId]);
    expect(formas).toEqual([{ method: 'pix', amount: '150.00' }]);
    const { rows: tx } = await q(`SELECT idempotency_key, amount::text, status FROM transactions WHERE idempotency_key LIKE $1`, [`%${saleId}%`]);
    expect(tx).toEqual([{ idempotency_key: `pdv-sale-${saleId}`, amount: '150.00', status: 'confirmed' }]);
    const { rows: baixa } = await q(
      `SELECT type, payment_method, amount::text, notes FROM customer_credit_transactions WHERE sale_id = $1`, [saleId]);
    expect(baixa).toEqual([{ type: 'debit', payment_method: 'credito_cliente', amount: '50.00', notes: `Crédito usado na venda #${r.body.sale.sale_number}` }]);
    // Nada de parcela nem carne: nao e crediario.
    expect((await q(`SELECT COUNT(*)::int AS n FROM credit_installments WHERE sale_id = $1`, [saleId])).rows[0].n).toBe(0);
    expect((await q(`SELECT COUNT(*)::int AS n FROM credit_accounts WHERE company_id = $1`, [ID.loja])).rows[0].n).toBe(0);
  });

  test('o detalhe da venda, o cupom e a ficha mostram o crédito usado', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const r = await vender({
      items: VESTIDO, payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }],
    });
    const saleId = r.body.sale.id;

    const det = await request(app).get(`/companies/${ID.loja}/sales/${saleId}`);
    expect(det.status).toBe(200);
    expect(det.body.payments).toEqual([
      expect.objectContaining({ method: 'pix', amount: 150 }),
      { method: 'credito_cliente', amount: 50 },
    ]);

    const cupom = await request(app).get(`/companies/${ID.loja}/print/receipt/${saleId}`);
    expect(cupom.status).toBe(200);
    expect(cupom.text).toContain('<td>Pix</td><td style="text-align:right">R$150.00</td>');
    expect(cupom.text).toContain('<td>Credito da cliente</td><td style="text-align:right">R$50.00</td>');

    // A linha do tempo da ficha (Crediario) so abre com o crediario ligado.
    await q(`UPDATE companies SET pdv_settings = pdv_settings || '{"crediario_enabled": true}'::jsonb WHERE id = $1`, [ID.loja]);
    const hist = await request(app).get(`/companies/${ID.loja}/credit/customers/${ID.cliente}/history`);
    expect(hist.status).toBe(200);
    const tipos = hist.body.events.map((e) => [e.type, e.amount]);
    expect(tipos).toEqual(expect.arrayContaining([['exchange_credit', -50], ['credit_use', 50]]));
    expect(tipos.find(([t]) => t === 'purchase')).toBeUndefined();
  });

  test('venda inteira no crédito: nenhuma forma no caixa, nenhuma receita, ficha zerada', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const antes = await numeros();
    const r = await vender({ items: [{ product_id: ID.casaco, quantity: 1, unit_price: 50 }], payment_method: 'credito_cliente', customer_id: ID.cliente });
    expect(r.status).toBe(201);
    const d = delta(await numeros(), antes);
    expect(d).toEqual({ faturamento: 50, receita_painel: 0, a_receber_painel: 0, ficha: 50, caixa_pix: 0, caixa_fiado: 0 });
    expect((await q(`SELECT COUNT(*)::int AS n FROM sale_payments WHERE sale_id = $1`, [r.body.sale.id])).rows[0].n).toBe(0);
    const cupom = await request(app).get(`/companies/${ID.loja}/print/receipt/${r.body.sale.id}`);
    expect(cupom.text).toContain('<td>Credito da cliente</td><td style="text-align:right">R$50.00</td>');
  });

  test('cancelar a venda devolve o crédito para a ficha e tira a receita', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const r = await vender({
      items: VESTIDO, payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }],
    });
    expect(await ficha()).toBe(0);
    const del = await request(app).delete(`/companies/${ID.loja}/pdv/sale/${r.body.sale.id}`);
    expect(del.status).toBe(200);
    expect(await ficha()).toBe(-50);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, [`pdv-sale-${r.body.sale.id}`]);
    expect(rows[0].n).toBe(0);
  });

  test('editar a forma ou o cliente da venda que usou crédito: 409, nada muda', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const r = await vender({
      items: VESTIDO, payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }],
    });
    const ed = await request(app).patch(`/companies/${ID.loja}/sales/${r.body.sale.id}`)
      .send({ payments: [{ method: 'dinheiro', amount: 200 }] });
    expect(ed.status).toBe(409);
    expect(ed.body.code).toBe('CUSTOMER_CREDIT_SALE');
    expect(await ficha()).toBe(0);
  });

  test('crediário junto: 50 de crédito + 150 no crediário (o A Receber é só dos 150)', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const r = await vender({
      items: VESTIDO, payment_method: 'crediario', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'crediario', value: 150 }],
    });
    expect(r.status).toBe(201);
    const { rows: [ar] } = await q(`SELECT amount::numeric AS amount FROM transactions WHERE idempotency_key = $1`, [`pdv-credit-receivable-${r.body.sale.id}`]);
    expect(r2(ar.amount)).toBe(150);
    expect(await ficha()).toBe(150);
    const cx = await caixa();
    expect(r2(cx.totais_ao_vivo.fiado)).toBe(150);
  });
});

describe('recusas: nada gravado', () => {
  async function semVenda(body, code, status = 422) {
    const vendasAntes = (await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n;
    const r = await vender(body);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    const vendasDepois = (await q(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [ID.loja])).rows[0].n;
    expect(vendasDepois).toBe(vendasAntes);
    return r;
  }

  test('mais crédito do que a cliente tem', async () => {
    await abrirCaixa();
    await trocaComCredito();
    const r = await semVenda({ items: VESTIDO, payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 60 }, { method: 'pix', value: 140 }] }, 'CREDITO_INSUFICIENTE');
    expect(r.body.saldo_a_favor).toBe(50);
    expect(await ficha()).toBe(-50);
  });

  test('pagamentos que cobram o crédito de novo', async () => {
    await abrirCaixa();
    await trocaComCredito();
    await semVenda({ items: VESTIDO, payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 200 }] }, 'CREDITO_PAGAMENTOS_NAO_BATEM');
  });

  test('sem cliente', async () => {
    await abrirCaixa();
    await semVenda({ items: VESTIDO, payment_method: 'pix',
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }] }, 'CREDITO_EXIGE_CLIENTE');
  });

  test('crédito maior que a venda', async () => {
    await abrirCaixa();
    await trocaComCredito();
    await semVenda({ items: [{ product_id: ID.casaco, quantity: 0.5, unit_price: 50 }], payment_method: 'pix', customer_id: ID.cliente,
      payments: [{ method: 'credito_cliente', value: 50 }] }, 'CREDITO_MAIOR_QUE_VENDA');
  });

  test('outra cliente (sem crédito) e a filial (o crédito é da loja)', async () => {
    await abrirCaixa();
    await trocaComCredito();
    await semVenda({ items: VESTIDO, payment_method: 'pix', customer_id: ID.outra,
      payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }] }, 'CREDITO_INSUFICIENTE');
    const f = await vender({ items: [{ quantity: 1, unit_price: 50, product_name_snapshot: 'Avulso' }], payment_method: 'credito_cliente', customer_id: ID.cliente }, ID.filial);
    expect(f.status).toBe(422);
    expect(f.body.code).toBe('CREDITO_INSUFICIENTE');
    expect(await ficha()).toBe(-50);
  });

  test('duas vendas ao mesmo tempo com o mesmo crédito: uma entra, a outra recebe 422', async () => {
    for (let rodada = 0; rodada < 3; rodada++) {
      await apagarTudo();
      await abrirCaixa();
      await trocaComCredito();
      const body = { items: [{ product_id: ID.casaco, quantity: 1, unit_price: 50 }], payment_method: 'credito_cliente', customer_id: ID.cliente };
      const [a, b] = await Promise.all([vender(body), vender(body)]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect(await ficha()).toBe(0);
      await respirar();
    }
  });
});

afterAll(() => {
  if (!TABELA.length) return;
  const cab = 'momento | Faturamento | Receita do Painel | A receber | ficha | caixa Pix | caixa fiado';
  const linhas = TABELA.map((t) => [t.momento, t.faturamento, t.receita_painel, t.a_receber_painel, t.ficha, t.caixa_pix, t.caixa_fiado].join(' | '));
  process.stdout.write(`\n[INC-2026-11-17-03: venda de 200 = 50 de credito + 150 no Pix]\n${cab}\n${linhas.join('\n')}\n`);
});
