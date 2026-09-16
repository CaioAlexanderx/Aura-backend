// ============================================================
// AURA. — POST /admin/access-codes diante do CHECK de type/plan (11/09/2026)
//
// O caso real: o Gestao Aura oferece o chip "Manual", a rota aceita
// type='manual' e plan='personalizado', mas a 019 criou access_codes com
// CHECKs que nao conhecem nenhum dos dois. O INSERT estourava 23514 e o
// painel recebia 500 sem motivo. A migration 327 alarga os CHECKs; ate ela
// ser aplicada, a rota tem que dizer o que falta em vez de 500.
//
// Banco mockado: o que se testa aqui e o mapeamento do erro. O contrato com o
// Postgres de verdade esta em codigoDeAcessoManual.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const router = require('../src/routes/adminAccessCodes');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const admin = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
app.use('/admin', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.statusCode || err.status || 500).json({ error: err.message });
});

function pgError(code, constraint) {
  const e = new Error(`new row for relation "access_codes" violates check constraint "${constraint}"`);
  e.code = code;
  e.constraint = constraint;
  return e;
}

const corpo = (extra) => ({ code: 'CLIENTE-LORENA', type: 'manual', plan: 'negocio', trial_days: 30, ...extra });

describe('POST /admin/access-codes — tipo manual e plano personalizado', () => {
  test('a rota aceita manual e personalizado e grava o que recebeu', async () => {
    db.query.mockImplementation((sql, params) => Promise.resolve({
      rows: [{ id: 'x', code: params[0], type: params[1], plan: params[2] }],
    }));

    const res = await request(app).post('/admin/access-codes').set(admin)
      .send(corpo({ plan: 'personalizado' }));

    expect(res.status).toBe(201);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [, params] = db.query.mock.calls[0];
    expect(params.slice(0, 3)).toEqual(['CLIENTE-LORENA', 'manual', 'personalizado']);
  });

  test('banco sem a 327 (CHECK de type) vira 400 que diz o que falta, nao 500', async () => {
    db.query.mockRejectedValue(pgError('23514', 'access_codes_type_check'));

    const res = await request(app).post('/admin/access-codes').set(admin).send(corpo());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/migration 327/);
    expect(res.body.error).toMatch(/"manual"/);
  });

  test('banco sem a 327 (CHECK de plan) tambem vira 400', async () => {
    db.query.mockRejectedValue(pgError('23514', 'access_codes_plan_check'));

    const res = await request(app).post('/admin/access-codes').set(admin)
      .send(corpo({ type: 'promo', plan: 'personalizado', trial_days: 0, discount_pct: 10 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"personalizado"/);
  });

  test('outro CHECK violado nao e mascarado como migration pendente', async () => {
    db.query.mockRejectedValue(pgError('23514', 'access_codes_discount_pct_check'));

    const res = await request(app).post('/admin/access-codes').set(admin).send(corpo());

    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/migration 327/);
  });

  test('tipo fora da lista da rota continua 400 antes de tocar o banco', async () => {
    const res = await request(app).post('/admin/access-codes').set(admin)
      .send(corpo({ type: 'payment' }));

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});
