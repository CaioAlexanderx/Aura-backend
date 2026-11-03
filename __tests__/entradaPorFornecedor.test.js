// ============================================================
// AURA. — Fornecedores do produto e entrada de mercadoria (03/11/2026)
//
// Migration 424 + src/routes/productSuppliers.js. Números do mockup
// aprovado (aura-app docs/mockups/estoque-entrada-por-fornecedor.html).
//
// Cobertura:
//   1. custo médio ponderado (estoque negativo, sem custo, primeira compra)
//   2. leitura do corpo (grade, variante repetida, principal único)
//   3. POST /products/:pid/stock-entries: estoque, custo médio, movimento
//      com fornecedor/custo/variante, fornecedor novo na hora, erros de grade
//   4. PUT /products/:pid/suppliers: custo ausente mantém o gravado
//   5. a rota monta antes de ./products (o /:pid curinga não engole)
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const { custoMedioPonderado, lerEntrada, lerListaDeFornecedores } = require('../src/services/entradaDeMercadoria');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SID2 = 'cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa';
const V1 = 'dddddddd-eeee-ffff-aaaa-bbbbbbbbbbbb';
const V2 = 'eeeeeeee-ffff-aaaa-bbbb-cccccccccccc';
const BASE = `/companies/${COMPANY}`;
const token = () => jwt.sign({ id: 'dono', role: 'client', plan: 'essencial', company: COMPANY }, 'aura-test-secret-2026', { expiresIn: '1h' });

let montado;
beforeAll(() => {
  montado = express();
  montado.use(express.json());
  montado.use('/companies/:id', require('../src/routes/private'));
}, 60000);

describe('custo médio ponderado', () => {
  test('4 un a R$ 5,50 + 20 a R$ 5,90 = R$ 5,8333 (tela 2)', () => {
    expect(custoMedioPonderado({ estoqueAntes: 4, custoAtual: 5.5, quantidade: 20, custoUnitario: 5.9 })).toBe(5.8333);
  });
  test('4 a R$ 5,50 + 10 a R$ 4,80 = R$ 5,00 (tela 3)', () => {
    expect(custoMedioPonderado({ estoqueAntes: 4, custoAtual: 5.5, quantidade: 10, custoUnitario: 4.8 })).toBe(5);
  });
  test('estoque negativo não entra na média', () => {
    expect(custoMedioPonderado({ estoqueAntes: -3, custoAtual: 9, quantidade: 10, custoUnitario: 5 })).toBe(5);
  });
  test('sem custo anterior ou sem estoque: o custo da entrada', () => {
    expect(custoMedioPonderado({ estoqueAntes: 7, custoAtual: null, quantidade: 2, custoUnitario: 3 })).toBe(3);
    expect(custoMedioPonderado({ estoqueAntes: 0, custoAtual: 8, quantidade: 2, custoUnitario: 3 })).toBe(3);
  });
  test('entrada sem custo não mexe na média', () => {
    expect(custoMedioPonderado({ estoqueAntes: 4, custoAtual: 5.5, quantidade: 20, custoUnitario: null })).toBe(5.5);
    expect(custoMedioPonderado({ estoqueAntes: 4, custoAtual: null, quantidade: 20 })).toBeNull();
  });
});

describe('leitura do corpo', () => {
  test('quantidade simples, vírgula e nota', () => {
    expect(lerEntrada({ quantity: '20', unit_cost: '5,90', invoice_number: ' 004512 ' }))
      .toMatchObject({ total: 20, custoUnitario: 5.9, nota: '004512', atualizarCusto: true, itens: [{ variant_id: null, quantidade: 20 }] });
  });
  test('grade: zeros saem, variante repetida e sem variante são erro', () => {
    expect(lerEntrada({ items: [{ variant_id: V1, quantity: 4 }, { variant_id: V2, quantity: 0 }] }).total).toBe(4);
    expect(lerEntrada({ items: [{ variant_id: V1, quantity: 1 }, { variant_id: V1, quantity: 2 }] }).erro).toMatch(/repetida/);
    expect(lerEntrada({ items: [{ quantity: 1 }] }).erro).toMatch(/variante/);
    expect(lerEntrada({ quantity: 0 }).erro).toMatch(/quantidade/);
  });
  test('lista de fornecedores: um principal só; cost ausente = manter', () => {
    const r = lerListaDeFornecedores({ suppliers: [{ supplier_id: SID, cost: 5.21 }, { supplier_id: SID2, is_main: true }] }, SID);
    expect(r.itens.map((i) => [i.supplier_id, i.principal, i.temCusto])).toEqual([[SID, false, true], [SID2, true, false]]);
    const semMarca = lerListaDeFornecedores({ suppliers: [{ supplier_id: SID }, { supplier_id: SID2 }] }, SID2);
    expect(semMarca.itens.find((i) => i.principal).supplier_id).toBe(SID2);
    expect(lerListaDeFornecedores({}, null).erro).toBeTruthy();
  });
});

// ── Banco de mentira: guarda estado suficiente para as rotas ─────────
function bancoFalso({ variantes = [], produto = {} } = {}) {
  const estado = {
    produto: { id: PID, company_id: COMPANY, name: 'Capa iPhone 15', stock_qty: 4, cost_price: 5.5, weighted_avg_cost: null, supplier_id: null, ...produto },
    variantes: variantes.map((v) => ({ ...v })),
    ps: [],
    movimentos: [],
    fornecedoresCriados: [],
    sql: [],
  };
  const r = (rows) => Promise.resolve({ rows, rowCount: rows.length });
  const handler = (sql, params = []) => {
    const s = String(sql);
    estado.sql.push(s);
    if (/'owner' AS role/.test(s)) return r([{ role: 'owner' }]);
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(s.trim())) return r([]);
    if (/FROM products\s+WHERE id = \$1 AND/.test(s)) return r(params[0] === PID ? [{ ...estado.produto }] : []);
    if (/FROM product_variants WHERE product_id = \$1 AND is_active/.test(s)) return r(estado.variantes.map((v) => ({ ...v })));
    if (/FROM suppliers WHERE id = \$1/.test(s)) {
      return r([SID, SID2].includes(params[0]) ? [{ id: params[0], name: params[0] === SID ? 'Distribuidora Alfa' : 'Brás Capas', cnpj: null, phone: null }] : []);
    }
    if (/FROM suppliers WHERE id = ANY/.test(s)) return r(params[0].filter((i) => [SID, SID2].includes(i)).map((id) => ({ id })));
    if (/FROM suppliers\s+WHERE company_id IN/.test(s) && /lower\(trim\(name\)\)/.test(s)) return r([]);
    if (/INSERT INTO suppliers/.test(s)) {
      const f = { id: 'ffffffff-0000-0000-0000-000000000001', name: params[1], cnpj: params[2], phone: params[3] };
      estado.fornecedoresCriados.push(f);
      return r([f]);
    }
    if (/UPDATE product_variants SET stock_qty = stock_qty \+/.test(s)) {
      const v = estado.variantes.find((x) => x.id === params[1]);
      v.stock_qty += params[0];
      return r([]);
    }
    if (/UPDATE products SET stock_qty = stock_qty \+/.test(s)) { estado.produto.stock_qty += params[0]; return r([]); }
    if (/SET weighted_avg_cost = \$2/.test(s)) {
      estado.produto.weighted_avg_cost = params[1];
      if (params[2]) estado.produto.cost_price = Math.round(params[1] * 100) / 100;
      return r([]);
    }
    if (/INSERT INTO product_suppliers/.test(s) && /ON CONFLICT/.test(s)) {
      const sup = params[2];
      const existente = estado.ps.find((x) => x.supplier_id === sup);
      if (/temCusto|\$7::boolean/.test(s)) {
        // PUT
        if (existente) {
          if (params[6]) existente.cost = params[3];
          existente.supplier_code = params[4]; existente.is_main = params[5];
        } else estado.ps.push({ supplier_id: sup, cost: params[3], supplier_code: params[4], is_main: params[5] });
      } else if (existente) {
        if (params[3] !== null) existente.cost = params[3];
      } else {
        estado.ps.push({ supplier_id: sup, cost: params[3], is_main: !estado.ps.some((x) => x.is_main) });
      }
      return r([]);
    }
    if (/DELETE FROM product_suppliers WHERE product_id = \$1 AND NOT/.test(s)) {
      estado.ps = estado.ps.filter((x) => params[1].includes(x.supplier_id));
      return r([]);
    }
    if (/UPDATE product_suppliers SET is_main = false WHERE product_id = \$1/.test(s)) { estado.ps.forEach((x) => { x.is_main = false; }); return r([]); }
    if (/INSERT INTO stock_movements/.test(s)) {
      estado.movimentos.push({ quantity: params[2], notes: params[3], supplier_id: params[4], unit_cost: params[5], variant_id: params[6], company_id: params[1] });
      return r([]);
    }
    if (/FROM product_suppliers ps\s+JOIN suppliers s/.test(s) && /ORDER BY ps.is_main/.test(s)) {
      return r(estado.ps.map((x) => ({ supplier_id: x.supplier_id, name: 'F', cnpj: null, phone: null, cost: x.cost, supplier_code: x.supplier_code || null, is_main: x.is_main, last_purchase_at: null })));
    }
    return r([]);
  };
  db.query.mockImplementation(handler);
  db.connect.mockImplementation(async () => ({ query: jest.fn(handler), release: jest.fn() }));
  return estado;
}

const entrada = (body) => request(montado).post(`${BASE}/products/${PID}/stock-entries`).set('Authorization', `Bearer ${token()}`).send(body);

beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); });

describe('POST /products/:pid/stock-entries', () => {
  test('produto simples: estoque 4 → 24, custo médio 5,50 → 5,83, movimento com fornecedor e custo', async () => {
    const e = bancoFalso();
    const res = await entrada({ supplier_id: SID, quantity: 20, unit_cost: 5.9, invoice_number: '004512' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ quantity: 20, before: { stock_qty: 4, avg_cost: 5.5 }, after: { stock_qty: 24, avg_cost: 5.8333 } });
    expect(e.produto.stock_qty).toBe(24);
    expect(e.produto.cost_price).toBe(5.83);
    expect(e.movimentos).toEqual([{ quantity: 20, notes: 'NF 004512', supplier_id: SID, unit_cost: 5.9, variant_id: null, company_id: COMPANY }]);
    expect(e.ps).toEqual([{ supplier_id: SID, cost: 5.9, is_main: true }]);
  });

  test('update_cost false: guarda o médio sem mexer no custo do produto', async () => {
    const e = bancoFalso();
    await entrada({ supplier_id: SID, quantity: 20, unit_cost: 5.9, update_cost: false });
    expect(e.produto.weighted_avg_cost).toBe(5.8333);
    expect(e.produto.cost_price).toBe(5.5);
  });

  test('sem custo (ex.: quem não vê custo): soma estoque, não mexe no custo', async () => {
    const e = bancoFalso();
    const res = await entrada({ supplier_id: SID, quantity: 3 });
    expect(res.status).toBe(201);
    expect(e.produto.stock_qty).toBe(7);
    expect(e.sql.some((s) => /SET weighted_avg_cost/.test(s))).toBe(false);
  });

  test('fornecedor novo cadastrado na hora (tela 3)', async () => {
    const e = bancoFalso();
    const res = await entrada({ new_supplier: { name: 'Distribuidora Centro' }, quantity: 10, unit_cost: 4.8 });
    expect(res.status).toBe(201);
    expect(res.body.supplier).toMatchObject({ name: 'Distribuidora Centro', created: true });
    expect(e.fornecedoresCriados).toHaveLength(1);
    expect(res.body.after.avg_cost).toBe(5);
  });

  test('grade: soma em cada variante e grava um movimento por variante', async () => {
    const e = bancoFalso({ variantes: [{ id: V1, stock_qty: 2 }, { id: V2, stock_qty: 0 }], produto: { stock_qty: 0, cost_price: 24 } });
    const res = await entrada({ supplier_id: SID, items: [{ variant_id: V1, quantity: 4 }, { variant_id: V2, quantity: 6 }], unit_cost: 24 });
    expect(res.status).toBe(201);
    expect(e.variantes).toEqual([{ id: V1, stock_qty: 6 }, { id: V2, stock_qty: 6 }]);
    expect(e.produto.stock_qty).toBe(0);
    expect(e.movimentos.map((m) => [m.variant_id, m.quantity])).toEqual([[V1, 4], [V2, 6]]);
  });

  test('produto com grade exige quantidade por variante; variante de outro produto é recusada', async () => {
    bancoFalso({ variantes: [{ id: V1, stock_qty: 2 }] });
    expect((await entrada({ supplier_id: SID, quantity: 3 })).status).toBe(400);
    bancoFalso({ variantes: [{ id: V1, stock_qty: 2 }] });
    expect((await entrada({ supplier_id: SID, items: [{ variant_id: V2, quantity: 1 }] })).status).toBe(400);
  });

  test('fornecedor de fora do grupo: 404 e nada grava', async () => {
    const e = bancoFalso();
    const res = await entrada({ supplier_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', quantity: 1 });
    expect(res.status).toBe(404);
    expect(e.movimentos).toHaveLength(0);
  });
});

describe('PUT /products/:pid/suppliers', () => {
  const put = (body) => request(montado).put(`${BASE}/products/${PID}/suppliers`).set('Authorization', `Bearer ${token()}`).send(body);

  test('grava a lista, um principal; cost ausente mantém o custo gravado', async () => {
    const e = bancoFalso();
    e.ps.push({ supplier_id: SID, cost: 5.9, is_main: true });
    const res = await put({ suppliers: [{ supplier_id: SID }, { supplier_id: SID2, cost: 5.21, is_main: true }] });
    expect(res.status).toBe(200);
    expect(e.ps.find((x) => x.supplier_id === SID)).toMatchObject({ cost: 5.9, is_main: false });
    expect(e.ps.find((x) => x.supplier_id === SID2)).toMatchObject({ cost: 5.21, is_main: true });
  });

  test('lista vazia tira todos', async () => {
    const e = bancoFalso();
    e.ps.push({ supplier_id: SID, cost: 5.9, is_main: true });
    await put({ suppliers: [] });
    expect(e.ps).toEqual([]);
  });
});

test('GET /products/:pid/suppliers chega na rota nova (não no /:pid de ./products)', async () => {
  const e = bancoFalso();
  e.ps.push({ supplier_id: SID, cost: 5.21, is_main: true });
  const res = await request(montado).get(`${BASE}/products/${PID}/suppliers`).set('Authorization', `Bearer ${token()}`);
  expect(res.status).toBe(200);
  expect(res.body.suppliers[0]).toMatchObject({ supplier_id: SID, cost: 5.21, is_main: true });
});

describe('POST /suppliers/:sid/products (vínculo em lote, tela 9)', () => {
  function banco() {
    const sqls = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      sqls.push({ s, params });
      if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/SELECT id, name, cnpj FROM suppliers s WHERE id = \$1/.test(s)) return Promise.resolve({ rows: [{ id: SID, name: 'Brás Capas', cnpj: null }] });
      if (/UPDATE products SET supplier_id = \$3/.test(s)) return Promise.resolve({ rows: [], rowCount: 2 });
      if (/INSERT INTO product_suppliers/.test(s)) return Promise.resolve({ rows: [], rowCount: 2 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    return sqls;
  }
  const vincular = (body) => request(montado).post(`${BASE}/suppliers/${SID}/products`).set('Authorization', `Bearer ${token()}`).send(body);

  test('padrão (principal): products.supplier_id + product_suppliers como principal, com o custo', async () => {
    const sqls = banco();
    const res = await vincular({ product_ids: [PID], cost: 5.21 });
    expect(res.status).toBe(200);
    expect(sqls.some(({ s }) => /UPDATE products SET supplier_id = \$3/.test(s))).toBe(true);
    const ins = sqls.find(({ s }) => /INSERT INTO product_suppliers/.test(s));
    expect(ins.params.slice(2)).toEqual([SID, 5.21, true]);
  });

  test('is_main false: só entra na lista, sem trocar o principal do produto', async () => {
    const sqls = banco();
    const res = await vincular({ product_ids: [PID], is_main: false });
    expect(res.status).toBe(200);
    expect(sqls.some(({ s }) => /UPDATE products SET supplier_id = \$3/.test(s))).toBe(false);
    const ins = sqls.find(({ s }) => /INSERT INTO product_suppliers/.test(s));
    expect(ins.params.slice(2)).toEqual([SID, null, false]);
  });

  test('base sem a migration 424: o vínculo de sempre segue funcionando', async () => {
    banco();
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/'owner' AS role/.test(s)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/SELECT id, name, cnpj FROM suppliers s WHERE id = \$1/.test(s)) return Promise.resolve({ rows: [{ id: SID, name: 'Brás', cnpj: null }] });
      if (/product_suppliers/.test(s)) return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const res = await vincular({ product_ids: [PID] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });
});
