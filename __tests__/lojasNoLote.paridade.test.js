// ============================================================
// AURA. — Paridade: lista sem `lojas` grava e responde como antes (B2, 20/11/2026)
//
// O registro `__tests__/fixtures/lojasNoLote.paridade.json` foi gravado com
// o codigo de ANTES do B2 (origin/main 8c2ff480), rodando este arquivo com
// GRAVAR_PARIDADE=1. Ele guarda toda escrita no banco (INSERT/UPDATE/DELETE,
// SQL e parametros, na ordem) e a resposta. O teste compara o codigo de hoje
// com esse registro, para loja sozinha e para loja de grupo que separou o
// estoque (as duas nascem privadas, como sempre).
//
// O que muda de proposito (D12) fica fora da paridade e tem teste proprio
// (lojasNoLote.banco.test.js): grupo de estoque unico nasce compartilhado.
// A planilha tem a paridade dela em tests/routes/importProdutosParidadeSemGrade
// e a "Chegou mercadoria" sem `lojas` nao faz nenhuma consulta nova.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database');
jest.mock('../src/services/onboardingProgress', () => ({ avancarSemEsperar: jest.fn() }));
jest.mock('../src/services/importCategoryLink', () => ({
  linkImportedCategories: jest.fn().mockResolvedValue({ linked: 1, pending: ['Blusas'], ambiguous: [], skipped: false }),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const FIXTURE = path.join(__dirname, 'fixtures', 'lojasNoLote.paridade.json');
const CID = '11111111-2222-4333-8444-555555555555';

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
app.use('/companies/:id/products', require('../src/routes/productsBatch'));

function bancoQueGrava({ separado }) {
  const escritas = [];
  const grava = (sql, params) => {
    const s = String(sql);
    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(s)) escritas.push({ sql: s, params: params || [] });
  };
  db.query.mockImplementation(async (sql, params) => {
    grava(sql, params);
    const s = String(sql);
    if (/SELECT COUNT\(\*\) AS total FROM products/.test(s)) return { rows: [{ total: '10' }] };
    if (/LOWER\(name\) = ANY/.test(s)) return { rows: [{ name: 'blusa', category: 'Blusas' }] };
    // grupo (so o codigo novo pergunta): 2 empresas, uma separou o estoque
    if (/AS empresas/.test(s)) return { rows: [{ empresas: separado ? 2 : 1, separadas: separado ? 1 : 0 }] };
    return { rows: [] };
  });
  db.connect.mockImplementation(async () => ({
    query: async (sql, params) => {
      grava(sql, params);
      if (/INSERT INTO products/.test(String(sql))) {
        return { rows: [{ id: 'p-1', name: 'Blusa', sku: 'B1', barcode: '789', category: 'Blusas', price: '59.90', cost_price: '20.00', stock_qty: 3, size: 'M', color: 'Preta', created_at: '2026-11-20T12:00:00.000Z' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  }));
  return escritas;
}

const CORPO = {
  products: [
    { name: 'Blusa', price: '59.90', cost_price: 20, stock_qty: '3', category: 'Blusas', size: 'M', color: 'Preta', sku: 'B1', barcode: '789' },
    { name: '', price: 1 },
    { name: 'Saia', price: 0, color: '#FF0000' },
  ],
};

async function rodar(caso) {
  db.query.mockReset();
  db.connect.mockReset();
  const escritas = bancoQueGrava(caso);
  const r = await request(app).post(`/companies/${CID}/products/batch-create`).send(CORPO);
  return { status: r.status, body: r.body, escritas };
}

test('lista sem lojas: mesmas escritas e mesma resposta (loja sozinha e grupo que separou o estoque)', async () => {
  const atual = {
    sozinha: await rodar({ separado: false }),
    grupo_separado: await rodar({ separado: true }),
  };
  if (process.env.GRAVAR_PARIDADE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(atual, null, 2) + '\n');
    return;
  }
  const registro = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  expect(atual).toEqual(registro);
  expect(atual.sozinha.escritas.length).toBeGreaterThan(0);
});
