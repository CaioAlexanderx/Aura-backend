// ============================================================
// AURA. — Orçamento público: rótulo dos campos da personalização (25/11/2026)
//
// A página /orcamento/:token mostrava a personalização do item pela chave
// do `customization`, que é o id do campo do produto. Agora cada item traz
// `customization_fields` (id, label, type) da config do produto, e a página
// mostra "Nome: Ana". Aditivo: o resto da resposta não muda.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const quotePublic = require('../src/routes/studioQuotePublic');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); });

const app = express();
app.use(express.json());
app.use('/orcamento', quotePublic);

const LINHA = {
  id: 'q1', token: 'tok-1', status: 'sent', expires_at: null,
  customer_name: 'Ana Souza', subtotal: '80', discount: '0', total: '80',
  deposit_pct: null, deposit_amount: null, response_note: null, responded_at: null,
  trade_name: 'Ateliê Lume', legal_name: null, site_name: null, logo_url: null,
  primary_color: null, secondary_color: null, font_family: null,
  dc_whatsapp: null, dc_phone: null, instagram: null,
  items: [{
    description: 'Caneca', quantity: 2, unit_price: 40,
    customization: { f_nome: 'Ana' },
    customization_fields: [{ id: 'f_nome', label: 'Nome', type: 'text' }],
  }],
};

test('o SELECT do item traz os campos da personalização do produto', async () => {
  db.query.mockImplementation((sql) => {
    if (/FROM studio_quotes q/.test(String(sql))) return Promise.resolve({ rows: [LINHA] });
    return Promise.resolve({ rows: [] });
  });
  const res = await request(app).get('/orcamento/tok-1');
  expect(res.status).toBe(200);
  expect(res.body.items[0].customization_fields).toEqual([{ id: 'f_nome', label: 'Nome', type: 'text' }]);
  expect(res.body.items[0].customization).toEqual({ f_nome: 'Ana' });

  const sql = String(db.query.mock.calls.find(([s]) => /FROM studio_quotes q/.test(String(s)))[0]);
  expect(sql).toMatch(/'customization_fields'/);
  expect(sql).toMatch(/p\.customization_config->'fields'/);
  // config sem lista de campos não derruba a página
  expect(sql).toMatch(/jsonb_typeof\(p\.customization_config->'fields'\) = 'array'/);
});
