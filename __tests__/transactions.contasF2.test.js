// ============================================================
// Contas a pagar F2 (28/09/2026): baixa em lote, "vence esta semana" e o que
// foi pago a mais/a menos no mes. O SQL foi conferido num Postgres 16 real
// (unnest com uuid[]/numeric[] e FILTER em janela); aqui ficam o contrato da
// rota e a citacao de parametros.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const quadro = require('../src/utils/quadroFinanceiro');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CRED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  return app;
}

const maior = (sql) => Math.max(...(sql.match(/\$(\d+)/g) || []).map((s) => Number(s.slice(1))));
const cita = (sql, n) => new RegExp('\\$' + n + '(?!\\d)').test(sql);

beforeEach(() => { db.query.mockReset(); });

describe('SQL da F2', () => {
  it('semana e baixa em lote citam todos os parametros', () => {
    expect(maior(quadro.sqlDaSemana())).toBe(3);
    for (let n = 1; n <= 3; n++) expect(cita(quadro.sqlDaSemana(), n)).toBe(true);
    expect(maior(quadro.sqlDaBaixaEmLote())).toBe(5);
    for (let n = 1; n <= 5; n++) expect(cita(quadro.sqlDaBaixaEmLote(), n)).toBe(true);
  });

  it('baixa em lote so pega pendente, movable e fora do crediario', () => {
    const sql = quadro.sqlDaBaixaEmLote();
    expect(sql).toMatch(/t\.status = 'pending'/);
    expect(sql).toMatch(/t\.idempotency_key IS NULL OR t\.idempotency_key ~\* '\^planilha-'/);
    expect(sql).toMatch(/NOT \(t\.category ILIKE 'credi_rio%'/);
  });

  it('montarQuadro devolve semana e diferencas', () => {
    const q = quadro.montarQuadro({
      tipo: 'expense', hoje: '2026-09-28', mes: '2026-09',
      cartoes: [{ coluna: 'feito', qtd_coluna: '2', total_coluna: '286.3', pago_a_mais: '6.4', pago_a_menos: '5', qtd_a_mais: '1', id: 'x', amount: '186.4', original_amount: '180', status: 'confirmed', comp: '2026-09-10' }],
      grupos: [],
      semana: { qtd: '2', total: '120', ate: '2026-10-04' },
    });
    expect(q.week).toEqual({ count: 2, total: 120, until: '2026-10-04' });
    expect(q.columns.feito.diferenca).toEqual({ a_mais: 6.4, a_menos: 5, count_a_mais: 1 });
  });
});

describe('POST /transactions/baixa-em-lote', () => {
  it('manda ids e valores pagos em arrays, sem repetir id, e devolve os pulados', async () => {
    let chamada;
    db.query.mockImplementation((sql, params) => {
      chamada = { sql: String(sql), params };
      return Promise.resolve({ rows: [{ id: A, amount: '186.40' }, { id: B, amount: '99.90' }] });
    });
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions/baixa-em-lote')
      .send({ paid_at: '2026-09-28', payment_method: 'boleto', items: [{ id: A, paid_amount: 186.4 }, { id: B }, { id: CRED }, { id: A }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, skipped: [CRED], total: 286.3 });
    expect(chamada.params).toEqual([COMPANY, [A, B, CRED], '2026-09-28', 'boleto', [186.4, null, null]]);
  });

  it.each([
    ['sem itens', { items: [] }],
    ['id invalido', { items: [{ id: 'abc' }] }],
    ['valor pago zero', { items: [{ id: A, paid_amount: 0 }] }],
    ['data em outro formato', { paid_at: '28/09/2026', items: [{ id: A }] }],
    ['forma desconhecida', { payment_method: 'cheque', items: [{ id: A }] }],
  ])('recusa %s com 400 sem tocar no banco', async (_n, corpo) => {
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions/baixa-em-lote').send(corpo);
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('mais de 200 itens e recusado', async () => {
    const items = Array.from({ length: 201 }, () => ({ id: A }));
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions/baixa-em-lote').send({ items });
    expect(res.status).toBe(400);
  });
});
