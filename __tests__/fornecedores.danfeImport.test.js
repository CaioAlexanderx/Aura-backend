// ============================================================
// AURA. — Fase 1 fornecedores: import de NF-e cria/reusa fornecedor
// (POST /companies/:id/products/import-nfe?save=true,
// src/routes/importData.js + src/services/supplierLookup.js)
//
// Este e o unico caminho do repo que hoje GRAVA produto a partir de
// DANFE/NF-e (danfeImport.js so extrai/preview, nunca escreve --
// documentado no corpo do PR). Testa a integracao completa via HTTP,
// com db.connect() mockado (padrao de transacao do repo, igual
// courierPickup.test.js mocka db.query).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const router = require('../src/routes/importData');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/companies/:id', router);
  return app;
}

const SECRET = 'aura-test-secret-2026';
const AUTH = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}` };

const CID = 'c1111111-1111-1111-1111-111111111111';
const SUPPLIER_ID = 's6666666-6666-6666-6666-666666666666';
const PID = 'p7777777-7777-7777-7777-777777777777';

const XML_NFE = `<NFe>
  <infNFe>
    <ide><nNF>123</nNF><serie>1</serie><dhEmi>2026-09-16T10:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>Fornecedor Teste LTDA</xNome></emit>
    <det>
      <prod>
        <cProd>COD1</cProd>
        <xProd>Produto Importado</xProd>
        <NCM>12345678</NCM>
        <cEAN>SEM GTIN</cEAN>
        <uCom>UN</uCom>
        <qCom>10.0000</qCom>
        <vUnCom>5.00</vUnCom>
      </prod>
    </det>
    <total><ICMSTot><vNF>50.00</vNF></ICMSTot></total>
  </infNFe>
</NFe>`;

function fakeClient(handlers) {
  const calls = [];
  const query = jest.fn((sql, params) => {
    calls.push([sql, params]);
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)/i.test(sql.trim())) {
      return Promise.resolve({ rows: [] });
    }
    for (const [re, fn] of handlers) {
      if (re.test(sql)) return Promise.resolve(fn(params));
    }
    return Promise.resolve({ rows: [] });
  });
  return { client: { query, release: jest.fn() }, calls };
}

beforeEach(() => { db.query.mockReset(); if (db.connect.mockReset) db.connect.mockReset(); });

describe('POST /companies/:id/products/import-nfe?save=true — fornecedor', () => {
  test('CNPJ do emitente novo -> cria supplier e vincula ao produto + registra entrada de estoque', async () => {
    const { client, calls } = fakeClient([
      [/SELECT id FROM products WHERE company_id=\$1 AND lower\(name\)=lower\(\$2\)/, () => ({ rows: [] })],
      [/SELECT id FROM suppliers WHERE cnpj = \$1 AND/, () => ({ rows: [] })],
      [/INSERT INTO suppliers/, () => ({ rows: [{ id: SUPPLIER_ID }] })],
      [/INSERT INTO products/, () => ({ rows: [{ id: PID }] })],
    ]);
    db.connect.mockImplementation(() => client);

    const res = await request(makeApp())
      .post(`/companies/${CID}/products/import-nfe?save=true`)
      .set(AUTH)
      .send({ xml_content: XML_NFE });

    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(1);

    const supplierInsert = calls.find(([sql]) => /INSERT INTO suppliers/.test(sql));
    expect(supplierInsert[1]).toEqual([CID, 'Fornecedor Teste LTDA', '11222333000181']);

    const productInsert = calls.find(([sql]) => /INSERT INTO products/.test(sql));
    expect(productInsert[1]).toEqual(expect.arrayContaining([SUPPLIER_ID]));
    // Quantidade e custo continuam vindo do XML, sem alteracao de comportamento.
    expect(productInsert[1]).toEqual(expect.arrayContaining([10, 5]));

    const stockMovInsert = calls.find(([sql]) => /INSERT INTO stock_movements/.test(sql));
    expect(stockMovInsert).toBeDefined();
    expect(stockMovInsert[1]).toEqual([PID, CID, 10, 5, SUPPLIER_ID, expect.any(String), 'Importacao NF-e']);
  });

  test('CNPJ do emitente ja cadastrado -> reusa o supplier existente (nao cria outro)', async () => {
    const { client, calls } = fakeClient([
      [/SELECT id FROM products WHERE company_id=\$1 AND lower\(name\)=lower\(\$2\)/, () => ({ rows: [] })],
      [/SELECT id FROM suppliers WHERE cnpj = \$1 AND/, () => ({ rows: [{ id: SUPPLIER_ID }] })],
      [/INSERT INTO products/, () => ({ rows: [{ id: PID }] })],
    ]);
    db.connect.mockImplementation(() => client);

    const res = await request(makeApp())
      .post(`/companies/${CID}/products/import-nfe?save=true`)
      .set(AUTH)
      .send({ xml_content: XML_NFE });

    expect(res.status).toBe(201);
    expect(calls.some(([sql]) => /INSERT INTO suppliers/.test(sql))).toBe(false);

    const productInsert = calls.find(([sql]) => /INSERT INTO products/.test(sql));
    expect(productInsert[1]).toEqual(expect.arrayContaining([SUPPLIER_ID]));
  });

  test('produto ja existente (mesmo nome) -> soma estoque e preenche supplier_id so se ainda nao tinha', async () => {
    const EXISTING_PID = 'pexist-1111-1111-1111-111111111111';
    const { client, calls } = fakeClient([
      [/SELECT id FROM products WHERE company_id=\$1 AND lower\(name\)=lower\(\$2\)/, () => ({ rows: [{ id: EXISTING_PID }] })],
      [/SELECT id FROM suppliers WHERE cnpj = \$1 AND/, () => ({ rows: [{ id: SUPPLIER_ID }] })],
      [/UPDATE products SET stock_qty=stock_qty\+\$1/, () => ({ rows: [] })],
    ]);
    db.connect.mockImplementation(() => client);

    const res = await request(makeApp())
      .post(`/companies/${CID}/products/import-nfe?save=true`)
      .set(AUTH)
      .send({ xml_content: XML_NFE });

    expect(res.status).toBe(201);
    expect(res.body.stock_updated).toBe(1);

    const updateCall = calls.find(([sql]) => /UPDATE products SET stock_qty=stock_qty\+\$1/.test(sql));
    expect(updateCall[1]).toEqual([10, 5, EXISTING_PID, SUPPLIER_ID]);
    expect(updateCall[0]).toMatch(/supplier_id=COALESCE\(supplier_id,\$4\)/);

    const stockMovInsert = calls.find(([sql]) => /INSERT INTO stock_movements/.test(sql));
    expect(stockMovInsert[1]).toEqual([EXISTING_PID, CID, 10, 5, SUPPLIER_ID, expect.any(String), 'Importacao NF-e']);
  });
});
