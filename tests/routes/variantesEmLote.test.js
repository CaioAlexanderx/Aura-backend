// ============================================================
// AURA. — GET /products/variants?product_ids= (p-73, 30/10/2026)
// Testes com banco simulado: uma consulta só, validação e montagem do
// mapa. A regra de grupo contra o Postgres real está em
// __tests__/variantesEmLote.banco.test.js.
// ============================================================
const express = require('express');
const request = require('supertest');

const productsRouter = require('../../src/routes/products');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const p1 = '11111111-1111-4111-8111-111111111111';
const p2 = '22222222-2222-4222-8222-222222222222';

const app = express();
app.use(express.json());
app.use('/companies/:id/products', productsRouter);

const url = `/companies/${cid}/products/variants`;

describe('GET /products/variants (lote)', () => {
  test('uma consulta só, com ANY e a regra de grupo da listagem', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { visible_product_id: p1, product_id: p1, id: 'v1', sku_suffix: 'AZUL-M', price_override: '59.90',
          stock_qty: '2.000', barcode: '2100000000015', color_name: 'Azul',
          attributes: [{ attribute: 'Cor', value: '#3B82F6' }, { attribute: 'Tamanho', value: 'M' }] },
        { visible_product_id: p2, product_id: null, id: null, sku_suffix: null, price_override: null,
          stock_qty: null, barcode: null, color_name: null, attributes: [] },
      ],
    });
    const r = await request(app).get(url).query({ product_ids: `${p1},${p2},${p1},xyz` });
    expect(r.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain('p.id = ANY($2::uuid[])');
    expect(flat).toContain('pv.is_active = true');
    expect(flat).toContain('p.is_group_shared = true');
    expect(flat).toContain('(p.company_id = $1 OR');
    expect(params).toEqual([cid, [p1, p2]]);

    expect(r.body.variants_by_product[p2]).toEqual([]);
    expect(r.body.variants_by_product[p1]).toEqual([{
      id: 'v1', product_id: p1, sku_suffix: 'AZUL-M', price_override: '59.90', stock_qty: '2.000',
      barcode: '2100000000015', color_name: 'Azul',
      attributes: [{ attribute: 'Cor', value: '#3B82F6' }, { attribute: 'Tamanho', value: 'M' }],
      color: '#3B82F6', size: 'M', price: 59.9, is_active: true,
    }]);
  });

  test('sem product_ids -> 400, sem ir ao banco', async () => {
    const r = await request(app).get(url);
    expect(r.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('mais de 200 ids distintos -> 400', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const r = await request(app).get(url).query({ product_ids: ids.join(',') });
    expect(r.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('exatamente 200 passa', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const r = await request(app).get(url).query({ product_ids: ids.join(',') });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ variants_by_product: {} });
  });

  test('só ids inválidos -> mapa vazio, sem ir ao banco', async () => {
    const r = await request(app).get(url).query({ product_ids: 'abc,def' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ variants_by_product: {} });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('tamanho sem nome de atributo conhecido cai no primeiro valor que não é cor', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ visible_product_id: p1, product_id: p1, id: 'v9', sku_suffix: '42', price_override: null,
        stock_qty: '1.000', barcode: null, color_name: null,
        attributes: [{ attribute: 'Numeração', value: '42' }] }],
    });
    const r = await request(app).get(url).query({ product_ids: p1 });
    expect(r.body.variants_by_product[p1][0]).toMatchObject({ size: '42', color: null, price: null });
  });

  test('erro no banco -> 500', async () => {
    db.query.mockRejectedValueOnce(new Error('boom'));
    const r = await request(app).get(url).query({ product_ids: p1 });
    expect(r.status).toBe(500);
  });
});
