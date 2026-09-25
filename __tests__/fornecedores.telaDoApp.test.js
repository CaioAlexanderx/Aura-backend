// ============================================================
// AURA. — Tela de Fornecedores do app (25/09/2026): consulta de CNPJ
// para o cadastro e vinculo de produtos em lote (src/routes/suppliers.js).
//
// O que estes testes travam:
//   1. GET /cnpj/:cnpj nao e capturado pelo GET /:sid.
//   2. CNPJ ja cadastrado no grupo responde sem gastar consulta na Receita.
//   3. Nome sugerido = fantasia, senao razao social; erros da Receita viram
//      404/429/502 com mensagem que manda preencher a mao.
//   4. Limite por empresa (60/hora).
//   5. POST /:sid/products vincula com a visibilidade de produto, e o
//      desvinculo so mexe em quem esta ligado a ESTE fornecedor.
// ============================================================
'use strict';

jest.mock('../src/services/cnpj', () => ({ lookupCNPJ: jest.fn() }));

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { lookupCNPJ } = require('../src/services/cnpj');
const router = require('../src/routes/suppliers');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/suppliers', router);
  return app;
}

const CID = 'c1111111-1111-1111-1111-111111111111';
const SID = 's2222222-2222-2222-2222-222222222222';
const CNPJ = '11222333000181';

beforeEach(() => { db.query.mockReset(); lookupCNPJ.mockReset(); });

describe('GET /suppliers/cnpj/:cnpj', () => {
  const semDuplicata = () => db.query.mockImplementation(() => Promise.resolve({ rows: [] }));

  test('CNPJ invalido: 400 sem consultar nada', async () => {
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/cnpj/11111111111111`);
    expect(res.status).toBe(400);
    expect(lookupCNPJ).not.toHaveBeenCalled();
  });

  test('nao cai no GET /:sid e preenche com o nome fantasia', async () => {
    semDuplicata();
    lookupCNPJ.mockResolvedValue({ legal_name: 'DISTRIBUIDORA X LTDA', trade_name: 'Casa do Cimento', phone: '(11) 4002-8922', email: 'vendas@x.com', is_active: true, address_city: 'Campinas', address_state: 'SP' });
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/cnpj/11.222.333%2F0001-81`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cnpj: CNPJ, existing: null, name: 'Casa do Cimento', phone: '(11) 4002-8922', email: 'vendas@x.com', is_active: true });
    expect(db.query.mock.calls.some(([sql]) => /FROM suppliers s WHERE id = \$1/.test(sql))).toBe(false);
  });

  test('sem nome fantasia usa a razao social', async () => {
    semDuplicata();
    lookupCNPJ.mockResolvedValue({ legal_name: 'DISTRIBUIDORA X LTDA', trade_name: '', is_active: true });
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/cnpj/${CNPJ}`);
    expect(res.body.name).toBe('DISTRIBUIDORA X LTDA');
  });

  test('ja cadastrado no grupo: devolve o existente e nao consulta a Receita', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [{ id: SID, name: 'Casa do Cimento' }] }));
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/cnpj/${CNPJ}`);
    expect(res.status).toBe(200);
    expect(res.body.existing).toEqual({ id: SID, name: 'Casa do Cimento' });
    expect(lookupCNPJ).not.toHaveBeenCalled();
  });

  test.each([
    ['CNPJ não encontrado na Receita Federal', 404],
    ['Limite de consultas atingido. Tente novamente em alguns minutos.', 429],
    ['CNPJ lookup timeout', 502],
  ])('erro "%s" vira %i', async (msg, status) => {
    semDuplicata();
    lookupCNPJ.mockRejectedValue(new Error(msg));
    const res = await request(makeApp()).get(`/companies/${CID}/suppliers/cnpj/${CNPJ}`);
    expect(res.status).toBe(status);
    expect(res.body.error).toBeTruthy();
  });

  test('limite por empresa: a 61a consulta na hora leva 429', async () => {
    semDuplicata();
    lookupCNPJ.mockResolvedValue({ legal_name: 'X', is_active: true });
    const outra = 'c9999999-1111-1111-1111-111111111111';
    const app = makeApp();
    for (let i = 0; i < 60; i++) {
      const r = await request(app).get(`/companies/${outra}/suppliers/cnpj/${CNPJ}`);
      expect(r.status).toBe(200);
    }
    const res = await request(app).get(`/companies/${outra}/suppliers/cnpj/${CNPJ}`);
    expect(res.status).toBe(429);
    // Outra empresa segue livre.
    const livre = await request(app).get(`/companies/${CID}/suppliers/cnpj/${CNPJ}`);
    expect(livre.status).toBe(200);
  });
});

describe('POST /suppliers/:sid/products', () => {
  const P1 = 'a1111111-1111-1111-1111-111111111111';
  const P2 = 'a2222222-2222-2222-2222-222222222222';

  function mock({ fornecedor = true, rowCount = 2 } = {}) {
    db.query.mockImplementation((sql) => {
      if (/FROM suppliers s WHERE id = \$1/.test(sql)) {
        return Promise.resolve({ rows: fornecedor ? [{ id: SID, name: 'Casa do Cimento', cnpj: CNPJ }] : [] });
      }
      if (/UPDATE products/.test(sql)) return Promise.resolve({ rowCount, rows: [] });
      return Promise.resolve({ rows: [] });
    });
  }
  const updateCall = () => db.query.mock.calls.find(([sql]) => /UPDATE products/.test(sql));

  test('vincula com a visibilidade de produto e copia nome/CNPJ', async () => {
    mock();
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers/${SID}/products`).send({ product_ids: [P1, P2] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, unlink: false });
    const [sql, params] = updateCall();
    expect(sql).toMatch(/SET supplier_id = \$3, supplier_name = \$4, supplier_cnpj = \$5/);
    expect(sql).toMatch(/company_id = \$2 OR \(is_group_shared = true/);
    expect(params).toEqual([[P1, P2], CID, SID, 'Casa do Cimento', CNPJ]);
  });

  test('desvincula so quem esta ligado a este fornecedor', async () => {
    mock({ rowCount: 1 });
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers/${SID}/products`).send({ product_ids: [P1], unlink: true });
    expect(res.body).toEqual({ updated: 1, unlink: true });
    const [sql, params] = updateCall();
    expect(sql).toMatch(/SET supplier_id = NULL/);
    expect(sql).toMatch(/AND supplier_id = \$3/);
    expect(params).toEqual([[P1], CID, SID]);
  });

  test('fornecedor fora do grupo: 404 e nada e gravado', async () => {
    mock({ fornecedor: false });
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers/${SID}/products`).send({ product_ids: [P1] });
    expect(res.status).toBe(404);
    expect(updateCall()).toBeUndefined();
  });

  test.each([[undefined], [[]], ['abc']])('product_ids=%p leva 400', async (ids) => {
    mock();
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers/${SID}/products`).send({ product_ids: ids });
    expect(res.status).toBe(400);
    expect(updateCall()).toBeUndefined();
  });

  test('mais de 1000 de uma vez leva 400', async () => {
    mock();
    const ids = Array.from({ length: 1001 }, (_, i) => `a${String(i).padStart(7, '0')}-1111-1111-1111-111111111111`);
    const res = await request(makeApp()).post(`/companies/${CID}/suppliers/${SID}/products`).send({ product_ids: ids });
    expect(res.status).toBe(400);
  });
});
