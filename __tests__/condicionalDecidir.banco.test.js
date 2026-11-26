// ============================================================
// AURA. — Venda condicional (C9): decidir as pecas — Postgres real
// PATCH /companies/:id/condicionais/:cid/itens | /prazo,
// POST  /companies/:id/condicionais/:cid/itens | /tudo-devolvido | /cancelar
// (routes/condicionais.js, services/condicionalDecidir.js), migration 468.
//
// Provado aqui, no banco de verdade:
//   R1  nada disso cria venda, lancamento, movimento de caixa ou de estoque,
//       e o estoque nao muda;
//   R6  "Voltou" tira de com clientes na hora; a condicional so encerra
//       quando nada esta com a cliente e nada "ficou" sem venda;
//   defeito: sai de com clientes, nao volta a livre (resolver_qty), e a
//       ultima unidade fica presa ate o C16;
//   "ficou" continua fora (out_qty) e a condicional fica a cobrar;
//   R10 "Tudo devolvido" encerra sem venda e zera com clientes;
//   409s: peca cobrada, condicional fechada, cancelar decidida, sem saldo,
//       nada com ela, ficou sem venda;
//   concorrencia: duas marcacoes ao mesmo tempo encerram uma vez so; dois
//       "tudo devolvido" ao mesmo tempo: um passa, o outro 409;
//   Idempotency-Key: repeticao (tambem em paralelo) acrescenta uma vez so;
//   prazo no fuso de Sao Paulo, ate hoje + 30.
//
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const condicional = require('../src/services/condicional');

const { hojeSP, somarDias } = condicional;

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = {
  dono: uuid(), loja: uuid(), semEstoque: uuid(), cliente: uuid(),
  saia: uuid(), blusa: uuid(), cinto: uuid(), bolsa: uuid(), unica: uuid(), defeito: uuid(),
  lenco: uuid(), meia: uuid(), zerada: uuid(), vestido: uuid(), varM: uuid(), dupla: uuid(), vendida: uuid(),
};
const EMPRESAS = [ID.loja, ID.semEstoque];
const HOJE = hojeSP();
const dia = (n) => somarDias(HOJE, n);

let pool;
let app;
let usuario;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);
const DONO = () => ({ id: ID.dono, role: 'client', is_staff: true, plan: 'negocio' });

async function limpar() {
  const passos = [
    [`UPDATE condicional_itens SET sale_id = NULL WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`UPDATE sales SET condicional_id = NULL WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM sales WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicionais WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicional_sequencias WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono]]],
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
  // Colunas de producao que o GET /products le e nenhuma migration do repo
  // cria (mesmo ajuste de comClientes.banco.test.js).
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS ncm TEXT`);

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture C9')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $3, 'Fixture C9 Loja', 'Centro'), ($2, $3, 'Fixture C9 Sem Estoque', 'Sem Estoque')`,
    [ID.loja, ID.semEstoque, ID.dono]);
  await q(`UPDATE companies SET pdv_settings = '{"allow_sale_without_stock": true}'::jsonb WHERE id = $1`, [ID.semEstoque]);

  const produto = (id, empresa, nome, preco, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, $4, $5)`, [id, empresa, nome, preco, estoque]);
  await produto(ID.saia, ID.loja, 'Saia Plissada', 120, 5);
  await produto(ID.blusa, ID.loja, 'Blusa Tricô', 90, 5);
  await produto(ID.cinto, ID.loja, 'Cinto', 40, 5);
  await produto(ID.bolsa, ID.loja, 'Bolsa', 200, 5);
  await produto(ID.unica, ID.loja, 'Jaqueta Única', 260, 1);
  await produto(ID.defeito, ID.loja, 'Calça Única', 150, 1);
  await produto(ID.lenco, ID.loja, 'Lenço', 30, 5);
  await produto(ID.meia, ID.loja, 'Meia', 10, 50);
  await produto(ID.dupla, ID.loja, 'Top Duplo', 70, 2);
  await produto(ID.vendida, ID.loja, 'Brinco', 25, 1);
  await produto(ID.zerada, ID.semEstoque, 'Peça sem saldo', 30, 0);
  await produto(ID.vestido, ID.loja, 'Vestido', 199.9, 0);
  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty, color_name, is_active) VALUES ($1, $2, 'AZ-M', 1, 'Azul', true)`,
    [ID.varM, ID.vestido]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'Marina Lopes', '(11) 98888-7777')`, [ID.cliente, ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/condicionais', require('../src/routes/condicionais'));
  app.use('/companies/:id/products', require('../src/routes/products'));
});

beforeEach(() => {
  usuario = DONO();
  delete process.env.CONDICIONAL_LIBERADA;
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

function chave() { seq += 1; return `teste-c9-${seq}-${uuid()}`; }

async function guardar(empresa, items, extra) {
  const r = await request(app).post(`/companies/${empresa}/condicionais`).set('Idempotency-Key', chave())
    .send({ customer_id: ID.cliente, items, ...(extra || {}) });
  expect(r.status).toBe(201);
  return r.body.condicional;
}

const url = (cond, sufixo, empresa = ID.loja) => `/companies/${empresa}/condicionais/${cond.id}${sufixo}`;
const marcar = (cond, items, k) => {
  const r = request(app).patch(url(cond, '/itens'));
  return (k ? r.set('Idempotency-Key', k) : r).send({ items });
};
const post = (cond, sufixo, body = {}, k = null, empresa = ID.loja) => {
  const r = request(app).post(url(cond, sufixo, empresa));
  return (k ? r.set('Idempotency-Key', k) : r).send(body);
};
const prazo = (cond, dueDate) => request(app).patch(url(cond, '/prazo')).send({ due_date: dueDate });
const peca = (cond, productId) => cond.items.find((i) => i.product_id === productId);

async function produtos() {
  process.env.CONDICIONAL_LIBERADA = 'true';
  const r = await request(app).get(`/companies/${ID.loja}/products?limit=100`);
  delete process.env.CONDICIONAL_LIBERADA;
  expect(r.status).toBe(200);
  return Object.fromEntries(r.body.products.map((p) => [p.id, p]));
}

async function contarEfeitos() {
  const { rows } = await q(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE company_id = ANY($1))::int AS transacoes,
            (SELECT COUNT(*) FROM sales WHERE company_id = ANY($1))::int AS vendas,
            (SELECT COUNT(*) FROM stock_movements WHERE company_id = ANY($1))::int AS movimentos,
            (SELECT COUNT(*) FROM caixa_movimentos WHERE company_id = ANY($1))::int AS caixa,
            (SELECT COALESCE(SUM(stock_qty), 0) FROM products WHERE company_id = ANY($1))::numeric AS estoque,
            (SELECT COALESCE(SUM(stock_qty), 0) FROM product_variants WHERE id = $2)::numeric AS estoque_var`,
    [EMPRESAS, ID.varM]);
  return rows[0];
}

let efeitosNoInicio;
test('fotografia antes de tudo (R1 no fim do arquivo)', async () => {
  efeitosNoInicio = await contarEfeitos();
});

describe('Voltou (R6) e encerramento', () => {
  test('voltou tira de com clientes na hora; a ultima peca decidida encerra', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.saia }, { product_id: ID.blusa }]);
    expect((await produtos())[ID.saia].out_qty).toBe(1);

    const r = await marcar(c, [{ item_id: peca(c, ID.saia).id, situacao: 'voltou' }]);
    expect(r.status).toBe(200);
    expect(r.body.condicional).toMatchObject({ status: 'aberta', situacao: 'com_cliente', parcial: true });
    expect(peca(r.body.condicional, ID.saia)).toMatchObject({ situacao: 'voltou', decided_by: ID.dono });
    expect(peca(r.body.condicional, ID.saia).decided_at).toBeTruthy();
    const p = await produtos();
    expect(p[ID.saia].out_qty).toBe(0);
    expect(p[ID.blusa].out_qty).toBe(1);

    const fim = await marcar(c, [{ item_id: peca(c, ID.blusa).id, situacao: 'voltou' }]);
    expect(fim.status).toBe(200);
    expect(fim.body.condicional).toMatchObject({ status: 'encerrada', situacao: 'concluida' });
    expect(fim.body.condicional.closed_at).toBeTruthy();
    expect(fim.body.condicional.events.map((e) => e.tipo)).toEqual(['criada', 'voltou', 'voltou', 'encerrada']);
    expect(fim.body.condicional.events[3].dados).toMatchObject({ motivo: 'pecas_decididas', com_venda: false });
    expect((await produtos())[ID.blusa].out_qty).toBe(0);

    // Encerrada nao muda mais.
    const depois = await marcar(c, [{ item_id: peca(c, ID.blusa).id, situacao: 'com_cliente' }]);
    expect(depois.status).toBe(409);
    expect(depois.body.code).toBe('COND_FECHADA');
  });

  test('voltar a "Ainda com ela" antes de encerrar volta a contar fora', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.cinto }, { product_id: ID.lenco }]);
    await marcar(c, [{ item_id: peca(c, ID.cinto).id, situacao: 'voltou' }]);
    const r = await marcar(c, [{ item_id: peca(c, ID.cinto).id, situacao: 'com_cliente' }]);
    expect(r.status).toBe(200);
    expect(peca(r.body.condicional, ID.cinto)).toMatchObject({ situacao: 'com_cliente', decided_at: null, decided_by: null });
    expect(r.body.condicional.events.map((e) => e.tipo)).toEqual(['criada', 'voltou', 'ainda_com_ela']);
    expect((await produtos())[ID.cinto].out_qty).toBe(1);
    await post(c, '/tudo-devolvido');
  });

  test('peca que tinha voltado so sai de novo se ainda houver unidade livre', async () => {
    const a = await guardar(ID.loja, [{ product_id: ID.unica }, { product_id: ID.meia }]);
    await marcar(a, [{ item_id: peca(a, ID.unica).id, situacao: 'voltou' }]);
    const b = await guardar(ID.loja, [{ product_id: ID.unica }]);
    const r = await marcar(a, [{ item_id: peca(a, ID.unica).id, situacao: 'ficou' }]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COND_SEM_SALDO');
    expect(r.body.error).toContain(b.numero_exibicao);
    await post(b, '/tudo-devolvido');
    const ok = await marcar(a, [{ item_id: peca(a, ID.unica).id, situacao: 'ficou' }]);
    expect(ok.status).toBe(200);
    await marcar(a, [{ item_id: peca(a, ID.unica).id, situacao: 'voltou' }, { item_id: peca(a, ID.meia).id, situacao: 'voltou' }]);
  });
});

describe('Voltou com defeito (para resolver)', () => {
  test('sai de com clientes, nao volta a livre e segura a ultima unidade', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.defeito }]);
    const r = await marcar(c, [{ item_id: c.items[0].id, situacao: 'voltou_defeito', defect_note: 'Sem etiqueta' }]);
    expect(r.status).toBe(200);
    expect(r.body.condicional.items[0]).toMatchObject({ situacao: 'voltou_defeito', defect_note: 'Sem etiqueta', resolved_at: null });
    // A unica peca decidida: encerra (nada com ela, nada a cobrar).
    expect(r.body.condicional.status).toBe('encerrada');

    const p = (await produtos())[ID.defeito];
    expect(p).toMatchObject({ out_qty: 0, resolver_qty: 1, resolver_by_variant: {}, stock_qty: 1 });

    // A unica unidade esta para resolver: nao entra em outra condicional.
    const nao = await request(app).post(`/companies/${ID.loja}/condicionais`).set('Idempotency-Key', chave())
      .send({ customer_id: ID.cliente, items: [{ product_id: ID.defeito }] });
    expect(nao.status).toBe(409);
    expect(nao.body.faltas[0]).toMatchObject({ estoque: 1, com_clientes: 0, para_resolver: 1, livre: 0 });
    expect(nao.body.error).toMatch(/Peças para resolver/);

    // Resolvida (C16): volta a livre, e a peca nao muda mais.
    await q(`UPDATE condicional_itens SET resolved_at = NOW() WHERE id = $1`, [c.items[0].id]);
    expect((await produtos())[ID.defeito].resolver_qty).toBe(0);
    const outra = await guardar(ID.loja, [{ product_id: ID.defeito }]);
    await post(outra, '/tudo-devolvido');
  });

  test('por variante: resolver_by_variant', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.vestido, variant_id: ID.varM }, { product_id: ID.meia }]);
    await marcar(c, [{ item_id: peca(c, ID.vestido).id, situacao: 'voltou_defeito' }]);
    const p = (await produtos())[ID.vestido];
    expect(p).toMatchObject({ out_qty: 0, out_by_variant: {}, resolver_qty: 1, resolver_by_variant: { [ID.varM]: 1 } });
    // Mudar de ideia antes de encerrar: voltou normal, livre de novo.
    const r = await marcar(c, [{ item_id: peca(c, ID.vestido).id, situacao: 'voltou' }]);
    expect(peca(r.body.condicional, ID.vestido).defect_note).toBeNull();
    expect((await produtos())[ID.vestido].resolver_qty).toBe(0);
    await post(c, '/tudo-devolvido');
  });

  test('peca resolvida nao muda: 409', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.lenco }, { product_id: ID.meia }]);
    await marcar(c, [{ item_id: peca(c, ID.lenco).id, situacao: 'voltou_defeito' }]);
    await q(`UPDATE condicional_itens SET resolved_at = NOW() WHERE id = $1`, [peca(c, ID.lenco).id]);
    const r = await marcar(c, [{ item_id: peca(c, ID.lenco).id, situacao: 'voltou' }]);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'COND_PECA_RESOLVIDA', item_id: peca(c, ID.lenco).id });
    await post(c, '/tudo-devolvido');
  });
});

describe('Ficou, falta cobrar e peca cobrada', () => {
  test('ficou segue fora; nada com ela = a cobrar, sem prazo, sem acrescentar, sem cancelar', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.bolsa }, { product_id: ID.saia }]);
    const r = await marcar(c, [
      { item_id: peca(c, ID.bolsa).id, situacao: 'ficou' },
      { item_id: peca(c, ID.saia).id, situacao: 'voltou' },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.condicional).toMatchObject({ status: 'aberta', situacao: 'a_cobrar' });
    expect(r.body.condicional.resumo).toMatchObject({ a_cobrar: 1, valor_a_cobrar: 200, com_cliente: 0 });
    expect((await produtos())[ID.bolsa].out_qty).toBe(1);

    expect((await prazo(r.body.condicional, dia(2))).body.code).toBe('COND_NADA_COM_ELA');
    expect((await post(c, '/itens', { items: [{ product_id: ID.meia }] })).body.code).toBe('COND_NADA_COM_ELA');
    expect((await post(c, '/tudo-devolvido')).body.code).toBe('COND_TEM_FICOU');
    const cancelar = await post(c, '/cancelar');
    expect(cancelar.status).toBe(409);
    expect(cancelar.body.code).toBe('COND_CANCELAR_DECIDIDA');
    expect(cancelar.body.error).toMatch(/Voltou/);

    // A venda (C11) grava sale_id: a peca nao muda mais.
    const venda = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount, condicional_id) VALUES ($1, $2, 200, $3)`, [venda, ID.loja, c.id]);
    await q(`UPDATE condicional_itens SET sale_id = $2 WHERE id = $1`, [peca(c, ID.bolsa).id, venda]);
    const cobrada = await marcar(c, [{ item_id: peca(c, ID.bolsa).id, situacao: 'voltou' }]);
    expect(cobrada.status).toBe(409);
    expect(cobrada.body).toMatchObject({ code: 'COND_PECA_COBRADA', item_id: peca(c, ID.bolsa).id, sale_id: venda });
    await q(`UPDATE condicional_itens SET sale_id = NULL WHERE id = $1`, [peca(c, ID.bolsa).id]);
    await q(`DELETE FROM sales WHERE id = $1`, [venda]);
    // Ficou -> voltou (desistiu antes de pagar): encerra.
    const fim = await marcar(c, [{ item_id: peca(c, ID.bolsa).id, situacao: 'voltou' }]);
    expect(fim.body.condicional.status).toBe('encerrada');
  });
});

describe('Tudo devolvido (R10) e cancelar', () => {
  test('as com_cliente viram voltou, encerra sem venda e zera com clientes', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.saia }, { product_id: ID.blusa }, { product_id: ID.cinto }]);
    await marcar(c, [{ item_id: peca(c, ID.cinto).id, situacao: 'voltou_defeito' }]);
    const k = chave();
    const r = await post(c, '/tudo-devolvido', {}, k);
    expect(r.status).toBe(200);
    const d = r.body.condicional;
    expect(d).toMatchObject({ status: 'encerrada', situacao: 'concluida' });
    expect(d.items.map((i) => i.situacao).sort()).toEqual(['voltou', 'voltou', 'voltou_defeito']);
    expect(d.events.filter((e) => e.tipo === 'encerrada')).toHaveLength(1);
    expect(d.events.find((e) => e.tipo === 'encerrada').dados).toMatchObject({ motivo: 'tudo_devolvido', com_venda: false });
    const p = await produtos();
    expect(p[ID.saia].out_qty).toBe(0);
    expect(p[ID.blusa].out_qty).toBe(0);
    const { rows: [s] } = await q(`SELECT COUNT(*)::int AS n FROM sales WHERE condicional_id = $1`, [c.id]);
    expect(s.n).toBe(0);

    // Repetir com a mesma chave: 200 de repeticao; sem chave: 409.
    const rep = await post(c, '/tudo-devolvido', {}, k);
    expect(rep.status).toBe(200);
    expect(rep.body.idempotent_replay).toBe(true);
    expect(rep.headers['idempotent-replayed']).toBe('true');
    const semChave = await post(c, '/tudo-devolvido');
    expect(semChave.status).toBe(409);
    expect(semChave.body.code).toBe('COND_FECHADA');
    // A mesma chave para outra coisa: 409.
    const outra = await post(c, '/cancelar', {}, k);
    expect(outra.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  test('cancelar a aberta por engano tira tudo de com clientes; depois nada muda', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.lenco }]);
    expect((await produtos())[ID.lenco].out_qty).toBe(1);
    const r = await post(c, '/cancelar', { reason: 'Abri na cliente errada' });
    expect(r.status).toBe(200);
    expect(r.body.condicional).toMatchObject({ status: 'cancelada', situacao: 'cancelada', cancel_reason: 'Abri na cliente errada' });
    expect(r.body.condicional.cancelled_at).toBeTruthy();
    expect(r.body.condicional.events.map((e) => e.tipo)).toEqual(['criada', 'cancelada']);
    expect((await produtos())[ID.lenco].out_qty).toBe(0);
    expect((await post(c, '/cancelar')).body.code).toBe('COND_FECHADA');
    expect((await marcar(c, [{ item_id: c.items[0].id, situacao: 'voltou' }])).body.code).toBe('COND_FECHADA');
  });

  test('outra loja nao enxerga a condicional (404)', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.meia }]);
    const r = await post(c, '/tudo-devolvido', {}, null, ID.semEstoque);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('COND_NAO_ENCONTRADA');
    await post(c, '/tudo-devolvido');
  });
});

describe('Nova data (fuso de Sao Paulo)', () => {
  test('de hoje a hoje + 30, evento nova_data', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.meia }], { due_date: dia(1) });
    const r = await prazo(c, dia(7));
    expect(r.status).toBe(200);
    expect(r.body.condicional.due_date).toBe(dia(7));
    const ev = r.body.condicional.events.find((e) => e.tipo === 'nova_data');
    expect(ev.dados).toMatchObject({ de: dia(1), para: dia(7) });
    expect((await prazo(c, dia(-1))).body.code).toBe('COND_DATA');
    expect((await prazo(c, dia(31))).body.code).toBe('COND_DATA');
    expect((await prazo(c, dia(30))).status).toBe(200);
    expect((await prazo(c, HOJE)).body.condicional.situacao).toBe('vence_hoje');
    await post(c, '/tudo-devolvido');
  });

  test('23h30 em Sao Paulo (02h30 UTC do dia seguinte): hoje ainda vale', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.meia }], { due_date: dia(1) });
    const original = condicional.hojeSP;
    const instante = new Date('2026-11-27T02:30:00Z');
    jest.spyOn(condicional, 'hojeSP').mockImplementation((agora) => original(agora || instante));
    const r = await prazo(c, '2026-11-26');
    expect(r.status).toBe(200);
    expect(r.body.condicional.due_date).toBe('2026-11-26');
    expect((await prazo(c, '2026-11-25')).body.code).toBe('COND_DATA');
    jest.restoreAllMocks();
    await post(c, '/tudo-devolvido');
  });
});

describe('Acrescentar peca', () => {
  test('preco do dia, mesmo prazo, evento; sem unidade livre 409 com o numero', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.meia }], { due_date: dia(4) });
    await q(`UPDATE products SET promo_price = 99, promo_starts_at = NOW() - interval '1 day', promo_ends_at = NOW() + interval '1 day' WHERE id = $1`, [ID.saia]);
    const r = await post(c, '/itens', { items: [{ product_id: ID.saia }, { product_id: ID.unica }] });
    await q(`UPDATE products SET promo_price = NULL, promo_starts_at = NULL, promo_ends_at = NULL WHERE id = $1`, [ID.saia]);
    expect(r.status).toBe(201);
    expect(r.body.avisos).toEqual([]);
    expect(r.body.itens_acrescentados).toHaveLength(2);
    const d = r.body.condicional;
    expect(d.due_date).toBe(dia(4));
    expect(d.items.map((i) => i.product_id)).toEqual([ID.meia, ID.saia, ID.unica]);
    expect(peca(d, ID.saia)).toMatchObject({ unit_price: 99, situacao: 'com_cliente' });
    expect(d.events.filter((e) => e.tipo === 'peca_acrescentada')).toHaveLength(2);
    expect((await produtos())[ID.unica].out_qty).toBe(1);

    // A unica unidade ja esta nesta condicional: a segunda nao entra.
    const nao = await post(c, '/itens', { items: [{ product_id: ID.unica }] });
    expect(nao.status).toBe(409);
    expect(nao.body.code).toBe('COND_SEM_SALDO');
    expect(nao.body.error).toContain(c.numero_exibicao);
    expect((await post(c, '/itens', { items: [{ product_id: ID.unica, quantity: 2 }] })).body.code).toBe('COND_QUANTIDADE');
    await post(c, '/tudo-devolvido');
  });

  test('loja que vende sem estoque: entra com o aviso', async () => {
    const c = await guardar(ID.semEstoque, [{ product_id: ID.zerada }]);
    const r = await post(c, '/itens', { items: [{ product_id: ID.zerada }] }, null, ID.semEstoque);
    expect(r.status).toBe(201);
    expect(r.body.avisos[0]).toMatchObject({ product_id: ID.zerada, livre: 0, mensagem: condicional.AVISO_SEM_ESTOQUE });
    expect(r.body.condicional.events.find((e) => e.tipo === 'peca_acrescentada').dados).toMatchObject({ sem_saldo: true });
    await post(c, '/tudo-devolvido', {}, null, ID.semEstoque);
  });

  test('Idempotency-Key: a repeticao (tambem em paralelo) acrescenta uma vez so', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.meia }]);
    const k = chave();
    const [a, b] = await Promise.all([
      post(c, '/itens', { items: [{ product_id: ID.meia }] }, k),
      post(c, '/itens', { items: [{ product_id: ID.meia }] }, k),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const rep = await post(c, '/itens', { items: [{ product_id: ID.meia }] }, k);
    expect(rep.status).toBe(200);
    expect(rep.body.idempotent_replay).toBe(true);
    expect(rep.body.condicional.items).toHaveLength(2);
    expect(rep.body.itens_acrescentados).toEqual((a.status === 201 ? a : b).body.itens_acrescentados);
    expect(rep.body.avisos).toEqual([]);
    const outra = await post(c, '/itens', { items: [{ product_id: ID.lenco }] }, k);
    expect(outra.status).toBe(409);
    expect(outra.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await post(c, '/tudo-devolvido');
  });
});

describe('Concorrencia', () => {
  test('duas marcacoes ao mesmo tempo: as duas valem e a condicional encerra uma vez', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.saia }, { product_id: ID.blusa }]);
    const [a, b] = await Promise.all([
      marcar(c, [{ item_id: peca(c, ID.saia).id, situacao: 'voltou' }]),
      marcar(c, [{ item_id: peca(c, ID.blusa).id, situacao: 'voltou' }]),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const { rows } = await q(`SELECT tipo FROM condicional_eventos WHERE condicional_id = $1 ORDER BY created_at, id`, [c.id]);
    expect(rows.filter((e) => e.tipo === 'encerrada')).toHaveLength(1);
    expect(rows.filter((e) => e.tipo === 'voltou')).toHaveLength(2);
    const { rows: [s] } = await q(`SELECT status FROM condicionais WHERE id = $1`, [c.id]);
    expect(s.status).toBe('encerrada');
  });

  test('a mesma peca marcada em dois aparelhos: a ultima vale, sem estado torto', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.saia }, { product_id: ID.blusa }]);
    const it = peca(c, ID.saia).id;
    const [a, b] = await Promise.all([
      marcar(c, [{ item_id: it, situacao: 'ficou' }]),
      marcar(c, [{ item_id: it, situacao: 'voltou' }]),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const { rows: [i] } = await q(`SELECT situacao FROM condicional_itens WHERE id = $1`, [it]);
    expect(['ficou', 'voltou']).toContain(i.situacao);
    const { rows: ev } = await q(`SELECT tipo FROM condicional_eventos WHERE condicional_id = $1 AND item_id = $2`, [c.id, it]);
    expect(ev.map((e) => e.tipo).sort()).toEqual(['ficou', 'voltou']);
    await marcar(c, [{ item_id: it, situacao: 'voltou' }]);
    await post(c, '/tudo-devolvido');
  });

  test('dois "tudo devolvido" ao mesmo tempo, sem chave: um passa, o outro 409', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.cinto }]);
    const rs = await Promise.all([post(c, '/tudo-devolvido'), post(c, '/tudo-devolvido')]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM condicional_eventos WHERE condicional_id = $1 AND tipo = 'encerrada'`, [c.id]);
    expect(rows[0].n).toBe(1);
  });
});

describe('revisao do C9', () => {
  test('peca com sale_id nunca conta como com a cliente (com_cliente cobrada fora do contrato)', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.saia }, { product_id: ID.blusa }]);
    const venda = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount, condicional_id) VALUES ($1, $2, 120, $3)`, [venda, ID.loja, c.id]);
    await q(`UPDATE condicional_itens SET sale_id = $2 WHERE id = $1`, [peca(c, ID.saia).id, venda]);
    expect((await produtos())[ID.saia].out_qty).toBe(0);
    const lista = await request(app).get(`/companies/${ID.loja}/condicionais?filtro=todas&limit=100`);
    expect(lista.body.condicionais.find((x) => x.id === c.id).pecas_com_cliente).toBe(1);
    const r = await post(c, '/tudo-devolvido');
    expect(r.status).toBe(200);
    expect(r.body.condicional).toMatchObject({ status: 'encerrada' });
    expect(peca(r.body.condicional, ID.saia)).toMatchObject({ situacao: 'com_cliente', sale_id: venda });
    expect(peca(r.body.condicional, ID.blusa).situacao).toBe('voltou');
    expect(r.body.condicional.resumo.com_cliente).toBe(0);
    await q(`UPDATE condicional_itens SET sale_id = NULL WHERE id = $1`, [peca(c, ID.saia).id]);
    await q(`DELETE FROM sales WHERE id = $1`, [venda]);
    await q(`UPDATE condicional_itens SET situacao = 'voltou' WHERE id = $1`, [peca(c, ID.saia).id]);
  });

  test('voltou -> voltou_defeito confere o livre: a unidade vendida no Caixa da 409', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.vendida }, { product_id: ID.meia }]);
    await marcar(c, [{ item_id: peca(c, ID.vendida).id, situacao: 'voltou' }]);
    // A unidade que voltou foi vendida no Caixa (baixa no estoque).
    await q(`UPDATE products SET stock_qty = 0 WHERE id = $1`, [ID.vendida]);
    const r = await marcar(c, [{ item_id: peca(c, ID.vendida).id, situacao: 'voltou_defeito' }]);
    await q(`UPDATE products SET stock_qty = 1 WHERE id = $1`, [ID.vendida]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COND_SEM_SALDO');
    expect(r.body.error).toMatch(/^Não dá para levar: "Brinco": sem unidade no estoque\.$/);
    // Com a unidade de volta, passa.
    const ok = await marcar(c, [{ item_id: peca(c, ID.vendida).id, situacao: 'voltou_defeito' }]);
    expect(ok.status).toBe(200);
    expect((await produtos())[ID.vendida]).toMatchObject({ resolver_qty: 1, out_qty: 0 });
    await q(`UPDATE condicional_itens SET resolved_at = NOW() WHERE id = $1`, [peca(c, ID.vendida).id]);
    await post(c, '/tudo-devolvido');
  });

  test('livre sobre o estado final: uma volta e outra sai da mesma variante no mesmo PATCH', async () => {
    const a = await guardar(ID.loja, [{ product_id: ID.dupla }, { product_id: ID.dupla }, { product_id: ID.meia }]);
    const [p1, p2] = a.items.filter((i) => i.product_id === ID.dupla);
    await marcar(a, [{ item_id: p1.id, situacao: 'voltou' }]);
    const b = await guardar(ID.loja, [{ product_id: ID.dupla }]);
    // Livre agora 0: p1 sai sozinha = 409; p1 sai e p2 volta juntas = 0 liquido.
    const sozinha = await marcar(a, [{ item_id: p1.id, situacao: 'ficou' }]);
    expect(sozinha.status).toBe(409);
    expect(sozinha.body.code).toBe('COND_SEM_SALDO');
    const juntas = await marcar(a, [{ item_id: p1.id, situacao: 'ficou' }, { item_id: p2.id, situacao: 'voltou' }]);
    expect(juntas.status).toBe(200);
    expect((await produtos())[ID.dupla].out_qty).toBe(2);
    await marcar(a, [{ item_id: p1.id, situacao: 'voltou' }, { item_id: peca(a, ID.meia).id, situacao: 'voltou' }]);
    await post(b, '/tudo-devolvido');
  });

  test('repeticao do POST /itens devolve a mesma resposta (avisos e itens_acrescentados)', async () => {
    const c = await guardar(ID.semEstoque, [{ product_id: ID.zerada }]);
    const k = chave();
    const primeira = await post(c, '/itens', { items: [{ product_id: ID.zerada }] }, k, ID.semEstoque);
    expect(primeira.status).toBe(201);
    expect(primeira.body.avisos).toHaveLength(1);
    const rep = await post(c, '/itens', { items: [{ product_id: ID.zerada }] }, k, ID.semEstoque);
    expect(rep.status).toBe(200);
    expect(rep.body.idempotent_replay).toBe(true);
    expect(rep.body.itens_acrescentados).toEqual(primeira.body.itens_acrescentados);
    expect(rep.body.avisos).toEqual(primeira.body.avisos);
    expect(rep.body.condicional.items).toHaveLength(2);
    // As outras rotas: a repeticao traz os mesmos campos da primeira.
    const k2 = chave();
    const marcarNaOutra = () => request(app).patch(url(c, '/itens', ID.semEstoque)).set('Idempotency-Key', k2)
      .send({ items: [{ item_id: primeira.body.itens_acrescentados[0], situacao: 'voltou' }] });
    const m1 = await marcarNaOutra();
    expect(m1.status).toBe(200);
    const m2 = await marcarNaOutra();
    expect(m2.status).toBe(200);
    expect(m2.body.idempotent_replay).toBe(true);
    expect(m2.body.avisos).toEqual(m1.body.avisos);
    await post(c, '/tudo-devolvido', {}, null, ID.semEstoque);
  });
});

describe('trava CONDICIONAL_LIBERADA', () => {
  test('lojista sem a trava: as rotas novas nao existem (404)', async () => {
    const c = await guardar(ID.loja, [{ product_id: ID.meia }]);
    usuario = { id: ID.dono, role: 'client', plan: 'negocio' };
    expect((await marcar(c, [{ item_id: c.items[0].id, situacao: 'voltou' }])).status).toBe(404);
    expect((await prazo(c, dia(2))).status).toBe(404);
    expect((await post(c, '/tudo-devolvido')).status).toBe(404);
    expect((await post(c, '/cancelar')).status).toBe(404);
    expect((await post(c, '/itens', { items: [{ product_id: ID.meia }] })).status).toBe(404);
    process.env.CONDICIONAL_LIBERADA = 'true';
    expect((await post(c, '/tudo-devolvido')).status).toBe(200);
  });
});

test('R1: nada disso criou venda, lancamento, caixa ou movimento, e o estoque nao mudou', async () => {
  expect(await contarEfeitos()).toEqual(efeitosNoInicio);
  const { rows: [abertas] } = await q(`SELECT COUNT(*)::int AS n FROM condicionais WHERE company_id = ANY($1) AND status = 'aberta'`, [EMPRESAS]);
  expect(abertas.n).toBe(0);
});
