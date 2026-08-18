// ============================================================
// AURA. — D3: árvore de categorias no payload público da vitrine
//
// O que estes testes provam:
//   1. O payload GANHA `categories` e os campos por produto — e o campo
//      `category` (texto) CONTINUA lá. Adiciona, nunca remove.
//   2. Categoria invisível na vitrine não entra, nem no topo nem no produto.
//   3. Produto sem vínculo devolve null — não inventa categoria a partir
//      do texto legado.
//   4. Base sem as migrations 257/258 (42P01) devolve o payload IDÊNTICO
//      ao de antes da D3.
//   5. `slug` sai no payload — é a semente das URLs canônicas por categoria.
//
// MOCK POR SQL, NUNCA POR POSIÇÃO. db.query vem do mock global.
// ============================================================
'use strict';

const db = require('../src/config/database');
const { buildStorefront } = require('../src/services/storefrontBuilder');

const CID = 'company-davi-1';

const CONFIG = {
  company_id: CID,
  slug: 'davi-calcados',
  show_prices: true,
};

function erro(code) {
  const e = new Error('pg: ' + code);
  e.code = code;
  return e;
}

// Despacha por SQL. `opts` liga cada fonte de dado.
function mockDb(opts = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM products/i.test(s) && /SELECT id, name, description/i.test(s)) {
      return { rows: opts.products || [] };
    }
    if (/FROM product_categories/i.test(s)) {
      if (opts.categoriasErro) throw opts.categoriasErro;
      return { rows: opts.categories || [] };
    }
    if (/FROM product_category_links/i.test(s)) {
      if (opts.linksErro) throw opts.linksErro;
      return { rows: opts.links || [] };
    }
    if (/FROM product_variants/i.test(s)) return { rows: [] };
    return { rows: [] };
  });
}

const PRODUTO = {
  id: 'p-1', name: 'Bota Cano Curto', description: null,
  price: '199.90', image_url: null, category: 'Botas', stock_qty: 3,
  created_at: '2026-08-01T00:00:00Z',
};

const CAT_BOTAS = {
  id: 'cat-botas', name: 'Botas', slug: 'botas',
  path: '/feminino/calcados/botas', depth: 2, parent_id: 'cat-calcados', sort_order: 1,
};

describe('D3 — taxonomia no payload público', () => {
  beforeEach(() => { db.query.mockReset(); });

  test('adiciona categories e os campos do produto, sem remover o texto legado', async () => {
    mockDb({
      products: [PRODUTO],
      categories: [CAT_BOTAS],
      links: [{ product_id: 'p-1', category_id: 'cat-botas' }],
    });

    const out = await buildStorefront(CONFIG);

    expect(out.categories).toHaveLength(1);
    expect(out.categories[0]).toEqual({
      id: 'cat-botas', name: 'Botas', slug: 'botas',
      path: '/feminino/calcados/botas', depth: 2, parent_id: 'cat-calcados',
    });

    const p = out.products[0];
    expect(p.category_id).toBe('cat-botas');
    expect(p.category_slug).toBe('botas');
    expect(p.category_path).toBe('/feminino/calcados/botas');
    // A regra que sustenta a compatibilidade: o texto continua.
    expect(p.category).toBe('Botas');
  });

  test('slug sai no payload — semente das URLs canônicas', async () => {
    mockDb({ products: [PRODUTO], categories: [CAT_BOTAS], links: [] });

    const out = await buildStorefront(CONFIG);

    expect(out.categories[0].slug).toBe('botas');
    // parent_id presente => o cliente deriva a hierarquia da lista flat.
    expect(out.categories[0]).toHaveProperty('parent_id');
  });

  test('categoria invisível na vitrine não entra — nem no topo nem no produto', async () => {
    // O SQL filtra por is_visible_storefront; o mock devolve lista vazia
    // para representar "a única categoria do produto está oculta".
    mockDb({
      products: [PRODUTO],
      categories: [],
      links: [{ product_id: 'p-1', category_id: 'cat-oculta' }],
    });

    const out = await buildStorefront(CONFIG);

    expect(out.categories).toEqual([]);
    expect(out.products[0].category_id).toBeNull();
    expect(out.products[0].category_slug).toBeNull();

    const sql = db.query.mock.calls.map(c => String(c[0])).find(s => /FROM product_categories/i.test(s));
    expect(sql).toMatch(/is_visible_storefront IS NOT FALSE/);
    expect(sql).toMatch(/type = 'product'/);
  });

  test('produto sem vínculo devolve null — não inventa categoria do texto', async () => {
    mockDb({ products: [PRODUTO], categories: [CAT_BOTAS], links: [] });

    const out = await buildStorefront(CONFIG);

    expect(out.products[0].category_id).toBeNull();
    expect(out.products[0].category_path).toBeNull();
    // O texto legado segue disponível para quem já o consome.
    expect(out.products[0].category).toBe('Botas');
  });

  test('base sem as migrations 257/258 devolve o payload de antes da D3', async () => {
    mockDb({
      products: [PRODUTO],
      categoriasErro: erro('42P01'),
      linksErro: erro('42P01'),
    });

    const out = await buildStorefront(CONFIG);

    expect(out.categories).toEqual([]);
    expect(out.products[0].category).toBe('Botas');
    expect(out.products[0].category_id).toBeNull();
    expect(out.total_products).toBe(1);
    // Nada de exceção vazando para a vitrine pública.
  });

  test('só busca vínculo quando há produto', async () => {
    mockDb({ products: [], categories: [CAT_BOTAS] });

    const out = await buildStorefront(CONFIG);

    expect(out.products).toEqual([]);
    const sqls = db.query.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => /FROM product_category_links/i.test(s))).toBe(false);
  });

  test('busca o vínculo PRIMÁRIO, não todos', async () => {
    mockDb({
      products: [PRODUTO],
      categories: [CAT_BOTAS],
      links: [{ product_id: 'p-1', category_id: 'cat-botas' }],
    });

    await buildStorefront(CONFIG);

    const sql = db.query.mock.calls.map(c => String(c[0])).find(s => /FROM product_category_links/i.test(s));
    expect(sql).toMatch(/is_primary/);
  });
});
