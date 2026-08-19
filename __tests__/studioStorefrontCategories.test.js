// ============================================================
// AURA Studio — S1: árvore de categorias no payload do Studio
//
// O D3 levou a taxonomia da F0 para o payload da loja comum e parou ali.
// O storefront do Studio só devolvia o texto legado `category` — sem id
// nem path, a vitrine não tem como agrupar as 9 canecas da Sheid numa
// página só, que é o alvo da F1.
//
// Os helpers vêm de storefrontBuilder: as duas regras que importam
// (só categoria com is_visible_storefront, só vínculo primário) valem
// igual nos dois storefronts. Estes testes garantem que continuam valendo
// aqui — inclusive a que impede produto compartilhado de outra empresa de
// arrastar a categoria dela para esta loja.
//
// MOCK POR SQL, NUNCA POR POSIÇÃO (CLAUDE.md).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const CID = 'c1';
const LOJA = {
  company_id: CID, slug: 'sheid-mania', is_published: true,
  site_name: 'Sheid Mania', company_display_name: 'Sheid Mania',
  pickup_enabled: true, delivery_enabled: true, delivery_fee: '10.00',
};

const CANECA_BRANCA = {
  id: 'p1', name: 'CANECA BRANCA', description: null, price: '39.90',
  image_url: null, category: 'Produtos', stock_qty: 10,
  customization_config: { fields: [] }, is_personalizable: true,
};
const CANECA_CHOPP = {
  id: 'p2', name: 'CANECA CHOPP', description: null, price: '70.00',
  image_url: null, category: 'Produtos', stock_qty: 5,
  customization_config: { fields: [] }, is_personalizable: true,
};

const CAT_CANECAS = {
  id: 'cat-1', name: 'Canecas', slug: 'canecas',
  path: 'canecas', depth: 0, parent_id: null, sort_order: 1,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/storefront', require('../src/routes/studioStorefront'));
  return app;
}

// links: { product_id: category_id }, cats: linhas de product_categories
function mockBanco({ cats = [CAT_CANECAS], links = {}, catsErr = null } = {}) {
  db.query.mockImplementation((sql) => {
    if (/FROM digital_channel_config/.test(sql)) return Promise.resolve({ rows: [LOJA] });
    if (/FROM products/.test(sql)) {
      return Promise.resolve({ rows: [CANECA_BRANCA, CANECA_CHOPP] });
    }
    if (/FROM product_categories/.test(sql)) {
      if (catsErr) return Promise.reject(catsErr);
      return Promise.resolve({ rows: cats });
    }
    if (/FROM product_category_links/.test(sql)) {
      return Promise.resolve({
        rows: Object.entries(links).map(([product_id, category_id]) => ({ product_id, category_id })),
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('S1 — GET /storefront/:slug/studio/products devolve a árvore', () => {
  beforeEach(() => { db.query.mockReset(); });

  test('categories[] sai flat com parent_id, no formato do payload da loja comum', async () => {
    mockBanco({
      cats: [
        CAT_CANECAS,
        { id: 'cat-2', name: 'Porcelana', slug: 'porcelana', path: 'canecas/porcelana', depth: 1, parent_id: 'cat-1', sort_order: 1 },
      ],
    });

    const res = await request(makeApp()).get('/storefront/sheid-mania/studio/products');

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([
      { id: 'cat-1', name: 'Canecas', slug: 'canecas', path: 'canecas', depth: 0, parent_id: null },
      { id: 'cat-2', name: 'Porcelana', slug: 'porcelana', path: 'canecas/porcelana', depth: 1, parent_id: 'cat-1' },
    ]);
  });

  test('produto vinculado recebe id, slug e path da categoria', async () => {
    mockBanco({ links: { p1: 'cat-1' } });

    const res = await request(makeApp()).get('/storefront/sheid-mania/studio/products');
    const p1 = res.body.products.find((p) => p.id === 'p1');

    expect(p1).toMatchObject({
      category_id: 'cat-1', category_slug: 'canecas', category_path: 'canecas',
    });
  });

  test('produto sem vínculo sai com os três campos null — catálogo pré-migração', async () => {
    mockBanco({ links: { p1: 'cat-1' } });

    const res = await request(makeApp()).get('/storefront/sheid-mania/studio/products');
    const p2 = res.body.products.find((p) => p.id === 'p2');

    expect(p2.category_id).toBeNull();
    expect(p2.category_slug).toBeNull();
    expect(p2.category_path).toBeNull();
  });

  // A regra que protege loja de grupo: o vínculo existe, mas aponta para
  // categoria que não está na árvore DESTA loja (outra empresa, ou
  // is_visible_storefront=false). Nesse caso o produto sai sem categoria,
  // nunca com a categoria alheia.
  test('vínculo para categoria fora da árvore desta loja não vaza', async () => {
    mockBanco({ cats: [CAT_CANECAS], links: { p1: 'cat-de-outra-empresa' } });

    const res = await request(makeApp()).get('/storefront/sheid-mania/studio/products');
    const p1 = res.body.products.find((p) => p.id === 'p1');

    expect(p1.category_id).toBeNull();
    expect(res.body.categories.map((c) => c.id)).toEqual(['cat-1']);
  });

  test('o texto legado `category` permanece — a mudança é aditiva', async () => {
    mockBanco({ links: { p1: 'cat-1' } });

    const res = await request(makeApp()).get('/storefront/sheid-mania/studio/products');

    expect(res.body.products.every((p) => p.category === 'Produtos')).toBe(true);
  });

  test('base sem as migrations 257/258 devolve categories vazio, sem quebrar', async () => {
    const err = new Error('relation "product_categories" does not exist');
    err.code = '42P01';
    mockBanco({ catsErr: err });

    const res = await request(makeApp()).get('/storefront/sheid-mania/studio/products');

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products[0].category_id).toBeNull();
  });
});
