// ============================================================
// Tomador da NFS-e junto com a venda do Caixa (10/11/2026, migration 440)
// POST /pdv/sale (src/routes/pdv.js) + nfseAutomaticaRepo.gravarTomadorDaVenda
//
// O que este arquivo prova:
//   A. nfse_tomador válido: grava sales.nfse_tomador DENTRO da transação
//      (SAVEPOINT, antes do COMMIT) e passa o tomador ao gatilho da NFS-e.
//   B. nfse_tomador inválido: a venda sai (201), nada é gravado, aviso no
//      log sem o documento, gatilho sem tomador.
//   C. Venda sem nfse_tomador: nenhuma consulta a mais (nem SAVEPOINT).
//   D. Banco sem a 440: a venda segue (ROLLBACK TO SAVEPOINT) e o tomador
//      ainda vai em memória para o gatilho.
//   E. Nenhum cadastro de cliente é criado ou alterado por causa dele.
// Mock do banco despachado por conteúdo do SQL (padrão do pdv-connection).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const mockClient = { query: jest.fn(), release: jest.fn() };
db.connect = jest.fn().mockResolvedValue(mockClient);
db.query = jest.fn();

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const pdvRouter = require('../src/routes/pdv');
const nfseAutomatica = require('../src/services/nfseAutomatica');
const nfseAutomaticaRepo = require('../src/services/nfseAutomaticaRepo');

const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);

const CID = 'comp-1', PROD = 'prod-1', SALE = 'sale-1';
const CNPJ = '11222333000181'; // válido

function despachar({ semColuna = false } = {}) {
  mockClient.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: { caixa_enabled: false } }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies/i.test(s)) return Promise.resolve({ rows: [{ name: 'Corte', cost_price: 0, stock_qty: 50, stock_company_id: CID }] });
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: SALE, total_amount: 100, employee_id: null, customer_id: null }] });
    if (semColuna && /UPDATE sales SET nfse_tomador/i.test(s)) {
      return Promise.reject(Object.assign(new Error('column "nfse_tomador" of relation "sales" does not exist'), { code: '42703' }));
    }
    return Promise.resolve({ rows: [] });
  });
  db.query.mockResolvedValue({ rows: [] });
}

const vender = (body = {}) =>
  request(app).post(`/companies/${CID}/pdv/sale`)
    .send({ items: [{ product_id: PROD, quantity: 1, unit_price: 100 }], payment_method: 'pix', ...body });

const sqls = () => mockClient.query.mock.calls.map((c) => String(c[0] || ''));
const chamadas = (re) => mockClient.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

let gatilho;
beforeEach(() => {
  jest.clearAllMocks(); mockClient.query.mockReset(); db.query.mockReset();
  nfseAutomaticaRepo._resetCache();
  gatilho = jest.spyOn(nfseAutomatica, 'aoFinalizarVenda').mockReturnValue(false);
});
afterEach(() => gatilho.mockRestore());

describe('A. nfse_tomador válido', () => {
  test('grava na venda, dentro da transação, e vai junto para o gatilho', async () => {
    despachar();
    const res = await vender({ nfse_tomador: { doc: '11.222.333/0001-81', nome: ' Loja X Ltda ' } });
    expect(res.status).toBe(201);

    const [[sql, params]] = chamadas(/UPDATE sales SET nfse_tomador/i);
    expect(sql).toBe('UPDATE sales SET nfse_tomador = $1::jsonb WHERE id = $2 AND company_id = $3');
    expect(JSON.parse(params[0])).toEqual({ doc: CNPJ, nome: 'Loja X Ltda' });
    expect(params.slice(1)).toEqual([SALE, CID]);

    const ordem = sqls();
    const iSave = ordem.indexOf('SAVEPOINT nfse_tomador');
    const iUpd = ordem.findIndex((s) => /UPDATE sales SET nfse_tomador/.test(s));
    const iRel = ordem.indexOf('RELEASE SAVEPOINT nfse_tomador');
    const iCommit = ordem.indexOf('COMMIT');
    expect(iSave).toBeGreaterThan(ordem.findIndex((s) => /INSERT INTO sales/.test(s)));
    expect(iSave).toBeLessThan(iUpd);
    expect(iUpd).toBeLessThan(iRel);
    expect(iRel).toBeLessThan(iCommit);

    expect(gatilho).toHaveBeenCalledWith({ companyId: CID, saleId: SALE, tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });
  });

  test('sem nome: grava só o documento (nome null)', async () => {
    despachar();
    await vender({ nfse_tomador: { doc: '529.982.247-25' } });
    const [[, params]] = chamadas(/UPDATE sales SET nfse_tomador/i);
    expect(JSON.parse(params[0])).toEqual({ doc: '52998224725', nome: null });
  });

  test('E. não cria nem altera cadastro de cliente', async () => {
    despachar();
    await vender({ nfse_tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });
    expect(chamadas(/INSERT INTO customers|UPDATE customers/i)).toHaveLength(0);
  });
});

describe('B. nfse_tomador inválido', () => {
  test('a venda sai, nada é gravado, aviso no log sem o documento', async () => {
    despachar();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await vender({ nfse_tomador: { doc: '529.982.247-24', nome: 'X' } });
    expect(res.status).toBe(201);
    expect(chamadas(/nfse_tomador|SAVEPOINT/i)).toHaveLength(0);
    const aviso = warn.mock.calls.find((c) => /nfse_tomador ignorado/.test(String(c[0])));
    expect(aviso).toBeTruthy();
    expect(JSON.stringify(aviso)).not.toMatch(/5299822472/);
    expect(gatilho).toHaveBeenCalledWith({ companyId: CID, saleId: SALE, tomador: null });
    warn.mockRestore();
  });

  test('formato errado (texto solto) também só avisa', async () => {
    despachar();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await vender({ nfse_tomador: '52998224725' });
    expect(res.status).toBe(201);
    expect(chamadas(/nfse_tomador/i)).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('C. venda sem nfse_tomador', () => {
  test('nenhuma consulta a mais: sem SAVEPOINT, sem UPDATE, gatilho sem tomador', async () => {
    despachar();
    const res = await vender();
    expect(res.status).toBe(201);
    expect(chamadas(/nfse_tomador|SAVEPOINT/i)).toHaveLength(0);
    expect(gatilho).toHaveBeenCalledWith({ companyId: CID, saleId: SALE, tomador: null });
  });
});

describe('D. banco sem a migration 440', () => {
  test('a venda segue (ROLLBACK TO SAVEPOINT), o tomador vai em memória e não tenta de novo', async () => {
    despachar({ semColuna: true });
    const res = await vender({ nfse_tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });
    expect(res.status).toBe(201);
    expect(sqls()).toContain('ROLLBACK TO SAVEPOINT nfse_tomador');
    expect(chamadas(/^COMMIT$/)).toHaveLength(1);
    expect(gatilho).toHaveBeenCalledWith({ companyId: CID, saleId: SALE, tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });

    mockClient.query.mockClear();
    const res2 = await vender({ nfse_tomador: { doc: CNPJ, nome: 'Loja X Ltda' } });
    expect(res2.status).toBe(201);
    expect(chamadas(/nfse_tomador|SAVEPOINT/i)).toHaveLength(0);
  });
});
