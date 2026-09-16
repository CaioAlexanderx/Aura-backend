// ============================================================
// GET /sales/:id — o que foi devolvido aparece (16/09/2026)
// Caso MHT / Karina Quadros: o Vans 42/43 devolvido seguia listado como
// vendido na tela de Vendas ("o 42 permanece"), e a venda de devolução
// abria com zero itens.
//
//   1. venda com devolução ativa: item com returned/available + returns[]
//   2. venda type='devolucao': bloco devolucao com o que voltou
//   3. tabela de trocas ausente (42P01): detalhe abre igual a antes
// ============================================================
jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const router = require('../src/routes/sales');
const app = express();
app.use(express.json());
app.use('/companies/:id/sales', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));

const CID = 'comp-1';

function despachar({ tipo = 'sale', semTabela = false } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM sales s\s+LEFT JOIN customers/i.test(s)) {
      return Promise.resolve({ rows: [{
        id: 'S', company_id: CID, type: tipo, status: 'completed', sale_number: tipo === 'sale' ? 34 : 40,
        total_amount: tipo === 'sale' ? '290.00' : '-120.00', exchange_of_sale_id: tipo === 'sale' ? null : 'S34',
        created_at: '2026-09-14T20:16:51Z',
      }] });
    }
    if (/FROM sale_items si/i.test(s)) {
      return Promise.resolve({ rows: tipo === 'sale' ? [
        { id: 'i-vans', quantity: '1', unit_price: '120', total_price: '120', product_name: 'VANS HYLANE 42/43' },
        { id: 'i-sand', quantity: '1', unit_price: '85', total_price: '85', product_name: 'SANDALIA 34/35' },
      ] : [] });
    }
    if (/troca_returned_items/i.test(s)) {
      if (semTabela) { const e = new Error('relation does not exist'); e.code = '42P01'; return Promise.reject(e); }
      if (/GROUP BY tri.original_sale_item_id/.test(s)) return Promise.resolve({ rows: [{ item_id: 'i-vans', qty: '1' }] });
      if (/SELECT DISTINCT ts.id/.test(s)) return Promise.resolve({ rows: [{ id: 'D40', sale_number: 40, type: 'devolucao' }] });
      if (/WHERE tri.troca_sale_id = \$1/.test(s)) {
        return Promise.resolve({ rows: [{ quantity: '1', unit_price: '120', product_name: 'VANS HYLANE 42/43', original_sale_number: 34 }] });
      }
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => { db.query.mockReset(); });

test('1. item devolvido vem marcado e a devolução ativa aparece', async () => {
  despachar();
  const res = await request(app).get(`/companies/${CID}/sales/S`);

  expect(res.status).toBe(200);
  const vans = res.body.items.find((i) => i.id === 'i-vans');
  const sand = res.body.items.find((i) => i.id === 'i-sand');
  expect(vans).toMatchObject({ returned_quantity: 1, available_quantity: 0 });
  expect(sand).toMatchObject({ returned_quantity: 0, available_quantity: 1 });
  expect(res.body.returns).toEqual([{ id: 'D40', sale_number: 40, type: 'devolucao' }]);
  expect(res.body.devolucao).toBeNull();
});

test('2. venda de devolução traz o que voltou e a venda de origem', async () => {
  despachar({ tipo: 'devolucao' });
  const res = await request(app).get(`/companies/${CID}/sales/D40`);

  expect(res.status).toBe(200);
  expect(res.body.devolucao).toEqual({
    original_sale_id: 'S34',
    original_sale_number: 34,
    refund_value: 120,
    items: [{ product_id: undefined, variant_id: undefined, quantity: 1, unit_price: 120, product_name: 'VANS HYLANE 42/43' }],
  });
});

test('3. sem a tabela de trocas, o detalhe abre como antes', async () => {
  despachar({ semTabela: true });
  const res = await request(app).get(`/companies/${CID}/sales/S`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2);
  expect(res.body.items[0]).toMatchObject({ returned_quantity: 0, available_quantity: 1 });
  expect(res.body.returns).toEqual([]);
});
