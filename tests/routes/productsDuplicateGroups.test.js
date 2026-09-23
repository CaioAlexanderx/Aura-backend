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
