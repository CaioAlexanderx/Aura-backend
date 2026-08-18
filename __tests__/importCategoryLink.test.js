// ============================================================
// AURA. — D4: importação vincula categoria ou deixa pendente no wizard
//
// O que estes testes provam:
//   1. Categoria que EXISTE na árvore vira VÍNCULO — e a rota nunca faz
//      UPDATE products SET category (quem escreve é o trigger).
//   2. Categoria que NÃO existe fica PENDENTE em category_migration_staging,
//      e o texto CONTINUA no produto — é a chave de junção do wizard.
//   3. Nome AMBÍGUO (mesmo nome em dois ramos) também fica pendente:
//      adivinhar o ramo colocaria produto na categoria errada em silêncio.
//   4. Desmarca a primária ANTES do insert (armadilha do índice parcial
//      one_primary, a mesma já paga em categoryMigration).
//   5. Base sem a árvore (42P01) não derruba a importação.
//
// MOCK POR SQL, NUNCA POR POSIÇÃO — o despacho lê a própria SQL.
// ============================================================
'use strict';

const { linkImportedCategories } = require('../src/services/importCategoryLink');

const CID = 'company-davi-1';

function erro(code) {
  const e = new Error('pg: ' + code);
  e.code = code;
  return e;
}

// Cliente pg falso que despacha por SQL e registra tudo o que rodou.
function fakeClient(handlers = {}) {
  const seen = [];
  return {
    seen,
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      seen.push({ sql: s, params });
      if (/FROM unnest\(\$2::text\[\]\) AS v\(valor\)/i.test(s)) {
        if (handlers.resolveErro) throw handlers.resolveErro;
        const valores = params[1];
        return { rows: valores.map(v => ({ valor: v, ids: (handlers.arvore || {})[v] || [] })) };
      }
      if (/INSERT INTO product_category_links/i.test(s)) {
        if (handlers.linkErro) throw handlers.linkErro;
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO category_migration_staging/i.test(s)) {
        if (handlers.stagingErro) throw handlers.stagingErro;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

const has = (c, re) => c.seen.some(q => re.test(q.sql));

describe('D4 — vínculo de categoria na importação', () => {
  test('categoria existente vira vínculo, e nada escreve products.category', async () => {
    const c = fakeClient({ arvore: { 'Sandalias': ['cat-sandalias'] } });

    const r = await linkImportedCategories(c, CID, [
      { id: 'p-1', category: 'Sandalias' },
      { id: 'p-2', category: 'Sandalias' },
    ]);

    expect(r.linked).toBe(2);
    expect(r.pending).toEqual([]);
    expect(has(c, /INSERT INTO product_category_links/i)).toBe(true);
    // A regra que sustenta o dual-write: a rota NUNCA escreve a coluna legada.
    expect(has(c, /UPDATE products SET category/i)).toBe(false);
    // Nada pendente => não mexe no staging.
    expect(has(c, /INSERT INTO category_migration_staging/i)).toBe(false);
  });

  test('desmarca a primária ANTES de inserir o vínculo', async () => {
    const c = fakeClient({ arvore: { 'Botas': ['cat-botas'] } });

    await linkImportedCategories(c, CID, [{ id: 'p-1', category: 'Botas' }]);

    const iDesmarca = c.seen.findIndex(q => /UPDATE product_category_links SET is_primary = false/i.test(q.sql));
    const iInsere   = c.seen.findIndex(q => /INSERT INTO product_category_links/i.test(q.sql));
    expect(iDesmarca).toBeGreaterThanOrEqual(0);
    expect(iDesmarca).toBeLessThan(iInsere);
  });

  test('categoria inexistente fica pendente no wizard e o texto fica no produto', async () => {
    const c = fakeClient({ arvore: {} });

    const r = await linkImportedCategories(c, CID, [
      { id: 'p-1', category: 'Sandalia Feminina Verao' },
    ]);

    expect(r.linked).toBe(0);
    expect(r.pending).toEqual(['Sandalia Feminina Verao']);
    expect(has(c, /INSERT INTO category_migration_staging/i)).toBe(true);
    expect(has(c, /INSERT INTO product_category_links/i)).toBe(false);
    // O texto é a chave de junção do wizard (products.category = raw_value):
    // apagá-lo perderia esses produtos de vista para sempre.
    expect(has(c, /UPDATE products SET category/i)).toBe(false);
  });

  test('nome ambíguo em dois ramos fica pendente, não escolhe sozinho', async () => {
    const c = fakeClient({ arvore: { 'Calcados': ['cat-fem-calcados', 'cat-masc-calcados'] } });

    const r = await linkImportedCategories(c, CID, [{ id: 'p-1', category: 'Calcados' }]);

    expect(r.linked).toBe(0);
    expect(r.ambiguous).toEqual(['Calcados']);
    expect(has(c, /INSERT INTO product_category_links/i)).toBe(false);
    expect(has(c, /INSERT INTO category_migration_staging/i)).toBe(true);
  });

  test('mistura: resolve o que dá, deixa o resto pendente', async () => {
    const c = fakeClient({ arvore: { 'Botas': ['cat-botas'] } });

    const r = await linkImportedCategories(c, CID, [
      { id: 'p-1', category: 'Botas' },
      { id: 'p-2', category: 'Botas' },
      { id: 'p-3', category: 'Chinelo Dedo' },
    ]);

    expect(r.linked).toBe(2);
    expect(r.pending).toEqual(['Chinelo Dedo']);
  });

  test('a contagem do staging é recontada de products, com o escopo do wizard', async () => {
    const c = fakeClient({ arvore: {} });

    await linkImportedCategories(c, CID, [{ id: 'p-1', category: 'Nova' }]);

    const sql = c.seen.find(q => /INSERT INTO category_migration_staging/i.test(q.sql)).sql;
    // Mesmo escopo de categoryMigration.analyze — senão o wizard mostra
    // dois números diferentes para a mesma coisa.
    expect(sql).toMatch(/is_active AND stock_qty > 0 AND \(unit IS NULL OR unit <> 'srv'\)/);
    expect(sql).toMatch(/ON CONFLICT \(company_id, COALESCE\(raw_value, '__NULL__'\)\)/);
  });

  test('produto sem categoria é ignorado, sem query nenhuma', async () => {
    const c = fakeClient({ arvore: {} });

    const r = await linkImportedCategories(c, CID, [
      { id: 'p-1', category: null },
      { id: 'p-2', category: '   ' },
    ]);

    expect(r.linked).toBe(0);
    expect(r.pending).toEqual([]);
    expect(c.query).not.toHaveBeenCalled();
  });

  test('base sem a árvore (42P01) não derruba a importação', async () => {
    const c = fakeClient({ resolveErro: erro('42P01') });

    const r = await linkImportedCategories(c, CID, [{ id: 'p-1', category: 'Botas' }]);

    expect(r.skipped).toBe(true);
    expect(r.linked).toBe(0);
    expect(has(c, /INSERT INTO product_category_links/i)).toBe(false);
  });

  test('falha ao vincular um valor vira pendente, sem derrubar os outros', async () => {
    const c = fakeClient({
      arvore: { 'Botas': ['cat-botas'], 'Tenis': ['cat-tenis'] },
      linkErro: erro('23503'),
    });

    const r = await linkImportedCategories(c, CID, [
      { id: 'p-1', category: 'Botas' },
      { id: 'p-2', category: 'Tenis' },
    ]);

    expect(r.linked).toBe(0);
    expect(r.pending.sort()).toEqual(['Botas', 'Tenis']);
    expect(has(c, /INSERT INTO category_migration_staging/i)).toBe(true);
  });
});
