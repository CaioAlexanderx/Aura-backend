// ============================================================
// AURA. — Venda condicional (C11): cobrar no Caixa — Postgres real
// POST /companies/:id/pdv/sale com condicional_id + condicional_item_ids
// (routes/pdv.js, services/condicionalVenda.js), migrations 467 a 469.
//
// Provado aqui, no banco de verdade:
//   paridade: sem condicional_id a venda e a de sempre (nada da condicional);
//   2 de 3 pecas: a condicional segue aberta, pecas 'ficou' com sale_id,
//     sales.condicional_id, evento 'venda', estoque baixa uma vez, preco do item;
//   o resto: encerra (evento 'encerrada'); detalhe traz venda_numero;
//   409 de peca ja cobrada com o numero da venda;
//   duas vendas simultaneas das mesmas pecas (chaves diferentes): uma passa,
//     a outra 409, estoque baixa uma vez;
//   mesma Idempotency-Key devolve a mesma venda;
//   cancelar (DELETE /pdv/sale/:id): pecas voltam a 'ficou' sem sale_id e a
//     condicional encerrada reabre;
//   trava CONDICIONAL_LIBERADA.
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const condicional = require('../src/services/condicional');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid(), a: uuid(), b: uuid(), c: uuid(), d: uuid() };
let pool;
let app;
let usuario;
let numero = 0;
const q = (sql, params) => pool.query(sql, params);
const STAFF = () => ({ id: ID.dono, role: 'client', is_staff: true, plan: 'negocio' });
const LOJISTA = () => ({ id: ID.dono, role: 'client', is_staff: false, plan: 'negocio' });
const urlVenda = `/companies/${ID.loja}/pdv/sale`;

async function limpar() {
  const passos = [
    [`UPDATE condicional_itens SET sale_id = NULL WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`, [ID.loja]],
    [`UPDATE sales SET condicional_id = NULL WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM transactions WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM sale_payments WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM stock_movements WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`, [ID.loja]],
    [`DELETE FROM sales WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM condicionais WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM products WHERE company_id = $1`, [ID.loja]],
    [`DELETE FROM companies WHERE id = $1`, [ID.loja]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  const vendaIdempotente = require('../src/services/vendaIdempotente');
  if (vendaIdempotente._resetCache) vendaIdempotente._resetCache();

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture C11')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture C11 Loja', 'Centro')`,
    [ID.loja, ID.dono]);
  for (const [id, nome, preco] of [[ID.a, 'Saia C11', 120], [ID.b, 'Blusa C11', 90], [ID.c, 'Cinto C11', 40], [ID.d, 'Comum C11', 10]]) {
    await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, $4, 10)`, [id, ID.loja, nome, preco]);
  }

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
  app.use('/companies/:id/condicionais', require('../src/routes/condicionais'));
  app.use('/companies/:id', require('../src/routes/transactionSale'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
});

beforeEach(() => { usuario = STAFF(); delete process.env.CONDICIONAL_LIBERADA; });

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  await limpar();
  await pool.end();
});

/** Condicional aberta com uma peca por produto (preco da retirada = unit_price). */
async function nova(produtos) {
  numero += 1;
  const { rows: [c] } = await q(
    `INSERT INTO condicionais (company_id, numero, customer_name, customer_phone, due_date)
     VALUES ($1, $2, 'Marina Lopes', '11988887777', CURRENT_DATE + 3) RETURNING id`,
    [ID.loja, 9000 + numero]
  );
  const itens = [];
  for (const [pid, preco] of produtos) {
    const { rows: [i] } = await q(
      `INSERT INTO condicional_itens (condicional_id, product_id, product_name, unit_price) VALUES ($1, $2, 'peca', $3) RETURNING id`,
      [c.id, pid, preco]
    );
    itens.push({ id: i.id, product_id: pid, unit_price: preco });
  }
  return { id: c.id, itens };
}

const carrinho = (itens) => itens.map((i) => ({
  product_id: i.product_id, quantity: 1, unit_price: i.unit_price, product_name_snapshot: 'peca',
}));
const vender = (cond, itens, key) => {
  const r = request(app).post(urlVenda);
  if (key) r.set('Idempotency-Key', key);
  return r.send({
    items: carrinho(itens), payment_method: 'dinheiro',
    condicional_id: cond.id, condicional_item_ids: itens.map((i) => i.id),
  });
};
const estoque = async (pid) => Number((await q(`SELECT stock_qty FROM products WHERE id = $1`, [pid])).rows[0].stock_qty);
const lerCond = async (id) => (await q(`SELECT status, closed_at FROM condicionais WHERE id = $1`, [id])).rows[0];
const lerItens = async (id) => (await q(`SELECT id, situacao, sale_id, decided_at FROM condicional_itens WHERE condicional_id = $1 ORDER BY id`, [id])).rows;
const eventos = async (id) => (await q(`SELECT tipo FROM condicional_eventos WHERE condicional_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.tipo);

describe('paridade', () => {
  test('sem condicional_id a venda e a de sempre', async () => {
    const antes = await estoque(ID.d);
    const r = await request(app).post(urlVenda).send({
      items: [{ product_id: ID.d, quantity: 2, unit_price: 10, product_name_snapshot: 'Comum C11' }], payment_method: 'dinheiro',
    });
    expect(r.status).toBe(201);
    expect(r.body.condicional).toBeUndefined();
    expect(r.body.sale.condicional_id || null).toBeNull();
    expect(await estoque(ID.d)).toBe(antes - 2);
    const { rows } = await q(`SELECT condicional_id FROM sales WHERE id = $1`, [r.body.sale.id]);
    expect(rows[0].condicional_id).toBeNull();
  });
});

describe('cobrar no Caixa', () => {
  test('2 de 3 pecas: segue aberta; o resto encerra; estoque baixa uma vez; preco = unit_price', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 89.9], [ID.c, 40]]);
    const [i1, i2, i3] = cond.itens;
    const estA = await estoque(ID.a); const estB = await estoque(ID.b); const estC = await estoque(ID.c);

    const r1 = await vender(cond, [i1, i2]);
    expect(r1.status).toBe(201);
    expect(r1.body.condicional).toMatchObject({ id: cond.id, itens: 2, encerrada: false });
    expect(Number(r1.body.sale.total_amount)).toBeCloseTo(209.9, 2);
    const itensVenda = r1.body.sale.items.map((i) => Number(i.unit_price)).sort();
    expect(itensVenda).toEqual([89.9, 120]);
    expect(await estoque(ID.a)).toBe(estA - 1);
    expect(await estoque(ID.b)).toBe(estB - 1);
    expect(await estoque(ID.c)).toBe(estC);
    expect((await lerCond(cond.id)).status).toBe('aberta');
    const itens = await lerItens(cond.id);
    for (const it of itens.filter((x) => x.id !== i3.id)) {
      expect(it.situacao).toBe('ficou');
      expect(it.sale_id).toBe(r1.body.sale.id);
      expect(it.decided_at).toBeTruthy();
    }
    expect(itens.find((x) => x.id === i3.id)).toMatchObject({ situacao: 'com_cliente', sale_id: null });
    const { rows: [s] } = await q(`SELECT condicional_id FROM sales WHERE id = $1`, [r1.body.sale.id]);
    expect(s.condicional_id).toBe(cond.id);
    expect(await eventos(cond.id)).toEqual(['venda', 'venda']);

    // Detalhe: venda_numero nas pecas cobradas (um join so).
    const det = await request(app).get(`/companies/${ID.loja}/condicionais/${cond.id}`);
    expect(det.status).toBe(200);
    const comNumero = det.body.condicional.items.filter((i) => i.sale_id);
    expect(comNumero).toHaveLength(2);
    for (const i of comNumero) expect(i.venda_numero).toBe(Number(r1.body.sale.sale_number));
    expect(det.body.condicional.items.find((i) => i.id === i3.id).venda_numero).toBeNull();

    const r2 = await vender(cond, [i3]);
    expect(r2.status).toBe(201);
    expect(r2.body.condicional.encerrada).toBe(true);
    expect((await lerCond(cond.id)).status).toBe('encerrada');
    expect(await estoque(ID.c)).toBe(estC - 1);
    expect(await eventos(cond.id)).toEqual(['venda', 'venda', 'venda', 'encerrada']);
  });

  test('peca "ficou" sem venda tambem pode ser cobrada', async () => {
    const cond = await nova([[ID.a, 120]]);
    await q(`UPDATE condicional_itens SET situacao = 'ficou' WHERE id = $1`, [cond.itens[0].id]);
    const r = await vender(cond, cond.itens);
    expect(r.status).toBe(201);
    expect(r.body.condicional.encerrada).toBe(true);
  });

  test('409 de peca ja cobrada, com o numero da venda; nada grava', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 90]]);
    const r1 = await vender(cond, [cond.itens[0]]);
    expect(r1.status).toBe(201);
    const est = await estoque(ID.a);
    const r2 = await vender(cond, [cond.itens[0]], uuid());
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe('COND_JA_COBRADA');
    expect(r2.body.error).toBe(`Estas peças já foram cobradas na venda #${r1.body.sale.sale_number}.`);
    expect(r2.body.venda_numero).toBe(Number(r1.body.sale.sale_number));
    expect(await estoque(ID.a)).toBe(est);
  });

  test('409 para peca de outra condicional, condicional fechada e peca voltou; 422 para carrinho diferente', async () => {
    const x = await nova([[ID.a, 120]]);
    const y = await nova([[ID.b, 90]]);
    const alheia = await request(app).post(urlVenda).send({
      items: carrinho(x.itens), payment_method: 'dinheiro', condicional_id: y.id, condicional_item_ids: [x.itens[0].id],
    });
    expect(alheia.status).toBe(409);
    expect(alheia.body.code).toBe('COND_ITEM_INVALIDO');

    await q(`UPDATE condicional_itens SET situacao = 'voltou' WHERE id = $1`, [y.itens[0].id]);
    const voltou = await vender(y, y.itens);
    expect(voltou.status).toBe(409);
    expect(voltou.body.code).toBe('COND_ITEM_SITUACAO');

    await q(`UPDATE condicionais SET status = 'encerrada' WHERE id = $1`, [y.id]);
    const fechada = await vender(y, y.itens);
    expect(fechada.status).toBe(409);
    expect(fechada.body.code).toBe('COND_FECHADA');

    const errado = await request(app).post(urlVenda).send({
      items: carrinho([{ product_id: ID.d, unit_price: 10 }]), payment_method: 'dinheiro',
      condicional_id: x.id, condicional_item_ids: [x.itens[0].id],
    });
    expect(errado.status).toBe(422);
    expect(errado.body.code).toBe('COND_CARRINHO_DIFERENTE');
    expect((await lerItens(x.id))[0]).toMatchObject({ situacao: 'com_cliente', sale_id: null });
  });

  test('duas vendas simultaneas das mesmas pecas: uma passa, a outra 409; estoque baixa uma vez', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 90]]);
    const estA = await estoque(ID.a);
    const [r1, r2] = await Promise.all([vender(cond, cond.itens, uuid()), vender(cond, cond.itens, uuid())]);
    const status = [r1.status, r2.status].sort();
    expect(status).toEqual([201, 409]);
    const perdeu = r1.status === 409 ? r1 : r2;
    expect(perdeu.body.code).toBe('COND_JA_COBRADA');
    expect(await estoque(ID.a)).toBe(estA - 1);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM sales WHERE condicional_id = $1`, [cond.id]);
    expect(rows[0].n).toBe(1);
  });

  test('mesma Idempotency-Key devolve a mesma venda', async () => {
    const cond = await nova([[ID.a, 120]]);
    const key = uuid();
    const estA = await estoque(ID.a);
    const r1 = await vender(cond, cond.itens, key);
    const r2 = await vender(cond, cond.itens, key);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.sale.id).toBe(r1.body.sale.id);
    expect(await estoque(ID.a)).toBe(estA - 1);
  });
});

describe('cancelar a venda', () => {
  test('as pecas voltam a ficou sem sale_id e a condicional encerrada reabre', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 90]]);
    const r = await vender(cond, cond.itens);
    expect(r.status).toBe(201);
    expect((await lerCond(cond.id)).status).toBe('encerrada');
    const estA = await estoque(ID.a);

    const del = await request(app).delete(`/companies/${ID.loja}/pdv/sale/${r.body.sale.id}`);
    expect(del.status).toBe(200);
    expect(await estoque(ID.a)).toBe(estA + 1);
    const c = await lerCond(cond.id);
    expect(c.status).toBe('aberta');
    expect(c.closed_at).toBeNull();
    for (const it of await lerItens(cond.id)) expect(it).toMatchObject({ situacao: 'ficou', sale_id: null });
    const tipos = await eventos(cond.id);
    expect(tipos.slice(-3)).toEqual(['venda_cancelada', 'venda_cancelada', 'reaberta']);

    // De novo no Caixa: cobra de novo, uma venda nova.
    const de_novo = await vender(cond, cond.itens);
    expect(de_novo.status).toBe(201);
    expect(de_novo.body.sale.id).not.toBe(r.body.sale.id);
    expect((await lerCond(cond.id)).status).toBe('encerrada');
  });

  test('cancelar venda de 1 de 2 pecas: a outra segue com a cliente e a condicional continua aberta', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 90]]);
    const r = await vender(cond, [cond.itens[0]]);
    await request(app).delete(`/companies/${ID.loja}/pdv/sale/${r.body.sale.id}`);
    const itens = await lerItens(cond.id);
    expect(itens.find((i) => i.id === cond.itens[0].id)).toMatchObject({ situacao: 'ficou', sale_id: null });
    expect(itens.find((i) => i.id === cond.itens[1].id)).toMatchObject({ situacao: 'com_cliente', sale_id: null });
    expect((await lerCond(cond.id)).status).toBe('aberta');
  });
});

describe('remover item da venda (transactionSale)', () => {
  const removerItem = async (saleId, productId) => {
    const { rows: [tx] } = await q(`SELECT id FROM transactions WHERE idempotency_key = $1 AND company_id = $2`, ['pdv-sale-' + saleId, ID.loja]);
    const { rows: [it] } = await q(`SELECT id FROM sale_items WHERE sale_id = $1 AND product_id = $2`, [saleId, productId]);
    return request(app).delete(`/companies/${ID.loja}/transactions/${tx.id}/sale-items/${it.id}`);
  };

  test('remover A: a peca A volta a ficou sem venda na hora, a condicional reabre; depois cancelar a venda solta so B (sem evento duplicado de A)', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 90]]);
    const r = await vender(cond, cond.itens);
    expect(r.status).toBe(201);
    expect((await lerCond(cond.id)).status).toBe('encerrada');

    const rem = await removerItem(r.body.sale.id, ID.a);
    expect(rem.status).toBe(200);
    let itens = await lerItens(cond.id);
    expect(itens.find((i) => i.id === cond.itens[0].id)).toMatchObject({ situacao: 'ficou', sale_id: null });
    expect(itens.find((i) => i.id === cond.itens[1].id)).toMatchObject({ situacao: 'ficou', sale_id: r.body.sale.id });
    expect((await lerCond(cond.id)).status).toBe('aberta');
    expect((await eventos(cond.id)).filter((t) => t === 'venda_cancelada')).toHaveLength(1);

    const del = await request(app).delete(`/companies/${ID.loja}/pdv/sale/${r.body.sale.id}`);
    expect(del.status).toBe(200);
    itens = await lerItens(cond.id);
    for (const it of itens) expect(it).toMatchObject({ situacao: 'ficou', sale_id: null });
    expect((await eventos(cond.id)).filter((t) => t === 'venda_cancelada')).toHaveLength(2);
    expect((await lerCond(cond.id)).status).toBe('aberta');
  });

  test('remover o ultimo item cancela a venda e solta a peca restante', async () => {
    const cond = await nova([[ID.a, 120]]);
    const r = await vender(cond, cond.itens);
    const rem = await removerItem(r.body.sale.id, ID.a);
    expect(rem.status).toBe(200);
    expect((await lerItens(cond.id))[0]).toMatchObject({ situacao: 'ficou', sale_id: null });
    expect((await lerCond(cond.id)).status).toBe('aberta');
  });
});

describe('trava CONDICIONAL_LIBERADA', () => {
  test('desligada: lojista recebe 404 e nada grava; staff passa; ligada: lojista passa', async () => {
    const cond = await nova([[ID.a, 120], [ID.b, 90]]);
    usuario = LOJISTA();
    const barrada = await vender(cond, [cond.itens[0]]);
    expect(barrada.status).toBe(404);
    expect((await lerItens(cond.id)).every((i) => !i.sale_id)).toBe(true);

    process.env.CONDICIONAL_LIBERADA = 'true';
    const liberada = await vender(cond, [cond.itens[0]]);
    expect(liberada.status).toBe(201);
    delete process.env.CONDICIONAL_LIBERADA;

    usuario = STAFF();
    const staff = await vender(cond, [cond.itens[1]]);
    expect(staff.status).toBe(201);
    expect(condicional.condicionalLiberada({ user: STAFF() })).toBe(true);
  });
});
