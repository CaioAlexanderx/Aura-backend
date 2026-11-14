// ============================================================
// Cupom do Caixa: a variante sai com o NOME da cor (CP2a da revisão de
// cores, 14/11/2026 — decisão do Caio). Antes: o sku_suffix ("OFF WHITE-M").
// O cupom de venda sem variante, ou de variante sem atributo, não muda
// (cupom.logoDaLoja.test.js trava o HTML byte a byte).
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const LOJA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const VENDA = '5b1d3f0a-0000-4000-8000-000000000043';

const app = express();
app.use('/companies/:id/print', require('../src/routes/print'));

const cor = (hex, tam) => [{ attribute: 'Cor', value: hex }, { attribute: 'Tamanho', value: tam }];
const ITENS = [
  { product_name: 'Vestido Midi', variant_id: 'v1', quantity: 1, unit_price: 189.9, total_price: 189.9, discount: 0,
    variant_label: 'OFF WHITE-M', variant_color_name: 'Off White', variant_attrs: cor('#FAF9F6', 'M') },
  { product_name: 'Vestido Midi', variant_id: 'v2', quantity: 1, unit_price: 189.9, total_price: 189.9, discount: 0,
    variant_label: 'AZUL ESCUR-G', variant_color_name: 'AZUL ESCUR', variant_attrs: cor('#1F2A44', 'G') },
  { product_name: 'Saia', variant_id: 'v3', quantity: 1, unit_price: 99, total_price: 99, discount: 0,
    variant_label: 'CAQUI-P', variant_color_name: null, variant_attrs: cor('#C3B091', 'P') },
  { product_name: 'Blusa', variant_id: 'v4', quantity: 1, unit_price: 59, total_price: 59, discount: 0,
    variant_label: 'X<Y', variant_color_name: '<b>Lua</b>', variant_attrs: cor('#000000', 'U') },
  { product_name: 'Meia', variant_id: 'v5', quantity: 1, unit_price: 9, total_price: 9, discount: 0,
    variant_label: 'KIT-3', variant_color_name: null, variant_attrs: null },
];

beforeEach(() => {
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [{ trade_name: 'Loja', legal_name: 'Loja LTDA' }] });
    if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [{ id: VENDA, total_amount: '546.80', created_at: '2026-11-14T15:00:00.000Z', payment_method: 'pix' }] });
    if (/FROM sale_items/i.test(s)) return Promise.resolve({ rows: ITENS.map((i) => ({ ...i })) });
    return Promise.resolve({ rows: [] });
  });
});

test('nome gravado, nome cortado (vira a paleta), sufixo legível e escape', async () => {
  const html = (await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`)).text;
  expect(html).toContain('Vestido Midi <small>(Off White · M)</small>');
  expect(html).toContain('Vestido Midi <small>(Cinza escuro · G)</small>');
  expect(html).not.toContain('AZUL ESCUR');
  expect(html).toContain('Saia <small>(Caqui · P)</small>');
  expect(html).toContain('Blusa <small>(&lt;b&gt;Lua&lt;/b&gt; · U)</small>');
  // Variante sem atributo: o sufixo, como sempre.
  expect(html).toContain('Meia <small>(KIT-3)</small>');
});

test('a consulta pede o color_name e os atributos da variante', async () => {
  await request(app).get(`/companies/${LOJA}/print/receipt/${VENDA}`);
  const sql = db.query.mock.calls.map((c) => String(c[0])).find((s) => /FROM sale_items/i.test(s));
  expect(sql).toMatch(/pv\.color_name AS variant_color_name/);
  expect(sql).toMatch(/AS variant_attrs/);
});
