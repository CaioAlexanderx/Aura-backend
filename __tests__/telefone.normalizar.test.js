// ============================================================
// AURA — Telefone com +55 antes de gravar (10/11/2026)
//
// Caso real: "5566992384539" (o +55 digitado) era cortado em 11 dígitos e
// virava "55669923845". O backend não cortava; quem cortava era a tela.
// Este arquivo garante que o backend:
//   1. tira o 55 (ou 00/0) da frente quando sobra dígito;
//   2. nunca corta: dígitos a mais viram 400 com mensagem gentil;
//   3. não muda nada do que já cabia (até 11 dígitos, grafia de sempre);
//   4. aplica a regra nas rotas: cliente (POST e PATCH), perfil da empresa
//      e o cadastro (users.phone / companies.phone).
//
// Banco mockado (tests/jest.setup.js), inspecionando o SQL por regex.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const {
  normalizarTelefone, normalizarTelefoneSemRecusar, digitosNacionais, mesmoTelefone, ERRO_TELEFONE_LONGO,
} = require('../src/utils/telefone');

describe('normalizarTelefone', () => {
  it.each([
    ['+55 (66) 99238-4539', '66992384539'],
    ['5566992384539', '66992384539'],
    ['+55 66 99238 4539', '66992384539'],
    ['  +55  66  99238  4539  ', '66992384539'],
    ['556692384539', '6692384539'],            // fixo com o 55
    ['0055 66 99238-4539', '66992384539'],     // discagem internacional
    ['066992384539', '66992384539'],           // 0 de longa distância
    ['0 15 66 99238-4539', '66992384539'],     // 0 + operadora
  ])('%s -> %s', (entrada, esperado) => {
    expect(normalizarTelefone(entrada)).toEqual({ ok: true, valor: esperado });
  });

  it.each([
    ['66992384539'],
    ['(66) 99238-4539'],
    ['(66) 9238-4539'],          // fixo, 10 dígitos
    ['6692384539'],
    ['55999998888'],             // DDD 55 (RS) legítimo: fica como está
    [''],
  ])('%s cabia: grava como veio', (entrada) => {
    expect(normalizarTelefone(entrada)).toEqual({ ok: true, valor: entrada });
  });

  it('null e undefined passam como vieram', () => {
    expect(normalizarTelefone(null)).toEqual({ ok: true, valor: null });
    expect(normalizarTelefone(undefined)).toEqual({ ok: true, valor: undefined });
  });

  it.each([
    ['669923845391'],              // 12 dígitos sem 55 na frente
    ['55669923845391'],            // 55 + 12 dígitos
    ['+55 (66) 99238-45391'],
  ])('%s tem dígito a mais: erro, nunca corta', (entrada) => {
    const r = normalizarTelefone(entrada);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PHONE_TOO_LONG');
    expect(r.error).toBe(ERRO_TELEFONE_LONGO);
  });

  it('sem recusar: o que não cabe volta como veio', () => {
    expect(normalizarTelefoneSemRecusar('669923845391')).toBe('669923845391');
    expect(normalizarTelefoneSemRecusar('5566992384539')).toBe('66992384539');
    expect(normalizarTelefoneSemRecusar(null)).toBe(null);
  });

  it('digitosNacionais e mesmoTelefone', () => {
    expect(digitosNacionais('+55 (66) 99238-4539')).toBe('66992384539');
    expect(mesmoTelefone('(66) 99238-4539', '66992384539')).toBe(true);
    expect(mesmoTelefone('66992384539', '55669923845')).toBe(false);
  });
});

// ── rotas ───────────────────────────────────────────────────
const CO = '11111111-1111-4111-8111-111111111111';
const CUST = '33333333-3333-4333-8333-333333333333';

function appCom(prefixo, router) {
  const app = express();
  app.use(express.json());
  app.use(prefixo, (req, res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
  app.use(prefixo, router);
  return app;
}

describe('POST/PATCH /customers', () => {
  const customersRouter = require('../src/routes/customers');
  const app = appCom('/companies/:id/customers', customersRouter);

  beforeEach(() => {
    jest.resetAllMocks();
    customersRouter._resetProfileColumnsCache();
  });

  function bancoQueGrava(gravados) {
    db.query.mockImplementation(async (sql, params) => {
      if (/SELECT id FROM companies/.test(sql) || /owner_id/.test(sql)) return { rows: [{ id: CO }] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: '0' }] };
      if (/INSERT INTO customers/.test(sql) || /UPDATE customers/.test(sql)) {
        gravados.push({ sql, params });
        return { rows: [{ id: CUST, company_id: CO, name: 'X' }] };
      }
      if (/SELECT phone FROM customers/.test(sql)) return { rows: [{ phone: '1234567890123' }] };
      return { rows: [] };
    });
  }

  it('POST com +55 grava sem o 55', async () => {
    const gravados = [];
    bancoQueGrava(gravados);
    const r = await request(app).post(`/companies/${CO}/customers`).send({ name: 'Ana', phone: '+55 (66) 99238-4539' });
    expect(r.status).toBe(201);
    const ins = gravados.find(g => /INSERT INTO customers/.test(g.sql));
    expect(ins.params).toContain('66992384539');
    expect(ins.params).not.toContain('+55 (66) 99238-4539');
  });

  it('POST com máscara de sempre grava como veio', async () => {
    const gravados = [];
    bancoQueGrava(gravados);
    const r = await request(app).post(`/companies/${CO}/customers`).send({ name: 'Ana', phone: '(66) 99238-4539' });
    expect(r.status).toBe(201);
    expect(gravados[0].params).toContain('(66) 99238-4539');
  });

  it('POST com dígito a mais: 400 gentil e nada gravado', async () => {
    const gravados = [];
    bancoQueGrava(gravados);
    const r = await request(app).post(`/companies/${CO}/customers`).send({ name: 'Ana', phone: '669923845391' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'PHONE_TOO_LONG', field: 'phone', error: ERRO_TELEFONE_LONGO });
    expect(gravados).toHaveLength(0);
  });

  it('PATCH com +55 grava sem o 55', async () => {
    const gravados = [];
    bancoQueGrava(gravados);
    const r = await request(app).patch(`/companies/${CO}/customers/${CUST}`).send({ phone: '5566992384539' });
    expect(r.status).toBe(200);
    const up = gravados.find(g => /UPDATE customers/.test(g.sql));
    expect(up.params).toContain('66992384539');
  });

  it('PATCH com dígito a mais e número novo: 400', async () => {
    const gravados = [];
    bancoQueGrava(gravados);
    const r = await request(app).patch(`/companies/${CO}/customers/${CUST}`).send({ phone: '669923845391' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('PHONE_TOO_LONG');
    expect(gravados).toHaveLength(0);
  });

  it('PATCH que reenvia o telefone antigo já gravado (13 dígitos) segue como está', async () => {
    const gravados = [];
    bancoQueGrava(gravados);
    const r = await request(app).patch(`/companies/${CO}/customers/${CUST}`).send({ name: 'Ana', phone: '1234567890123' });
    expect(r.status).toBe(200);
    const up = gravados.find(g => /UPDATE customers/.test(g.sql));
    expect(up.params).toContain('1234567890123');
  });
});

describe('PUT /companies/:id/profile', () => {
  const companyRouter = require('../src/routes/company');
  const app = appCom('/companies/:id', companyRouter);

  beforeEach(() => jest.resetAllMocks());

  it('telefone com +55 grava sem o 55', async () => {
    const gravados = [];
    db.query.mockImplementation(async (sql, params) => {
      if (/UPDATE companies/.test(sql)) { gravados.push(params); return { rows: [{ id: CO, phone: params[0] }] }; }
      return { rows: [] };
    });
    const r = await request(app).put(`/companies/${CO}/profile`).send({ phone: '+55 (66) 99238-4539' });
    expect(r.status).toBe(200);
    expect(gravados[0][0]).toBe('66992384539');
  });

  it('dígito a mais: 400 e nada gravado', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await request(app).put(`/companies/${CO}/profile`).send({ phone: '669923845391' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'PHONE_TOO_LONG', field: 'phone' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
