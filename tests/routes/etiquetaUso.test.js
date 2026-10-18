// ============================================================
// Etiquetas: registro de uso da impressão (card tq-23, 18/10/2026)
//
// O GET /products/:pid/label/print devolve HTML e agora soma +1 em
// label_print_days (empresa, dia). O que estes testes seguram:
//   - o HTML devolvido é BYTE A BYTE o mesmo com o registro funcionando,
//     falhando (rejeitado), lançando na hora ou com a tabela ausente;
//   - falha ao registrar nunca derruba a impressão (status 200);
//   - o registro não espera o banco (fire-and-forget);
//   - não conta: recarga do "Aplicar e imprimir" (save=1), staff em modo
//     admin, produto inexistente/sem código, e os GET de dados (JSON);
//   - nada de produto vai para o banco: só empresa e quantidade.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

let mockUser = { id: 'u1', role: 'user' };
jest.mock('../../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = mockUser; next(); },
}));

const db = require('../../src/config/database');
const { registrarImpressao, etiquetasPedidas } = require('../../src/services/etiquetaUso');

const CID = 'c0000000-0000-0000-0000-000000000001';
const PID = 'p0000000-0000-0000-0000-000000000001';

const PRODUTO = {
  id: PID, name: 'Camiseta Azul', price: '59.90', barcode: '7891234567895',
  barcode_format: 'EAN13', sku: 'CAM-AZ', color: 'Azul', size: 'M',
};

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/products', require('../../src/routes/labels'));
  return a;
}

const ehRegistro = (sql) => /INSERT INTO label_print_days/.test(String(sql));

// modoRegistro: 'ok' | 'rejeita' | 'lanca' | 'sem_tabela' | 'lento'
function banco(modoRegistro = 'ok', { produto = PRODUTO } = {}) {
  const registros = [];
  db.query.mockReset();
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (ehRegistro(s)) {
      registros.push({ sql: s, params });
      if (modoRegistro === 'lanca') throw new Error('pool encerrado');
      if (modoRegistro === 'rejeita') return Promise.reject(new Error('conexao caiu'));
      if (modoRegistro === 'sem_tabela') return Promise.reject(Object.assign(new Error('relation "label_print_days" does not exist'), { code: '42P01' }));
      if (modoRegistro === 'lento') return new Promise(() => {}); // nunca resolve
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/FROM products WHERE id=\$1 AND company_id=\$2/.test(s)) return Promise.resolve({ rows: produto ? [produto] : [] });
    if (/SELECT pdv_settings FROM companies/.test(s)) return Promise.resolve({ rows: [{ pdv_settings: { label_offset_mm: -1, label_cols: 3 } }] });
    return Promise.resolve({ rows: [] });
  });
  return registros;
}

const imprimir = (qs = '') => request(app()).get(`/companies/${CID}/products/${PID}/label/print${qs}`);

beforeEach(() => {
  mockUser = { id: 'u1', role: 'user' };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('HTML da etiqueta não muda por causa do registro', () => {
  test('igual com registro ok, rejeitado, lançando, sem tabela e travado', async () => {
    const htmls = {};
    for (const modo of ['ok', 'rejeita', 'lanca', 'sem_tabela', 'lento']) {
      banco(modo);
      const r = await imprimir('?qty=3&mode=barcode');
      expect([modo, r.status]).toEqual([modo, 200]);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      htmls[modo] = r.text;
    }
    expect(htmls.ok.length).toBeGreaterThan(1000);
    for (const modo of Object.keys(htmls)) expect([modo, htmls[modo]]).toEqual([modo, htmls.ok]);
  });

  test('o registro não espera o banco: com o INSERT travado a resposta sai', async () => {
    const registros = banco('lento');
    const r = await imprimir('?qty=2');
    expect(r.status).toBe(200);
    expect(registros).toHaveLength(1);
  });
});

describe('o que é registrado', () => {
  test('uma abertura = um INSERT com empresa e quantidade, nada de produto', async () => {
    const registros = banco('ok');
    await imprimir('?qty=5');
    expect(registros).toHaveLength(1);
    expect(registros[0].params).toEqual([CID, 5]);
    const tudo = JSON.stringify(registros[0]);
    for (const dado of ['Camiseta', '59.90', '7891234567895', 'CAM-AZ', PID]) expect(tudo).not.toContain(dado);
    // upsert por (empresa, dia de Brasília) somando
    expect(registros[0].sql).toMatch(/ON CONFLICT \(company_id, dia\) DO UPDATE/);
    expect(registros[0].sql).toMatch(/America\/Sao_Paulo/);
    expect(registros[0].sql).toMatch(/prints\s+= label_print_days\.prints \+ 1/);
  });

  test('qty acima do teto vira 200; ausente ou lixo vira 1', async () => {
    let registros = banco('ok');
    await imprimir('?qty=999');
    expect(registros[0].params[1]).toBe(200);
    registros = banco('ok');
    await imprimir();
    expect(registros[0].params[1]).toBe(1);
    expect(etiquetasPedidas('abc')).toBe(1);
    expect(etiquetasPedidas('-4')).toBe(1);
  });

  test('não conta: recarga do "Aplicar e imprimir" (save=1)', async () => {
    const registros = banco('ok');
    const r = await imprimir('?qty=2&save=1&offset=-3&cols=3');
    expect(r.status).toBe(200);
    expect(registros).toHaveLength(0);
  });

  test('não conta: staff em modo admin', async () => {
    mockUser = { id: 'staff', role: 'admin' };
    const registros = banco('ok');
    expect((await imprimir()).status).toBe(200);
    expect(registros).toHaveLength(0);
  });

  test('não conta: produto inexistente (404) nem sem código (422)', async () => {
    let registros = banco('ok', { produto: null });
    const naoAcha = await request(app()).get(`/companies/${CID}/products/${PID}/label`);
    expect(naoAcha.status).toBe(404);
    expect(registros).toHaveLength(0);
    registros = banco('ok', { produto: { ...PRODUTO, barcode: null } });
    expect((await request(app()).get(`/companies/${CID}/products/${PID}/label`)).status).toBe(422);
    expect(registros).toHaveLength(0);
  });

  test('não conta: GET de dados em JSON (/label e /labels/batch)', async () => {
    const registros = banco('ok');
    expect((await request(app()).get(`/companies/${CID}/products/${PID}/label`)).status).toBe(200);
    await request(app()).get(`/companies/${CID}/products/labels/batch?ids=${PID}`);
    expect(registros).toHaveLength(0);
  });
});

describe('registrarImpressao isolada', () => {
  test('nunca lança nem devolve promessa pendente: rejeição, throw síncrono e sem empresa', async () => {
    const ruins = [
      { query: () => Promise.reject(new Error('x1')) },
      { query: () => { throw new Error('x2'); } },
      { query: () => undefined },
    ];
    for (const pool of ruins) expect(registrarImpressao(pool, { companyId: CID, qty: 1 })).toBeUndefined();
    const semEmpresa = { query: jest.fn() };
    expect(registrarImpressao(semEmpresa, { companyId: null, qty: 1 })).toBeUndefined();
    expect(semEmpresa.query).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r)); // deixa os catch rodarem: sem unhandled rejection
  });
});
