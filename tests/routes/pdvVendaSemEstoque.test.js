// ============================================================
// AURA. -- Testes: vender sem estoque (06/10/2026)
//
// Configuracoes > Politicas do Caixa > "Vender sem estoque"
// (pdv_settings.allow_sale_without_stock, desligada por padrao).
//
// O que estes testes travam:
//   1. desligada: saldo menor que a quantidade => 409, nada e gravado
//   2. ligada: a venda passa com saldo zero (produto e variante)
//   3. so `true` literal liga -- "true" (texto) ou 1 nao liga
//   4. a baixa nunca deixa o saldo negativo (GREATEST(0, ...))
//   5. venda COM estoque nao faz consulta a mais de pdv_settings
//   6. a chave e lida uma vez por venda, nao uma por item
//   7. /pdv-settings: default false, aceita boolean, recusa o resto,
//      e salvar outra chave nao a desliga (merge)
//   8. lancamento de venda no Financeiro (POST sale-items) segue a mesma chave
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const pdvRouter = require('../../src/routes/pdv');
const pdvSettingsRouter = require('../../src/routes/pdvSettings');
const transactionSaleRouter = require('../../src/routes/transactionSale');
const { lerVendaSemEstoque } = require('../../src/utils/vendaSemEstoque');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const prod = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const vari = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const txId = 'cccccccc-dddd-eeee-ffff-000000000000';
const saleId = 'dddddddd-eeee-ffff-0000-111111111111';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/pdv', pdvRouter);
  scoped.use('/', pdvSettingsRouter);
  scoped.use('/', transactionSaleRouter);
  app.use('/api/v1/companies/:id', scoped);
  // AppError dos routers com asyncHandler vira resposta JSON
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const app = buildApp();

const LIGADA = { allow_sale_without_stock: true };

function mockClient({ pdvSettings = {}, stock = '0', variantStock = '0' } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: pdvSettings }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Cimento', cost_price: '30.00', stock_qty: stock, stock_company_id: cid }] });
    }
    if (/SELECT stock_qty, sku_suffix FROM product_variants/i.test(s)) {
      return Promise.resolve({ rows: [{ stock_qty: variantStock, sku_suffix: 'CP2' }] });
    }
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '37.00' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

const callsMatching = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const settingsReads = (client) => callsMatching(client, /SELECT pdv_settings FROM companies/i).length;

function usar(client) {
  db.connect.mockResolvedValue(client);
  db.query.mockResolvedValue({ rows: [] });
  return client;
}

const sell = (items, extra = {}) => request(app)
  .post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth)
  .send({ items, payment_method: 'dinheiro', ...extra });

const umItem = [{ product_id: prod, quantity: 2, unit_price: 18.5 }];

describe('lerVendaSemEstoque -- so true literal liga', () => {
  test.each([
    [{ allow_sale_without_stock: true }, true],
    [{ allow_sale_without_stock: false }, false],
    [{ allow_sale_without_stock: 'true' }, false],
    [{ allow_sale_without_stock: 1 }, false],
    [{}, false],
    [null, false],
    [undefined, false],
  ])('%j => %s', (settings, esperado) => {
    expect(lerVendaSemEstoque(settings)).toBe(esperado);
  });
});

describe('Caixa (POST /pdv/sale) -- chave desligada', () => {
  test('saldo zero => 409 e nada e gravado', async () => {
    const client = usar(mockClient({ pdvSettings: {}, stock: '0' }));

    const res = await sell(umItem);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Estoque insuficiente para "Cimento"/);
    expect(res.body.product_id).toBe(prod);
    expect(callsMatching(client, /INSERT INTO sales/i)).toHaveLength(0);
    expect(callsMatching(client, /^ROLLBACK$/i)).toHaveLength(1);
  });

  test('saldo menor que a quantidade => 409', async () => {
    usar(mockClient({ pdvSettings: { allow_sale_without_stock: false }, stock: '1' }));
    const res = await sell(umItem);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Disponivel: 1/);
  });

  test('"true" como texto nao liga', async () => {
    usar(mockClient({ pdvSettings: { allow_sale_without_stock: 'true' }, stock: '0' }));
    const res = await sell(umItem);
    expect(res.status).toBe(409);
  });
});

describe('Caixa (POST /pdv/sale) -- chave ligada', () => {
  test('saldo zero => a venda passa', async () => {
    const client = usar(mockClient({ pdvSettings: LIGADA, stock: '0' }));

    const res = await sell(umItem);

    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO sales/i)).toHaveLength(1);
    expect(callsMatching(client, /INSERT INTO sale_items/i)).toHaveLength(1);
  });

  test('a baixa nao deixa o saldo negativo', async () => {
    const client = usar(mockClient({ pdvSettings: LIGADA, stock: '0' }));

    await sell(umItem);

    const baixa = callsMatching(client, /UPDATE products SET stock_qty/i);
    expect(baixa).toHaveLength(1);
    expect(baixa[0][0]).toMatch(/GREATEST\(0,\s*stock_qty-\$1\)/);
  });

  test('variante com saldo zero tambem passa', async () => {
    const client = usar(mockClient({ pdvSettings: LIGADA, stock: '0', variantStock: '0' }));

    const res = await sell([{ product_id: prod, variant_id: vari, quantity: 1, unit_price: 37 }]);

    expect(res.status).toBe(201);
    const baixa = callsMatching(client, /UPDATE product_variants SET stock_qty/i);
    expect(baixa).toHaveLength(1);
    expect(baixa[0][0]).toMatch(/GREATEST\(0,/);
  });

  test('a chave e lida uma vez por venda, nao uma por item', async () => {
    const semFalta = usar(mockClient({ pdvSettings: LIGADA, stock: '50' }));
    await sell(umItem);
    const base = settingsReads(semFalta);

    const comFalta = usar(mockClient({ pdvSettings: LIGADA, stock: '0' }));
    const res = await sell([
      { product_id: prod, quantity: 1, unit_price: 10 },
      { product_id: prod, quantity: 1, unit_price: 10 },
      { product_id: prod, quantity: 1, unit_price: 10 },
    ]);

    expect(res.status).toBe(201);
    expect(settingsReads(comFalta)).toBe(base + 1);
  });
});

describe('Caixa -- venda com estoque nao paga consulta a mais', () => {
  test('mesmo numero de leituras de pdv_settings com a chave ligada ou nao', async () => {
    const desligada = usar(mockClient({ pdvSettings: {}, stock: '50' }));
    expect((await sell(umItem)).status).toBe(201);

    const ligada = usar(mockClient({ pdvSettings: LIGADA, stock: '50' }));
    expect((await sell(umItem)).status).toBe(201);

    expect(settingsReads(ligada)).toBe(settingsReads(desligada));
  });
});

describe('/pdv-settings -- allow_sale_without_stock', () => {
  const url = `/api/v1/companies/${cid}/pdv-settings`;
  function mockSql(saved) {
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/SELECT pdv_settings(, vertical_active)? FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: saved }] });
      return Promise.resolve({ rows: [] });
    });
  }
  const gravado = () => JSON.parse(db.query.mock.calls.filter((c) => /UPDATE companies SET pdv_settings/i.test(String(c[0] || '')))[0][1][0]);

  test('GET: desligada para quem nunca mexeu', async () => {
    mockSql({ caixa_enabled: true });
    const res = await request(app).get(url).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.settings.allow_sale_without_stock).toBe(false);
  });

  test('PUT: true e gravado', async () => {
    mockSql({});
    const res = await request(app).put(url).set(adminAuth).send({ settings: { allow_sale_without_stock: true } });
    expect(res.status).toBe(200);
    expect(res.body.settings.allow_sale_without_stock).toBe(true);
    expect(gravado().allow_sale_without_stock).toBe(true);
  });

  test('PUT: texto no lugar de boolean => 400', async () => {
    mockSql({});
    const res = await request(app).put(url).set(adminAuth).send({ settings: { allow_sale_without_stock: 'sim' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allow_sale_without_stock deve ser boolean/);
  });

  test('PUT de outra chave nao desliga a que estava ligada', async () => {
    mockSql({ allow_sale_without_stock: true });
    const res = await request(app).put(url).set(adminAuth).send({ settings: { require_seller: true } });
    expect(res.status).toBe(200);
    expect(gravado()).toMatchObject({ allow_sale_without_stock: true, require_seller: true });
  });
});

describe('Financeiro (POST /transactions/:tx/sale-items)', () => {
  const url = `/api/v1/companies/${cid}/transactions/${txId}/sale-items`;

  function mockFinanceiro({ pdvSettings = {}, stock = '0' } = {}) {
    const query = jest.fn().mockImplementation((sql) => {
      const s = String(sql || '');
      if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: pdvSettings }] });
      if (/FROM transactions/i.test(s)) {
        return Promise.resolve({ rows: [{ id: txId, amount: '100.00', idempotency_key: 'pdv-sale-' + saleId, description: 'Venda', type: 'income', status: 'confirmed' }] });
      }
      if (/FROM sales/i.test(s)) return Promise.resolve({ rows: [{ id: saleId, total_amount: '100.00', status: 'completed' }] });
      if (/FROM products WHERE id/i.test(s)) return Promise.resolve({ rows: [{ id: prod, name: 'Cimento', price: '37.00', stock_qty: stock }] });
      if (/INSERT INTO sale_items/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 'item-1', product_id: prod, variant_id: null, quantity: '1', unit_price: '37.00', discount: '0', total_price: '37.00', product_name_snapshot: 'Cimento' }] });
      }
      return Promise.resolve({ rows: [{ id: saleId, total_amount: '137.00', amount: '137.00' }] });
    });
    return { query, release: jest.fn() };
  }
  const add = () => request(app).post(url).set(adminAuth).send({ product_id: prod, quantity: 1 });

  test('desligada: saldo zero => 400 Estoque insuficiente', async () => {
    const client = usar(mockFinanceiro({ pdvSettings: {}, stock: '0' }));
    const res = await add();
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Estoque insuficiente/);
    expect(callsMatching(client, /INSERT INTO sale_items/i)).toHaveLength(0);
  });

  test('ligada: saldo zero passa e a baixa tem piso zero', async () => {
    const client = usar(mockFinanceiro({ pdvSettings: LIGADA, stock: '0' }));
    const res = await add();
    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO sale_items/i)).toHaveLength(1);
    const baixa = callsMatching(client, /UPDATE products SET stock_qty/i);
    expect(baixa).toHaveLength(1);
    expect(baixa[0][0]).toMatch(/GREATEST\(0, COALESCE\(stock_qty, 0\) - \$1\)/);
  });

  test('com estoque a chave nem e consultada', async () => {
    const client = usar(mockFinanceiro({ pdvSettings: {}, stock: '10' }));
    await add();
    expect(settingsReads(client)).toBe(0);
    expect(callsMatching(client, /INSERT INTO sale_items/i)).toHaveLength(1);
  });
});
