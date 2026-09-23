// ============================================================
// AURA. -- Testes: importacao de produtos de deposito (22/09/2026, Matcon)
//
// Primeira planilha de material de construcao (2.017 produtos):
//   ITEM | NOME | UNID. | MARCA | CUSTO | VALOR DIN | VALOR CART |
//   ESTOQUE | TOTAL VEND/EST | TOTAL C/E
//
// O que estes testes travam:
//   1. mapeamento: NOME vence ITEM, UNID. -> unit, MARCA -> brand, e as
//      colunas TOTAL nao caem em preco/estoque.
//   2. unidade normalizada no servidor ("MT" -> "m", "RL" -> "rolo"...);
//      desconhecida grava em minusculas e aparece em unidades_desconhecidas.
//   3. duplicata = nome + unidade + marca (sem acento/caixa/espacos), no
//      lote e contra o banco; codigo de barras dedup sozinho. O dry_run
//      lista as duplicatas com a linha.
//   4. estoque com virgula: "1,5" = 1.5 (antes parseFloat -> 1).
//   5. brand no INSERT em lote.
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, importData;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  importData = require('../../src/routes/importData');
});
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };
const url = `/api/v1/companies/${cid}/products/import`;

function mockSql(rotas) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    for (const [re, resp] of rotas) {
      if (re.test(s)) return typeof resp === 'function' ? resp(s, params) : Promise.resolve(resp);
    }
    return Promise.resolve({ rows: [] });
  });
}
const chamadas = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

const CABECALHOS = ['ITEM', 'NOME', 'UNID.', 'MARCA', 'CUSTO', 'VALOR DIN', 'VALOR CART', 'ESTOQUE', 'TOTAL VEND/EST', 'TOTAL C/E'];

/** Linha da planilha real, na ordem das colunas. */
function linha(item, nome, unid, marca, custo, din, cart, estoque, totalVend, totalCE) {
  const valores = [item, nome, unid, marca, custo, din, cart, estoque, totalVend, totalCE];
  return Object.fromEntries(CABECALHOS.map((h, i) => [h, valores[i] === undefined ? '' : valores[i]]));
}

// ────────────────────────────────────────────────────────────
describe('mapeamento dos cabecalhos da planilha de deposito', () => {
  test('cabecalhos reais: NOME vence ITEM e as colunas TOTAL ficam sem campo', () => {
    const { suggestMapping, PRODUCT_FIELDS } = importData;
    expect(suggestMapping(CABECALHOS, PRODUCT_FIELDS)).toEqual({
      NOME: 'name',
      'UNID.': 'unit',
      MARCA: 'brand',
      CUSTO: 'cost_price',
      'VALOR DIN': 'price',
      'VALOR CART': 'card_price',
      ESTOQUE: 'stock_qty',
    });
  });

  test('NOME vence ITEM em qualquer ordem de coluna', () => {
    const { suggestMapping, PRODUCT_FIELDS } = importData;
    expect(suggestMapping(['NOME', 'ITEM'], PRODUCT_FIELDS)).toEqual({ NOME: 'name' });
    expect(suggestMapping(['Descrição', 'Item'], PRODUCT_FIELDS)).toEqual({ 'Descrição': 'name' });
  });

  test('planilha so com ITEM continua usando ITEM como nome', () => {
    const { suggestMapping, PRODUCT_FIELDS } = importData;
    expect(suggestMapping(['Item', 'Preço de venda'], PRODUCT_FIELDS)).toEqual({ Item: 'name', 'Preço de venda': 'price' });
  });

  test.each([
    ['UNID.', 'unit'],
    ['Unid', 'unit'],
    ['UND', 'unit'],
    ['UN.', 'unit'],
    ['Un', 'unit'],
    ['Unidade', 'unit'],
    ['Unidade de medida', 'unit'],
    ['Marca', 'brand'],
    ['Fabricante', 'brand'],
    ['Brand', 'brand'],
    ['Marca/Fabricante', 'brand'],
    // 'unid'/'un.' nao podem roubar cabecalho de preco/custo
    ['Preço unitário', 'price'],
    ['Preço un.', 'price'],
    ['Valor unid.', 'price'],
    ['Valor unitário', 'price'],
    ['Custo unitário', 'cost_price'],
    ['Quantidade', 'stock_qty'],
    ['Estoque', 'stock_qty'],
  ])('%s -> %s', (header, field) => {
    const { suggestMapping, PRODUCT_FIELDS } = importData;
    expect(suggestMapping([header], PRODUCT_FIELDS)[header]).toBe(field);
  });

  test.each([['TOTAL VEND/EST'], ['TOTAL C/E'], ['Total']])('%s nao cai em campo nenhum', (header) => {
    const { suggestMapping, PRODUCT_FIELDS } = importData;
    expect(suggestMapping([header], PRODUCT_FIELDS)[header]).toBeUndefined();
  });

  test('dry_run com a linha real: nome, unidade, marca, precos e estoque certos; TOTAL ignorado', async () => {
    mockSql([]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [linha('17', 'CIMENTO CP II 50KG', 'SC', 'VOTORAN', '28,50', '32,90', '34,50', '1.234,5', '99.999,99', '88.888,88')],
    });
    expect(res.status).toBe(200);
    expect(res.body.preview[0]).toMatchObject({
      name: 'CIMENTO CP II 50KG',
      unit: 'sc',
      brand: 'VOTORAN',
      cost_price: 28.5,
      price: 32.9,
      card_price: 34.5,
      stock_qty: 1234.5,
    });
  });
});

// ────────────────────────────────────────────────────────────
describe('normalizarUnidadeImport', () => {
  test.each([
    ['MT', 'm'], ['mts', 'm'], ['METRO', 'm'], ['Metros', 'm'], ['M', 'm'],
    ['M²', 'm²'], ['m2', 'm²'], ['MT2', 'm²'], ['metro quadrado', 'm²'],
    ['M³', 'm³'], ['m3', 'm³'], ['MT3', 'm³'],
    ['RL', 'rolo'], ['Rolo', 'rolo'],
    ['UM', 'un'], ['U', 'un'], ['UN', 'un'], ['UND', 'un'], ['Unid.', 'un'], ['UNIDADE', 'un'], ['uni', 'un'],
    ['LT', 'L'], ['l', 'L'], ['Litro', 'L'], ['ML', 'ml'],
    ['PÇ', 'pç'], ['pc', 'pç'], ['PCA', 'pç'], ['Peça', 'pç'], ['peca', 'pç'],
    ['DZ', 'dz'], ['Dúzia', 'dz'], ['duzia', 'dz'],
    ['CART', 'cartela'], ['cartela', 'cartela'],
    ['KG', 'kg'], ['quilo', 'kg'], ['G', 'g'], ['GR', 'g'],
    ['PCT', 'pct'], ['Pacote', 'pct'], ['CX', 'cx'], ['Caixa', 'cx'],
    ['SC', 'sc'], ['saco', 'sc'], ['BR', 'br'], ['Barra', 'br'],
    ['MLH', 'mlh'], ['Milheiro', 'mlh'], ['MIL', 'mlh'],
    ['TON', 'ton'], ['T', 'ton'], ['PAR', 'par'], ['PR', 'par'],
    ['KIT', 'kit'], ['JG', 'kit'], ['Jogo', 'kit'],
    ['LATA', 'lata'], ['BALDE', 'balde'], ['BD', 'balde'],
    ['GL', 'gl'], ['Galão', 'gl'], ['galao', 'gl'],
    ['  cx.  ', 'cx'], ['Kg.', 'kg'],
    ['', 'un'], [null, 'un'], [undefined, 'un'],
  ])('%p -> %p', (entrada, esperado) => {
    expect(importData.normalizarUnidadeImport(entrada)).toBe(esperado);
  });

  test('desconhecida: grava em minusculas como veio', () => {
    expect(importData.normalizarUnidadeImport(' CX C/10 ')).toBe('cx c/10');
    expect(importData.normalizarUnidadeImport('FARDO')).toBe('fardo');
  });

  test('dry_run conta as desconhecidas com os valores distintos', async () => {
    mockSql([]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [
        linha('1', 'Arame recozido', 'FARDO', '', '', '10,00'),
        linha('2', 'Arame farpado', 'Fardo', '', '', '12,00'),
        linha('3', 'Prego 17x21', 'CX C/10', '', '', '8,00'),
        linha('4', 'Fio 2,5mm', 'MT', '', '', '2,50'),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.unidades_desconhecidas).toEqual({ total: 3, valores: ['fardo', 'cx c/10'] });
    expect(res.body.preview.map((p) => p.unit)).toEqual(['fardo', 'fardo', 'cx c/10', 'm']);
  });

  test('sem unidade desconhecida: total 0 e lista vazia', async () => {
    mockSql([]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [linha('1', 'Areia media', 'M³', '', '', '120,00')],
    });
    expect(res.body.unidades_desconhecidas).toEqual({ total: 0, valores: [] });
  });
});

// ────────────────────────────────────────────────────────────
describe('duplicata por nome + unidade + marca', () => {
  test('mesmo nome com marcas diferentes entra duas vezes', async () => {
    mockSql([]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [
        linha('1', 'Tubo PVC 100mm', 'BR', 'TIGRE', '', '45,00'),
        linha('2', 'Tubo PVC 100mm', 'BR', 'AMANCO', '', '42,00'),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicatas).toEqual([]);
    expect(res.body.duplicate_count).toBe(0);
    expect(res.body.a_importar).toBe(2);
  });

  test('mesmo nome em PCT e UN entra duas vezes (e metro x rolo tambem)', async () => {
    mockSql([]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [
        linha('1', 'Parafuso 6mm', 'PCT', 'CISER', '', '15,00'),
        linha('2', 'Parafuso 6mm', 'UN', 'CISER', '', '0,20'),
        linha('3', 'Fio flexivel 2,5mm', 'MT', 'SIL', '', '2,50'),
        linha('4', 'Fio flexivel 2,5mm', 'RL', 'SIL', '', '210,00'),
      ],
    });
    expect(res.body.duplicatas).toEqual([]);
    expect(res.body.a_importar).toBe(4);
  });

  test('mesmo nome + unidade + marca vira duplicata (caixa, acento, espacos e grafia da unidade nao importam)', async () => {
    mockSql([]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [
        linha('1', 'Cimento CP II', 'SC', 'Votoran', '', '32,90'),
        linha('2', 'Areia', 'M³', '', '', '120,00'),
        linha('3', 'CIMENTO  cp ii', 'saco', 'VOTORAN', '', '33,90'),
        linha('4', 'Areia', 'm3', '', '', '125,00'),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.a_importar).toBe(2);
    expect(res.body.duplicate_count).toBe(2);
    expect(res.body.duplicatas).toEqual([
      { index: 2, origem: 'lote', criterio: 'nome_unidade_marca', duplicata_de: 0,
        name: 'CIMENTO  cp ii', unit: 'sc', brand: 'VOTORAN', barcode: null },
      { index: 3, origem: 'lote', criterio: 'nome_unidade_marca', duplicata_de: 1,
        name: 'Areia', unit: 'm³', brand: null, barcode: null },
    ]);
  });

  test('nome com e sem acento e a mesma chave', () => {
    const { chaveProdutoImport } = importData;
    expect(chaveProdutoImport('Tinta Acrílica  Branca', 'LT', 'Suvinil'))
      .toBe(chaveProdutoImport('tinta acrilica branca', 'litro', 'SUVINIL'));
    expect(chaveProdutoImport('Tinta', 'L', 'Suvinil')).not.toBe(chaveProdutoImport('Tinta', 'gl', 'Suvinil'));
  });

  test('contra o banco: mesma chave vira duplicata com o id; marca diferente entra', async () => {
    mockSql([[/SELECT id, name, unit, brand FROM products/i, { rows: [
      { id: 'p9', name: 'Cimento CP II', unit: 'SC', brand: 'Votoran' },
      { id: 'p8', name: 'Areia', unit: null, brand: null }, // unidade antiga vazia = 'un'
    ] }]]);
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [
        linha('1', 'cimento cp ii', 'saco', 'VOTORAN', '', '32,90'),
        linha('2', 'Cimento CP II', 'SC', 'Itaú', '', '31,90'),
        linha('3', 'Areia', 'UN', '', '', '5,00'),
        linha('4', 'Areia', 'M³', '', '', '120,00'),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicatas).toEqual([
      expect.objectContaining({ index: 0, origem: 'banco', criterio: 'nome_unidade_marca', produto_id: 'p9' }),
      expect.objectContaining({ index: 2, origem: 'banco', criterio: 'nome_unidade_marca', produto_id: 'p8' }),
    ]);
    expect(res.body.a_importar).toBe(2);
    // lookup e da empresa; sem filtro de is_active (DELETE e fisico)
    const [sql, params] = chamadas(/SELECT id, name, unit, brand FROM products/i)[0];
    expect(params).toEqual([cid]);
    expect(sql).not.toMatch(/is_active/);
  });

  test('codigo de barras continua deduplicando sozinho (lote e banco)', async () => {
    mockSql([[/SELECT id, barcode FROM products/i, { rows: [{ id: 'p5', barcode: '7890000000002' }] }]]);
    const rows = [
      { NOME: 'Torneira A', 'VALOR DIN': '50,00', EAN: '7890000000001' },
      { NOME: 'Torneira B', 'VALOR DIN': '55,00', EAN: '7890000000001' },
      { NOME: 'Torneira C', 'VALOR DIN': '60,00', EAN: '7890000000002' },
    ];
    const res = await request(app).post(url).set(auth).send({ dry_run: true, rows });
    expect(res.body.duplicatas).toEqual([
      expect.objectContaining({ index: 1, origem: 'lote', criterio: 'codigo_de_barras', duplicata_de: 0 }),
      expect.objectContaining({ index: 2, origem: 'banco', criterio: 'codigo_de_barras', produto_id: 'p5' }),
    ]);
    expect(res.body.a_importar).toBe(1);
  });

  test('import de verdade: duplicatas ficam fora do INSERT e voltam na resposta', async () => {
    mockSql([[/INSERT INTO products/i, { rows: [] }]]);
    const res = await request(app).post(url).set(auth).send({
      rows: [
        linha('1', 'Tubo PVC 100mm', 'BR', 'TIGRE', '', '45,00'),
        linha('2', 'Tubo PVC 100mm', 'BR', 'AMANCO', '', '42,00'),
        linha('3', 'Tubo PVC 100mm', 'barra', 'Tigre', '', '46,00'),
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(2);
    expect(res.body.duplicates_skipped).toBe(1);
    expect(res.body.duplicatas).toEqual([expect.objectContaining({ index: 2, origem: 'lote', duplicata_de: 0 })]);
    expect(res.body.unidades_desconhecidas).toEqual({ total: 0, valores: [] });
  });
});

// ────────────────────────────────────────────────────────────
describe('estoque com virgula e marca no INSERT', () => {
  test.each([
    ['1,5', 1.5], ['1.234,5', 1234.5], ['1,234.5', 1234.5], ['1.5', 1.5], ['10', 10],
    ['10 un', 10], [' 2,25 ', 2.25], ['0,3333', 0.333], ['1.000.000', 1000000], ['-2', -2],
    [12, 12], [0.1235, 0.124], ['', null], [null, null], ['abc', null],
  ])('parseQuantidade(%p) = %p', (entrada, esperado) => {
    expect(importData.parseQuantidade(entrada)).toBe(esperado);
  });

  test('INSERT: stock "1,5" grava 1.5, minimo com virgula, unidade normalizada e marca saneada', async () => {
    mockSql([[/INSERT INTO products/i, { rows: [] }]]);
    const res = await request(app).post(url).set(auth).send({
      rows: [
        { NOME: 'Fio 2,5mm', 'UNID.': 'MT', MARCA: '  Sil  ', 'VALOR DIN': '2,50', ESTOQUE: '1,5', 'Estoque mínimo': '0,5' },
        { NOME: 'Cal', 'UNID.': 'SC', MARCA: '', 'VALOR DIN': '12,00', ESTOQUE: '', 'Estoque mínimo': '' },
        { NOME: 'Brita', 'UNID.': 'M³', MARCA: 'x'.repeat(200), 'VALOR DIN': '150,00', ESTOQUE: '1.234,5', 'Estoque mínimo': '' },
      ],
    });
    expect(res.status).toBe(201);
    const [sql, params] = chamadas(/INSERT INTO products/i)[0];
    expect(sql).toMatch(/unit, description, ncm, brand, import_batch_id/);
    // $1 empresa, $2 lote, depois 14 valores por linha (sem card_price):
    // name, price, cost, stock_qty, stock_min, barcode, sku, category,
    // color, size, unit, description, ncm, brand
    const L = (n) => params.slice(2 + 14 * n, 2 + 14 * (n + 1));
    expect(L(0)[3]).toBe(1.5);
    expect(L(0)[4]).toBe(0.5);
    expect(L(0)[10]).toBe('m');
    expect(L(0)[13]).toBe('Sil');
    expect(L(1)[3]).toBe(0);
    expect(L(1)[4]).toBeNull();
    expect(L(1)[10]).toBe('sc');
    expect(L(1)[13]).toBeNull();
    expect(L(2)[3]).toBe(1234.5);
    expect(L(2)[10]).toBe('m³');
    expect(L(2)[13]).toHaveLength(120);
  });
});
