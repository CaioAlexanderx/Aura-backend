// ============================================================
// AURA. — Fase 1 fornecedores: vinculo produto <-> fornecedor
// (src/routes/products.js, POST/PATCH aceitando supplier_id)
//
// CLAUDE.md armadilha 4/7: rotas adjacentes de produto tem que respeitar
// a mesma visibilidade (propria empresa OU grupo). Aqui o vinculo e com
// `suppliers`, nao com `products`, mas a regra e a mesma: supplier_id de
// uma empresa fora do grupo -> 404, nao vaza nem lista nem PATCH.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const router = require('../src/routes/products');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/products', router);
  return app;
}

const CID = 'c1111111-1111-1111-1111-111111111111';
const PID = 'p3333333-3333-3333-3333-333333333333';
const SUPPLIER_ID = 's4444444-4444-4444-4444-444444444444';

beforeEach(() => { db.query.mockReset(); });

describe('POST /companies/:id/products — supplier_id', () => {
  test('supplier_id de empresa fora do grupo -> 404, produto NAO e criado', async () => {
    db.query.mockImplementation((sql) => {
      if (/AS in_group/.test(sql)) return Promise.resolve({ rows: [{ total: '0', in_group: false }] });
      if (/SELECT id, name, cnpj FROM suppliers WHERE id = \$1 AND/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).post(`/companies/${CID}/products`).send({
      name: 'Produto Teste', price: 10, supplier_id: SUPPLIER_ID,
    });

    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO products/.test(sql))).toBe(false);
  });

  test('supplier_id valido -> produto criado com supplier_name/cnpj sincronizados', async () => {
    db.query.mockImplementation((sql) => {
      if (/AS in_group/.test(sql)) return Promise.resolve({ rows: [{ total: '0', in_group: false }] });
      if (/SELECT id, name, cnpj FROM suppliers WHERE id = \$1 AND/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SUPPLIER_ID, name: 'Fornecedor Y', cnpj: '11222333000181' }] });
      }
      if (/INSERT INTO products/.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: PID, name: 'Produto Teste', price: 10, company_id: CID,
            supplier_id: SUPPLIER_ID, supplier_name: 'Fornecedor Y', supplier_cnpj: '11222333000181',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).post(`/companies/${CID}/products`).send({
      name: 'Produto Teste', price: 10, supplier_id: SUPPLIER_ID,
    });

    expect(res.status).toBe(201);
    expect(res.body.supplier).toEqual({ id: SUPPLIER_ID, name: 'Fornecedor Y', cnpj: '11222333000181' });

    const insertCall = db.query.mock.calls.find(([sql]) => /INSERT INTO products/.test(sql));
    expect(insertCall[1]).toEqual(expect.arrayContaining([SUPPLIER_ID, 'Fornecedor Y', '11222333000181']));
  });

  test('sem supplier_id -> produto criado sem vinculo, sem consultar suppliers', async () => {
    db.query.mockImplementation((sql) => {
      if (/AS in_group/.test(sql)) return Promise.resolve({ rows: [{ total: '0', in_group: false }] });
      if (/INSERT INTO products/.test(sql)) {
        return Promise.resolve({ rows: [{ id: PID, name: 'Produto Sem Fornecedor', price: 10, company_id: CID }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).post(`/companies/${CID}/products`).send({ name: 'Produto Sem Fornecedor', price: 10 });

    expect(res.status).toBe(201);
    expect(res.body.supplier).toBeNull();
    expect(db.query.mock.calls.some(([sql]) => /FROM suppliers/.test(sql))).toBe(false);
  });
});

describe('PATCH /companies/:id/products/:pid — supplier_id', () => {
  test('supplier_id de empresa fora do grupo -> 404, produto NAO e alterado', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id, name, cnpj FROM suppliers WHERE id = \$1 AND/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).patch(`/companies/${CID}/products/${PID}`).send({ supplier_id: SUPPLIER_ID });

    expect(res.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => /UPDATE products SET/.test(sql))).toBe(false);
  });

  test('supplier_id valido -> atualiza e resincroniza supplier_name/cnpj', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id, name, cnpj FROM suppliers WHERE id = \$1 AND/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SUPPLIER_ID, name: 'Fornecedor Z', cnpj: '11444777000161' }] });
      }
      if (/UPDATE products SET/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: PID, supplier_id: SUPPLIER_ID, supplier_name: 'Fornecedor Z', supplier_cnpj: '11444777000161' }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).patch(`/companies/${CID}/products/${PID}`).send({ supplier_id: SUPPLIER_ID });

    expect(res.status).toBe(200);
    expect(res.body.supplier).toEqual({ id: SUPPLIER_ID, name: 'Fornecedor Z', cnpj: '11444777000161' });
  });

  test('supplier_id null -> desvincula (limpa os 3 campos)', async () => {
    db.query.mockImplementation((sql) => {
      if (/UPDATE products SET/.test(sql)) {
        return Promise.resolve({ rows: [{ id: PID, supplier_id: null, supplier_name: null, supplier_cnpj: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).patch(`/companies/${CID}/products/${PID}`).send({ supplier_id: null });

    expect(res.status).toBe(200);
    expect(res.body.supplier).toBeNull();
    expect(db.query.mock.calls.some(([sql]) => /FROM suppliers WHERE id/.test(sql))).toBe(false);

    const updateCall = db.query.mock.calls.find(([sql]) => /UPDATE products SET/.test(sql));
    expect(updateCall[0]).toMatch(/supplier_id = \$/);
  });
});
