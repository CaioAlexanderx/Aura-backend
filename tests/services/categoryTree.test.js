// ============================================================
// AURA. -- Testes: src/services/categoryTree.js (F0 Bloco B1)
// Mock por SQL (mockImplementation casando o texto da query), nunca
// fila posicional. beforeEach com resetAllMocks -- nunca clearAllMocks
// (nao limpa a fila de mockResolvedValueOnce entre testes).
// ============================================================
const categoryTree = require('../../src/services/categoryTree');
const { TREE_PRODUCT, COMPANY_A, flatten } = require('../fixtures/categoryTree');

function mockQueryable(handlers) {
  // handlers: array de [regex, fn(params) => result]
  return {
    query: jest.fn((sql, params) => {
      for (const [pattern, fn] of handlers) {
        if (pattern.test(sql)) return Promise.resolve(fn(params));
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('TREE_QUERY -- query canonica do contrato (secao 7)', () => {
  test('usa left(path, ...) -- NUNCA a variante LIKE...ESCAPE da spec v2 superada (secao 6.5)', () => {
    expect(categoryTree.TREE_QUERY).toMatch(/left\(d\.path, length\(p\.path\) \+ 1\) = p\.path \|\| '\/'/);
    expect(categoryTree.TREE_QUERY).not.toMatch(/LIKE/i);
    expect(categoryTree.TREE_QUERY).not.toMatch(/ESCAPE/i);
  });
  test('filtro de type fixo em product, parent_id IS NULL na raiz', () => {
    expect(categoryTree.TREE_QUERY).toMatch(/c\.type = 'product' AND c\.parent_id IS NULL/);
  });
});

describe('isUuid', () => {
  test('aceita uuid valido (qualquer caixa)', () => {
    expect(categoryTree.isUuid('08c05f0e-b75b-4c12-870e-d7fb65f1dca0')).toBe(true);
    expect(categoryTree.isUuid('08C05F0E-B75B-4C12-870E-D7FB65F1DCA0')).toBe(true);
  });
  test('rejeita nome comum', () => {
    expect(categoryTree.isUuid('Botas')).toBe(false);
    expect(categoryTree.isUuid('')).toBe(false);
    expect(categoryTree.isUuid(undefined)).toBe(false);
  });
});

describe('nestTree / shapeCategoryNode -- fixture de 3 niveis', () => {
  test('monta arvore aninhada com product_count_total por no', () => {
    // Achata a fixture (secao 6.3 da spec / tests/fixtures/categoryTree.js)
    // em linhas de query simuladas, com product_count fixo = 1 por no pra
    // facilitar a asserção de soma.
    const flat = flatten(TREE_PRODUCT);
    const idOf = new Map(flat.map((n) => [n.key, `id-${n.key}`]));
    const rows = flat.map((n) => ({
      id: idOf.get(n.key),
      company_id: COMPANY_A,
      type: 'product',
      parent_id: n.parentKey ? idOf.get(n.parentKey) : null,
      name: n.name,
      slug: n.expectedPath.split('/').pop(),
      path: n.expectedPath,
      depth: n.expectedDepth,
      sort_order: 0,
      color: null,
      image_url: null,
      banner_url: null,
      is_visible_storefront: true,
      seo_title: null,
      seo_description: null,
      product_count: 1,
      // product_count_total simulado: cada no soma 1 (proprio) + 1 por
      // descendente direto/indireto -- calculado aqui so pra depth=0.
      product_count_total: n.expectedDepth === 0
        ? flat.filter((x) => x.key === n.key || x.key.startsWith(`${n.key}>`)).length
        : flat.filter((x) => x.key === n.key || x.key.startsWith(`${n.key}>`)).length,
    }));

    const tree = categoryTree.nestTree(rows);

    // 3 raizes: Feminino, Masculino, Infantil
    expect(tree.map((n) => n.name).sort()).toEqual(['Feminino', 'Infantil', 'Masculino']);

    const feminino = tree.find((n) => n.name === 'Feminino');
    expect(feminino.depth).toBe(0);
    expect(feminino.children.map((c) => c.name).sort()).toEqual(['Acessorios', 'Calcados']);

    const calcados = feminino.children.find((c) => c.name === 'Calcados');
    expect(calcados.depth).toBe(1);
    expect(calcados.children).toHaveLength(4); // Botas, Sandalias, Scarpins, Tenis
    calcados.children.forEach((leaf) => expect(leaf.depth).toBe(2));

    // product_count_total de Feminino soma ele + todos os descendentes
    // (1 Feminino + 2 filhos diretos + 4+2 netos = 9)
    expect(feminino.product_count_total).toBe(9);
  });

  test('"Tenis" em Feminino e Masculino nao colide -- pais diferentes', () => {
    const flat = flatten(TREE_PRODUCT);
    const idOf = new Map(flat.map((n) => [n.key, `id-${n.key}`]));
    const rows = flat.map((n) => ({
      id: idOf.get(n.key), company_id: COMPANY_A, type: 'product',
      parent_id: n.parentKey ? idOf.get(n.parentKey) : null,
      name: n.name, path: n.expectedPath, depth: n.expectedDepth,
      sort_order: 0, product_count: 0, product_count_total: 0,
    }));
    const tree = categoryTree.nestTree(rows);
    const femininoTenis = tree.find((n) => n.name === 'Feminino').children
      .find((c) => c.name === 'Calcados').children.find((l) => l.name === 'Tenis');
    const masculinoTenis = tree.find((n) => n.name === 'Masculino').children
      .find((c) => c.name === 'Calcados').children.find((l) => l.name === 'Tenis');
    expect(femininoTenis.id).not.toBe(masculinoTenis.id);
    expect(femininoTenis.path).toBe('/feminino/calcados/tenis');
    expect(masculinoTenis.path).toBe('/masculino/calcados/tenis');
  });
});

describe('mapTriggerOrConstraintError -- contrato secao 6', () => {
  test('P0001 CATEGORY_CYCLE -> 422', () => {
    const mapped = categoryTree.mapTriggerOrConstraintError({ code: 'P0001', message: 'CATEGORY_CYCLE' });
    expect(mapped).toEqual({ status: 422, body: { error: expect.any(String), code: 'CATEGORY_CYCLE' } });
  });
  test('P0001 CATEGORY_CROSS_TENANT -> 403', () => {
    const mapped = categoryTree.mapTriggerOrConstraintError({ code: 'P0001', message: 'CATEGORY_CROSS_TENANT' });
    expect(mapped.status).toBe(403);
    expect(mapped.body.code).toBe('CATEGORY_CROSS_TENANT');
  });
  // Inalcancavel pela API da F0 (tudo e 'product'), mas mapeado
  // defensivamente -- contrato secao 6 / briefing secao 6.2.
  test('P0001 CATEGORY_TYPE_MISMATCH -> 422 (defensivo, inalcancavel pela API)', () => {
    const mapped = categoryTree.mapTriggerOrConstraintError({ code: 'P0001', message: 'CATEGORY_TYPE_MISMATCH' });
    expect(mapped.status).toBe(422);
    expect(mapped.body.code).toBe('CATEGORY_TYPE_MISMATCH');
  });
  test('23514 product_categories_depth_max -> 422 CATEGORY_MAX_DEPTH', () => {
    const mapped = categoryTree.mapTriggerOrConstraintError({ code: '23514', constraint: 'product_categories_depth_max' });
    expect(mapped.status).toBe(422);
    expect(mapped.body.code).toBe('CATEGORY_MAX_DEPTH');
  });
  test('23505 product_categories_unique_sibling -> 409 CATEGORY_DUPLICATE', () => {
    const mapped = categoryTree.mapTriggerOrConstraintError({ code: '23505', constraint: 'product_categories_unique_sibling' });
    expect(mapped.status).toBe(409);
    expect(mapped.body.code).toBe('CATEGORY_DUPLICATE');
  });
  test('erro nao mapeado devolve null (caller cai no 500 generico)', () => {
    expect(categoryTree.mapTriggerOrConstraintError({ code: '42P01', message: 'undefined_table' })).toBeNull();
    expect(categoryTree.mapTriggerOrConstraintError(null)).toBeNull();
  });
});

describe('resolveMoveTarget', () => {
  beforeEach(() => jest.resetAllMocks());

  test('uuid resolve direto por id', async () => {
    const q = mockQueryable([
      [/WHERE id = \$1 AND company_id = \$2 AND type = \$3/, () => ({ rows: [{ id: 'cat-1', path: '/feminino/botas' }] })],
    ]);
    const result = await categoryTree.resolveMoveTarget(q, { companyId: 'c1', type: 'product', raw: '08c05f0e-b75b-4c12-870e-d7fb65f1dca0' });
    expect(result).toEqual({ id: 'cat-1' });
  });

  test('nome unico resolve por name_norm', async () => {
    const q = mockQueryable([
      [/name_norm = lower\(btrim\(\$3\)\)/, () => ({ rows: [{ id: 'cat-2', path: '/masculino/botas' }] })],
    ]);
    const result = await categoryTree.resolveMoveTarget(q, { companyId: 'c1', type: 'product', raw: 'Botas' });
    expect(result).toEqual({ id: 'cat-2' });
  });

  test('nome ambiguo devolve candidatos (id, path)', async () => {
    const q = mockQueryable([
      [/name_norm = lower\(btrim\(\$3\)\)/, () => ({
        rows: [
          { id: 'cat-a', path: '/feminino/calcados/botas' },
          { id: 'cat-b', path: '/infantil/botas' },
        ],
      })],
    ]);
    const result = await categoryTree.resolveMoveTarget(q, { companyId: 'c1', type: 'product', raw: 'Botas' });
    expect(result.ambiguous).toHaveLength(2);
    expect(result.ambiguous).toEqual(expect.arrayContaining([
      { id: 'cat-a', path: '/feminino/calcados/botas' },
      { id: 'cat-b', path: '/infantil/botas' },
    ]));
  });

  test('nao encontrado devolve null', async () => {
    const q = mockQueryable([[/./, () => ({ rows: [] })]]);
    const result = await categoryTree.resolveMoveTarget(q, { companyId: 'c1', type: 'product', raw: 'Nao Existe' });
    expect(result).toBeNull();
  });
});

describe('moveLinks -- armadilha do one_primary (secao 6.1)', () => {
  beforeEach(() => jest.resetAllMocks());

  function mockClient(primaryRows) {
    const calls = [];
    const client = {
      query: jest.fn((sql, params) => {
        calls.push(sql);
        if (/SELECT product_id FROM product_category_links WHERE category_id = ANY/.test(sql)) {
          return Promise.resolve({ rows: primaryRows });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    return { client, calls };
  }

  test('INSERT usa DO NOTHING e a reafirmacao de primaria e um statement SEPARADO', async () => {
    const { client, calls } = mockClient([{ product_id: 'p1' }, { product_id: 'p2' }]);
    const result = await categoryTree.moveLinks(client, { sourceIds: ['src-1'], targetId: 'dest-1' });

    expect(result.moved_products).toBe(2);
    const insertCall = calls.find((c) => /INSERT INTO product_category_links/.test(c));
    expect(insertCall).toMatch(/ON CONFLICT \(product_id, category_id\) DO NOTHING/);
    const deleteCall = calls.find((c) => /^DELETE FROM product_category_links/.test(c.trim()));
    expect(deleteCall).toBeDefined();
    const reaffirmCall = calls.find((c) => /UPDATE product_category_links SET is_primary = true/.test(c));
    expect(reaffirmCall).toBeDefined();
    // A reafirmacao acontece DEPOIS do INSERT e do DELETE -- statement separado.
    expect(calls.indexOf(insertCall)).toBeLessThan(calls.indexOf(reaffirmCall));
    expect(calls.indexOf(deleteCall)).toBeLessThan(calls.indexOf(reaffirmCall));
  });

  test('sem primarias na origem, nao executa o UPDATE de reafirmacao', async () => {
    const { client, calls } = mockClient([]);
    const result = await categoryTree.moveLinks(client, { sourceIds: ['src-1'], targetId: 'dest-1' });
    expect(result.moved_products).toBe(0);
    expect(calls.some((c) => /UPDATE product_category_links SET is_primary = true/.test(c))).toBe(false);
  });
});

describe('findSiblingId', () => {
  beforeEach(() => jest.resetAllMocks());

  test('casa por (company_id, type, parent_id, name_norm) -- mesma regra do indice unique_sibling', async () => {
    const q = mockQueryable([
      [/name_norm = lower\(btrim\(\$4\)\)/, (params) => ({ rows: [{ id: 'existing-1' }] , params })],
    ]);
    const id = await categoryTree.findSiblingId(q, { companyId: 'c1', type: 'product', parentId: 'p1', name: 'Botas' });
    expect(id).toBe('existing-1');
  });

  test('nao encontrado devolve null', async () => {
    const q = mockQueryable([[/./, () => ({ rows: [] })]]);
    const id = await categoryTree.findSiblingId(q, { companyId: 'c1', type: 'product', parentId: null, name: 'Nao Existe' });
    expect(id).toBeNull();
  });
});
