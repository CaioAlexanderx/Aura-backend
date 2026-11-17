// ============================================================
// AURA. -- Testes: grade na importacao de produtos (b-import-grade, 17/11/2026)
//
// A planilha-modelo da Aura traz uma linha por cor/tamanho, com o mesmo
// nome e o mesmo SKU. Antes o import gravava so a primeira linha (as outras
// eram "duplicata"). Agora vira UM produto com variantes, no formato do
// PUT /variations:
//   - sku_suffix pelo skuSuffixFromAttrs; Cor (hex) e Tamanho em
//     product_variant_values; nome da cor em color_name;
//   - EAN-13 interno (serie 210) para a variante sem codigo na planilha;
//   - estoque do pai = soma das variantes;
//   - categoria pelo linkImportedCategories;
//   - aviso quando preco, custo ou categoria diferem nas linhas do SKU;
//   - limite de produtos do plano: o modelo conta como um produto.
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, importGrade, variations;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  importGrade = require('../../src/services/importGrade');
  variations = require('../../src/routes/productsVariations');
});
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const token = (extra) => `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial', ...extra }, SECRET, { expiresIn: '1h' })}`;
const auth = { Authorization: token() };
const url = `/api/v1/companies/${cid}/products/import`;

const H = ['nome do produto', 'preco de venda (r$)', 'preco de custo (r$)', 'estoque atual', 'estoque minimo',
  'codigo de barras (ean)', 'sku / codigo interno', 'categoria', 'cor', 'tamanho', 'unidade'];
function linha(...v) { return Object.fromEntries(H.map((h, i) => [h, v[i] === undefined ? '' : v[i]])); }

// Planilha-modelo da Aura, loja de jeans: uma linha por tamanho.
const CALCA = [
  linha('Calça Wide Leg', '189,90', '80', '2', '', '', 'CWL-01', 'Calça', '', '36', 'un'),
  linha('Calça Wide Leg', '189,90', '80', '3', '', '', 'CWL-01', 'Calça', '', '38', 'un'),
  linha('Calça Wide Leg', '189,90', '80', '1', '', '7899999000017', 'CWL-01', 'Calça', '', '40', 'un'),
];

/**
 * Banco de mentira. `db.query` (fora da transacao) e o client da transacao
 * respondem pelo SQL. Guarda o que o client gravou.
 */
function mockBanco({ produtos = [], totalProdutos = 0, plano = null, maxSerie = 0, codigosUsados = [] } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/SELECT id, name, unit, brand, sku FROM products WHERE company_id/i.test(s)) return Promise.resolve({ rows: produtos });
    if (/AS total_produtos/i.test(s)) return Promise.resolve({ rows: [{ plan: plano, total_produtos: String(totalProdutos) }] });
    if (/FROM product_variants pv/i.test(s) && /ANY/i.test(s)) return Promise.resolve({ rows: codigosUsados.map((code) => ({ code })) });
    if (/INSERT INTO products/i.test(s)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
  const client = {
    query: jest.fn((sql, params) => {
      const s = String(sql || '');
      if (/MAX\(substr/i.test(s)) return Promise.resolve({ rows: [{ max_n: maxSerie }] });
      if (/INSERT INTO products/i.test(s)) {
        // id e o 1o valor depois de company_id; category o 8o
        const porLinha = /card_price/.test(s) ? 13 : 12;
        const n = (params.length - 2) / porLinha;
        const rows = [];
        for (let i = 0; i < n; i++) rows.push({ id: params[2 + i * porLinha], category: params[2 + i * porLinha + 7] });
        return Promise.resolve({ rows });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: jest.fn(),
  };
  db.connect.mockImplementation(() => client);
  return client;
}
const doClient = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const doDb = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

/** Variantes gravadas: [{ id, product_id, sku_suffix, stock_qty, barcode, color_name, price_override }] */
function variantesGravadas(client) {
  const out = [];
  for (const [, params] of doClient(client, /INSERT INTO product_variants/i)) {
    for (let i = 0; i < params.length; i += 7) {
      const [id, product_id, sku_suffix, stock_qty, barcode, color_name, price_override] = params.slice(i, i + 7);
      out.push({ id, product_id, sku_suffix, stock_qty, barcode, color_name, price_override });
    }
  }
  return out;
}
function atributosGravados(client) {
  const out = [];
  for (const [, params] of doClient(client, /INSERT INTO product_variant_values/i)) {
    for (let i = 0; i < params.length; i += 3) out.push(params.slice(i, i + 3));
  }
  return out;
}

// ────────────────────────────────────────────────────────────
describe('planilha com grade vira 1 produto com as variantes', () => {
  test('previa: "1 modelo com 3 variacoes", nada gravado', async () => {
    const client = mockBanco();
    const res = await request(app).post(url).set(auth).send({ dry_run: true, rows: CALCA });
    expect(res.status).toBe(200);
    expect(res.body.a_importar).toBe(1);
    expect(res.body.duplicatas).toEqual([]);
    expect(res.body.grade).toMatchObject({ modelos: 1, variacoes: 3, linhas: 3 });
    expect(res.body.grade.itens[0]).toMatchObject({
      nome: 'Calça Wide Leg', sku: 'CWL-01', estoque: 6, variacoes: 3, tamanhos: ['36', '38', '40'], cores: [], linhas: [0, 1, 2],
    });
    expect(res.body.avisos_grade).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
    expect(doDb(/^\s*INSERT/i)).toEqual([]);
  });

  test('gravacao: pai com estoque somado, variantes no formato do PUT /variations, EAN 210 e categoria vinculada', async () => {
    const client = mockBanco({ maxSerie: 41 });
    const res = await request(app).post(url).set(auth).send({ rows: CALCA });
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(1);
    expect(res.body.duplicates_skipped).toBe(0);
    expect(res.body.grade).toEqual({ modelos: 1, variacoes: 3 });

    // transacao com a trava da serie de codigos
    const sqls = client.query.mock.calls.map((c) => String(c[0]).trim().split(/\s+/)[0]);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(doClient(client, /pg_advisory_xact_lock\(hashtext\('ean13-gerar:'/)).toHaveLength(1);
    expect(client.release).toHaveBeenCalled();

    // produto pai
    const [[sqlProd, pp]] = doClient(client, /INSERT INTO products/i);
    expect(sqlProd).toMatch(/import_batch_id/);
    const [, batch, pid, nome, preco, custo, estoque, , sku, categoria] = pp;
    expect(batch).toBe(res.body.batch_id);
    expect({ nome, preco, custo, estoque, sku, categoria }).toEqual({
      nome: 'Calça Wide Leg', preco: 189.9, custo: 80, estoque: 6, sku: 'CWL-01', categoria: 'Calça',
    });
    expect(sqlProd).not.toMatch(/barcode|color|size/); // pai sem codigo, cor ou tamanho proprios

    // variantes: sku_suffix = tamanho, EAN da planilha mantido, os outros da serie 210
    const vs = variantesGravadas(client);
    expect(vs.map((v) => [v.sku_suffix, v.stock_qty, v.product_id])).toEqual([['36', 2, pid], ['38', 3, pid], ['40', 1, pid]]);
    expect(vs[2].barcode).toBe('7899999000017');
    expect(vs[0].barcode).toMatch(/^210000000042\d$/);
    expect(vs[1].barcode).toMatch(/^210000000043\d$/);
    expect(vs.every((v) => v.price_override === null && v.color_name === null)).toBe(true);
    expect(atributosGravados(client)).toEqual(vs.map((v) => [v.id, 'Tamanho', v.sku_suffix]));

    // categoria pelo linkImportedCategories (a resposta lista o pendente)
    expect(res.body.categorias.pendentes).toEqual(['Calça']);
    // historico do lote com a grade
    const [[, logParams]] = doDb(/INSERT INTO import_logs/i);
    expect(JSON.parse(logParams[6]).grade).toEqual({ modelos: 1, variacoes: 3 });
    // nada foi para o INSERT simples
    expect(doDb(/INSERT INTO products/i)).toEqual([]);
  });

  test('cor x tamanho: matriz completa como o PUT, nome da cor em color_name, celula ausente nasce com 0', async () => {
    const client = mockBanco();
    const rows = [
      linha('Legging Dry', '99,90', '40', '2', '', '', 'LEG-7', 'Legging', 'Preto', 'P', 'un'),
      linha('Legging Dry', '99,90', '40', '1', '', '', 'LEG-7', 'Legging', 'Preto', 'M', 'un'),
      linha('Legging Dry', '99,90', '40', '4', '', '', 'LEG-7', 'Legging', 'Passion', 'P', 'un'),
      linha('Legging Dry', '99,90', '40', '1', '', '', 'LEG-7', 'Legging', 'Preto', 'P', 'un'), // repetida: soma
    ];
    const res = await request(app).post(url).set(auth).send({ rows });
    expect(res.status).toBe(201);
    expect(res.body.grade).toEqual({ modelos: 1, variacoes: 4 });
    const vs = variantesGravadas(client);
    expect(vs.map((v) => [v.sku_suffix, v.stock_qty, v.color_name])).toEqual([
      ['PRETO-P', 3, 'Preto'], ['PRETO-M', 1, 'Preto'], ['PASSION-P', 4, 'Passion'], ['PASSION-M', 0, 'Passion'],
    ]);
    const [[, pp]] = doClient(client, /INSERT INTO products/i);
    expect(pp[6]).toBe(8); // estoque do pai = soma
    const cores = atributosGravados(client).filter((a) => a[1] === 'Cor').map((a) => a[2]);
    expect(cores[0]).toBe(variations.coerceColorHex('Preto').toUpperCase());
    expect(cores[2]).toMatch(/^#[0-9A-F]{6}$/);
    expect(cores[2]).not.toBe(cores[0]);
    const tipos = res.body.avisos_grade.map((a) => a.tipo).sort();
    expect(tipos).toEqual(['combinacao_repetida', 'cor_sem_amostra']);
  });

  test('linha avulsa do mesmo nome/SKU sem cor nem tamanho vira duplicata do modelo', async () => {
    mockBanco();
    const res = await request(app).post(url).set(auth).send({
      dry_run: true,
      rows: [...CALCA, linha('Calça Wide Leg', '189,90', '80', '1', '', '', 'CWL-01', 'Calça', '', '', 'un')],
    });
    expect(res.body.a_importar).toBe(1);
    expect(res.body.duplicatas).toEqual([expect.objectContaining({ index: 3, origem: 'lote', duplicata_de: 0 })]);
  });

  test('sem SKU: agrupa por nome + unidade + marca', async () => {
    mockBanco();
    const rows = [
      linha('Top Nadador', '79,90', '30', '1', '', '', '', 'Top', '', 'P', 'un'),
      linha('top nadador', '79,90', '30', '2', '', '', '', 'Top', '', 'M', 'un'),
      linha('Top Nadador', '59,90', '20', '5', '', '', '', 'Top', '', '', 'un'), // sem tamanho: duplicata do modelo
    ];
    const res = await request(app).post(url).set(auth).send({ dry_run: true, rows });
    expect(res.body.grade).toMatchObject({ modelos: 1, variacoes: 2 });
    expect(res.body.a_importar).toBe(1);
  });

  test('modelo que ja existe na loja (mesmo nome e SKU) nao entra de novo', async () => {
    const client = mockBanco({ produtos: [{ id: 'p-cwl', name: 'Calça Wide Leg', unit: 'un', brand: null, sku: 'cwl-01' }] });
    const res = await request(app).post(url).set(auth).send({ rows: CALCA });
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(0);
    expect(res.body.duplicatas.map((d) => [d.index, d.origem, d.produto_id])).toEqual([[0, 'banco', 'p-cwl'], [1, 'banco', 'p-cwl'], [2, 'banco', 'p-cwl']]);
    expect(res.body.grade).toBeUndefined();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('codigo de barras de variante que ja existe no grupo: a variante ganha um interno, com aviso', async () => {
    const client = mockBanco({ codigosUsados: ['7899999000017'] });
    const res = await request(app).post(url).set(auth).send({ rows: CALCA });
    expect(res.status).toBe(201);
    const vs = variantesGravadas(client);
    expect(vs.every((v) => /^210\d{10}$/.test(v.barcode))).toBe(true);
    expect(new Set(vs.map((v) => v.barcode)).size).toBe(3);
    expect(res.body.avisos_grade).toEqual([expect.objectContaining({ tipo: 'codigo_repetido', linhas: [2] })]);
  });

  test('falha na transacao da grade: ROLLBACK e nada do lote gravado', async () => {
    const client = mockBanco();
    client.query.mockImplementation((sql) => {
      if (/INSERT INTO product_variants/i.test(String(sql))) return Promise.reject(new Error('boom'));
      if (/MAX\(substr/i.test(String(sql))) return Promise.resolve({ rows: [{ max_n: 0 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).post(url).set(auth).send({
      rows: [...CALCA, linha('Bolsa', '99,00', '', '1', '', '', 'BOL-1', '', '', '', 'un')],
    });
    expect(res.status).toBe(500);
    expect(doClient(client, /^ROLLBACK/)).toHaveLength(1);
    expect(doDb(/INSERT INTO products/i)).toEqual([]);
    expect(doDb(/INSERT INTO import_logs/i)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
describe('aviso de preco, custo e categoria diferentes no mesmo SKU', () => {
  const rows = [
    linha('Vestido Midi', '159,90', '60', '1', '', '', 'VM-3', 'Vestido', '', 'P', 'un'),
    linha('Vestido Midi', '159,90', '60', '1', '', '', 'VM-3', 'Vestido', '', 'M', 'un'),
    linha('Vestido Midi', '169,90', '65', '1', '', '', 'VM-3', 'Vestidos', '', 'GG', 'un'),
  ];

  test('previa lista os tres avisos com as linhas', async () => {
    mockBanco();
    const res = await request(app).post(url).set(auth).send({ dry_run: true, rows });
    expect(res.status).toBe(200);
    const porTipo = Object.fromEntries(res.body.avisos_grade.map((a) => [a.tipo, a]));
    expect(Object.keys(porTipo).sort()).toEqual(['categoria_diferente', 'custo_diferente', 'preco_diferente']);
    expect(porTipo.preco_diferente).toMatchObject({ modelo: 'Vestido Midi', sku: 'VM-3', linhas: [0, 1, 2], valores: [159.9, 169.9] });
    expect(porTipo.preco_diferente.mensagem).toMatch(/R\$ 159,90/);
    expect(porTipo.categoria_diferente.valores).toEqual(['Vestido', 'Vestidos']);
  });

  test('gravacao: o produto fica com o preco da primeira linha e a variante de outro preco com price_override', async () => {
    const client = mockBanco();
    const res = await request(app).post(url).set(auth).send({ rows });
    expect(res.status).toBe(201);
    const [[, pp]] = doClient(client, /INSERT INTO products/i);
    expect(pp[4]).toBe(159.9);
    expect(variantesGravadas(client).map((v) => [v.sku_suffix, v.price_override])).toEqual([['P', null], ['M', null], ['GG', 169.9]]);
    expect(res.body.avisos_grade.map((a) => a.tipo)).toContain('preco_diferente');
  });
});

// ────────────────────────────────────────────────────────────
describe('limite de produtos do plano', () => {
  const simples = [
    linha('Boné', '49,90', '', '1', '', '', 'BON-1', '', '', '', 'un'),
    linha('Meia', '19,90', '', '1', '', '', 'MEI-1', '', '', '', 'un'),
  ];

  test('Essencial com 1.999 produtos: previa avisa e a gravacao recusa com 403, sem escrever nada', async () => {
    mockBanco({ totalProdutos: 1999, plano: 'essencial' });
    const previa = await request(app).post(url).set(auth).send({ dry_run: true, rows: simples });
    expect(previa.status).toBe(200);
    expect(previa.body.limite_plano).toEqual({ limite: 2000, atual: 1999, a_importar: 2, disponivel: 1 });

    jest.resetAllMocks();
    const client = mockBanco({ totalProdutos: 1999, plano: 'essencial' });
    const res = await request(app).post(url).set(auth).send({ rows: simples });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LIMITE_DE_PRODUTOS');
    expect(res.body.error).toMatch(/limite de 2000 produtos/);
    expect(doDb(/^\s*INSERT/i)).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('grade conta como UM produto: 3 linhas cabem na ultima vaga', async () => {
    mockBanco({ totalProdutos: 1999, plano: 'essencial' });
    const res = await request(app).post(url).set(auth).send({ dry_run: true, rows: CALCA });
    expect(res.body.a_importar).toBe(1);
    expect(res.body.limite_plano).toBeUndefined();
  });

  test('plano lido da empresa, nao do token velho: Negocio no banco com token Essencial passa', async () => {
    mockBanco({ totalProdutos: 1999, plano: 'negocio' });
    const res = await request(app).post(url).set(auth).send({ dry_run: true, rows: simples });
    expect(res.body.limite_plano).toBeUndefined();
  });

  test('sem plano na empresa vale o do token', async () => {
    mockBanco({ totalProdutos: 6999, plano: null });
    const res = await request(app).post(url).set({ Authorization: token({ plan: 'negocio' }) }).send({ dry_run: true, rows: simples });
    expect(res.body.limite_plano).toEqual({ limite: 7000, atual: 6999, a_importar: 2, disponivel: 1 });
  });
});

// ────────────────────────────────────────────────────────────
describe('montarGrades (puro)', () => {
  const deps = () => ({ coerceColorHex: variations.coerceColorHex, skuSuffixFromAttrs: variations.skuSuffixFromAttrs });
  const item = (o) => ({ name: 'X', price: 10, cost_price: null, card_price: null, stock_qty: 1, stock_min: null,
    barcode: null, sku: null, category: null, color: null, size: null, unit: 'un', brand: null, description: null, ncm: null, ...o });

  test('mesmo SKU e a mesma combinacao so (linha repetida) nao e grade', () => {
    const r = importGrade.montarGrades([item({ sku: 'A', size: 'M' }), item({ sku: 'A', size: 'M' })], [0, 1], deps());
    expect(r.modelos).toEqual([]);
    expect(r.naGrade.size).toBe(0);
  });

  test('SKU unico com cor e tamanho (exemplo da planilha-modelo) nao e grade', () => {
    const r = importGrade.montarGrades([item({ sku: 'CAM-AZM', color: '#0000FF', size: 'M' }), item({ sku: 'CAM-AZP', color: '#0000FF', size: 'P' })], [0, 1], deps());
    expect(r.modelos).toEqual([]);
  });

  test('linha sem tamanho numa grade de cor e tamanho vira erro, nao some', () => {
    const r = importGrade.montarGrades([
      item({ sku: 'A', color: 'Preto', size: 'P' }), item({ sku: 'A', color: 'Branco', size: 'M' }), item({ sku: 'A', color: 'Preto' }),
    ], [0, 1, 2], deps());
    expect(r.modelos).toHaveLength(1);
    expect(r.modelos[0].variantes).toHaveLength(4);
    expect(r.erros).toEqual([expect.objectContaining({ index: 2, error: expect.stringMatching(/sem tamanho/) })]);
    expect(r.naGrade.has(2)).toBe(true);
  });

  test('hex da planilha fica sem color_name; sku_suffix igual ao do PUT', () => {
    const r = importGrade.montarGrades([item({ sku: 'A', color: '#ff0000', size: 'P' }), item({ sku: 'A', color: '#ff0000', size: 'G' })], [0, 1], deps());
    expect(r.modelos[0].variantes.map((v) => [v.color_hex, v.color_name, v.sku_suffix]))
      .toEqual([['#FF0000', null, 'FF0000-P'], ['#FF0000', null, 'FF0000-G']]);
  });
});
