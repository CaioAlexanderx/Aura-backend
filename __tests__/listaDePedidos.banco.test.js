// ============================================================
// AURA. — Aba Pedidos: lista, filtros, numeros e consolidado (B3 / p-61c)
// Postgres real. GET /companies/:id/pedidos, GET /companies/:id/pedidos/:oid,
// PATCH /companies/:id/pedidos/:oid/status, GET /me/pedidos.
//
// O que este arquivo prova:
//   1. a lista mostra so os pedidos do balcao da loja, com o chip de
//      situacao (abertos por padrao), atrasados no topo e busca por nome,
//      numero, telefone e peca;
//   2. os numeros da aba (abertos, pecas, atrasados, sinais, falta) sao dos
//      abertos qualquer que seja o filtro; o sinal vem dos studio_payments
//      de sinal pagos (o B4a grava ali);
//   3. Separar e Pronto andam so para a frente, so no pedido do balcao, sem
//      baixa, sem lancamento; concluir e cancelar nao passam por aqui;
//   4. o consolidado soma as lojas do usuario (dono ou membro que ve o
//      Caixa), com o numero de cada loja, e recusa loja de fora (403);
//   5. a trava PEDIDO_LIBERADO vale nas duas rotas.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
// /me/pedidos chama requireAuth no proprio router: o usuario vem do app.
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
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
  dono: uuid(), membro: uuid(), outroDono: uuid(),
  centro: uuid(), shopping: uuid(), semCaixa: uuid(), deFora: uuid(),
  vestido: uuid(), cinto: uuid(),
};
const EMPRESAS = [ID.centro, ID.shopping, ID.semCaixa, ID.deFora];
const { hojeSP } = require('../src/services/pedidoBalcao');
const HOJE = hojeSP();
const dia = (n) => {
  const d = new Date(HOJE + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let pool;
let app;
let usuario;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);
const P = {};

async function limpar() {
  const passos = [
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM company_members WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono, ID.membro, ID.outroDono]]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

async function pedido({ empresa = ID.centro, nome, telefone = '', status = 'confirmed', promessa = null, total = 100,
  itens = [{ p: ID.vestido, nome: 'Vestido Midi Linho', qtd: 1 }], origem = 'balcao', sinal = 0, criadoHa = 0 }) {
  seq += 1;
  const id = uuid();
  await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total,
             status, origem, promised_date, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9::date, NOW() - ($10 || ' minutes')::interval)`,
  [id, empresa, 'LOJ-' + String(seq).padStart(4, '0'), nome, telefone, total, status, origem, promessa, String(criadoHa)]);
  for (const it of itens) {
    await q(`INSERT INTO digital_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal)
             VALUES ($1, $2, $3, 10, $4, 10 * $4)`, [id, it.p || null, it.nome, it.qtd]);
  }
  if (sinal) {
    await q(`INSERT INTO studio_payments (company_id, order_id, kind, amount, status, method, paid_at)
             VALUES ($1, $2, 'deposit', $3, 'paid', 'pix', NOW())`, [empresa, id, sinal]);
  }
  return id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES
             ($1, $2, 'x', 'Fixture Dono'), ($3, $4, 'x', 'Fixture Membro'), ($5, $6, 'x', 'Outro Dono')`,
  [ID.dono, `fixture-${ID.dono}@example.test`, ID.membro, `fixture-${ID.membro}@example.test`,
    ID.outroDono, `fixture-${ID.outroDono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary) VALUES
             ($1, $4, 'Fixture Centro LTDA', 'Centro', true),
             ($2, $4, 'Fixture Shopping LTDA', 'Shopping', false),
             ($3, $5, 'Fixture Sem Caixa', NULL, false)`,
  [ID.centro, ID.shopping, ID.semCaixa, ID.dono, ID.outroDono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture De Fora')`, [ID.deFora, ID.outroDono]);
  // O membro: ve o Caixa no Centro, nao ve na "Sem Caixa" (de outro dono).
  await q(`INSERT INTO company_members (company_id, user_id, role_label, permissions, status, is_active) VALUES
             ($1, $3, 'vendedora', '{"pdv": true}'::jsonb, 'active', true),
             ($2, $3, 'vendedora', '{"pdv": false, "financeiro": true}'::jsonb, 'active', true)`,
  [ID.centro, ID.semCaixa, ID.membro]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $3, 'Vestido Midi Linho', 189.9, 4), ($2, $3, 'Cinto Couro', 59.9, 1)`,
    [ID.vestido, ID.cinto, ID.centro]);

  P.marina = await pedido({ nome: 'Marina Duarte', telefone: '11988887777', promessa: dia(-2), total: 389.7, sinal: 100,
    itens: [{ p: ID.vestido, nome: 'Vestido Midi Linho', qtd: 1 }, { p: ID.cinto, nome: 'Cinto Couro', qtd: 2 }, { nome: 'Ajuste', qtd: 1 }] });
  P.julia = await pedido({ nome: 'Julia', status: 'preparing', promessa: dia(1), total: 200, criadoHa: 5 });
  P.ana = await pedido({ nome: 'Ana', status: 'ready', promessa: null, total: 50, criadoHa: 10 });
  P.bia = await pedido({ nome: 'Bia', status: 'confirmed', promessa: dia(3), total: 80, criadoHa: 15, sinal: 30 });
  P.velho = await pedido({ nome: 'Atrasada Antiga', status: 'preparing', promessa: dia(-10), total: 70, criadoHa: 20 });
  P.feito = await pedido({ nome: 'Concluida', status: 'delivered', promessa: dia(-5), total: 999 });
  P.cancelado = await pedido({ nome: 'Cancelada', status: 'cancelled', promessa: dia(-5), total: 999 });
  P.online = await pedido({ nome: 'Marina Duarte', origem: null, total: 999 });
  P.shopping = await pedido({ empresa: ID.shopping, nome: 'Carla', promessa: dia(-1), total: 120, sinal: 20 });
  P.semCaixa = await pedido({ empresa: ID.semCaixa, nome: 'Outra', total: 10 });
  P.deFora = await pedido({ empresa: ID.deFora, nome: 'Fora', total: 10 });

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/me', require('../src/routes/mePedidos'));
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

const ids = (r) => r.body.orders.map((o) => o.id);

describe('GET /companies/:id/pedidos', () => {
  test('padrao: abertos da loja, atrasados no topo, depois a data mais perto, sem data por ultimo', async () => {
    const r = await request(app).get(`/companies/${ID.centro}/pedidos`);
    expect(r.status).toBe(200);
    expect(r.body.situacao).toBe('abertos');
    // Atrasados: a de 10 dias e a de 2 dias (pela data), depois amanha, em 3 dias e sem data.
    expect(ids(r)).toEqual([P.velho, P.marina, P.julia, P.bia, P.ana]);
    const marina = r.body.orders.find((o) => o.id === P.marina);
    expect(marina).toMatchObject({
      status: 'confirmed', customer_name: 'Marina Duarte', total: 389.7, sinal_pago: 100, falta: 289.7,
      atrasado: true, dias_de_atraso: 2, item_count: 3, pecas: 4,
      company_id: ID.centro, company_name: 'Centro',
    });
    // O primeiro item e o de menor id (BIGINT em producao = o primeiro gravado;
    // no CI o id e uuid, entao so confere que e um dos itens).
    expect(['Vestido Midi Linho', 'Cinto Couro', 'Ajuste']).toContain(marina.first_item_name);
    expect(r.body.orders.find((o) => o.id === P.julia)).toMatchObject({ atrasado: false, dias_de_atraso: 0, sinal_pago: 0, falta: 200 });
  });

  test('numeros da aba sao dos abertos, qualquer que seja o chip', async () => {
    const esperado = {
      abertos: 5, atrasados: 2,
      pecas_reservadas: 3 + 1 + 1 + 1 + 1, // a Marina tem 3 pecas com produto (o ajuste nao conta)
      sinais_recebidos: 130,
      falta_receber: Math.round((289.7 + 200 + 50 + 50 + 70) * 100) / 100,
    };
    for (const chip of ['', '?situacao=concluidos', '?situacao=todos', '?q=Bia']) {
      const r = await request(app).get(`/companies/${ID.centro}/pedidos${chip}`);
      expect(r.body.kpis).toEqual(esperado);
      expect(r.body.counts).toEqual({ abertos: 5, aguardando: 2, separando: 2, prontos: 1, concluidos: 1, cancelados: 1, atrasados: 2, todos: 7 });
    }
  });

  test.each([
    ['?situacao=aguardando', () => [P.marina, P.bia]],
    ['?situacao=separando', () => [P.velho, P.julia]],
    ['?situacao=prontos', () => [P.ana]],
    ['?situacao=concluidos', () => [P.feito]],
    ['?situacao=cancelados', () => [P.cancelado]],
    ['?atrasados=1', () => [P.velho, P.marina]],
    ['?situacao=qualquer-coisa', () => [P.velho, P.marina, P.julia, P.bia, P.ana]],
  ])('filtro %s', async (filtro, esperado) => {
    const r = await request(app).get(`/companies/${ID.centro}/pedidos${filtro}`);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(esperado());
  });

  test('busca por nome, peca, telefone e numero; o pedido da loja online nunca aparece', async () => {
    const busca = async (termo, sit = 'todos') => ids(await request(app).get(`/companies/${ID.centro}/pedidos?situacao=${sit}&q=${encodeURIComponent(termo)}`));
    expect(await busca('marina')).toEqual([P.marina]);
    expect(await busca('Cinto')).toEqual([P.marina]);
    expect(await busca('98888')).toEqual([P.marina]);
    expect(await busca('1')).toEqual([P.marina]); // LOJ-0001
    expect(await busca('100%')).toEqual([]);
  });

  test('paginacao conta a busca', async () => {
    const r = await request(app).get(`/companies/${ID.centro}/pedidos?limit=2&page=2`);
    expect(ids(r)).toEqual([P.julia, P.bia]);
    expect(r.body.pagination).toEqual({ page: 2, limit: 2, total: 5, pages: 3 });
  });

  test('detalhe: pedido do balcao da loja; o da loja online e o de outra loja sao 404', async () => {
    const r = await request(app).get(`/companies/${ID.centro}/pedidos/${P.marina}`);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ id: P.marina, origem: 'balcao', sinal_pago: 100, falta: 289.7 });
    expect(r.body.order.items).toHaveLength(3);
    expect((await request(app).get(`/companies/${ID.centro}/pedidos/${P.online}`)).status).toBe(404);
    expect((await request(app).get(`/companies/${ID.centro}/pedidos/${P.shopping}`)).status).toBe(404);
    expect((await request(app).get(`/companies/${ID.centro}/pedidos/abc`)).status).toBe(404);
  });

  test('trava desligada: lojista recebe 404', async () => {
    usuario = { id: ID.dono, role: 'client' };
    expect((await request(app).get(`/companies/${ID.centro}/pedidos`)).status).toBe(404);
  });
});

describe('PATCH /companies/:id/pedidos/:oid/status (Separar e Pronto)', () => {
  const patch = (oid, status, empresa = ID.centro) =>
    request(app).patch(`/companies/${empresa}/pedidos/${oid}/status`).send({ status });

  test('aguardando -> separando -> pronto; repetir e 200 sem mudar', async () => {
    const r1 = await patch(P.bia, 'preparing');
    expect(r1.status).toBe(200);
    expect(r1.body.order.status).toBe('preparing');
    const r2 = await patch(P.bia, 'ready');
    expect(r2.body.order.status).toBe('ready');
    const r3 = await patch(P.bia, 'ready');
    expect(r3.status).toBe(200);
    expect(r3.body.ja_estava).toBe(true);
    const { rows: [o] } = await q(`SELECT status::text AS status, stock_deducted, transaction_id FROM digital_orders WHERE id = $1`, [P.bia]);
    expect(o).toEqual({ status: 'ready', stock_deducted: false, transaction_id: null });
    expect(require('../src/services/digitalOrderNotifications').notifyStatusChange).not.toHaveBeenCalled();
  });

  test('voltar, concluir e cancelar nao passam por aqui', async () => {
    expect((await patch(P.bia, 'preparing')).status).toBe(409);
    expect((await patch(P.julia, 'delivered')).status).toBe(400);
    expect((await patch(P.julia, 'cancelled')).status).toBe(400);
    expect((await patch(P.feito, 'ready')).status).toBe(409);
    expect((await patch(P.cancelado, 'ready')).status).toBe(409);
  });

  test('pedido da loja online e de outra loja: 404', async () => {
    expect((await patch(P.online, 'preparing')).status).toBe(404);
    expect((await patch(P.shopping, 'preparing')).status).toBe(404);
  });
});

describe('GET /me/pedidos (consolidado)', () => {
  test('dono: soma as lojas dele, com o numero de cada uma', async () => {
    const r = await request(app).get('/me/pedidos');
    expect(r.status).toBe(200);
    expect(r.body.company_count).toBe(2);
    const deCada = Object.fromEntries(r.body.por_empresa.map((e) => [e.company_id, e]));
    expect(deCada[ID.centro]).toMatchObject({ company_name: 'Centro', abertos: 5 });
    expect(deCada[ID.shopping]).toMatchObject({ company_name: 'Shopping', abertos: 1, atrasados: 1, sinais_recebidos: 20, falta_receber: 100 });
    expect(r.body.kpis.abertos).toBe(6);
    expect(r.body.kpis.atrasados).toBe(3);
    expect(ids(r)).toEqual(expect.arrayContaining([P.shopping, P.marina]));
    expect(ids(r)).not.toContain(P.semCaixa);
    expect(ids(r)).not.toContain(P.deFora);
    expect(ids(r)).not.toContain(P.online);
    expect(r.body.orders.find((o) => o.id === P.shopping).company_name).toBe('Shopping');
  });

  test('?company_id= de uma loja dele filtra; de loja de fora e 403', async () => {
    const r = await request(app).get(`/me/pedidos?company_id=${ID.shopping}`);
    expect(ids(r)).toEqual([P.shopping]);
    expect(r.body.filtered_company_id).toBe(ID.shopping);
    expect((await request(app).get(`/me/pedidos?company_id=${ID.deFora}`)).status).toBe(403);
  });

  test('membro: so as lojas em que ve o Caixa', async () => {
    usuario = { id: ID.membro, role: 'client', is_staff: true };
    const r = await request(app).get('/me/pedidos?situacao=todos');
    expect(r.body.company_count).toBe(1);
    expect(r.body.por_empresa.map((e) => e.company_id)).toEqual([ID.centro]);
    expect(ids(r)).not.toContain(P.semCaixa);
  });

  test('trava desligada: 404', async () => {
    usuario = { id: ID.dono, role: 'client' };
    expect((await request(app).get('/me/pedidos')).status).toBe(404);
  });
});
