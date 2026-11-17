// ============================================================
// AURA. — Vínculo em lote com custo e código por produto (B4, 17/11/2026)
//
// POST /suppliers/:sid/products, montado por src/routes/private.js, com o
// banco falso. O Postgres de verdade está em
// fornecedores.vinculoPorItem.banco.test.js.
//
//   1. PARIDADE: o corpo de hoje ({ product_ids, cost, is_main, unlink })
//      manda ao banco exatamente os mesmos comandos, com os mesmos
//      parâmetros, e responde igual. O snapshot foi gravado rodando este
//      arquivo contra o suppliers.js de origin/main (fbf5724f), antes da
//      mudança, e não pode ser regravado para fazer o teste passar.
//   2. items[]: o custo e o código de cada produto chegam ao INSERT, na
//      ordem; produto repetido vale a última linha; sem custo no item vale
//      o `cost` do corpo; custo inválido vira "manter o gravado"; erros de
//      corpo levam 400 sem ir ao banco.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const SID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const P1 = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
const P2 = 'aaaaaaaa-bbbb-cccc-dddd-000000000002';
const P3 = 'aaaaaaaa-bbbb-cccc-dddd-000000000003';
const BASE = `/companies/${COMPANY}`;
const token = () => jwt.sign({ id: 'dono', role: 'client', plan: 'essencial', company: COMPANY }, 'aura-test-secret-2026', { expiresIn: '1h' });

let montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
}, 60000);

// Banco falso: fornecedor do grupo (ou não), product_suppliers presente (ou
// não, base sem a 424). Guarda tudo o que a rota mandou.
function banco({ fornecedor = true, semTabela = false, ligados = null } = {}) {
  const sqls = [];
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    sqls.push({ s, params });
    if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    if (/SELECT id, name, cnpj FROM suppliers s WHERE id = \$1/.test(s)) {
      return Promise.resolve({ rows: fornecedor ? [{ id: SID, name: 'Brás Capas', cnpj: '12345678000190' }] : [] });
    }
    if (semTabela && /product_suppliers/.test(s)) {
      return Promise.reject(Object.assign(new Error('relation "product_suppliers" does not exist'), { code: '42P01' }));
    }
    if (/UPDATE products SET supplier_id/.test(s)) return Promise.resolve({ rows: [], rowCount: (params[0] || []).length });
    if (/INSERT INTO product_suppliers/.test(s)) {
      const ids = ligados || params[0] || [];
      return Promise.resolve({ rows: ids.map((product_id) => ({ product_id })), rowCount: ids.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return sqls;
}

const vincular = (body) => request(montado)
  .post(`${BASE}/suppliers/${SID}/products`)
  .set('Authorization', `Bearer ${token()}`)
  .send(body);

// Só os comandos da rota (o resto é autenticação e middleware, igual nos
// dois lados), com o espaço em branco normalizado.
const daRota = (sqls) => sqls
  .filter(({ s }) => /suppliers|product_suppliers|products/.test(s) && !/'owner' AS role/.test(s) && !/company_members/.test(s))
  .map(({ s, params }) => ({ sql: s.replace(/\s+/g, ' ').trim(), params }));

const ids1001 = Array.from({ length: 1001 }, (_, i) => `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, '0')}`);

// ── 1. Paridade com o corpo de hoje ─────────────────────────────────
describe('paridade: o corpo de hoje faz o mesmo que antes do B4', () => {
  const casos = [
    ['principal, sem custo', {}, { product_ids: [P1, P2] }],
    ['principal, com custo', {}, { product_ids: [P1, P2], cost: 5.21 }],
    ['principal, custo em texto', {}, { product_ids: [P1], cost: '7.5' }],
    ['principal, custo zero (manter)', {}, { product_ids: [P1], cost: 0 }],
    ['is_main false, sem custo', {}, { product_ids: [P1, P2], is_main: false }],
    ['is_main false, com custo', {}, { product_ids: [P1, P2, P3], is_main: false, cost: 3 }],
    ['desvincular', {}, { product_ids: [P1, P2], unlink: true }],
    ['desvincular com is_main false', {}, { product_ids: [P1], unlink: true, is_main: false }],
    ['product_ids vazio', {}, { product_ids: [] }],
    ['sem product_ids', {}, { cost: 4 }],
    ['product_ids que não é lista', {}, { product_ids: P1 }],
    ['mais de 1000', {}, { product_ids: ids1001 }],
    ['fornecedor fora do grupo', { fornecedor: false }, { product_ids: [P1] }],
    ['base sem a 424, principal', { semTabela: true }, { product_ids: [P1, P2], cost: 2 }],
    ['base sem a 424, is_main false', { semTabela: true }, { product_ids: [P1], is_main: false }],
  ];

  test.each(casos)('%s', async (_nome, cenario, body) => {
    const sqls = banco(cenario);
    const res = await vincular(body);
    expect({ status: res.status, body: res.body, comandos: daRota(sqls) }).toMatchSnapshot();
  });
});

// ── 2. items[]: custo e código por produto ─────────────────────────
describe('items[]: custo e código de cada produto', () => {
  const insert = (sqls) => sqls.find(({ s }) => /INSERT INTO product_suppliers/.test(s));

  test('is_main false: cada produto com o seu custo e o seu código, sem tocar no principal nem no estoque', async () => {
    const sqls = banco();
    const res = await vincular({
      is_main: false,
      items: [
        { product_id: P1, cost: 5.9, supplier_code: ' AL-0391 ' },
        { product_id: P2, cost: '12,5' },            // vírgula não é número: manter o custo gravado
        { product_id: P3, cost: 0.75, supplier_code: '' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3, unlink: false, is_main: false, linked: 3, not_found: [] });
    const ins = insert(sqls);
    expect(ins.params).toEqual([[P1, P2, P3], COMPANY, SID, [5.9, null, 0.75], ['AL-0391', null, null], false]);
    expect(ins.s).toMatch(/supplier_code = COALESCE\(EXCLUDED\.supplier_code, product_suppliers\.supplier_code\)/);
    expect(ins.s).toMatch(/cost = COALESCE\(EXCLUDED\.cost, product_suppliers\.cost\)/);
    // não troca o principal de ninguém e não mexe em estoque nem no custo do produto
    expect(sqls.some(({ s }) => /UPDATE products SET supplier_id = \$3/.test(s))).toBe(false);
    expect(sqls.some(({ s }) => /UPDATE product_suppliers SET is_main = false/.test(s))).toBe(false);
    expect(sqls.some(({ s }) => /stock_qty|cost_price|weighted_avg_cost|stock_movements/.test(s))).toBe(false);
  });

  test('principal (padrão): espelha products.supplier_id como o corpo antigo, com o custo de cada um', async () => {
    const sqls = banco();
    const res = await vincular({ items: [{ product_id: P1, cost: 4 }, { product_id: P2, cost: 6 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, unlink: false, is_main: true, linked: 2 });
    const upd = sqls.find(({ s }) => /UPDATE products SET supplier_id = \$3/.test(s));
    expect(upd.params).toEqual([[P1, P2], COMPANY, SID, 'Brás Capas', '12345678000190']);
    expect(sqls.some(({ s }) => /UPDATE product_suppliers SET is_main = false/.test(s))).toBe(true);
    expect(insert(sqls).params).toEqual([[P1, P2], COMPANY, SID, [4, 6], [null, null], true]);
  });

  test('sem custo no item vale o cost do corpo', async () => {
    const sqls = banco();
    await vincular({ is_main: false, cost: 9.99, items: [{ product_id: P1 }, { product_id: P2, cost: 3 }] });
    expect(insert(sqls).params[3]).toEqual([9.99, 3]);
  });

  test('produto repetido: vale a última linha', async () => {
    const sqls = banco();
    const res = await vincular({
      is_main: false,
      items: [
        { product_id: P1, cost: 1, supplier_code: 'A' },
        { product_id: P2, cost: 2 },
        { product_id: P1, cost: 3, supplier_code: 'B' },
      ],
    });
    expect(res.status).toBe(200);
    expect(insert(sqls).params.slice(0, 1).concat(insert(sqls).params.slice(3, 5))).toEqual([[P2, P1], [2, 3], [null, 'B']]);
  });

  test('código do fornecedor cortado em 60', async () => {
    const sqls = banco();
    await vincular({ is_main: false, items: [{ product_id: P1, supplier_code: 'x'.repeat(80) }] });
    expect(insert(sqls).params[4]).toEqual(['x'.repeat(60)]);
  });

  test('produto que não é da loja nem do grupo: fica em not_found', async () => {
    banco({ ligados: [P1] });
    const res = await vincular({ is_main: false, items: [{ product_id: P1, cost: 1 }, { product_id: P2, cost: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ linked: 1, not_found: [P2] });
  });

  test('desvincular por items: igual ao unlink de hoje', async () => {
    const sqls = banco();
    const res = await vincular({ unlink: true, items: [{ product_id: P1, cost: 3 }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, unlink: true });
    expect(sqls.some(({ s }) => /DELETE FROM product_suppliers/.test(s))).toBe(true);
    expect(sqls.some(({ s }) => /INSERT INTO product_suppliers/.test(s))).toBe(false);
  });

  test('base sem a 424: 200, linked null', async () => {
    banco({ semTabela: true });
    const res = await vincular({ is_main: false, items: [{ product_id: P1, cost: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 0, linked: null, not_found: [] });
  });

  test.each([
    ['lista vazia', { items: [] }],
    ['item sem product_id', { items: [{ cost: 3 }] }],
    ['item que não é objeto', { items: [P1] }],
    ['mais de 1000', { items: ids1001.map((product_id) => ({ product_id })) }],
  ])('%s: 400 sem ir ao banco', async (_n, body) => {
    const sqls = banco();
    const res = await vincular(body);
    expect(res.status).toBe(400);
    expect(sqls.some(({ s }) => /suppliers s WHERE id/.test(s))).toBe(false);
  });

  test('fornecedor fora do grupo: 404 e nada grava', async () => {
    const sqls = banco({ fornecedor: false });
    const res = await vincular({ items: [{ product_id: P1, cost: 1 }] });
    expect(res.status).toBe(404);
    expect(sqls.some(({ s }) => /INSERT|UPDATE/.test(s))).toBe(false);
  });

  test('product_id que não é uuid: 400', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/FROM suppliers s WHERE id = \$1/.test(s)) return Promise.resolve({ rows: [{ id: SID, name: 'B', cnpj: null }] });
      if (/INSERT INTO product_suppliers/.test(s)) return Promise.reject(Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const res = await vincular({ is_main: false, items: [{ product_id: 'abc' }] });
    expect(res.status).toBe(400);
  });
});
