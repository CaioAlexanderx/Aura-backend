// ============================================================
// Davi Calcados no QA das lojas (08/09/2026): dois achados de grupo e
// numeracao.
//
// 1) A loja e da Villa Branca; 147 das 178 pecas sao da matriz, e o
//    vinculo primario delas aponta pra categoria DA MATRIZ. A loja so
//    conhecia as categorias dela, entao o vinculo nao casava com nada e a
//    peca saia sem trilha: "Inicio / Chinelos", sem o genero. As duas
//    arvores sao espelhadas (30 nos, 30 caminhos iguais): o vinculo e
//    traduzido pra categoria da loja com o mesmo caminho.
//
// 2) Filtrar "34" nao trazia o chinelo gravado como "33/34".
// ============================================================
const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const { fetchPrimaryCategoryLinks } = require('../src/services/storefrontBuilder');
const { normalizarTamanho } = require('../src/services/tamanhosDaLoja');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('vinculo primario traduzido pra arvore da loja', () => {
  beforeEach(() => db.query.mockReset());

  test('com a empresa da loja, casa pelo caminho e cai no id original quando nao ha espelho', async () => {
    db.query.mockResolvedValue({ rows: [
      { product_id: 'p1', category_id: 'villa-casuais' },
      { product_id: 'p2', category_id: 'matriz-sem-espelho' },
    ] });
    const mapa = await fetchPrimaryCategoryLinks(['p1', 'p2'], 'villa');
    expect(mapa).toEqual({ p1: 'villa-casuais', p2: 'matriz-sem-espelho' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('COALESCE(mesma.id, l.category_id) AS category_id');
    expect(sql).toContain('mesma.company_id = $2 AND mesma.path = c.path');
    expect(sql).toContain('l.is_primary');
    expect(params).toEqual([['p1', 'p2'], 'villa']);
  });

  test('sem a empresa, a consulta e a de sempre', async () => {
    db.query.mockResolvedValue({ rows: [{ product_id: 'p1', category_id: 'c1' }] });
    const mapa = await fetchPrimaryCategoryLinks(['p1']);
    expect(mapa).toEqual({ p1: 'c1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toContain('mesma');
    expect(params).toEqual([['p1']]);
  });

  test('lista vazia nem vai ao banco', async () => {
    expect(await fetchPrimaryCategoryLinks([], 'villa')).toEqual({});
    expect(db.query).not.toHaveBeenCalled();
  });

  test('todo consumidor passa a empresa da loja', () => {
    const builder = fonte('src/services/storefrontBuilder.js');
    expect(builder).toContain('fetchPrimaryCategoryLinks(products.map(p => p.id), cid)');
    expect(builder).toContain('fetchPrimaryCategoryLinks(idsDaHome, cid)');
    expect(fonte('src/routes/storefront.js')).toContain('fetchPrimaryCategoryLinks(ids, cfg.company_id)');
    expect(fonte('src/routes/studioStorefront.js')).toContain('fetchPrimaryCategoryLinks(products.map(p => p.id), cid)');
  });
});

describe('numero inteiro no filtro cobre a meia numeracao', () => {
  // valoresDeTamanho vive na rota; executa o trecho como esta la.
  const rota = fonte('src/routes/storefront.js');
  const ini = rota.indexOf('function valoresDeTamanho');
  const fim = rota.indexOf('\n}\n', ini) + 3;
  const valoresDeTamanho = new Function('normalizarTamanho', rota.slice(ini, fim) + '\nreturn valoresDeTamanho;')(normalizarTamanho);

  test('"34" traz 33/34 e 34/35 tambem', () => {
    const v = valoresDeTamanho('34');
    expect(v).toEqual(expect.arrayContaining(['34', '33/34', '34/35', '33 / 34', '34 / 35']));
  });

  test('o par pedido direto continua exato', () => {
    const v = valoresDeTamanho('33/34');
    expect(v).toContain('33/34');
    expect(v).not.toContain('34/35');
    expect(v).not.toContain('34');
  });

  test('letra nao ganha par', () => {
    expect(valoresDeTamanho('M')).toEqual(expect.arrayContaining(['M', 'm']));
    expect(valoresDeTamanho('M').some((x) => x.includes('/'))).toBe(false);
  });
});
