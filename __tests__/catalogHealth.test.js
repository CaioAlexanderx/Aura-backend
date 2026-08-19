// ============================================================
// AURA. — E1: índice de saúde do catálogo (F0, Onda E)
//
// O que estes testes provam:
//   1. `categoria_arvore` mede VÍNCULO, não texto. Medir texto daria
//      número bonito e esconderia o trabalho que a fase existe para
//      fazer — na Davi, 251 têm texto e 0 têm vínculo.
//   2. Órfão é quem não tem categoria por caminho NENHUM (sem vínculo
//      E sem texto).
//   3. Serviço fica fora do escopo (F0 é product-only) e estoque zerado
//      fica DENTRO (produto parado ainda precisa de foto).
//   4. A quebra por categoria conta a SUBÁRVORE — contar só o vínculo
//      direto faria o nó pai parecer vazio.
//   5. Base sem as migrations 257/258 devolve o resumo com a árvore
//      zerada, em vez de estourar 500.
//
// MOCK POR SQL, NUNCA POR POSIÇÃO. db.query vem do mock global.
// ============================================================
'use strict';

const db = require('../src/config/database');
const { health } = require('../src/services/catalogHealth');

const CID = 'company-davi-1';

function erro(code) {
  const e = new Error('pg: ' + code);
  e.code = code;
  return e;
}

// Números reais da Davi Calçados, medidos em produção em 18/08.
const RESUMO_DAVI = {
  total: 1434, com_categoria_texto: 251, com_foto: 147,
  com_descricao: 0, com_custo: 1424, com_marca: 0,
};

function isResumo(sql)   { return /COUNT\(\*\) FILTER \(WHERE p\.image_url IS NOT NULL\)/.test(sql) && /FROM products p/.test(sql); }
function isVinculo(sql)  { return /JOIN product_category_links l ON l\.product_id = p\.id AND l\.is_primary/.test(sql); }
function isOrfaos(sql)   { return /NOT EXISTS/.test(sql) && /product_category_links/.test(sql); }
function isPorCat(sql)   { return /FROM product_categories c/.test(sql) && /GROUP BY c\.id/.test(sql); }

function mockDb(opts = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (isPorCat(s))  { if (opts.catErro) throw opts.catErro; return { rows: opts.porCategoria || [] }; }
    if (isOrfaos(s))  return { rows: [{ n: opts.orfaos ?? 0 }] };
    if (isVinculo(s)) { if (opts.vinculoErro) throw opts.vinculoErro; return { rows: [{ n: opts.comVinculo ?? 0 }] }; }
    if (isResumo(s))  return { rows: [opts.resumo || RESUMO_DAVI] };
    return { rows: [] };
  });
}

describe('E1 — saúde do catálogo', () => {
  beforeEach(() => { db.query.mockReset(); });

  test('categoria_arvore mede vínculo; categoria_texto mede o legado', async () => {
    mockDb({ comVinculo: 0, orfaos: 1183 });

    const h = await health(CID);

    // O par que conta: 0% no modelo novo, 17,5% no legado. Essa distância
    // é o indicador da fase.
    expect(h.cobertura.categoria_arvore).toEqual({ com: 0, sem: 1434, pct: 0 });
    expect(h.cobertura.categoria_texto.com).toBe(251);
    expect(h.cobertura.categoria_texto.pct).toBe(17.5);
  });

  test('percentuais batem com os números reais da Davi', async () => {
    mockDb({ comVinculo: 0, orfaos: 1183 });

    const h = await health(CID);

    expect(h.total).toBe(1434);
    expect(h.cobertura.foto.pct).toBe(10.3);
    expect(h.cobertura.descricao).toEqual({ com: 0, sem: 1434, pct: 0 });
    expect(h.cobertura.custo.pct).toBe(99.3);
    expect(h.cobertura.marca.pct).toBe(0);
  });

  test('órfão é quem não tem categoria por caminho nenhum', async () => {
    mockDb({ comVinculo: 0, orfaos: 1183 });

    const h = await health(CID);

    expect(h.orfaos).toBe(1183);
    const sql = db.query.mock.calls.map(c => String(c[0])).find(isOrfaos);
    // Tem que exigir as DUAS ausências: sem texto E sem vínculo.
    expect(sql).toMatch(/NOT \(p\.category IS NOT NULL/);
    expect(sql).toMatch(/NOT EXISTS/);
  });

  test('serviço fica fora do escopo e estoque zerado fica dentro', async () => {
    mockDb({});
    await health(CID);

    const sql = db.query.mock.calls.map(c => String(c[0])).find(isResumo);
    expect(sql).toMatch(/p\.unit IS NULL OR p\.unit <> 'srv'/);
    expect(sql).toMatch(/p\.is_active IS TRUE/);
    // Produto parado ainda precisa de foto — nada de stock_qty aqui.
    // (O analyze do wizard usa stock_qty > 0; ver comentário do serviço.)
    expect(sql).not.toMatch(/stock_qty/);
  });

  test('quebra por categoria conta a subárvore', async () => {
    mockDb({
      porCategoria: [
        { id: 'c1', name: 'Feminino', path: '/feminino', depth: 0, total: 80, com_foto: 12, com_descricao: 0 },
        { id: 'c2', name: 'Botas', path: '/feminino/botas', depth: 1, total: 30, com_foto: 12, com_descricao: 0 },
      ],
    });

    const h = await health(CID);

    // "Feminino: 12 de 80 com foto" é meta; "10,3% de cobertura" é lamento.
    expect(h.por_categoria[0]).toMatchObject({ name: 'Feminino', total: 80, com_foto: 12, pct_foto: 15 });
    expect(h.por_categoria[1]).toMatchObject({ name: 'Botas', total: 30, pct_foto: 40 });

    const sql = db.query.mock.calls.map(c => String(c[0])).find(isPorCat);
    // O LIKE de path é o que faz o pai somar os filhos.
    expect(sql).toMatch(/d\.path LIKE c\.path \|\| '\/%'/);
  });

  test('base sem a árvore devolve resumo com árvore zerada, não 500', async () => {
    mockDb({ vinculoErro: erro('42P01'), catErro: erro('42P01') });

    const h = await health(CID);

    expect(h.arvore_disponivel).toBe(false);
    expect(h.cobertura.categoria_arvore.com).toBe(0);
    expect(h.por_categoria).toEqual([]);
    // O legado continua sendo reportado — é o que existe nessa base.
    expect(h.cobertura.categoria_texto.com).toBe(251);
  });

  test('catálogo vazio não divide por zero', async () => {
    mockDb({
      resumo: { total: 0, com_categoria_texto: 0, com_foto: 0, com_descricao: 0, com_custo: 0, com_marca: 0 },
    });

    const h = await health(CID);

    expect(h.total).toBe(0);
    expect(h.cobertura.foto.pct).toBe(0);
    expect(h.orfaos).toBe(0);
  });
});
