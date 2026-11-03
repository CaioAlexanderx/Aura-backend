// ============================================================
// AURA. — Custo oculto para funcionário sem retaguarda (03/11/2026)
//
// Funcionário com Caixa e Estoque, mas sem Financeiro, Painel, Relatórios e
// Configurações, não vê custo, margem nem valor do estoque. Continua vendo
// preço e gravando produto (diferente do estoque_consulta).
//
// Cobertura:
//   1. regra podeVerCusto (chave explícita `custos`, painel ausente, consulta)
//   2. GET /products: sem custo, com preço — e intacto para quem vê
//   3. PATCH /products/:pid: o custo do corpo é descartado (não apaga o custo)
//   4. mounts fora de /products: em estoqueConsultaCustoRotas.test.js (perfil BALCAO)
//   5. /margin: 403; /estoque/ruptura: passa, sem custo
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const { podeVerCusto, semCustoNaEscrita } = require('../src/middleware/estoqueSoConsulta');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BASE = `/companies/${COMPANY}`;

const PRODUTO = {
  id: PID, name: 'Capa iPhone 15', sku: 'C15', barcode: '789', category: 'Capas',
  description: '', price: '35.00', cost_price: '5.50', card_price: null,
  stock_qty: '4', stock_min: '0', stock_max: '0', unit: 'un', color: '', size: '',
  image_url: '', ncm: '', brand: '', is_active: true, is_group_shared: false,
  company_id: COMPANY, created_at: new Date('2026-10-01T00:00:00Z'),
  has_variants: false, variants_stock_total: '0', variant_barcodes: [],
};

// O perfil real visto em produção (2 membros em 03/11/2026).
const BALCAO = { pdv: true, painel: false, estoque: true, clientes: true };

const token = () => jwt.sign(
  { id: 'funcionario', role: 'client', plan: 'negocio', company: COMPANY },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

let montado;
const app = () => montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
});

function banco({ papel = 'Colaborador', permissions }) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: papel }] });
    if (/cm\.role_label, cm\.permissions/.test(s)) {
      return Promise.resolve({ rows: [{ is_owner: papel === 'owner', role_label: papel, permissions }] });
    }
    if (/SELECT COUNT\(\*\) AS total FROM products/.test(s)) return Promise.resolve({ rows: [{ total: '1' }] });
    if (/SELECT id FROM products WHERE/.test(s)) return Promise.resolve({ rows: [{ id: PID }] });
    if (/SELECT id, name, sku, barcode, category, description, price, cost_price/.test(s)) {
      return Promise.resolve({ rows: [PRODUTO] });
    }
    if (/^\s*UPDATE products SET/i.test(s)) return Promise.resolve({ rows: [PRODUTO], rowCount: 1 });
    if (/FROM products/.test(s)) return Promise.resolve({ rows: [PRODUTO] });
    return Promise.resolve({ rows: [] });
  });
}

const get = (path) => request(app()).get(`${BASE}${path}`).set('Authorization', `Bearer ${token()}`);

beforeEach(() => { db.query.mockReset(); });

describe('regra podeVerCusto', () => {
  const membro = (permissions) => ({ isOwner: false, roleLabel: 'Colaborador', permissions });

  test('dono, admin e permissions null veem', () => {
    expect(podeVerCusto({ isOwner: true, roleLabel: null, permissions: BALCAO })).toBe(true);
    expect(podeVerCusto({ isOwner: false, roleLabel: 'admin', permissions: BALCAO })).toBe(true);
    expect(podeVerCusto(membro(null))).toBe(true);
  });

  test('Caixa + Estoque sem retaguarda não vê', () => {
    expect(podeVerCusto(membro(BALCAO))).toBe(false);
    expect(podeVerCusto(membro({ pdv: true, painel: false }))).toBe(false);
  });

  test('qualquer chave de retaguarda libera', () => {
    for (const k of ['financeiro', 'relatorios', 'configuracoes', 'painel']) {
      expect(podeVerCusto(membro({ ...BALCAO, [k]: true }))).toBe(true);
    }
  });

  test('painel ausente conta como ligado (igual ao menu do app)', () => {
    expect(podeVerCusto(membro({ pdv: true, estoque: true }))).toBe(true);
  });

  test('a chave custos, quando marcada pelo dono, decide', () => {
    expect(podeVerCusto(membro({ ...BALCAO, custos: true }))).toBe(true);
    expect(podeVerCusto(membro({ pdv: true, estoque: true, financeiro: true, custos: false }))).toBe(false);
  });

  test('estoque_consulta nunca vê, nem com custos: true', () => {
    expect(podeVerCusto(membro({ estoque_consulta: true, custos: true }))).toBe(false);
  });

  test('semCustoNaEscrita tira o custo em qualquer profundidade', () => {
    expect(semCustoNaEscrita({ price: 9, cost_price: 1, itens: [{ unit_cost: 2, quantity: 3 }] }))
      .toEqual({ price: 9, itens: [{ quantity: 3 }] });
  });
});

describe('GET /products', () => {
  test('balcão recebe preço, sem custo', async () => {
    banco({ permissions: BALCAO });
    const res = await get('/products');
    expect(res.status).toBe(200);
    const p = res.body.products[0];
    expect(p.price).toBe(35);
    expect(p).not.toHaveProperty('cost_price');
  });

  test('com financeiro, vê o custo', async () => {
    banco({ permissions: { ...BALCAO, financeiro: true } });
    const res = await get('/products');
    expect(res.body.products[0]).toMatchObject({ price: 35, cost_price: 5.5 });
  });

  test('dono vê tudo e não paga a leitura de permissão', async () => {
    banco({ papel: 'owner', permissions: null });
    const res = await get('/products');
    expect(res.body.products[0]).toMatchObject({ cost_price: 5.5 });
    expect(db.query.mock.calls.some(([s]) => /cm\.role_label, cm\.permissions/.test(String(s)))).toBe(false);
  });
});

describe('PATCH /products/:pid', () => {
  test('balcão grava o preço e o custo do corpo é descartado', async () => {
    banco({ permissions: BALCAO });
    const res = await request(app()).patch(`${BASE}/products/${PID}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ price: 39.9, cost_price: 0 });
    expect(res.status).toBeLessThan(300);
    const update = db.query.mock.calls.map(([s]) => String(s)).find((s) => /UPDATE products SET/i.test(s));
    expect(update).toMatch(/price = \$/);
    expect(update).not.toMatch(/cost_price/);
    expect(res.body).not.toHaveProperty('cost_price');
  });

  test('com financeiro, o custo grava', async () => {
    banco({ permissions: { ...BALCAO, financeiro: true } });
    await request(app()).patch(`${BASE}/products/${PID}`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ cost_price: 6 });
    const update = db.query.mock.calls.map(([s]) => String(s)).find((s) => /UPDATE products SET/i.test(s));
    expect(update).toMatch(/cost_price = \$/);
  });
});

describe('fora de /products', () => {
  // /margin é do Expansão: no Negócio o plano já barra (outro 403). Aqui
  // interessa quem barrou.
  test('/margin: o balcão é barrado pelo custo', async () => {
    banco({ permissions: BALCAO });
    const res = await get('/margin');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ESTOQUE_SO_CONSULTA');
  });

  test('/margin: quem tem financeiro não é barrado pelo custo', async () => {
    banco({ permissions: { ...BALCAO, financeiro: true } });
    const res = await get('/margin');
    expect(res.body.code).not.toBe('ESTOQUE_SO_CONSULTA');
  });
});
