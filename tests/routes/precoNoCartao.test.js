// ============================================================
// AURA. -- Testes: preco no cartao (22/09/2026, migration 351)
//
// A loja pode cobrar mais no cartao. Opcao da loja, desligada por padrao.
// Ligada: acrescimo padrao em % (pdv_settings.card_price_pct) e, por
// produto, um preco no cartao opcional (products.card_price).
//
// O que estes testes travam:
//   1. pdv_settings: card_price_enabled / card_price_pct na whitelist
//      (chave fora dela faz o toggle "deslizar e voltar" no app), default
//      desligado e null, e o null salvo NAO vira 0 no proximo PUT.
//   2. produtos: create/update/list com card_price (null quando vazio,
//      > 0, 2 casas) e degrau 42703 para base atras da 351.
//   3. GET /pdv/scan (scanner.js, a rota que responde de fato): card_price
//      junto do preco, com o mesmo degrau.
//   4. importacao: "VALOR DIN" vai pra price e "VALOR CART" pra
//      card_price — antes as duas caiam em price e a ultima vencia.
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

/** Roteia db.query pelo texto do SQL. `rotas` = [[regex, resposta|fn]]. */
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
const erro42703 = () => { const e = new Error('column "card_price" does not exist'); e.code = '42703'; return e; };
const chamadas = (re) => db.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

// ────────────────────────────────────────────────────────────
describe('pdv_settings -- preco no cartao', () => {
  const url = `/api/v1/companies/${cid}/pdv-settings`;

  test('GET: desligado e sem % para quem nunca configurou', async () => {
    mockSql([[/SELECT pdv_settings FROM companies/i, { rows: [{ pdv_settings: { caixa_enabled: true } }] }]]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.card_price_enabled).toBe(false);
    expect(res.body.settings.card_price_pct).toBeNull();
  });

  test('PUT: as duas chaves passam pela whitelist e sao gravadas', async () => {
    mockSql([[/SELECT pdv_settings FROM companies/i, { rows: [{ pdv_settings: { card_fee_enabled: true } }] }]]);
    const res = await request(app).put(url).set(auth)
      .send({ settings: { card_price_enabled: true, card_price_pct: 5.5 } });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ card_price_enabled: true, card_price_pct: 5.5, card_fee_enabled: true });
    const gravado = JSON.parse(chamadas(/UPDATE companies SET pdv_settings/i)[0][1][0]);
    expect(gravado).toMatchObject({ card_price_enabled: true, card_price_pct: 5.5 });
  });

  test('PUT: um null ja salvo nao vira 0 num save de outra chave', async () => {
    mockSql([[/SELECT pdv_settings FROM companies/i, { rows: [{ pdv_settings: { card_price_enabled: false, card_price_pct: null } }] }]]);
    const res = await request(app).put(url).set(auth).send({ settings: { caixa_enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body.settings.card_price_pct).toBeNull();
  });

  test('PUT: card_price_pct aceita null/vazio para limpar', async () => {
    mockSql([[/SELECT pdv_settings FROM companies/i, { rows: [{ pdv_settings: { card_price_pct: 8 } }] }]]);
    const res = await request(app).put(url).set(auth).send({ settings: { card_price_pct: '' } });
    expect(res.status).toBe(200);
    expect(res.body.settings.card_price_pct).toBeNull();
  });

  test.each([[-1], [101], ['abc'], [true]])('PUT: card_price_pct=%p e recusado', async (v) => {
    mockSql([[/SELECT pdv_settings FROM companies/i, { rows: [{ pdv_settings: {} }] }]]);
    const res = await request(app).put(url).set(auth).send({ settings: { card_price_pct: v } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/card_price_pct/);
  });

  test('PUT: card_price_enabled so aceita boolean', async () => {
    mockSql([[/SELECT pdv_settings FROM companies/i, { rows: [{ pdv_settings: {} }] }]]);
    const res = await request(app).put(url).set(auth).send({ settings: { card_price_enabled: 'sim' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/card_price_enabled/);
  });
});

// ────────────────────────────────────────────────────────────
describe('produtos -- card_price', () => {
  const base = `/api/v1/companies/${cid}/products`;

  test('POST: grava card_price arredondado a 2 casas e devolve numero', async () => {
    mockSql([
      [/COUNT\(\*\) FROM products WHERE company_id/i, { rows: [{ total: '0', in_group: false }] }],
      [/INSERT INTO products/i, { rows: [{ id: 'p1', name: 'Camisa', price: '100.00' }] }],
      [/UPDATE products SET card_price/i, { rows: [{ id: 'p1', name: 'Camisa', price: '100.00', card_price: '108.46' }] }],
    ]);
    const res = await request(app).post(base).set(auth)
      .send({ name: 'Camisa', price: 100, card_price: '108,456' });
    expect(res.status).toBe(201);
    expect(chamadas(/UPDATE products SET card_price/i)[0][1]).toEqual(['p1', 108.46]);
    expect(res.body.card_price).toBe(108.46);
  });

  test.each([[''], [null], [0], ['0,00']])('POST: card_price=%p vira null e nao roda UPDATE', async (v) => {
    mockSql([
      [/COUNT\(\*\) FROM products WHERE company_id/i, { rows: [{ total: '0', in_group: false }] }],
      [/INSERT INTO products/i, { rows: [{ id: 'p1', name: 'Camisa' }] }],
    ]);
    const res = await request(app).post(base).set(auth).send({ name: 'Camisa', price: 100, card_price: v });
    expect(res.status).toBe(201);
    expect(chamadas(/card_price/i)).toHaveLength(0);
    expect(res.body.card_price).toBeNull();
  });

  test('POST: card_price negativo e 400 antes de criar o produto', async () => {
    mockSql([[/COUNT\(\*\) FROM products WHERE company_id/i, { rows: [{ total: '0', in_group: false }] }]]);
    const res = await request(app).post(base).set(auth).send({ name: 'Camisa', price: 100, card_price: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/card_price/);
    expect(chamadas(/INSERT INTO products/i)).toHaveLength(0);
  });

  test('POST: base sem a 351 cria o produto mesmo assim (sem 500 que duplicaria o cadastro)', async () => {
    mockSql([
      [/COUNT\(\*\) FROM products WHERE company_id/i, { rows: [{ total: '0', in_group: false }] }],
      [/INSERT INTO products/i, { rows: [{ id: 'p1', name: 'Camisa' }] }],
      [/UPDATE products SET card_price/i, () => Promise.reject(erro42703())],
    ]);
    const res = await request(app).post(base).set(auth).send({ name: 'Camisa', price: 100, card_price: 110 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('p1');
    expect(res.body.card_price).toBeNull();
  });

  test('PATCH: grava card_price e null limpa (volta a seguir o %)', async () => {
    mockSql([[/UPDATE products SET/i, (s, p) => Promise.resolve({ rows: [{ id: 'p1', card_price: p[0] === null ? null : String(p[0]) }] })]]);
    let res = await request(app).patch(`${base}/p1`).set(auth).send({ card_price: 119.9 });
    expect(res.status).toBe(200);
    expect(chamadas(/UPDATE products SET/i)[0][0]).toMatch(/card_price = \$1/);
    expect(res.body.card_price).toBe(119.9);

    res = await request(app).patch(`${base}/p1`).set(auth).send({ card_price: null });
    expect(res.status).toBe(200);
    expect(chamadas(/UPDATE products SET/i)[1][1][0]).toBeNull();
    expect(res.body.card_price).toBeNull();
  });

  test('PATCH: card_price invalido e 400', async () => {
    mockSql([]);
    const res = await request(app).patch(`${base}/p1`).set(auth).send({ card_price: 'dez' });
    expect(res.status).toBe(400);
    expect(chamadas(/UPDATE products/i)).toHaveLength(0);
  });

  test('PATCH: base sem a 351 salva o resto (preco) sem o card_price', async () => {
    mockSql([[/UPDATE products SET/i, (s) => (/card_price/.test(s)
      ? Promise.reject(erro42703())
      : Promise.resolve({ rows: [{ id: 'p1', price: '99.00' }] }))]]);
    const res = await request(app).patch(`${base}/p1`).set(auth).send({ price: 99, card_price: 110 });
    expect(res.status).toBe(200);
    const updates = chamadas(/UPDATE products SET/i);
    expect(updates).toHaveLength(2);
    expect(updates[1][0]).not.toMatch(/card_price/);
    expect(updates[1][0]).toMatch(/price = \$1/);
  });

  test('GET: listagem pede card_price e devolve numero (null quando vazio)', async () => {
    mockSql([
      [/SELECT COUNT\(\*\) AS total FROM products/i, { rows: [{ total: '2' }] }],
      [/SELECT id, name, sku/i, { rows: [
        { id: 'p1', name: 'A', price: '100.00', card_price: '110.00' },
        { id: 'p2', name: 'B', price: '50.00', card_price: null },
      ] }],
    ]);
    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(200);
    expect(chamadas(/SELECT id, name, sku/i)[0][0]).toMatch(/card_price,/);
    expect(res.body.products.map((p) => p.card_price)).toEqual([110, null]);
  });

  test('GET: base so sem a 351 custa UMA query extra e lista sem card_price', async () => {
    mockSql([
      [/SELECT COUNT\(\*\) AS total FROM products/i, { rows: [{ total: '1' }] }],
      [/SELECT id, name, sku/i, (s) => (/card_price/.test(s)
        ? Promise.reject(erro42703())
        : Promise.resolve({ rows: [{ id: 'p1', name: 'A', price: '100.00' }] }))],
    ]);
    const res = await request(app).get(base).set(auth);
    expect(res.status).toBe(200);
    expect(chamadas(/SELECT id, name, sku/i)).toHaveLength(2);
    expect(res.body.products[0].card_price).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
describe('GET /pdv/scan -- card_price junto do preco', () => {
  test('match por barcode traz card_price', async () => {
    mockSql([[/p\.barcode=\$2/i, { rows: [{ id: 'p1', name: 'Camisa', price: '100.00', card_price: '110.00', variants: [] }] }]]);
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/scan/7891000315507`).set(auth);
    expect(res.status).toBe(200);
    expect(chamadas(/p\.barcode=\$2/i)[0][0]).toMatch(/p\.card_price/);
    expect(res.body.product.card_price).toBe('110.00');
  });

  test('base sem a 351: repete a consulta sem a coluna e o bipe funciona', async () => {
    mockSql([[/p\.barcode=\$2/i, (s) => (/card_price/.test(s)
      ? Promise.reject(erro42703())
      : Promise.resolve({ rows: [{ id: 'p1', name: 'Camisa', price: '100.00', variants: [] }] }))]]);
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/scan/7891000315507`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('exact');
    expect(res.body.product.card_price).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────
describe('importacao -- dinheiro e cartao em colunas separadas', () => {
  const { suggestMapping, PRODUCT_FIELDS } = require('../../src/routes/importData');

  test('VALOR DIN -> price, VALOR CART -> card_price (antes: os dois em price)', () => {
    const map = suggestMapping(['PRODUTO', 'VALOR DIN', 'VALOR CART'], PRODUCT_FIELDS);
    expect(map).toEqual({ PRODUTO: 'name', 'VALOR DIN': 'price', 'VALOR CART': 'card_price' });
  });

  test.each([
    ['Preço no cartão', 'card_price'],
    ['Preço cartão', 'card_price'],
    ['Valor cartão', 'card_price'],
    ['Cartão', 'card_price'],
    ['Preço venda cartão', 'card_price'], // casa price tambem, mas cartao nunca vira preco normal
    ['Valor dinheiro', 'price'],
    ['Preço à vista', 'price'],
    ['À vista', 'price'],
    ['Preço de venda', 'price'],
    ['Valor', 'price'],
    ['Estoque mínimo', 'stock_min'],
    ['Preço de custo', 'cost_price'],
    ['Valor de custo', 'cost_price'],
  ])('%s -> %s', (header, field) => {
    expect(suggestMapping([header], PRODUCT_FIELDS)[header]).toBe(field);
  });

  test('dry_run: preview separa os dois precos', async () => {
    mockSql([]);
    const res = await request(app).post(`/api/v1/companies/${cid}/products/import`).set(auth).send({
      dry_run: true,
      rows: [{ PRODUTO: 'Cimento CP II', 'VALOR DIN': '32,90', 'VALOR CART': '34,50' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.suggested_map).toMatchObject({ 'VALOR DIN': 'price', 'VALOR CART': 'card_price' });
    expect(res.body.preview[0]).toMatchObject({ name: 'Cimento CP II', price: 32.9, card_price: 34.5 });
  });

  test('import: card_price entra no INSERT; vazio vira null', async () => {
    mockSql([[/INSERT INTO products/i, { rows: [] }]]);
    const res = await request(app).post(`/api/v1/companies/${cid}/products/import`).set(auth).send({
      rows: [
        { PRODUTO: 'Cimento', 'VALOR DIN': '32,90', 'VALOR CART': '34,50' },
        { PRODUTO: 'Areia',   'VALOR DIN': '10,00', 'VALOR CART': '' },
      ],
    });
    expect(res.status).toBe(201);
    const [sql, params] = chamadas(/INSERT INTO products/i)[0];
    expect(sql).toMatch(/ncm, card_price, import_batch_id/);
    // $1 empresa, $2 lote, depois 14 valores por linha; card_price e o ultimo.
    expect(params[2 + 1]).toBe(32.9);   // price da linha 1
    expect(params[2 + 13]).toBe(34.5);  // card_price da linha 1
    expect(params[2 + 14 + 13]).toBeNull(); // card_price da linha 2
    expect(res.body.card_price_ignorado).toBeUndefined();
  });

  test('import sem coluna de cartao: INSERT identico ao de antes', async () => {
    mockSql([[/INSERT INTO products/i, { rows: [] }]]);
    const res = await request(app).post(`/api/v1/companies/${cid}/products/import`).set(auth).send({
      rows: [{ Nome: 'Camisa', 'Preço de venda': '59,90' }],
    });
    expect(res.status).toBe(201);
    expect(chamadas(/INSERT INTO products/i)[0][0]).not.toMatch(/card_price/);
  });

  test('import em base sem a 351: repete sem a coluna e avisa', async () => {
    mockSql([[/INSERT INTO products/i, (s) => (/card_price/.test(s)
      ? Promise.reject(erro42703())
      : Promise.resolve({ rows: [] }))]]);
    const res = await request(app).post(`/api/v1/companies/${cid}/products/import`).set(auth).send({
      rows: [{ PRODUTO: 'Cimento', 'VALOR DIN': '32,90', 'VALOR CART': '34,50' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(1);
    expect(res.body.card_price_ignorado).toBe(true);
  });

  test('applyMap: celula vazia nao apaga o valor que outra coluna do mesmo campo trouxe', () => {
    const { applyMap } = importData;
    expect(applyMap({ A: '10', B: '' }, { A: 'price', B: 'price' })).toEqual({ price: '10' });
  });
});
