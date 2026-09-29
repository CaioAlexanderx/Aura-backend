// ============================================================
// Financeiro — atrasos clicáveis (contas F4 · 29/09/2026)
//
// O "Cobre R$ X em atraso" e a faixa "Atrasadas" somavam crediário e contas
// comuns num número só, e cada parte se resolve num lugar (crediário na tela
// do Crediário; o resto no Quadro). Os insights passam a separar as duas
// partes, e "hoje" é o dia civil de São Paulo (como no Quadro), não o
// CURRENT_DATE do servidor em UTC.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';

function buildApp() {
  const app = express();
  app.use('/companies/:id/financeiro', require('../src/routes/financeiroInsights').companyRouter);
  return app;
}

function responder(sqls) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    sqls.push(s);
    if (/income_count/.test(s) && /tx_count/.test(s)) return Promise.resolve({ rows: [{ income: '1000', expenses: '400', income_count: '10', tx_count: '30' }] });
    if (/oldest_days/.test(s)) return Promise.resolve({ rows: [{ total: '680', count: '5', oldest_days: '12', crediario_total: '480', crediario_count: '3' }] });
    if (/AS bucket/.test(s)) {
      return Promise.resolve({ rows: [
        { bucket: 'atrasadas', total: '680', count: '5', crediario_total: '480', crediario_count: '3' },
        { bucket: 'esta_semana', total: '100', count: '1', crediario_total: '0', crediario_count: '0' },
      ] });
    }
    return Promise.resolve({ rows: [] });
  });
}

afterEach(() => { db.query.mockReset(); });

describe('insights — atraso separado em crediário e contas', () => {
  test('biggest_lever.split e timeline.atrasadas.crediario', async () => {
    const sqls = [];
    responder(sqls);
    const res = await request(buildApp()).get(`/companies/${CID}/financeiro/insights?period=month`);
    expect(res.status).toBe(200);
    const lever = res.body.biggest_lever || (res.body.insights && res.body.insights.biggest_lever);
    expect(lever).toBeTruthy();
    expect(lever.split).toEqual({ crediario: { amount: 480, count: 3 }, contas: { amount: 200, count: 2 } });
    const corpo = JSON.stringify(res.body);
    expect(corpo).toMatch(/"atrasadas":\{"total":680,"count":5,"crediario":\{"total":480,"count":3\}\}/);
  });

  test('"hoje" é São Paulo, não CURRENT_DATE do servidor', async () => {
    const sqls = [];
    responder(sqls);
    await request(buildApp()).get(`/companies/${CID}/financeiro/insights?period=month`);
    const atraso = sqls.filter((s) => /oldest_days|AS bucket/.test(s));
    expect(atraso.length).toBeGreaterThanOrEqual(2);
    for (const s of atraso) {
      expect(s).not.toMatch(/CURRENT_DATE/);
      expect(s).toMatch(/AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
      expect(s).toMatch(/credi_rio%/);
    }
  });
});
