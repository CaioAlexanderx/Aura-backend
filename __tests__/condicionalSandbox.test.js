// ============================================================
// AURA. — Venda condicional: a empresa de teste (is_sandbox) passa pela trava
// (28/11/2026). Banco de mentira; o flag vem de companies.is_sandbox pela
// empresa da rota, nunca do que o cliente manda.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const c = require('../src/services/condicional');
const { requireCompanyAccess } = require('../src/middleware/auth');
const condicionaisRouter = require('../src/routes/condicionais');

const REAL = '11111111-2222-3333-4444-555555555555';
const TESTE = 'b0463109-aaaa-bbbb-cccc-dddddddddddd';

function app(user) {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id', (req, _res, next) => { req.user = user; next(); }, requireCompanyAccess(), condicionaisRouter);
  return a;
}

let consultas;
beforeEach(() => {
  delete process.env.CONDICIONAL_LIBERADA;
  consultas = [];
  jest.spyOn(db, 'query').mockImplementation(async (sql, params) => {
    consultas.push([String(sql), params]);
    if (/AS role/.test(sql)) return { rows: [{ role: 'owner', is_sandbox: params[0] === TESTE }] };
    return { rows: [] };
  });
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.CONDICIONAL_LIBERADA; });

const lojista = { id: 'u1', role: 'client', is_staff: false };

describe('trava da condicional com a empresa de teste', () => {
  test('empresa real, sem staff e trava desligada: 404', async () => {
    const r = await request(app(lojista)).post(`/companies/${REAL}/`).send({ is_sandbox: true });
    expect(r.status).toBe(404);
  });

  test('empresa de teste (is_sandbox no banco): passa pela trava', async () => {
    const r = await request(app(lojista)).post(`/companies/${TESTE}/`).send({});
    expect(r.status).not.toBe(404);
    expect(r.body.error).not.toBe('Não encontrado');
  });

  test('is_sandbox enviado pelo cliente (corpo, query, usuario) nao conta', async () => {
    const r = await request(app({ ...lojista, is_sandbox: true }))
      .post(`/companies/${REAL}/?is_sandbox=true`).send({ is_sandbox: true, company: { is_sandbox: true } });
    expect(r.status).toBe(404);
  });

  test('staff passa; trava ligada tambem', async () => {
    const staff = await request(app({ ...lojista, is_staff: true })).post(`/companies/${REAL}/`).send({});
    expect(staff.status).not.toBe(404);
    process.env.CONDICIONAL_LIBERADA = 'true';
    const r = await request(app(lojista)).post(`/companies/${REAL}/`).send({});
    expect(r.status).not.toBe(404);
  });

  test('falha de banco no acesso nao libera (500, nunca 2xx)', async () => {
    db.query.mockImplementation(async () => { throw new Error('boom'); });
    const r = await request(app(lojista)).post(`/companies/${TESTE}/`).send({});
    expect(r.status).toBe(500);
  });

  test('o acesso nao faz consulta a mais por causa do flag', async () => {
    await request(app(lojista)).post(`/companies/${REAL}/`).send({});
    expect(consultas.filter(([s]) => /AS role/.test(s)).length).toBe(1);
    expect(consultas.length).toBe(1);
  });

  test('condicionalLiberada: so o carimbo do servidor libera', () => {
    expect(c.condicionalLiberada({ user: lojista })).toBe(false);
    expect(c.condicionalLiberada({ user: lojista, body: { is_sandbox: true } })).toBe(false);
    expect(c.condicionalLiberada({ user: lojista, companySandbox: true })).toBe(true);
  });
});
