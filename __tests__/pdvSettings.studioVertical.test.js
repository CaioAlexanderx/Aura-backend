// ============================================================
// AURA — pdv-settings: studio_enabled segue a vertical
//
// Caso real (03/10/2026): o admin ativou a vertical Studio e, 2s depois, um
// PUT do app com a copia antiga das configuracoes (studio_enabled:false, o
// default devolvido pelo GET) desligou a chave. A dona caiu em "Modo Studio
// desativado" e ficou sem acesso a nada.
//
// Cobertura:
//  (1) PUT em empresa da vertical Studio com studio_enabled:false grava true.
//  (2) PUT em empresa da vertical Studio sem a chave no corpo nem no salvo
//      grava true (o default e false).
//  (3) GET em empresa da vertical Studio devolve true mesmo com false salvo.
//  (4) Fora da vertical Studio nada muda: a chave segue o que foi enviado.
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

// Banco em memoria de uma linha de companies, roteado pelo texto do SQL.
function mockCompany(row) {
  const state = { ...row, updates: [] };
  db.query.mockImplementation(async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) {
      const out = {};
      if (/pdv_settings/.test(sql)) out.pdv_settings = state.pdv_settings;
      if (/vertical_active/.test(sql)) out.vertical_active = state.vertical_active;
      return { rows: [out] };
    }
    if (/^\s*UPDATE companies SET pdv_settings/i.test(sql)) {
      state.pdv_settings = JSON.parse(params[0]);
      state.updates.push(state.pdv_settings);
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL inesperado no teste: ' + sql);
  });
  return state;
}

afterEach(() => db.query.mockReset());

describe('pdv-settings — empresa da vertical Studio', () => {
  test('(1) PUT com copia antiga (studio_enabled:false) nao desliga o Studio', async () => {
    const state = mockCompany({ vertical_active: 'studio', pdv_settings: { studio_enabled: true } });

    const res = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { studio_enabled: false, require_customer: true } });

    expect(res.status).toBe(200);
    expect(res.body.settings.studio_enabled).toBe(true);
    expect(res.body.settings.require_customer).toBe(true);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].studio_enabled).toBe(true);
  });

  test('(2) PUT sem a chave, e sem a chave salva, grava true', async () => {
    const state = mockCompany({ vertical_active: 'studio', pdv_settings: null });

    const res = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { caixa_enabled: true } });

    expect(res.status).toBe(200);
    expect(state.updates[0].studio_enabled).toBe(true);
    expect(state.updates[0].caixa_enabled).toBe(true);
  });

  test('(3) GET devolve true mesmo com false salvo', async () => {
    mockCompany({ vertical_active: 'studio', pdv_settings: { studio_enabled: false } });

    const res = await request(makeApp()).get('/companies/' + COMPANY + '/pdv-settings');

    expect(res.status).toBe(200);
    expect(res.body.settings.studio_enabled).toBe(true);
  });
});

describe('pdv-settings — fora da vertical Studio', () => {
  test.each([null, 'food'])('(4) vertical %s: studio_enabled segue o que foi enviado', async (vertical) => {
    const state = mockCompany({ vertical_active: vertical, pdv_settings: { studio_enabled: true } });

    const put = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { studio_enabled: false } });
    expect(put.status).toBe(200);
    expect(state.updates[0].studio_enabled).toBe(false);

    const get = await request(makeApp()).get('/companies/' + COMPANY + '/pdv-settings');
    expect(get.body.settings.studio_enabled).toBe(false);
  });
});
