// ============================================================
// AURA — pdv-settings: termos e prazo padrao da venda condicional (C1/C2,
// 25/11/2026)
//
// As configuracoes do Caixa por loja moram em companies.pdv_settings
// (jsonb). A condicional ganha duas chaves, lidas ao guardar
// (services/condicional.js):
//   condicional_termos        texto da loja (ate 3000), null = sem quadro
//   condicional_prazo_padrao  dias (1-30), padrao 3
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const router = require('../src/routes/pdvSettings');

const COMPANY = '45d92b02-165d-44d6-928a-ac8e0183d5bd';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

function mockCompany(row) {
  const state = { ...row, updates: [] };
  db.query.mockImplementation(async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: [{ pdv_settings: state.pdv_settings, vertical_active: state.vertical_active }] };
    if (/^\s*UPDATE companies SET pdv_settings/i.test(sql)) {
      state.pdv_settings = JSON.parse(params[0]);
      state.updates.push(state.pdv_settings);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  });
  return state;
}

const put = (settings) => request(makeApp()).put('/companies/' + COMPANY + '/pdv-settings').send({ settings });

afterEach(() => db.query.mockReset());

describe('pdv-settings — condicional', () => {
  test('loja que nunca escolheu: sem termos e 3 dias', async () => {
    mockCompany({ vertical_active: null, pdv_settings: null });
    const get = await request(makeApp()).get('/companies/' + COMPANY + '/pdv-settings');
    expect(get.status).toBe(200);
    expect(get.body.settings).toMatchObject({ condicional_termos: null, condicional_prazo_padrao: 3 });
  });

  test('grava termos (com quebra de linha) e prazo', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: {} });
    const r = await put({ condicional_termos: '  Devolver sem uso.\nPeça com etiqueta.  ', condicional_prazo_padrao: 7 });
    expect(r.status).toBe(200);
    expect(state.updates[0]).toMatchObject({ condicional_termos: 'Devolver sem uso.\nPeça com etiqueta.', condicional_prazo_padrao: 7 });
  });

  test('texto vazio volta a null; prazo fora de 1-30 e 400 e nada e gravado', async () => {
    const state = mockCompany({ vertical_active: null, pdv_settings: { condicional_termos: 'Antigo' } });
    expect((await put({ condicional_termos: '   ' })).body.settings.condicional_termos).toBeNull();
    const antes = state.updates.length;
    expect((await put({ condicional_prazo_padrao: 31 })).status).toBe(400);
    expect((await put({ condicional_prazo_padrao: 0 })).status).toBe(400);
    expect((await put({ condicional_prazo_padrao: 2.5 })).status).toBe(400);
    expect((await put({ condicional_termos: 'x'.repeat(3001) })).status).toBe(400);
    expect(state.updates.length).toBe(antes);
  });
});
