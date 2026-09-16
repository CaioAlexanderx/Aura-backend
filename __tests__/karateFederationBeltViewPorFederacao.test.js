// ============================================================
// AURA KARATÊ — Regressão: a consulta de faixas do Painel filtra a VIEW
// karate_current_belt por federação, não só a tabela customers.
//
// 16/09/2026: o Painel da conta JKA (federação nova, 200 praticantes)
// respondia 500. A consulta filtrava só `c.federation_id = $1`; esse filtro
// não entra no DISTINCT ON da view, então a view recalculava o histórico de
// faixas de TODAS as federações. Com estatística velha o planejador estimou
// 1 praticante e fez o recálculo uma vez por praticante: 12,7 s e
// statement timeout.
//
// `cb.federation_id = $1` é o que empurra o filtro para dentro da view.
// Este teste existe porque a linha PARECE redundante com a de customers e
// é exatamente o tipo de coisa que alguém apaga numa limpeza.
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateFederation'));
  return app;
}

// Uma linha que serve para qualquer consulta do Painel: contagens zeradas.
function respondeVazio() {
  db.query.mockImplementation(() => Promise.resolve({
    rows: [{ dojo_count: '0', practitioner_count: '0', revenue_ytd: '0', cnt: '0' }],
  }));
}

// Acha a consulta de faixas pelo que ela É, não pela posição na sequência.
function consultaDeFaixas() {
  const call = db.query.mock.calls.find(([sql]) => /FROM karate_current_belt cb/.test(sql));
  if (!call) throw new Error('consulta de faixas não foi disparada');
  return call;
}

const FILTRO_NA_VIEW = /\bcb\.federation_id\s*=\s*\$1\b/;

describe.each([
  ['GET /dashboard', 'dashboard'],
  ['GET /belt-distribution', 'belt-distribution'],
])('%s — filtro de federação dentro da view de faixas', (_nome, rota) => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); respondeVazio(); });

  it.each([
    ['sem ?status (ativos)', '', [FED_ID, [true]]],
    ['?status=inactive', '?status=inactive', [FED_ID, [false]]],
    // `all` é a variante com um parâmetro só: se o filtro novo citasse $2
    // por engano, o Postgres recusaria a consulta — ver a memória
    // "parâmetro entra na consulta que o cita".
    ['?status=all', '?status=all', [FED_ID]],
  ])('%s', async (_caso, qs, paramsEsperados) => {
    const res = await request(app)
      .get(`/federation/${FED_ID}/${rota}${qs}`)
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    const [sql, params] = consultaDeFaixas();
    expect(sql).toMatch(FILTRO_NA_VIEW);
    expect(sql).toMatch(/\bc\.federation_id\s*=\s*\$1\b/);
    expect(params).toEqual(paramsEsperados);
  });
});
