// ============================================================
// AURA. — Permissão estoque_consulta (30/10/2026)
//
// Funcionário que vê produtos e quantidades, sem preços, custos nem valores.
// Monta o private.js inteiro, na ordem real: o middleware só protege se vier
// antes de todo router que responde /products.
//
// Cobertura:
//   1. dono, admin e permissions null recebem tudo, igual a antes
//   2. consulta não recebe custo nem preço; com pdv mantém preço e perde custo
//   3. estoque + estoque_consulta: vale consulta
//   4. toda escrita de produto volta 403, inclusive as montadas na raiz
//   5. rotas com valor (ranking, etiquetas, ruptura) voltam 403
//   6. Essencial e Negócio se comportam igual
//   7. falha ao ler a permissão nega, não libera
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const { ehSoConsulta, semValores } = require('../src/middleware/estoqueSoConsulta');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BASE = `/companies/${COMPANY}`;

const PRODUTO = {
  id: PID, name: 'Vestido', sku: 'V1', barcode: '789', category: 'Roupas',
  description: '', price: '120.00', cost_price: '50.00', card_price: '130.00',
  stock_qty: '7', stock_min: '2', stock_max: '0', unit: 'un', color: '', size: '',
  image_url: '', ncm: '', brand: '', is_active: true, is_group_shared: false,
  company_id: COMPANY, created_at: new Date('2026-10-01T00:00:00Z'),
  has_variants: true, variants_stock_total: '7', variant_barcodes: [],
};
const VARIANTE = {
  id: 'v1', sku_suffix: 'P', price_override: '125.00', stock_qty: 3,
  barcode: '790', color_name: null, attributes: [{ attribute: 'Tamanho', value: 'P' }],
};

const token = (plan = 'essencial') => jwt.sign(
  { id: 'funcionario', role: 'client', plan, company: COMPANY },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

// private.js carrega o backend quase inteiro: uma vez só, fora do tempo dos testes.
let montado;
const app = () => montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
}, 60000);

// papel: o que requireCompanyAccess lê. permissions: a linha do membro.
function banco({ papel, permissions, falhaNaPermissao = false }) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: papel }] });
    if (/cm\.role_label, cm\.permissions/.test(s)) {
      if (falhaNaPermissao) return Promise.reject(new Error('conexao caiu'));
      return Promise.resolve({ rows: [{ is_owner: papel === 'owner', role_label: papel, permissions }] });
    }
    if (/SELECT COUNT\(\*\) AS total FROM products/.test(s)) return Promise.resolve({ rows: [{ total: '1' }] });
    if (/visible_product_id/.test(s)) {
      return Promise.resolve({ rows: [{ ...VARIANTE, visible_product_id: PID, product_id: PID }] });
    }
    if (/FROM product_variants pv LEFT JOIN/.test(s)) return Promise.resolve({ rows: [VARIANTE] });
    if (/SELECT id FROM products WHERE/.test(s)) return Promise.resolve({ rows: [{ id: PID }] });
    if (/SELECT id, name, sku, barcode, category, description, price, cost_price/.test(s)) {
      return Promise.resolve({ rows: [PRODUTO] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const lista = (plan) => request(app()).get(`${BASE}/products`).set('Authorization', `Bearer ${token(plan)}`);

beforeEach(() => { db.query.mockReset(); });

describe('regra', () => {
  test('dono, admin e permissions null nunca são restringidos', () => {
    const permissions = { estoque_consulta: true };
    expect(ehSoConsulta({ isOwner: true, roleLabel: null, permissions })).toBe(false);
    expect(ehSoConsulta({ isOwner: false, roleLabel: 'owner', permissions })).toBe(false);
    expect(ehSoConsulta({ isOwner: false, roleLabel: 'admin', permissions })).toBe(false);
    expect(ehSoConsulta({ isOwner: false, roleLabel: 'Estoque', permissions: null })).toBe(false);
    expect(ehSoConsulta({ isOwner: false, roleLabel: 'Estoque', permissions: { estoque: true } })).toBe(false);
  });

  test('com as duas chaves, consulta', () => {
    expect(ehSoConsulta({ isOwner: false, roleLabel: 'Gerente', permissions: { estoque: true, estoque_consulta: true } })).toBe(true);
  });

  test('semValores entra em lista e objeto e não estraga data', () => {
    const quando = new Date();
    const out = semValores({ grupos: [{ produtos: [{ price: 1, cost_price: 2, nome: 'a', quando }] }] }, true);
    expect(out).toEqual({ grupos: [{ produtos: [{ nome: 'a', quando }] }] });
    expect(out.grupos[0].produtos[0].quando).toBe(quando);
  });
});

describe.each(['essencial', 'negocio'])('GET /products no plano %s', (plan) => {
  test('dono vê tudo e não custa consulta nova', async () => {
    banco({ papel: 'owner', permissions: null });
    const res = await lista(plan);
    expect(res.status).toBe(200);
    expect(res.body.products[0]).toMatchObject({ price: 120, cost_price: 50, card_price: 130 });
    expect(db.query.mock.calls.some(([s]) => /cm\.role_label, cm\.permissions/.test(String(s)))).toBe(false);
  });

  test('admin da empresa vê tudo', async () => {
    banco({ papel: 'admin', permissions: { estoque_consulta: true } });
    const res = await lista(plan);
    expect(res.body.products[0]).toMatchObject({ price: 120, cost_price: 50 });
  });

  test('membro com permissions null fica intacto', async () => {
    banco({ papel: 'colaborador', permissions: null });
    const res = await lista(plan);
    expect(res.body.products[0]).toMatchObject({ price: 120, cost_price: 50, card_price: 130 });
  });

  test('membro comum com estoque fica intacto', async () => {
    banco({ papel: 'Gerente', permissions: { estoque: true } });
    const res = await lista(plan);
    expect(res.body.products[0]).toMatchObject({ price: 120, cost_price: 50, card_price: 130 });
  });

  test('consulta recebe nome, código e quantidade, sem nenhum valor', async () => {
    banco({ papel: 'Estoque', permissions: { estoque_consulta: true } });
    const res = await lista(plan);
    expect(res.status).toBe(200);
    const p = res.body.products[0];
    expect(p).toMatchObject({ name: 'Vestido', sku: 'V1', stock_qty: 7, min_stock: 2, variants_stock_total: 7 });
    ['price', 'cost_price', 'card_price'].forEach((k) => expect(p).not.toHaveProperty(k));
  });

  test('consulta com Caixa mantém preço e perde custo', async () => {
    banco({ papel: 'Caixa', permissions: { estoque_consulta: true, pdv: true } });
    const res = await lista(plan);
    const p = res.body.products[0];
    expect(p).toMatchObject({ price: 120, card_price: 130 });
    expect(p).not.toHaveProperty('cost_price');
  });

  test('estoque e consulta juntos: vale consulta', async () => {
    banco({ papel: 'Gerente', permissions: { estoque: true, estoque_consulta: true } });
    const res = await lista(plan);
    expect(res.body.products[0]).not.toHaveProperty('cost_price');
    expect(res.body.products[0]).not.toHaveProperty('price');
  });
});

describe('variantes', () => {
  const get = () => request(app()).get(`${BASE}/products/${PID}/variants`).set('Authorization', `Bearer ${token()}`);

  test('consulta vê quantidade e atributos, sem price_override', async () => {
    banco({ papel: 'Estoque', permissions: { estoque_consulta: true } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.variants[0]).toMatchObject({ id: 'v1', stock_qty: 3, barcode: '790' });
    expect(res.body.variants[0]).not.toHaveProperty('price_override');
  });

  test('dono vê price_override', async () => {
    banco({ papel: 'owner', permissions: null });
    const res = await get();
    expect(res.body.variants[0].price_override).toBe('125.00');
  });

  test('lote: consulta não recebe preço', async () => {
    banco({ papel: 'Estoque', permissions: { estoque_consulta: true } });
    const res = await request(app())
      .get(`${BASE}/products/variants?product_ids=${PID}`)
      .set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.variants_by_product[PID][0]).toMatchObject({ id: 'v1', stock_qty: 3 });
    expect(JSON.stringify(res.body)).not.toMatch(/price/);
  });
});

describe('escrita', () => {
  const ESCRITAS = [
    ['post', '/products'],
    ['patch', `/products/${PID}`],
    ['delete', `/products/${PID}`],
    ['post', '/products/batch-create'],
    ['post', '/products/import'],
    ['post', '/products/import-nfe'],
    ['post', '/products/import-danfe-xml'],
    ['post', '/products/barcodes/generate'],
    ['post', '/products/price-adjustments'],
    ['post', '/products/brand/apply'],
    ['post', '/products/merge-as-variants'],
    ['put', `/products/${PID}/variations`],
    ['post', `/products/${PID}/variants`],
    ['post', `/products/${PID}/image`],
    ['post', `/products/${PID}/master-sku`],
    ['post', '/product-categories'],
    ['post', '/categories/migration/apply'],
    ['delete', '/imports/lote-1'],
  ];

  test.each(ESCRITAS)('%s %s volta 403 para consulta', async (metodo, caminho) => {
    banco({ papel: 'Estoque', permissions: { estoque_consulta: true, pdv: true } });
    const res = await request(app())[metodo](`${BASE}${caminho}`)
      .set('Authorization', `Bearer ${token()}`).send({ name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ESTOQUE_SO_CONSULTA');
  });

  test('dono não é barrado', async () => {
    banco({ papel: 'owner', permissions: null });
    const res = await request(app()).post(`${BASE}/products/batch-create`)
      .set('Authorization', `Bearer ${token()}`).send({ products: [] });
    expect(res.body.code).not.toBe('ESTOQUE_SO_CONSULTA');
  });
});

describe('leituras com valor', () => {
  test.each([
    '/products/ranking',
    '/products/categories',
    `/products/${PID}/label`,
    `/products/${PID}/label/print`,
    '/products/labels/batch',
    '/products/unclassified',
    '/estoque/ruptura',
  ])('GET %s volta 403 para consulta', async (caminho) => {
    banco({ papel: 'Estoque', permissions: { estoque_consulta: true, pdv: true } });
    const res = await request(app()).get(`${BASE}${caminho}`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ESTOQUE_SO_CONSULTA');
  });
});

test('categorias continuam legíveis para consulta', async () => {
  banco({ papel: 'Estoque', permissions: { estoque_consulta: true } });
  const res = await request(app()).get(`${BASE}/product-categories`).set('Authorization', `Bearer ${token()}`);
  expect(res.body.code).not.toBe('ESTOQUE_SO_CONSULTA');
});

test('falha ao ler a permissão nega em vez de liberar custo', async () => {
  banco({ papel: 'Estoque', falhaNaPermissao: true });
  const res = await lista();
  expect(res.status).toBe(503);
  expect(JSON.stringify(res.body)).not.toMatch(/cost_price/);
});
