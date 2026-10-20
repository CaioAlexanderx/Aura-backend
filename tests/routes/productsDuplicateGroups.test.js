// ============================================================
// AURA. -- Testes: GET /products/duplicate-groups (banner "N grupos de
// produtos duplicados" do Estoque, unificar em variantes)
//
// FIX (23/09/2026, QA producao 23/09/2026-preco-cartao-importacao.md,
// item 11): agrupava so por NOME normalizado (sem unidade, sem marca,
// sem remover acento). Isso fazia "MANTA ALUMINIZADA 10CM" cadastrada em
// METRO e em ROLO, ou "CIMENTO" das marcas Nassau e Mizu, entrarem como
// "duplicata" -- empurrando a loja a unificar em VARIANTE (cor/tamanho)
// produtos que sao DIFERENTES. Agora agrupa por nome + unidade + marca,
// a mesma chave do import por planilha (chaveProdutoImport).
//
// Mock por CONTEUDO DO SQL, nunca fila posicional (mesmo padrao de
// tests/routes/importProdutosMatcon.test.js).
// ============================================================
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '00000000-0000-0000-0000-000000000001';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };
const url = `/api/v1/companies/${cid}/products/duplicate-groups`;

function mockProducts(rows) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM company_members/i.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/FROM products/i.test(s)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

function produto(over) {
  return {
    id: 'p-' + Math.random().toString(36).slice(2),
    name: 'Produto', sku: '', barcode: '', color: '', size: '',
    price: '10.00', cost_price: '5.00', stock_qty: '1', created_at: new Date().toISOString(),
    unit: 'un', brand: '',
    ...over,
  };
}

describe('GET /duplicate-groups -- so agrupa nome + unidade + marca iguais', () => {
  test('metro x rolo NAO entra como duplicata (QA: MANTA ALUMINIZADA 10CM)', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Manta Aluminizada 10cm', unit: 'm', brand: '' }),
      produto({ id: 'b', name: 'Manta Aluminizada 10cm', unit: 'rolo', brand: '' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('marcas diferentes NAO entram como duplicata (QA: CIMENTO Nassau x Mizu)', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Cimento', unit: 'sc', brand: 'Nassau' }),
      produto({ id: 'b', name: 'Cimento', unit: 'sc', brand: 'Mizu' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  test('mesmo nome + unidade + marca -- entra como duplicata', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Cimento', unit: 'sc', brand: 'Nassau' }),
      produto({ id: 'b', name: 'Cimento', unit: 'sc', brand: 'Nassau' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].count).toBe(2);
    expect(res.body.groups[0].products.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  test('acento, caixa e espaco duplo nao importam pro nome, e "MT"/"metro" batem com "m"', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Tinta  Acrílica Branca', unit: 'MT', brand: 'Suvinil' }),
      produto({ id: 'b', name: 'tinta acrilica branca', unit: 'metro', brand: 'suvinil' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].count).toBe(2);
  });

  test('marca vazia == vazia (os dois sem marca cadastrada continuam duplicata)', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Parafuso 3/8', unit: 'un', brand: '' }),
      produto({ id: 'b', name: 'Parafuso 3/8', unit: 'un', brand: null }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
  });

  test('so 1 produto no grupo -- nao aparece (precisa de 2+)', async () => {
    mockProducts([produto({ id: 'a', name: 'Unico', unit: 'un', brand: '' })]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  test('filtra is_active=true na query (produto de variante ja unificada nao reaparece)', async () => {
    mockProducts([]);
    await request(app).get(url).set(auth);
    const sql = String(db.query.mock.calls.find(c => /FROM products/i.test(String(c[0])))[0]);
    expect(sql).toMatch(/is_active\s*=\s*true/i);
  });
});

// ============================================================
// FIX (20/10/2026, loja de roupas medida): planilha com nome generico
// ("Blusa" x23, "Colar" x8), cada linha com o SKU do fornecedor e preco
// proprio, virava 14 grupos de "duplicata". Agora SKU entra na chave:
// SKU igual agrupa (mesmo modelo em tamanhos diferentes), SKU diferente
// nao, sem SKU nos dois segue a regra de antes, um com e outro sem nao.
// ============================================================
describe('GET /duplicate-groups -- SKU separa pecas de mesmo nome generico', () => {
  test('caso da loja: varios "Blusa" com SKUs diferentes -- nenhum grupo', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Blusa', sku: 'B1010', price: '89.90' }),
      produto({ id: 'b', name: 'Blusa', sku: 'C2020', price: '119.90' }),
      produto({ id: 'c', name: 'Blusa', sku: '55871', price: '149.90' }),
      produto({ id: 'd', name: 'BLUSA', sku: 'TELKO', price: '99.90' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('caso da loja: dois "Blusa" com o SKU 41402, P e M -- 1 grupo (o resto nao entra)', async () => {
    mockProducts([
      produto({ id: 'p', name: 'Blusa', sku: '41402', size: 'P', price: '129.90' }),
      produto({ id: 'm', name: 'Blusa', sku: '41402', size: 'M', price: '129.90' }),
      produto({ id: 'x', name: 'Blusa', sku: 'B1010', size: 'P', price: '89.90' }),
      produto({ id: 'y', name: 'Blusa', sku: 'C2020', size: 'G', price: '119.90' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].count).toBe(2);
    expect(res.body.groups[0].sku).toBe('41402');
    expect(res.body.groups[0].products.map((p) => p.id).sort()).toEqual(['m', 'p']);
  });

  test('SKU compara com trim e sem caixa ("b8449 " == "B8449")', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Blusa', sku: 'B8449', size: 'P' }),
      produto({ id: 'b', name: 'Blusa', sku: ' b8449 ', size: 'M' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].count).toBe(2);
  });

  test('dois grupos de mesmo nome e SKUs diferentes tem normalized_name diferente (key da lista no front)', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Saia', sku: 'S3241', size: 'P' }),
      produto({ id: 'b', name: 'Saia', sku: 'S3241', size: 'M' }),
      produto({ id: 'c', name: 'Saia', sku: 'ALÊ', size: 'P' }),
      produto({ id: 'd', name: 'Saia', sku: 'ALÊ', size: 'G' }),
      produto({ id: 'e', name: 'Saia', sku: 'ALÊ', size: 'GG' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.body.groups.map((g) => g.count)).toEqual([3, 2]);
    const keys = res.body.groups.map((g) => g.normalized_name);
    expect(new Set(keys).size).toBe(2);
  });

  test('sem SKU nos dois -- agrupa como antes', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Colar', sku: '' }),
      produto({ id: 'b', name: 'Colar', sku: null }),
      produto({ id: 'c', name: 'Colar', sku: '   ' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0].count).toBe(3);
    expect(res.body.groups[0].sku).toBe(null);
  });

  test('sem SKU nos dois, caso Matcon de 23/09 continua: unidade ou marca diferentes nao agrupam', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Manta Aluminizada 10cm', unit: 'm', sku: null }),
      produto({ id: 'b', name: 'Manta Aluminizada 10cm', unit: 'rolo', sku: null }),
      produto({ id: 'c', name: 'Cimento', unit: 'sc', brand: 'Nassau', sku: '' }),
      produto({ id: 'd', name: 'Cimento', unit: 'sc', brand: 'Mizu', sku: '' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.body.groups).toEqual([]);
  });

  test('mesmo SKU mas marca diferente -- continua sem agrupar (SKU nao derruba nome+unidade+marca)', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Cimento', unit: 'sc', brand: 'Nassau', sku: 'CIM50' }),
      produto({ id: 'b', name: 'Cimento', unit: 'sc', brand: 'Mizu', sku: 'CIM50' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.body.groups).toEqual([]);
  });

  test('um com SKU e outro sem -- nao agrupa', async () => {
    mockProducts([
      produto({ id: 'a', name: 'Brinco', sku: '41402' }),
      produto({ id: 'b', name: 'Brinco', sku: '' }),
    ]);
    const res = await request(app).get(url).set(auth);
    expect(res.body.groups).toEqual([]);
  });

  test('a query traz o sku', async () => {
    mockProducts([]);
    await request(app).get(url).set(auth);
    const sql = String(db.query.mock.calls.find(c => /FROM products/i.test(String(c[0])))[0]);
    expect(sql).toMatch(/\bsku\b/);
  });
});
