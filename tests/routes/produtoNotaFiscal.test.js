// ============================================================
// AURA. — Testes: "Sai em" no cadastro do item (migration 442)
//
// O que estes testes travam (banco simulado, mock por conteudo do SQL):
//   1. POST e PATCH aceitam nota_fiscal 'nfce' | 'nfse' | null (e camelCase);
//      valor fora disso = 400 com mensagem gentil, nada gravado.
//   2. POST sem o campo (ou com null) nao faz UPDATE nenhum — o cadastro de
//      hoje nao muda; PATCH com null limpa (volta a seguir o tipo).
//   3. Base atras da 442: o POST segue sem o campo, o PATCH repete o UPDATE
//      sem ele e a listagem cai um degrau (nota_fiscal null).
//   4. GET devolve o campo.
//   5. A baixa de estoque do produto que sai na NFS-e acontece no Caixa,
//      como a de qualquer produto.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const productsRouter = require('../../src/routes/products');
const pdvRouter = require('../../src/routes/pdv');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const pid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/products', productsRouter);
  scoped.use('/pdv', pdvRouter);
  app.use('/api/v1/companies/:id', scoped);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const app = buildApp();

function mockDb({ semColuna = false, linha = {} } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/AS in_group/i.test(s)) return Promise.resolve({ rows: [{ total: '3', in_group: false }] });
    if (semColuna && /\bnota_fiscal\b/.test(s)) {
      const e = new Error('column "nota_fiscal" of relation "products" does not exist');
      e.code = '42703';
      return Promise.reject(e);
    }
    if (/INSERT INTO products/i.test(s) || /UPDATE products SET/i.test(s)) {
      return Promise.resolve({ rows: [{ id: pid, name: 'Carimbo', unit: 'un', ...linha }] });
    }
    if (/COUNT\(\*\) AS total FROM products/i.test(s)) return Promise.resolve({ rows: [{ total: '1' }] });
    if (/FROM products/i.test(s)) return Promise.resolve({ rows: [{ id: pid, name: 'Carimbo', unit: 'un', price: '30', ...linha }] });
    return Promise.resolve({ rows: [] });
  });
}

const criar = (body) => request(app)
  .post(`/api/v1/companies/${cid}/products`).set(auth).send({ name: 'Carimbo', unit: 'un', stock_qty: 10, ...body });
const editar = (body) => request(app)
  .patch(`/api/v1/companies/${cid}/products/${pid}`).set(auth).send(body);
const chamadas = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const updatesNota = () => chamadas(/UPDATE products SET/i).filter((c) => /nota_fiscal/.test(String(c[0])));

describe('POST /products — nota_fiscal', () => {
  test('nfse grava e volta na resposta; o estoque do cadastro e o de sempre', async () => {
    mockDb({ linha: { nota_fiscal: 'nfse', stock_qty: '10' } });
    const r = await criar({ nota_fiscal: 'nfse' });
    expect(r.status).toBe(201);
    const ups = updatesNota();
    expect(ups).toHaveLength(1);
    expect(ups[0][1]).toEqual([pid, 'nfse']);
    expect(r.body.nota_fiscal).toBe('nfse');
    const [, paramsInsert] = chamadas(/INSERT INTO products/i)[0];
    expect(paramsInsert[8]).toBe(10); // stock_qty
  });

  test('camelCase e "NFC-e" tambem valem', async () => {
    mockDb({ linha: { nota_fiscal: 'nfce' } });
    const r = await criar({ notaFiscal: 'NFC-e' });
    expect(r.status).toBe(201);
    expect(updatesNota()[0][1]).toEqual([pid, 'nfce']);
  });

  test('sem o campo, ou null: nenhum UPDATE, resposta com null', async () => {
    mockDb();
    const r1 = await criar({});
    expect(r1.status).toBe(201);
    expect(r1.body.nota_fiscal).toBeNull();
    const r2 = await criar({ nota_fiscal: null });
    expect(r2.status).toBe(201);
    expect(updatesNota()).toHaveLength(0);
  });

  test('valor invalido: 400 gentil e nada e criado', async () => {
    mockDb();
    const r = await criar({ nota_fiscal: 'nfe' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Cupom fiscal \(NFC-e\) ou Nota de serviço \(NFS-e\)/);
    expect(chamadas(/INSERT INTO products/i)).toHaveLength(0);
  });

  test('base sem a 442: o produto e criado mesmo assim', async () => {
    mockDb({ semColuna: true });
    const r = await criar({ nota_fiscal: 'nfse' });
    expect(r.status).toBe(201);
    expect(r.body.nota_fiscal).toBeNull();
    expect(chamadas(/INSERT INTO products/i)).toHaveLength(1);
  });
});

describe('PATCH /products/:pid — nota_fiscal', () => {
  test('grava nfse', async () => {
    mockDb({ linha: { nota_fiscal: 'nfse' } });
    const r = await editar({ nota_fiscal: 'nfse' });
    expect(r.status).toBe(200);
    const [sql, params] = updatesNota()[0];
    expect(sql).toMatch(/nota_fiscal = \$1/);
    expect(params[0]).toBe('nfse');
    expect(r.body.nota_fiscal).toBe('nfse');
  });

  test('null limpa (volta a seguir o tipo)', async () => {
    mockDb();
    const r = await editar({ nota_fiscal: null });
    expect(r.status).toBe(200);
    expect(updatesNota()[0][1][0]).toBeNull();
    expect(r.body.nota_fiscal).toBeNull();
  });

  test('sem o campo: o UPDATE nao fala de nota_fiscal', async () => {
    mockDb();
    await editar({ name: 'Carimbo 2' });
    expect(chamadas(/UPDATE products SET/i)).toHaveLength(1);
    expect(updatesNota()).toHaveLength(0);
  });

  test('valor invalido: 400, nenhum UPDATE', async () => {
    mockDb();
    const r = await editar({ name: 'X', nota_fiscal: 'iss' });
    expect(r.status).toBe(400);
    expect(chamadas(/UPDATE products SET/i)).toHaveLength(0);
  });

  test('base sem a 442: repete o UPDATE sem a coluna (outros campos salvos)', async () => {
    mockDb({ semColuna: true });
    const r = await editar({ name: 'Carimbo 3', nota_fiscal: 'nfse' });
    expect(r.status).toBe(200);
    const ups = chamadas(/UPDATE products SET/i);
    expect(ups).toHaveLength(2);
    expect(String(ups[1][0])).not.toMatch(/nota_fiscal/);
    expect(String(ups[1][0])).toMatch(/name = \$1/);
  });
});

describe('GET /products — nota_fiscal', () => {
  test('coluna no SELECT e na resposta', async () => {
    mockDb({ linha: { nota_fiscal: 'nfse' } });
    const r = await request(app).get(`/api/v1/companies/${cid}/products`).set(auth);
    expect(r.status).toBe(200);
    const sqlLista = chamadas(/ORDER BY name/).map((c) => String(c[0]))[0];
    expect(sqlLista).toMatch(/\bnota_fiscal\b/);
    expect(r.body.products[0].nota_fiscal).toBe('nfse');
  });

  test('base sem a 442: cai um degrau e devolve null', async () => {
    mockDb({ semColuna: true });
    const r = await request(app).get(`/api/v1/companies/${cid}/products`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.products[0].nota_fiscal).toBeNull();
    const listas = chamadas(/ORDER BY name/);
    expect(listas).toHaveLength(2);
    expect(String(listas[1][0])).toMatch(/nfse_ctribnac/); // a 437 continua
  });
});

describe('Caixa: produto que sai na NFS-e baixa o estoque', () => {
  test('venda do carimbo (unit un, nota_fiscal nfse) faz a baixa e o movimento', async () => {
    const query = jest.fn().mockImplementation((sql) => {
      const s = String(sql || '');
      if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: {} }] });
      if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM products p JOIN companies c/i.test(s)) {
        return Promise.resolve({ rows: [{ name: 'Carimbo', cost_price: '8.00', stock_qty: '10', stock_company_id: cid, unit: 'un', nota_fiscal: 'nfse' }] });
      }
      if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '60.00' }] });
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: jest.fn() };
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const r = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`).set(auth)
      .send({ items: [{ product_id: pid, quantity: 2, unit_price: 30 }], payment_method: 'dinheiro' });

    expect(r.status).toBe(201);
    const baixa = query.mock.calls.filter((c) => /UPDATE products SET stock_qty/i.test(String(c[0])));
    expect(baixa).toHaveLength(1);
    expect(baixa[0][1]).toEqual([2, pid, cid]);
    expect(query.mock.calls.some((c) => /INSERT INTO stock_movements/i.test(String(c[0])))).toBe(true);
  });
});
