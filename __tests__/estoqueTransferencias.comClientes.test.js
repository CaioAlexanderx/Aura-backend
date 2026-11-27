// ============================================================
// AURA. — Transferencia de estoque x "com clientes" (pos-C14, condicional)
// Banco mockado. O que este arquivo trava:
//   1. produto com grade: a variante so manda o que esta livre
//      (estoque - com clientes), validado no SERVIDOR (409 com `disponivel`
//      e `com_clientes`);
//   2. produto sem grade: idem;
//   3. sem a trava CONDICIONAL_LIBERADA: o saldo e o de sempre e nem
//      consulta condicional_itens (regressao: loja sem condicional);
//   4. base sem a migration 467: a transferencia segue pelo saldo de sempre.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const svc = require('../src/services/transferenciaDeEstoque');

const ORIGEM = '11111111-1111-4111-8111-111111111111';
const DESTINO = '22222222-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const V1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const BASE = `/companies/${ORIGEM}/estoque/transferencias`;
const token = () => jwt.sign({ id: 'dono', role: 'client', plan: 'essencial', company: ORIGEM }, 'aura-test-secret-2026', { expiresIn: '1h' });
const ENV_ANTES = process.env.CONDICIONAL_LIBERADA;

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/private'));
}, 60000);
afterAll(() => {
  if (ENV_ANTES === undefined) delete process.env.CONDICIONAL_LIBERADA; else process.env.CONDICIONAL_LIBERADA = ENV_ANTES;
});

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  svc._limparCacheDeColunas();
  db.query.mockImplementation(async (sql) => {
    if (/SELECT 'owner' AS role/.test(sql)) return { rows: [{ role: 'owner' }] };
    return { rows: [] };
  });
});

const lojas = () => ({
  rows: [
    { id: ORIGEM, grupo: ORIGEM, nome: 'Loja Centro', ativa: true, is_owner: true, role_label: null, permissions: null },
    { id: DESTINO, grupo: ORIGEM, nome: 'Loja Shopping', ativa: true, is_owner: true, role_label: null, permissions: null },
  ],
});

/**
 * Cliente falso. `comGrade`: produto tem variante (estoque na variante).
 * `fora`: linhas de condicional_itens ({ variant_id, qtd }).
 */
function montar({ comGrade, estoque, fora, erroDaCondicional = null }) {
  const chamadas = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      chamadas.push({ sql: s, params });
      if (/FROM companies c/.test(s)) return lojas();
      if (/FROM products\s+WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2\s+ORDER BY id\s+FOR UPDATE/.test(s)) {
        return { rows: [{ id: P1, name: 'Blusa', is_active: true, stock_qty: comGrade ? '0' : String(estoque), unit: 'un' }] };
      }
      if (/FROM product_variants\s+WHERE id = ANY\(\$1::uuid\[\]\)\s+ORDER BY id\s+FOR UPDATE/.test(s)) {
        return { rows: [{ id: V1, product_id: P1, is_active: true, stock_qty: String(estoque) }] };
      }
      if (/SELECT DISTINCT product_id FROM product_variants/.test(s)) return { rows: comGrade ? [{ product_id: P1 }] : [] };
      if (/condicional_itens/.test(s)) {
        if (erroDaCondicional) throw erroDaCondicional;
        return { rows: (fora || []).map((f) => ({ product_id: P1, variant_id: f.variant_id || null, qtd: String(f.qtd) })) };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect.mockResolvedValue(client);
  return { chamadas };
}

const enviar = (item) => request(app).post(BASE).set('Authorization', `Bearer ${token()}`)
  .send({ destino_company_id: DESTINO, itens: [item] });

describe('transferencia x com clientes', () => {
  beforeEach(() => { process.env.CONDICIONAL_LIBERADA = 'true'; });

  test('grade: pedir mais que o livre da variante -> 409 com disponivel e com_clientes', async () => {
    montar({ comGrade: true, estoque: 5, fora: [{ variant_id: V1, qtd: 3 }] });
    const res = await enviar({ product_id: P1, variant_id: V1, quantidade: 4 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ESTOQUE_INSUFICIENTE');
    expect(res.body.itens).toEqual([expect.objectContaining({ product_id: P1, variant_id: V1, quantidade: 4, disponivel: 2, com_clientes: 3 })]);
    expect(res.body.error).toMatch(/com clientes/);
  });

  test('grade: pedir exatamente o livre passa da validacao de saldo', async () => {
    montar({ comGrade: true, estoque: 5, fora: [{ variant_id: V1, qtd: 3 }] });
    const res = await enviar({ product_id: P1, variant_id: V1, quantidade: 2 });
    expect(res.body.code).not.toBe('ESTOQUE_INSUFICIENTE');
  });

  test('com clientes de OUTRA variante nao desconta esta', async () => {
    montar({ comGrade: true, estoque: 5, fora: [{ variant_id: 'cccccccc-0000-4000-8000-000000000009', qtd: 3 }] });
    const res = await enviar({ product_id: P1, variant_id: V1, quantidade: 5 });
    expect(res.body.code).not.toBe('ESTOQUE_INSUFICIENTE');
  });

  test('sem grade: estoque - com clientes tambem vale no servidor', async () => {
    montar({ comGrade: false, estoque: 10, fora: [{ variant_id: null, qtd: 4 }] });
    const res = await enviar({ product_id: P1, quantidade: 7 });
    expect(res.status).toBe(409);
    expect(res.body.itens[0]).toMatchObject({ disponivel: 6, com_clientes: 4 });
  });

  test('base sem a 467 (consulta falha): segue pelo saldo de sempre, sem derrubar', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { chamadas } = montar({ comGrade: false, estoque: 10, fora: [], erroDaCondicional: Object.assign(new Error('relation does not exist'), { code: '42P01' }) });
    const res = await enviar({ product_id: P1, quantidade: 7 });
    expect(res.body.code).not.toBe('ESTOQUE_INSUFICIENTE');
    expect(chamadas.some((c) => /ROLLBACK TO SAVEPOINT cc_transferencia/.test(c.sql))).toBe(true);
    spy.mockRestore();
  });
});

describe('regressao: sem a trava', () => {
  beforeEach(() => { delete process.env.CONDICIONAL_LIBERADA; });

  test('o saldo e o de sempre e condicional_itens nem e consultada', async () => {
    const { chamadas } = montar({ comGrade: true, estoque: 5, fora: [{ variant_id: V1, qtd: 3 }] });
    const res = await enviar({ product_id: P1, variant_id: V1, quantidade: 5 });
    expect(res.body.code).not.toBe('ESTOQUE_INSUFICIENTE');
    expect(chamadas.some((c) => /condicional_itens|SAVEPOINT cc_transferencia/.test(c.sql))).toBe(false);
  });

  test('sem a trava, passar do estoque continua 409 sem campo com_clientes', async () => {
    montar({ comGrade: true, estoque: 5, fora: [{ variant_id: V1, qtd: 3 }] });
    const res = await enviar({ product_id: P1, variant_id: V1, quantidade: 6 });
    expect(res.status).toBe(409);
    expect(res.body.itens[0]).toEqual(expect.objectContaining({ disponivel: 5 }));
    expect(res.body.itens[0].com_clientes).toBeUndefined();
    expect(res.body.error).toMatch(/estoque suficiente/);
  });
});
