// ============================================================
// AURA. -- Testes: nome da coluna de estoque (tq-26, 19/10/2026)
//
// products.stock_quantity NAO existe; a coluna real e products.stock_qty
// (schema de producao conferido em 19/10). Tres caminhos usavam o nome
// errado e dariam 42703/500 quando rodassem:
//   1. baixa por receita ao marcar pedido Food como `delivered`
//      (foodOrders.js: SELECT ... FOR UPDATE e UPDATE products)
//   2. baixa de material ao criar agendamento da barbearia
//      (barbershop.js: UPDATE products)
//   3. GET marketplace/product-map (marketplace.js: SELECT p.stock_*)
//
// Sem Postgres no CI, o teste confere o SQL EMITIDO ao banco simulado:
// o mock responde por CONTEUDO do SQL (nunca fila posicional) e recusa
// com 42703 qualquer SQL que cite `stock_quantity`, como o banco real faria.
// ============================================================
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const oid = 'aaaaaaaa-0000-0000-0000-000000000001';
const itemId = 'bbbbbbbb-0000-0000-0000-000000000002';
const prodId = 'cccccccc-0000-0000-0000-000000000003';
const svcId = 'dddddddd-0000-0000-0000-000000000004';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };

// Banco simulado: responde por conteudo do SQL e falha como o Postgres
// falharia se a coluna fantasma aparecesse.
function bancoSimulado(respostas) {
  const emitidos = [];
  const query = jest.fn(async (sql, params) => {
    emitidos.push({ sql: String(sql), params });
    if (/stock_quantity/.test(sql)) {
      const err = new Error('column "stock_quantity" does not exist');
      err.code = '42703';
      throw err;
    }
    for (const [re, resp] of respostas) {
      if (re.test(sql)) return typeof resp === 'function' ? resp(params) : resp;
    }
    return { rows: [] };
  });
  return { query, emitidos };
}

// Monta so o router testado (sem carregar src/index, que leva ~30 s).
function appCom(prefixo, router) {
  const app = express();
  app.use(express.json());
  app.use(`/api/v1/companies/:id/${prefixo}`, router);
  return app;
}

describe('Food: baixa por receita ao entregar usa stock_qty', () => {
  function appFood(client) {
    db.connect.mockResolvedValue({ query: client.query, release: jest.fn() });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 'u1', role: 'client', plan: 'negocio' }; next(); });
    app.use('/api/v1/companies/:id/food/orders', require('../../src/routes/foodOrders'));
    return app;
  }

  test('PATCH /:oid/status -> delivered: SELECT FOR UPDATE e UPDATE em stock_qty, 200', async () => {
    const client = bancoSimulado([
      [/FROM food_orders fo/, { rows: [{ id: oid, status: 'ready', table_id: null, items: [{ item_id: itemId, quantity: 3 }] }] }],
      [/UPDATE food_orders SET status/, { rows: [{ id: oid, status: 'delivered', table_id: null }] }],
      [/FROM food_recipes/, { rows: [{ product_id: prodId, unit_qty: 2 }] }],
      [/FROM products[\s\S]*FOR UPDATE/, { rows: [{ id: prodId, stock_qty: 50 }] }],
    ]);
    const res = await request(appFood(client))
      .patch(`/api/v1/companies/${cid}/food/orders/${oid}/status`)
      .set(auth)
      .send({ status: 'delivered' });

    expect(res.status).toBe(200);
    const sqls = client.emitidos.map((e) => e.sql);
    const lock = client.emitidos.find((e) => /FROM products[\s\S]*FOR UPDATE/.test(e.sql));
    const baixa = client.emitidos.find((e) => /UPDATE products/.test(e.sql));
    expect(lock.sql).toMatch(/SELECT id, stock_qty FROM products/);
    expect(baixa.sql).toMatch(/SET stock_qty = GREATEST\(0, stock_qty - \$1\)/);
    // 2 (receita) x 3 (quantidade do item) = 6, no produto e na loja certos
    expect(baixa.params).toEqual([6, prodId, cid]);
    expect(sqls.some((s) => /stock_quantity/.test(s))).toBe(false);
    expect(sqls.some((s) => /ROLLBACK/.test(s))).toBe(false);
    expect(sqls.some((s) => /COMMIT/.test(s))).toBe(true);
  });
});

describe('Barbearia: baixa de material ao criar agendamento usa stock_qty', () => {
  test('POST /barbershop/appointments com servico: UPDATE products em stock_qty, 201', async () => {
    const app = appCom('barbershop', require('../../src/routes/barbershop'));
    const client = bancoSimulado([
      [/INSERT INTO barbershop_appointments/, { rows: [{ id: 'a1', professional_id: 'p1', total_amount: 40 }] }],
      [/FROM barber_service_materials/, { rows: [{ product_id: prodId, quantity_per_use: 0.5 }] }],
    ]);
    db.connect.mockResolvedValue({ query: client.query, release: jest.fn() });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/barbershop/appointments`)
      .set(auth)
      .send({
        professional_id: 'p1',
        scheduled_at: new Date().toISOString(),
        customer_name: 'Pedro',
        services: [{ service_id: svcId, service_name: 'Corte', price: 40, commission_pct: 50 }],
      });

    expect(res.status).toBe(201);
    const baixa = client.emitidos.find((e) => /UPDATE products/.test(e.sql));
    expect(baixa.sql).toBe('UPDATE products SET stock_qty=GREATEST(stock_qty-$1,0) WHERE id=$2 AND company_id=$3');
    expect(baixa.params).toEqual([0.5, prodId, cid]);
    expect(client.emitidos.some((e) => /stock_quantity/.test(e.sql))).toBe(false);
    expect(client.emitidos.some((e) => /ROLLBACK/.test(e.sql))).toBe(false);
  });
});

describe('Marketplace: GET product-map le stock_qty', () => {
  test('SELECT usa p.stock_qty e devolve 200', async () => {
    const app = appCom('marketplace', require('../../src/routes/marketplace'));
    const banco = bancoSimulado([
      [/FROM marketplace_product_map/, { rows: [{ product_id: prodId, product_name: 'X', stock_qty: 7 }] }],
    ]);
    db.query.mockImplementation(banco.query);

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/marketplace/product-map/conn1`)
      .set(auth);

    expect(res.status).toBe(200);
    const sel = banco.emitidos.find((e) => /marketplace_product_map/.test(e.sql));
    expect(sel.sql).toMatch(/p\.stock_qty/);
    expect(res.body.mappings[0].stock_qty).toBe(7);
  });
});

describe('Guarda estatica: as rotas corrigidas nao citam a coluna fantasma', () => {
  test.each(['foodOrders.js', 'barbershop.js', 'marketplace.js'])('%s sem stock_quantity', (arq) => {
    const fonte = fs.readFileSync(path.join(__dirname, '../../src/routes', arq), 'utf8');
    expect(fonte).not.toMatch(/stock_quantity/);
  });
});
