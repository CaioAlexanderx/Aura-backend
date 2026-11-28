// ============================================================
// AURA. — Pedido guardado no Caixa (B1 / p-61a) — Postgres real
// POST /companies/:id/pedidos (routes/pedidosDoBalcao.js,
// services/pedidoBalcao.js), migration 459.
//
// Regras do Caio (17/11) provadas aqui, no banco de verdade:
//   1. pedido nao e venda: guardar NAO baixa estoque (produto, variante,
//      insumo do Studio), NAO cria venda nem movimento de caixa e, no
//      Financeiro, so lanca a conta "Pedido a receber" PENDENTE (B4a; o
//      sinal e o resto do dinheiro estao em sinalDoPedido.banco.test.js).
//      Nasce 'confirmed', stock_deducted FALSE;
//   2. preco congelado, desconto por item e do pedido, cliente opcional;
//   3. Idempotency-Key: repetir nao duplica (nem em paralelo); a mesma chave
//      com outros itens e 409;
//   4. a loja so usa produto que ve (regra unica do grupo) e cliente do
//      mesmo dono;
//   5. a trava PEDIDO_LIBERADO: desligada, so a equipe Aura;
//   6. o insumo do Studio continua descontado no pedido da loja online
//      (o trigger mudou so para a origem 'balcao').
//
// A paridade da fila do Canal Digital mora em
// canalSemPedidoDoBalcao.paridade.banco.test.js (precisa de status TEXT,
// como em producao, e por isso roda numa transacao revertida).
//
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/nfceEmissionService', () => ({
  emitForDigitalOrder: jest.fn(async () => ({ skipped: true, reason: 'teste' })),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = {
  dono: uuid(), outroDono: uuid(),
  loja: uuid(), filial: uuid(), deFora: uuid(),
  camiseta: uuid(), caneca: uuid(), daFilial: uuid(), daOutra: uuid(),
  varP: uuid(), varDeOutro: uuid(),
  cliente: uuid(), clienteDeFora: uuid(),
  insumo: uuid(), composicao: uuid(),
};
const EMPRESAS = [ID.loja, ID.filial, ID.deFora];

let pool;
let app;
let usuario;
let seq = 0;

const q = (sql, params) => pool.query(sql, params);
const base = `/companies/${ID.loja}`;

async function limpar() {
  const passos = [
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_composition_items WHERE composition_id = $1`, [ID.composicao]],
    [`DELETE FROM studio_compositions WHERE id = $1`, [ID.composicao]],
    [`DELETE FROM studio_inputs WHERE id = $1`, [ID.insumo]],
    [`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_channel_config WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono, ID.outroDono]]],
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

  // Banco recriado do zero (CI): a 070 cria digital_order_sequences sem
  // updated_at e a 273 (next_digital_order_number) grava essa coluna, que
  // existe em producao. Mesmo ajuste de studio.converterOrcamento.banco.
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Pedido'), ($3, $4, 'x', 'Outro Dono')`,
    [ID.dono, `fixture-${ID.dono}@example.test`, ID.outroDono, `fixture-${ID.outroDono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Loja')`, [ID.loja, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial', $3)`,
    [ID.filial, ID.dono, ID.loja]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture De Fora')`, [ID.deFora, ID.outroDono]);

  const produto = (id, empresa, nome, preco, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, $4, $5)`, [id, empresa, nome, preco, estoque]);
  await produto(ID.camiseta, ID.loja, 'Camiseta basica', 59.9, 100);
  await produto(ID.caneca, ID.loja, 'Caneca personalizada', 35, 10);
  await produto(ID.daFilial, ID.filial, 'Bone da filial', 20, 3);
  await produto(ID.daOutra, ID.deFora, 'Produto de outro dono', 9, 9);
  await q(`UPDATE products SET is_group_shared = true WHERE id = $1`, [ID.daFilial]);
  await q(`UPDATE products SET is_personalizable = true WHERE id = $1`, [ID.caneca]);
  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty) VALUES ($1, $2, 'P', 2), ($3, $4, 'X', 1)`,
    [ID.varP, ID.camiseta, ID.varDeOutro, ID.caneca]);

  await q(`INSERT INTO studio_inputs (id, company_id, name, stock_qty) VALUES ($1, $2, 'Caneca branca', 50)`, [ID.insumo, ID.loja]);
  await q(`INSERT INTO studio_compositions (id, company_id, product_id, is_active) VALUES ($1, $2, $3, true)`,
    [ID.composicao, ID.loja, ID.caneca]);
  await q(`INSERT INTO studio_composition_items (composition_id, input_id, qty_per_unit) VALUES ($1, $2, 2)`,
    [ID.composicao, ID.insumo]);

  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'Cliente Fixture', '11900000001')`, [ID.cliente, ID.loja]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente De Outro Dono')`, [ID.clienteDeFora, ID.deFora]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
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

function chave() { seq += 1; return `teste-pedido-${seq}-${uuid()}`; }

function guardar(body, k = chave()) {
  return request(app).post(`${base}/pedidos`).set('Idempotency-Key', k).send(body);
}

async function estoque() {
  const { rows } = await q(
    `SELECT (SELECT stock_qty FROM products WHERE id = $1)::numeric AS camiseta,
            (SELECT stock_qty FROM product_variants WHERE id = $2)::numeric AS var_p,
            (SELECT stock_qty FROM products WHERE id = $3)::numeric AS caneca,
            (SELECT stock_qty FROM studio_inputs WHERE id = $4)::numeric AS insumo,
            (SELECT stock_qty FROM products WHERE id = $5)::numeric AS da_filial`,
    [ID.camiseta, ID.varP, ID.caneca, ID.insumo, ID.daFilial]);
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}

async function contarEfeitos() {
  const { rows } = await q(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE company_id = ANY($1) AND status <> 'pending')::int AS transacoes,
            (SELECT COUNT(*) FROM transactions WHERE company_id = ANY($1) AND status = 'pending')::int AS a_receber,
            (SELECT COUNT(*) FROM sales WHERE company_id = ANY($1))::int AS vendas,
            (SELECT COUNT(*) FROM stock_movements WHERE company_id = ANY($1))::int AS movimentos`,
    [EMPRESAS]);
  return rows[0];
}

describe('guardar o pedido', () => {
  test('nasce confirmado, sem baixa, so a conta a receber pendente, com preco congelado', async () => {
    const antes = await estoque();
    const efeitosAntes = await contarEfeitos();
    const r = await guardar({
      items: [
        { product_id: ID.camiseta, variant_id: ID.varP, quantity: 2, unit_price: 59.9, item_discount: 9.8 },
        { product_id: ID.caneca, quantity: 1, unit_price: 35 },
        { product_name: 'Ajuste de barra', quantity: 1, unit_price: 15 },
      ],
      discount: 10,
      customer_id: ID.cliente,
      promised_date: '2099-12-20',
      notes: 'Vem buscar depois do almoço',
    });
    expect(r.status).toBe(201);
    const o = r.body.order;
    expect(o).toMatchObject({
      origem: 'balcao', status: 'confirmed', payment_status: 'pending',
      customer_id: ID.cliente, customer_name: 'Cliente Fixture', customer_phone: '11900000001',
      subtotal: 160, discount_amount: 10, total: 150, promised_date: '2099-12-20',
      notes: 'Vem buscar depois do almoço', created_by: ID.dono,
    });
    expect(o.items).toHaveLength(3);
    const camiseta = o.items.find((i) => i.product_id === ID.camiseta);
    expect(camiseta).toMatchObject({ variant_id: ID.varP, variant_label: 'P', quantity: 2, unit_price: 59.9, item_discount: 9.8, subtotal: 110, product_name: 'Camiseta basica' });
    expect(o.items.find((i) => !i.product_id)).toMatchObject({ product_name: 'Ajuste de barra', subtotal: 15 });

    const { rows: [linha] } = await q(
      `SELECT stock_deducted, transaction_id, sale_id, vertical, payment_method, delivery_type::text AS delivery_type, confirmed_at
         FROM digital_orders WHERE id = $1`, [o.id]);
    expect(linha).toMatchObject({ stock_deducted: false, sale_id: null, vertical: null, payment_method: 'balcao', delivery_type: 'pickup' });
    expect(linha.confirmed_at).not.toBeNull();

    // Nada baixou: produto, variante, nem o insumo da caneca (trigger 459).
    expect(await estoque()).toEqual(antes);
    // B4a: so a conta a receber, pendente, pelo valor cheio, ligada ao pedido.
    expect(await contarEfeitos()).toEqual({ ...efeitosAntes, a_receber: efeitosAntes.a_receber + 1 });
    const { rows: [conta] } = await q(
      `SELECT id, type::text AS type, status::text AS status, amount::numeric AS amount, category, due_date::text AS due_date
         FROM transactions WHERE idempotency_key = $1`, [`pedido-areceber-${o.id}`]);
    expect(conta).toMatchObject({ type: 'income', status: 'pending', category: 'Pedido a receber', due_date: '2099-12-20' });
    expect(Number(conta.amount)).toBe(150);
    expect(linha.transaction_id).toBe(conta.id);
  });

  test('sem cliente: so o nome, ou "Cliente"', async () => {
    const comNome = await guardar({ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }], customer_name: '  Maria   da Silva ', customer_phone: '+55 11 98888-7777' });
    expect(comNome.status).toBe(201);
    expect(comNome.body.order).toMatchObject({ customer_id: null, customer_name: 'Maria da Silva', customer_phone: '11988887777' });
    const semNada = await guardar({ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }] });
    expect(semNada.status).toBe(201);
    expect(semNada.body.order).toMatchObject({ customer_id: null, customer_name: 'Cliente', customer_phone: null, promised_date: null });
  });

  test('produto compartilhado da filial vale (regra do grupo); de outro dono, 404 e nada gravado', async () => {
    const ok = await guardar({ items: [{ product_id: ID.daFilial, quantity: 1, unit_price: 20 }] });
    expect(ok.status).toBe(201);
    const { rows: [{ n: antes }] } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1`, [ID.loja]);
    const r = await guardar({ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }, { product_id: ID.daOutra, quantity: 1, unit_price: 9 }] });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('PRODUCT_NOT_FOUND');
    const { rows: [{ n: depois }] } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1`, [ID.loja]);
    expect(depois).toBe(antes);
  });

  test('variante de outro produto: 422; cliente de outro dono: 404', async () => {
    const v = await guardar({ items: [{ product_id: ID.camiseta, variant_id: ID.varDeOutro, quantity: 1, unit_price: 59.9 }] });
    expect(v.status).toBe(422);
    const c = await guardar({ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }], customer_id: ID.clienteDeFora });
    expect(c.status).toBe(404);
    expect(c.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  test.each([
    [{ items: [] }, 'PEDIDO_SEM_ITENS'],
    [{ items: [{ product_id: ID.camiseta, quantity: 1.5, unit_price: 10 }] }, 'PEDIDO_QUANTIDADE'],
    [{ items: [{ product_id: ID.camiseta, quantity: 0, unit_price: 10 }] }, 'PEDIDO_QUANTIDADE'],
    [{ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: -1 }] }, 'PEDIDO_PRECO'],
    [{ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 10 }], discount: 11 }, 'PEDIDO_DESCONTO'],
    [{ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 10 }], promised_date: '2020-01-01' }, 'PEDIDO_DATA'],
    [{ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 10 }], promised_date: '2099-02-30' }, 'PEDIDO_DATA'],
    [{ items: [{ product_id: 'abc', quantity: 1, unit_price: 10 }] }, 'PEDIDO_ITEM_INVALIDO'],
    [{ items: [{ quantity: 1, unit_price: 10 }] }, 'PEDIDO_ITEM_INVALIDO'],
  ])('corpo invalido %#: 422 %s', async (body, code) => {
    const r = await guardar(body);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe(code);
  });
});

describe('Idempotency-Key', () => {
  const corpo = { items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }], customer_name: 'Repetida' };

  test('a mesma chave devolve o mesmo pedido (200), sem criar outro', async () => {
    const k = chave();
    const a = await guardar(corpo, k);
    const b = await guardar(corpo, k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.order.id).toBe(a.body.order.id);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1 AND idempotency_key = $2`, [ID.loja, k]);
    expect(rows[0].n).toBe(1);
  });

  test('dois toques ao mesmo tempo gravam um pedido so', async () => {
    const k = chave();
    const [a, b] = await Promise.all([guardar(corpo, k), guardar(corpo, k)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.order.id).toBe(b.body.order.id);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE idempotency_key = $1`, [k]);
    expect(rows[0].n).toBe(1);
  });

  test('a mesma chave com outros itens: 409', async () => {
    const k = chave();
    expect((await guardar(corpo, k)).status).toBe(201);
    const r = await guardar({ ...corpo, items: [{ product_id: ID.camiseta, quantity: 2, unit_price: 59.9 }] }, k);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('trava PEDIDO_LIBERADO', () => {
  test('desligada: lojista recebe 404 e nada e gravado', async () => {
    usuario = { id: ID.dono, role: 'client' };
    const k = chave();
    const r = await guardar({ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }] }, k);
    expect(r.status).toBe(404);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE idempotency_key = $1`, [k]);
    expect(rows[0].n).toBe(0);
  });

  test('ligada no ambiente: lojista guarda', async () => {
    usuario = { id: ID.dono, role: 'client' };
    process.env.PEDIDO_LIBERADO = 'true';
    const r = await guardar({ items: [{ product_id: ID.camiseta, quantity: 1, unit_price: 59.9 }] });
    expect(r.status).toBe(201);
  });
});

describe('insumo do Studio no pedido da loja online (trigger 459)', () => {
  test('o pedido da loja continua descontando o insumo; o do balcao nao', async () => {
    const antes = (await estoque()).insumo;
    await guardar({ items: [{ product_id: ID.caneca, quantity: 2, unit_price: 35 }] });
    expect((await estoque()).insumo).toBe(antes);

    const id = uuid();
    await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, vertical)
             VALUES ($1, $2, 'ST-0001', 'Cliente Loja', '', 70, 70, 'confirmed', 'studio')`, [id, ID.loja]);
    await q(`INSERT INTO digital_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal)
             VALUES ($1, $2, 'Caneca personalizada', 35, 2, 70)`, [id, ID.caneca]);
    expect((await estoque()).insumo).toBe(antes - 4);
  });
});


describe('pecas com clientes no pedido (C17, R3)', () => {
  // Produto e variante proprios (estoque 2): nenhum outro teste reserva deles.
  let condId;
  let prod;
  let vari;
  beforeEach(async () => {
    condId = uuid(); prod = uuid(); vari = uuid();
    await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Saia Iris', 80, 2)`, [prod, ID.loja]);
    await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty) VALUES ($1, $2, 'M', 2)`, [vari, prod]);
    await q(`INSERT INTO condicionais (id, company_id, numero, customer_name, customer_phone, due_date, status)
             VALUES ($1, $2, 990001, 'Cliente', '11988887777', CURRENT_DATE + 3, 'aberta')`, [condId, ID.loja]);
    await q(`INSERT INTO condicional_itens (condicional_id, product_id, variant_id, product_name, unit_price, situacao)
             VALUES ($1, $2, $3, 'Peca', 10, 'com_cliente')`, [condId, prod, vari]);
  });
  afterEach(async () => {
    await q(`DELETE FROM digital_order_items WHERE product_id = $1`, [prod]);
    await q(`DELETE FROM condicional_itens WHERE condicional_id = $1`, [condId]);
    await q(`DELETE FROM condicionais WHERE id = $1`, [condId]);
    await q(`DELETE FROM product_variants WHERE id = $1`, [vari]);
    await q(`DELETE FROM products WHERE id = $1`, [prod]);
  });

  const pedir = (quantity) => ({ items: [{ product_id: prod, variant_id: vari, quantity, unit_price: 80 }] });

  test('com a trava: 2 no estoque, 1 com cliente -> 2 pecas dao 409 com a causa; 1 passa', async () => {
    const r = await guardar(pedir(2));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PEDIDO_SEM_SALDO');
    expect(r.body.error).toContain('só 1 livre (1 com clientes)');
    expect((await guardar(pedir(1))).status).toBe(201);
  });

  test('sem a trava: resposta de hoje (a peca com cliente nao pesa)', async () => {
    process.env.PEDIDO_LIBERADO = 'true';
    usuario = { id: ID.dono, role: 'client' };
    expect((await guardar(pedir(2))).status).toBe(201);
  });
});

describe('trava por peca: duas clientes no ultimo tamanho', () => {
  test('dois pedidos ao mesmo tempo para a ultima peca: um separa, o outro recebe 409 PEDIDO_SEM_SALDO', async () => {
    const ultima = uuid();
    await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty) VALUES ($1, $2, 'ULTIMO-M', 1)`, [ultima, ID.camiseta]);
    const corpo = { items: [{ product_id: ID.camiseta, variant_id: ultima, quantity: 1, unit_price: 59.9 }] };
    const [a, b] = await Promise.all([guardar(corpo), guardar(corpo)]);
    const status = [a.status, b.status].sort();
    expect(status).toEqual([201, 409]);
    const recusado = a.status === 409 ? a : b;
    expect(recusado.body.code).toBe('PEDIDO_SEM_SALDO');
    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM digital_order_items i JOIN digital_orders o ON o.id = i.order_id
        WHERE i.variant_id = $1 AND o.origem = 'balcao'`, [ultima]);
    expect(rows[0].n).toBe(1);
    const { rows: [est] } = await q(`SELECT stock_qty::numeric AS s FROM product_variants WHERE id = $1`, [ultima]);
    expect(Number(est.s)).toBe(1); // reservar nunca baixa o estoque
  });
});

describe('reserva do WhatsApp: o que conta como pedido pago (estado real do banco)', () => {
  const { acharPedidoDaChave } = require('../src/services/hubProdutoGrade');
  const itens = (variante) => [{ product_id: ID.camiseta, variant_id: variante, quantity: 1 }];
  const novaVariante = async () => {
    const v = uuid();
    await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty) VALUES ($1, $2, 'WA', 5)`, [v, ID.camiseta]);
    return v;
  };

  test('pedido sem sinal segue reaproveitavel; com sinal gravado pelo caminho real conta como pago', async () => {
    const v = await novaVariante();
    const corpo = { items: [{ product_id: ID.camiseta, variant_id: v, quantity: 1, unit_price: 100 }] };
    const kSem = chave(); const kCom = chave();
    expect((await guardar(corpo, kSem)).status).toBe(201);
    const comSinal = await guardar({ ...corpo, sinal: { amount: 40, method: 'pix' } }, kCom);
    expect(comSinal.status).toBe(201);

    const sem = await acharPedidoDaChave(ID.loja, kSem, itens(v), { pagoEncerra: true });
    expect(sem.pago).toBe(false);
    expect(sem.existente).toBeTruthy();
    const com = await acharPedidoDaChave(ID.loja, kCom, itens(v), { pagoEncerra: true });
    expect(com.pago).toBe(true);
    // Sem message_id (G): o pedido com sinal nao e reaproveitado, vai para a chave -2.
    const g = await acharPedidoDaChave(ID.loja, kCom, itens(v), { pagoEncerra: false });
    expect(g).toMatchObject({ existente: null, chave: `${kCom}-2` });
  });

  test('status fora de pendente/confirmado (entregue) tambem conta como pago', async () => {
    const v = await novaVariante();
    const k = chave();
    const r = await guardar({ items: [{ product_id: ID.camiseta, variant_id: v, quantity: 1, unit_price: 100 }] }, k);
    expect(r.status).toBe(201);
    await q(`UPDATE digital_orders SET status = 'delivered' WHERE id = $1`, [r.body.order.id]);
    const x = await acharPedidoDaChave(ID.loja, k, itens(v), { pagoEncerra: true });
    expect(x.pago).toBe(true);
  });

  test('pedido aberto da mesma mensagem com outra quantidade: 409, sem abrir segundo pedido', async () => {
    const v = await novaVariante();
    const k = chave();
    expect((await guardar({ items: [{ product_id: ID.camiseta, variant_id: v, quantity: 1, unit_price: 100 }] }, k)).status).toBe(201);
    await expect(acharPedidoDaChave(ID.loja, k, [{ product_id: ID.camiseta, variant_id: v, quantity: 2 }], { pagoEncerra: true }))
      .rejects.toMatchObject({ code: 'RESERVA_COM_OUTRA_QUANTIDADE', status: 409 });
  });
});
