// ============================================================
// AURA. — Fase 1 fornecedores: CRUD (src/routes/suppliers.js)
//
// Banco mockado, no padrao dos outros testes de rota do repo (ex:
// __tests__/courierPickup.test.js): db.query.mockImplementation
// inspecionando o SQL por regex, sem sequencia fixa de mocks.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const router = require('../src/routes/suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/suppliers', router);
  return app;
}

const CID = 'c1111111-1111-1111-1111-111111111111';
const SID = 's2222222-2222-2222-2222-222222222222';
const CNPJ_VALIDO = '11.222.333/0001-81';
const CNPJ_DIGITS = '11222333000181';

beforeEach(() => { db.query.mockReset(); });

describe('GET /companies/:id/suppliers', () => {
  test('lista fornecedores visiveis', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM suppliers s/.test(sql)) {
        return Promise.resolve({
          rows: [{ id: SID, company_id: CID, name: 'Fornecedor A', cnpj: CNPJ_DIGITS, is_active: true, product_count: 3 }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp()).get(`/companies/${CID}/suppliers`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.suppliers[0].name).toBe('Fornecedor A');
  });

  test('erro de banco vira 500', async () => {
    db.query.mockImplementation(() => Promise.reject(new Error('conexao caiu')));
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers`);
    expect(res.status).toBe(500);
  });
});

describe('GET /companies/:id/suppliers/:sid', () => {
  test('404 quando o fornecedor nao e visivel pra esta empresa', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM suppliers s WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/${SID}`);
    expect(res.status).toBe(404);
  });

  test('200 com produtos vinculados e entradas recentes', async () => {
    db.query.mockImplementation((sql) => {
      if (/FROM suppliers s WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SID, company_id: CID, name: 'Fornecedor A', cnpj: CNPJ_DIGITS, is_active: true }] });
      }
      if (/FROM products WHERE supplier_id = \$1/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'p1', name: 'Produto 1', stock_qty: 5 }] });
      }
      if (/FROM stock_movements sm/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'm1', type: 'in', quantity: 5, unit_cost: 10 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/${SID}`);
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.recent_stock_movements).toHaveLength(1);
    expect(res.body.product_count).toBe(1);
  });
});

describe('POST /companies/:id/suppliers', () => {
  test('name e obrigatorio', async () => {
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers`).send({});
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('CNPJ com digito verificador invalido -> 400, sem tocar o banco', async () => {
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers`).send({
      name: 'Fornecedor X', cnpj: '11.222.333/0001-80',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/CNPJ/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('cria fornecedor sem CNPJ', async () => {
    db.query.mockImplementation((sql) => {
      if (/INSERT INTO suppliers/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SID, company_id: CID, name: 'Fornecedor Sem Cnpj', cnpj: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers`).send({ name: 'Fornecedor Sem Cnpj' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Fornecedor Sem Cnpj');
  });

  test('CNPJ duplicado no grupo -> 409 com o id existente', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM suppliers WHERE cnpj = \$1 AND/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SID }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers`).send({
      name: 'Fornecedor Duplicado', cnpj: CNPJ_VALIDO,
    });
    expect(res.status).toBe(409);
    expect(res.body.id).toBe(SID);
  });

  test('corrida no INSERT (23505) tambem devolve 409 com o id existente', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM suppliers WHERE cnpj = \$1 AND/.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO suppliers/.test(sql)) {
        const e = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        return Promise.reject(e);
      }
      if (/SELECT id FROM suppliers WHERE company_id = \$1 AND cnpj = \$2/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SID }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers`).send({
      name: 'Fornecedor Corrida', cnpj: CNPJ_VALIDO,
    });
    expect(res.status).toBe(409);
    expect(res.body.id).toBe(SID);
  });
});

describe('PATCH /companies/:id/suppliers/:sid', () => {
  test('nenhum campo -> 400', async () => {
    const res = await request(makeApp()).patch(`/companies/${CID}/suppliers/${SID}`).send({});
    expect(res.status).toBe(400);
  });

  test('404 quando o fornecedor nao e visivel', async () => {
    db.query.mockImplementation((sql) => {
      if (/UPDATE suppliers SET/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).patch(`/companies/${CID}/suppliers/${SID}`).send({ name: 'Novo Nome' });
    expect(res.status).toBe(404);
  });

  test('atualiza campos simples', async () => {
    db.query.mockImplementation((sql) => {
      if (/UPDATE suppliers SET/.test(sql)) {
        return Promise.resolve({ rows: [{ id: SID, name: 'Novo Nome', phone: '11999999999' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).patch(`/companies/${CID}/suppliers/${SID}`).send({ name: 'Novo Nome', phone: '11999999999' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Novo Nome');
  });

  test('CNPJ invalido -> 400 sem tocar o banco', async () => {
    const res = await request(makeApp()).patch(`/companies/${CID}/suppliers/${SID}`).send({ cnpj: '00.000.000/0000-00' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('CNPJ duplicado em outro fornecedor do grupo -> 409', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM suppliers WHERE cnpj = \$1 AND id != \$2 AND/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'outro-id' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).patch(`/companies/${CID}/suppliers/${SID}`).send({ cnpj: CNPJ_VALIDO });
    expect(res.status).toBe(409);
    expect(res.body.id).toBe('outro-id');
  });
});

describe('DELETE /companies/:id/suppliers/:sid', () => {
  test('404 quando nao visivel', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM suppliers WHERE id = \$1 AND/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).delete(`/companies/${CID}/suppliers/${SID}`);
    expect(res.status).toBe(404);
  });

  test('sem produto vinculado -> apaga de verdade', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM suppliers WHERE id = \$1 AND/.test(sql)) return Promise.resolve({ rows: [{ id: SID }] });
      if (/SELECT COUNT\(\*\)::int AS total FROM products WHERE supplier_id = \$1/.test(sql)) return Promise.resolve({ rows: [{ total: 0 }] });
      if (/DELETE FROM suppliers WHERE id = \$1/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).delete(`/companies/${CID}/suppliers/${SID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, soft: false, id: SID });
  });

  test('com produto vinculado -> desativa (soft)', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT id FROM suppliers WHERE id = \$1 AND/.test(sql)) return Promise.resolve({ rows: [{ id: SID }] });
      if (/SELECT COUNT\(\*\)::int AS total FROM products WHERE supplier_id = \$1/.test(sql)) return Promise.resolve({ rows: [{ total: 2 }] });
      if (/UPDATE suppliers SET is_active = false/.test(sql)) return Promise.resolve({ rows: [{ id: SID }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).delete(`/companies/${CID}/suppliers/${SID}`);
    expect(res.status).toBe(200);
    expect(res.body.soft).toBe(true);
    expect(res.body.product_count).toBe(2);
  });
});
