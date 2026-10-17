// ============================================================
// AURA. — Comandas do Caixa: nome da comanda (migration 389, card tc-01)
//
// Sem banco: o db e o mock global (tests/jest.setup.js). O que este arquivo
// segura:
//   1. nomeDaComanda: apara, colapsa espaco, corta em 40, vazio vira null
//   2. com a coluna: o POST manda o nome no INSERT (COALESCE no DO UPDATE)
//      e a resposta devolve o nome; o GET da lista devolve o nome
//   3. sem a coluna (deploy antes da 389): nenhum SQL cita `name`, a rota
//      responde igual e o nome vem null
// O comportamento no Postgres real (gravar, trocar, manter) fica em
// caixa.comandas.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const rota = require('../src/routes/comandas');

const companyId = '11111111-1111-4111-8111-111111111111';
const comandaId = '22222222-2222-4222-8222-222222222222';
const base = `/companies/${companyId}/comandas`;

let app;
let sqls;

function montar({ temColuna }) {
  sqls = [];
  rota._resetCache();
  const responder = async (sql, params) => {
    const s = String(sql);
    sqls.push({ sql: s, params });
    if (s.includes('pg_attribute')) return { rows: [{ ok: temColuna }] };
    if (s.includes("pdv_settings->>'comanda_enabled'")) return { rows: [{ enabled: 'true' }] };
    if (s.startsWith('INSERT INTO pdv_comandas')) return { rows: [{ id: comandaId, criada: true }] };
    if (s.startsWith('INSERT INTO pdv_comanda_items')) return { rows: [] };
    if (s.includes('FROM pdv_comanda_items') && s.includes('ORDER BY seq')) {
      return { rows: [{ id: 'i1', name: 'Copão', quantity: '2', unit_price: '25', created_at: 'x' }] };
    }
    if (s.includes('COUNT(i.id)')) {
      return { rows: [{ id: comandaId, number: 12, status: 'open', opened_at: 'x', items_count: 1, subtotal: '50', ...(temColuna ? { name: 'João' } : {}) }] };
    }
    if (s.includes('FROM pdv_comandas')) {
      return { rows: [{ id: comandaId, number: 12, status: 'open', opened_at: 'x', ...(temColuna ? { name: 'João' } : {}) }] };
    }
    return { rows: [] };
  };
  db.query.mockReset();
  db.query.mockImplementation(responder);
  db.connect.mockReset();
  db.connect.mockImplementation(async () => ({ query: jest.fn(responder), release: jest.fn() }));
}

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: '33333333-3333-4333-8333-333333333333' }; next(); });
  app.use('/companies/:id/comandas', rota);
});

const ITEM = { name: 'Copão', quantity: 2, unit_price: 25 };

describe('nomeDaComanda', () => {
  test('apara, colapsa espaço, tira controle e corta em 40', () => {
    expect(rota.nomeDaComanda('  João  ')).toBe('João');
    expect(rota.nomeDaComanda('Mesa   do\tfundo')).toBe('Mesa do fundo');
    expect(rota.nomeDaComanda('a\u0000b')).toBe('a b');
    expect(rota.nomeDaComanda('x'.repeat(60))).toBe('x'.repeat(40));
    // corta por caractere, não por unidade UTF-16 (emoji não vira meio caractere)
    expect(Array.from(rota.nomeDaComanda('🍺'.repeat(50))).length).toBe(40);
    expect(rota.nomeDaComanda(12)).toBe('12');
  });

  test('vazio, só espaço, ausente ou não-texto viram null', () => {
    for (const v of [undefined, null, '', '   ', {}, [], true]) {
      expect(rota.nomeDaComanda(v)).toBeNull();
    }
  });
});

describe('com a coluna (389 aplicada)', () => {
  beforeEach(() => montar({ temColuna: true }));

  test('POST grava o nome aparado e devolve na comanda', async () => {
    const r = await request(app).post(`${base}/12/items`).send({ items: [ITEM], name: '  João  ' });
    expect(r.status).toBe(201);
    expect(r.body.comanda).toMatchObject({ number: 12, name: 'João' });
    const ins = sqls.find((q) => q.sql.startsWith('INSERT INTO pdv_comandas'));
    expect(ins.sql).toContain('opened_by, name)');
    expect(ins.sql).toContain('name = COALESCE(EXCLUDED.name, pdv_comandas.name)');
    expect(ins.params[3]).toBe('João');
  });

  test('POST sem nome manda null (o COALESCE mantém o nome que já estava)', async () => {
    const r = await request(app).post(`${base}/12/items`).send({ items: [ITEM], name: '   ' });
    expect(r.status).toBe(201);
    const ins = sqls.find((q) => q.sql.startsWith('INSERT INTO pdv_comandas'));
    expect(ins.params[3]).toBeNull();
  });

  test('GET da lista e GET da comanda devolvem o nome', async () => {
    const lista = await request(app).get(base);
    expect(lista.status).toBe(200);
    expect(lista.body.comandas[0]).toMatchObject({ number: 12, name: 'João', subtotal: 50 });
    const uma = await request(app).get(`${base}/12`);
    expect(uma.body.comanda).toMatchObject({ number: 12, name: 'João' });
  });

  test('a coluna é sondada uma vez só', async () => {
    await request(app).get(base);
    await request(app).get(base);
    expect(sqls.filter((q) => q.sql.includes('pg_attribute'))).toHaveLength(1);
  });
});

describe('sem a coluna (backend antes da 389)', () => {
  beforeEach(() => montar({ temColuna: false }));

  test('POST com nome segue funcionando, nenhum SQL cita a coluna, e o nome vem null', async () => {
    const r = await request(app).post(`${base}/12/items`).send({ items: [ITEM], name: 'João' });
    expect(r.status).toBe(201);
    expect(r.body.comanda).toMatchObject({ number: 12, name: null, items_count: 1, subtotal: 50 });
    const ins = sqls.find((q) => q.sql.startsWith('INSERT INTO pdv_comandas'));
    expect(ins.sql).not.toMatch(/\bname\b/);
    expect(ins.params).toHaveLength(3);
    const sel = sqls.filter((q) => q.sql.includes('FROM pdv_comandas') && !q.sql.includes('pg_attribute'));
    for (const q of sel) expect(q.sql).not.toMatch(/c\.name|, name/);
  });

  test('GET da lista responde com name null', async () => {
    const lista = await request(app).get(base);
    expect(lista.status).toBe(200);
    expect(lista.body.comandas[0]).toMatchObject({ number: 12, name: null });
    const sel = sqls.find((q) => q.sql.includes('COUNT(i.id)'));
    expect(sel.sql).not.toContain('c.name');
  });

  test('sondagem que falha conta como "sem coluna"', async () => {
    rota._resetCache();
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('pg_attribute')) throw Object.assign(new Error('boom'), { code: '42P01' });
      return original(sql, params);
    });
    const lista = await request(app).get(base);
    expect(lista.status).toBe(200);
    expect(lista.body.comandas[0].name).toBeNull();
  });
});
