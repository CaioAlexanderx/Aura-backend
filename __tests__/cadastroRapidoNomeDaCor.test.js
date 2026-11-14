// ============================================================
// Cadastro rápido: o nome da cor entra (CP3 da revisão de cores, 14/11/2026)
// Antes, "Preta", "Caqui" e "Off White" sumiam sem aviso (só hex passava).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/onboardingProgress', () => ({ avancarSemEsperar: jest.fn() }));
jest.mock('../src/services/importCategoryLink', () => ({
  linkImportedCategories: jest.fn().mockResolvedValue({ linked: 0, pending: [], ambiguous: [], skipped: false }),
}));
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
app.use('/companies/:id/products', require('../src/routes/productsBatch'));

let insert;
beforeEach(() => {
  insert = null;
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    if (/COUNT\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ total: '0' }] });
    return Promise.resolve({ rows: [] });
  });
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      if (/INSERT INTO products/i.test(String(sql))) { insert = params; return Promise.resolve({ rows: [] }); }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  }));
});

test('hex segue hex; nome entra como a lojista escreveu; hex sem # e vazio ficam de fora', async () => {
  const cores = ['#FF0000', 'Preta', '  Off White  ', 'Caqui', 'ff0000', '', 'FFFFF'];
  const r = await request(app).post('/companies/c1/products/batch-create').send({
    products: cores.map((c, i) => ({ name: 'Peça ' + i, price: 10, color: c })),
  });
  expect(r.status).toBe(201);
  // 10 colunas por produto; a cor é a 10ª.
  const salvas = cores.map((_, i) => insert[i * 10 + 9]);
  expect(salvas).toEqual(['#FF0000', 'Preta', 'Off White', 'Caqui', null, null, null]);
});
