// ============================================================
// Financeiro — GET /companies/:id/financeiro/insights
//
// Lentidao do Studio (QA 04/09/2026): resumo do periodo, resumo do periodo
// anterior e atrasados eram tres idas sequenciais ANTES da rodada paralela
// de onze consultas (quatro rodadas, ~190ms cada, so de latencia). Este
// teste trava que TODAS as consultas saem antes de qualquer resposta
// voltar (uma rodada) e que os numeros do resumo continuam chegando
// inteiros na resposta.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db      = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';

function buildApp() {
  const app = express();
  app.use('/companies/:id/financeiro', require('../src/routes/financeiroInsights').companyRouter);
  return app;
}

// Responde cada consulta pelo formato do SQL — a ordem nao importa mais,
// que e justamente o ponto.
function rowsFor(sql) {
  if (/income_count/.test(sql) && /tx_count/.test(sql)) {
    // O resumo do periodo atual e o do anterior usam o mesmo SQL; o teste
    // distingue pelo parametro de data (ver abaixo).
    return null;
  }
  if (/oldest_days/.test(sql)) {
    return [{ total: '250', count: '2', oldest_days: '12' }];
  }
  return [];
}

afterEach(() => { db.query.mockReset(); });

describe('GET /companies/:id/financeiro/insights — idas ao banco', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('dispara todas as consultas numa unica rodada e devolve o resumo', async () => {
    const pendentes = [];
    db.query.mockImplementation((sql, params) => new Promise((resolve) => {
      pendentes.push({ sql, params, resolve });
    }));

    // O .then e o que faz o supertest disparar a requisicao de fato.
    const pending = request(app).get(`/companies/${CID}/financeiro/insights?period=month`).then((r) => r);
    // A requisicao atravessa o socket local antes de chegar ao handler:
    // alguns ciclos do event loop, nao um so.
    for (let i = 0; i < 20 && db.query.mock.calls.length < 14; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // 3 (resumo atual, resumo anterior, atrasados) + 11 (onda 2 e 3), tudo
    // pendurado ao mesmo tempo: nenhuma resposta voltou ainda. A contagem e
    // congelada antes das asserções; se falhar, o `finally` abaixo solta as
    // promessas presas para a requisição fechar e o Jest terminar.
    const disparadas = pendentes.length;
    const resumos = pendentes.filter((p) => /income_count/.test(p.sql)).length;

    // O resumo do periodo atual e o que recebe a data de hoje como fim.
    const hoje = new Date().toISOString().slice(0, 10);
    const soltar = () => { for (const p of pendentes) {
      if (/income_count/.test(p.sql)) {
        const atual = p.params[2] === hoje;
        p.resolve({ rows: [atual
          ? { income: '1000', expenses: '400', income_count: '4', tx_count: '6' }
          : { income: '800',  expenses: '300', income_count: '3', tx_count: '5' }] });
      } else {
        p.resolve({ rows: rowsFor(p.sql) });
      }
    } };

    // O código antigo dispara só 1 consulta e espera por ela: as demais
    // nunca entram em `pendentes` enquanto a primeira nao volta.
    let res;
    try {
      expect(disparadas).toBe(14);
      expect(resumos).toBe(2);
    } finally {
      // Solta o que ja esta preso e continua soltando o que o codigo antigo
      // dispararia em sequencia, ate a requisicao fechar.
      const fechou = pending.then((r) => { res = r; });
      let acabou = false;
      fechou.finally(() => { acabou = true; });
      for (let i = 0; i < 40 && !acabou; i++) {
        soltar();
        await new Promise((r) => setTimeout(r, 10));
      }
      await fechou;
    }
    expect(res.status).toBe(200);
    expect(res.body.consolidated).toBe(false);
    expect(res.body.income_breakdown.total).toBe(1000);
    expect(res.body.expense_breakdown.total).toBe(400);
    // Crescimento vs periodo anterior: 1000 sobre 800 = +25%.
    const crescimento = res.body.health.drivers.find((d) => d.id === 'crescimento');
    expect(crescimento.current).toBe('+25,0%');
    // Atrasados entram na alavanca de cobranca.
    expect(res.body.biggest_lever).toMatchObject({ type: 'collect_overdue', amount: 250, count: 2, oldest_days: 12 });
  });

  test('periodo sem comparativo anterior: 13 consultas, sem a do periodo anterior', async () => {
    db.query.mockImplementation((sql) => Promise.resolve({ rows:
      /income_count/.test(sql) ? [{ income: '0', expenses: '0', income_count: '0', tx_count: '0' }]
      : /oldest_days/.test(sql) ? [{ total: '0', count: '0', oldest_days: '0' }]
      : [] }));

    const res = await request(app).get(`/companies/${CID}/financeiro/insights?period=all`);
    expect(res.status).toBe(200);
    const resumos = db.query.mock.calls.filter(([sql]) => /income_count/.test(sql));
    expect(resumos).toHaveLength(1);
  });
});
