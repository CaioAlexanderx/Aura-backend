// ============================================================
// Financeiro — GET /companies/:id/transactions
//
// Lentidao do Studio (QA 04/09/2026): o banco fica em outra regiao e cada
// ida custa ~190ms. A listagem fazia tres idas em sequencia (contagem,
// pagina, somas). Estes testes travam o novo desenho: duas consultas, as
// duas disparadas ANTES de qualquer resposta voltar, contagem e somas na
// mesma consulta, e a resposta identica a de antes.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db      = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  return app;
}

// Promessa que so resolve quando o teste mandar — e o que deixa provar que
// a segunda consulta saiu sem esperar a primeira.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => { db.query.mockReset(); });

describe('GET /companies/:id/transactions — idas ao banco', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('faz duas consultas em paralelo: agregados (contagem + somas) e pagina', async () => {
    const agg  = deferred();
    const page = deferred();
    db.query
      .mockImplementationOnce(() => agg.promise)
      .mockImplementationOnce(() => page.promise);

    // O .then e o que faz o supertest disparar a requisicao de fato; sem
    // ele, nada sai ate o await la embaixo.
    const pending = request(app)
      .get(`/companies/${CID}/transactions?type=income&start=2026-08-01&end=2026-09-30&limit=50&offset=10`)
      .then((r) => r);

    // A requisicao atravessa o socket local antes de chegar ao handler:
    // alguns ciclos do event loop, nao um so.
    for (let i = 0; i < 20 && db.query.mock.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Se a asserção falhar, as promessas presas ainda precisam ser soltas —
    // senão a requisição fica aberta e o Jest nunca termina.
    const chamadas = db.query.mock.calls.length;
    if (chamadas < 2) {
      agg.resolve({ rows: [{}] });
      page.resolve({ rows: [] });
      await pending.catch(() => {});
    }
    expect(chamadas).toBe(2);

    const [aggSql, aggParams]   = db.query.mock.calls[0];
    const [pageSql, pageParams] = db.query.mock.calls[1];

    // Agregados: contagem da listagem (com type) como subconsulta, somas sem type.
    expect(aggSql).toMatch(/\(SELECT COUNT\(\*\) FROM transactions WHERE company_id = \$1 AND type = \$2/);
    expect(aggSql).toMatch(/AS total/);
    expect(aggSql).toMatch(/AS pending_expenses/);
    // A clausula das somas (depois do FROM externo) nao filtra por type.
    const somasWhere = aggSql.slice(aggSql.lastIndexOf('FROM transactions'));
    expect(somasWhere).not.toMatch(/type = \$2/);
    expect(somasWhere).toMatch(/>= \$3/);
    expect(somasWhere).toMatch(/<= \$4/);
    expect(aggParams).toEqual([CID, 'income', '2026-08-01', '2026-09-30']);

    // Pagina: mesmos filtros + limit/offset.
    expect(pageSql).toMatch(/LIMIT \$5 OFFSET \$6/);
    expect(pageParams).toEqual([CID, 'income', '2026-08-01', '2026-09-30', 50, 10]);

    agg.resolve({ rows: [{ total: '7', income: '100.50', expenses: '40', pending_income: '5', pending_expenses: '0' }] });
    page.resolve({ rows: [
      { id: 't1', type: 'income', amount: '100.50', description: 'Venda', category: 'Vendas', status: 'confirmed', due_date: '2026-09-01' },
    ] });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.summary).toMatchObject({ income: 100.5, expenses: 40, pending_income: 5, pending_expenses: 0 });
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0]).toMatchObject({ id: 't1', amount: 100.5, description: 'Venda' });
  });

  test('sem filtros: parametros so com company_id e a janela padrao do mes nas somas', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '0', income: '0', expenses: '0', pending_income: '0', pending_expenses: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/companies/${CID}/transactions`);
    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledTimes(2);

    const [aggSql, aggParams] = db.query.mock.calls[0];
    expect(aggParams).toEqual([CID]);
    // Sem start/end, as somas ficam presas ao mes corrente (regime caixa do dashboard).
    expect(aggSql).toMatch(/date_trunc\('month'/);
    expect(res.body).toMatchObject({ total: 0, transactions: [] });
  });
});
