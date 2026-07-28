// ============================================================
// AURA. -- Fixture de arvore de categorias (F0 Bloco A)
// Consumido por B1 (tests/services/categoryTree.test.js) e por B2.
// Espelha a arvore de calcados proposta na spec v2 secao 6.3, passo 2.
//
// Convencao do repo: strings PT-BR em codigo SEM acento. A unica
// excecao e SLUG_CASES, que precisa de entrada acentuada para exercitar
// unaccent() dentro de category_slugify().
// ============================================================

const COMPANY_A = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0'; // Davi Matriz
const COMPANY_B = 'ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc'; // Davi Villa Branca

// Arvore de 3 niveis. depth/slug/path sao calculados pelo trigger
// trg_category_path_maintain (migration 259) -- nunca informados no INSERT.
const TREE_PRODUCT = [
  {
    name: 'Feminino',
    type: 'product',
    expectedSlug: 'feminino',
    expectedPath: '/feminino',
    expectedDepth: 0,
    children: [
      {
        name: 'Calcados',
        type: 'product',
        expectedSlug: 'calcados',
        expectedPath: '/feminino/calcados',
        expectedDepth: 1,
        children: [
          { name: 'Botas',     type: 'product', expectedPath: '/feminino/calcados/botas',     expectedDepth: 2 },
          { name: 'Sandalias', type: 'product', expectedPath: '/feminino/calcados/sandalias', expectedDepth: 2 },
          { name: 'Scarpins',  type: 'product', expectedPath: '/feminino/calcados/scarpins',  expectedDepth: 2 },
          { name: 'Tenis',     type: 'product', expectedPath: '/feminino/calcados/tenis',     expectedDepth: 2 },
        ],
      },
      {
        name: 'Acessorios',
        type: 'product',
        expectedPath: '/feminino/acessorios',
        expectedDepth: 1,
        children: [
          { name: 'Bolsas', type: 'product', expectedPath: '/feminino/acessorios/bolsas', expectedDepth: 2 },
          { name: 'Cintos', type: 'product', expectedPath: '/feminino/acessorios/cintos', expectedDepth: 2 },
        ],
      },
    ],
  },
  {
    name: 'Masculino',
    type: 'product',
    expectedPath: '/masculino',
    expectedDepth: 0,
    children: [
      {
        name: 'Calcados',
        type: 'product',
        expectedPath: '/masculino/calcados',
        expectedDepth: 1,
        children: [
          { name: 'Sapatos sociais', type: 'product', expectedPath: '/masculino/calcados/sapatos-sociais', expectedDepth: 2 },
          { name: 'Sapatenis',       type: 'product', expectedPath: '/masculino/calcados/sapatenis',       expectedDepth: 2 },
          { name: 'Tenis',           type: 'product', expectedPath: '/masculino/calcados/tenis',           expectedDepth: 2 },
        ],
      },
    ],
  },
  {
    name: 'Infantil',
    type: 'product',
    expectedPath: '/infantil',
    expectedDepth: 0,
    children: [
      { name: 'Menina', type: 'product', expectedPath: '/infantil/menina', expectedDepth: 1 },
      { name: 'Menino', type: 'product', expectedPath: '/infantil/menino', expectedDepth: 1 },
    ],
  },
];

// 'Tenis' aparece em Feminino, Masculino e (potencialmente) Infantil.
// Slug identico sob pais DIFERENTES nao colide -- o indice unico e por
// (company_id, type, parent_id, name_norm). Usado para provar isso.
const DUPLICATE_LEAF_NAME = 'Tenis';

// Arvore de servico: mesmo nome de raiz que a de produto NAO colide,
// porque o indice unico inclui type.
const TREE_SERVICE = [
  { name: 'Feminino', type: 'service', expectedPath: '/feminino', expectedDepth: 0 },
];

// Entrada acentuada -> saida esperada de category_slugify().
// Unica excecao a convencao de "sem acento em codigo".
const SLUG_CASES = [
  { input: 'Cal\u00e7ados',        expected: 'calcados' },
  { input: 'Sand\u00e1lias',       expected: 'sandalias' },
  { input: 'T\u00eanis',           expected: 'tenis' },
  { input: 'Sapat\u00eanis',       expected: 'sapatenis' },
  { input: '  Botas  ',           expected: 'botas' },
  { input: 'Cano Alto',           expected: 'cano-alto' },
  { input: 'Peep-Toe',            expected: 'peep-toe' },
  { input: 'A / B',               expected: 'a-b' },
  { input: '---',                 expected: '' },   // trigger cai no fallback 'categoria'
  { input: '',                    expected: '' },
];

// Casos que devem levantar erro. As tres primeiras strings vem de
// RAISE EXCEPTION em trigger e chegam como SQLSTATE P0001.
const ERROR_CASES = {
  maxDepth:    { sqlstate: '23514', message: 'product_categories_depth_max' },
  cycle:       { sqlstate: 'P0001', message: 'CATEGORY_CYCLE' },
  typeMismatch:{ sqlstate: 'P0001', message: 'CATEGORY_TYPE_MISMATCH' },
  crossTenant: { sqlstate: 'P0001', message: 'CATEGORY_CROSS_TENANT' },
  duplicate:   { sqlstate: '23505', message: 'product_categories_unique_sibling' },
};

// Achata a arvore em lista de INSERTs na ordem correta (pai antes do filho).
function flatten(nodes, parentKey = null, acc = []) {
  for (const n of nodes) {
    const key = (parentKey ? `${parentKey}>` : '') + n.name;
    acc.push({
      key,
      parentKey,
      name: n.name,
      type: n.type,
      expectedPath: n.expectedPath,
      expectedDepth: n.expectedDepth,
    });
    if (n.children) flatten(n.children, key, acc);
  }
  return acc;
}

module.exports = {
  COMPANY_A,
  COMPANY_B,
  TREE_PRODUCT,
  TREE_SERVICE,
  DUPLICATE_LEAF_NAME,
  SLUG_CASES,
  ERROR_CASES,
  flatten,
};
