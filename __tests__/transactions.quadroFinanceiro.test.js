// ============================================================
// Quadro do Financeiro (28/09/2026) — GET /transactions/board e a baixa
// pelo quadro no PATCH /transactions/:txId.
//
// - Atrasado nao e gravado: sai da data do lancamento (competencia) < hoje SP.
// - Crediario fica fora do quadro e nao aceita mudar status pelo PATCH: a
//   baixa dele e parcela a parcela (credit_installments).
// - Desfazer (status pending) limpa paid_at; a baixa aceita a data escolhida.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const quadro = require('../src/utils/quadroFinanceiro');

const COMPANY = 'company-uuid-qbonita';
const TX_ID = 'tx-uuid-1';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  return app;
}

beforeEach(() => { db.query.mockReset(); });

describe('utils/quadroFinanceiro', () => {
  it('intervaloDoMes: mes pedido, virada de ano e fallback para o mes de hoje', () => {
    expect(quadro.intervaloDoMes('2026-09', '2026-09-28')).toEqual({ mes: '2026-09', inicio: '2026-09-01', fim: '2026-10-01' });
    expect(quadro.intervaloDoMes('2026-12', '2026-09-28')).toEqual({ mes: '2026-12', inicio: '2026-12-01', fim: '2027-01-01' });
    expect(quadro.intervaloDoMes('2026-13', '2026-09-28').mes).toBe('2026-09');
    expect(quadro.intervaloDoMes(undefined, '2026-09-28').mes).toBe('2026-09');
    expect(quadro.intervaloDoMes("2026-09'; drop", '2026-09-28').mes).toBe('2026-09');
  });

  it('hojeSP: 23h30 de Sao Paulo ainda e o mesmo dia (UTC ja virou)', () => {
    expect(quadro.hojeSP(new Date('2026-09-29T02:30:00Z'))).toBe('2026-09-28');
  });

  it('eCrediario: categoria com ou sem acento e chaves do ledger', () => {
    expect(quadro.eCrediario({ category: 'Crediario - A Receber' })).toBe(true);
    expect(quadro.eCrediario({ category: 'Crediário - Recebido' })).toBe(true);
    expect(quadro.eCrediario({ category: 'Vendas', idempotency_key: 'credit-payment-abc' })).toBe(true);
    expect(quadro.eCrediario({ category: 'Vendas', idempotency_key: 'pdv-credit-receivable-x' })).toBe(true);
    expect(quadro.eCrediario({ category: 'Aluguel', idempotency_key: null })).toBe(false);
    expect(quadro.eCrediario({ category: 'Vendas', idempotency_key: 'pdv-sale-abc' })).toBe(false);
  });

  it('podeMover: manual e planilha sim; o que nasce de outro fluxo nao', () => {
    expect(quadro.podeMover(null)).toBe(true);
    expect(quadro.podeMover('planilha-despesas-2026-09-01-1')).toBe(true);
    expect(quadro.podeMover('pdv-troca-v2-abc')).toBe(false);
    expect(quadro.podeMover('digital-order-abc')).toBe(false);
  });

  it('as consultas citam todos os parametros que recebem', () => {
    // Postgres conta pelo maior $n: parametro sobrando derruba a consulta.
    const maior = (sql) => Math.max(...(sql.match(/\$(\d+)/g) || []).map((s) => Number(s.slice(1))));
    expect(maior(quadro.sqlDosCartoes())).toBe(5);
    expect(maior(quadro.sqlDosGrupos())).toBe(4);
    for (let n = 1; n <= 5; n++) expect(quadro.sqlDosCartoes()).toContain('$' + n);
  });

  it('montarQuadro: colunas, totais e grupos do Caixa somados em Recebido', () => {
    const q = quadro.montarQuadro({
      tipo: 'income', hoje: '2026-09-28', mes: '2026-09',
      cartoes: [
        { coluna: 'atrasado', qtd_coluna: '1', total_coluna: '97.50', id: 'a', description: 'Parcela', category: 'Vendas', amount: '97.50', status: 'pending', employee_id: null, comp: '2026-08-30', due_date: '2026-08-30', idempotency_key: null },
        { coluna: 'feito', qtd_coluna: '1', total_coluna: '250', id: 'f', description: 'Aluguel vitrine', category: 'Outros', amount: '250', status: 'confirmed', comp: '2026-09-05', due_date: '2026-09-05', paid_at: '2026-09-05T03:00:00Z', idempotency_key: 'digital-order-x', employee_id: 'emp-1' },
      ],
      grupos: [{ dia: '2026-09-27', origem: 'caixa', qtd: '9', total: '1284.70' }],
    });
    expect(q.columns.atrasado).toMatchObject({ count: 1, total: 97.5 });
    expect(q.columns.atrasado.items[0]).toMatchObject({ id: 'a', date: '2026-08-30', movable: true, amount: 97.5 });
    // O modal "Editar lancamento" compara o funcionario com o de antes: sem o id, salvar apagaria o vinculo.
    expect(q.columns.atrasado.items[0]).toHaveProperty('employee_id', null);
    expect(q.columns.aberto).toMatchObject({ count: 0, total: 0, items: [] });
    expect(q.columns.feito.count).toBe(10);
    expect(q.columns.feito.total).toBe(1534.7);
    expect(q.columns.feito.items[0].movable).toBe(false);
    expect(q.columns.feito.items[0].employee_id).toBe('emp-1');
    expect(q.columns.feito.grupos).toEqual([{ date: '2026-09-27', origem: 'caixa', count: 9, total: 1284.7 }]);
  });
});

describe('GET /transactions/board', () => {
  it('usa o mes pedido e o tipo, e devolve as tres colunas', async () => {
    const chamadas = [];
    db.query.mockImplementation((sql, params) => {
      chamadas.push({ sql: String(sql), params });
      if (/GROUP BY 1, 2/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [
        { coluna: 'aberto', qtd_coluna: '1', total_coluna: '312.45', id: 'e', description: 'Energia', category: 'Contas', amount: '312.45', status: 'pending', comp: '2026-10-20', due_date: '2026-10-20', idempotency_key: null },
      ] });
    });

    const res = await request(buildApp()).get('/companies/' + COMPANY + '/transactions/board?type=expense&month=2026-10');

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('expense');
    expect(res.body.month).toBe('2026-10');
    expect(res.body.columns.aberto.items[0]).toMatchObject({ id: 'e', movable: true });
    const cartoes = chamadas.find((c) => /WITH base AS/.test(c.sql));
    expect(cartoes.params[0]).toBe(COMPANY);
    expect(cartoes.params[1]).toBe('expense');
    expect(cartoes.params[3]).toBe('2026-10-01');
    expect(cartoes.params[4]).toBe('2026-11-01');
  });

  it('tipo desconhecido cai em receitas', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(buildApp()).get('/companies/' + COMPANY + '/transactions/board?type=xpto');
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('income');
  });
});

describe('PATCH /transactions/:txId pelo quadro', () => {
  function mockLinha(linha) {
    const estado = { updates: [] };
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/^\s*SELECT amount, idempotency_key/.test(s)) return Promise.resolve({ rows: [linha] });
      if (/^\s*UPDATE transactions SET/.test(s)) {
        estado.updates.push({ sql: s, params });
        return Promise.resolve({ rows: [{ id: TX_ID, idempotency_key: linha.idempotency_key }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return estado;
  }

  it('baixa com data escolhida grava paid_at na meia-noite SP', async () => {
    const estado = mockLinha({ amount: '432', idempotency_key: null, category: 'Venda a prazo', status: 'pending' });
    const res = await request(buildApp())
      .patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send({ status: 'confirmed', paid_at: '2026-09-27', payment_method: 'pix' });
    expect(res.status).toBe(200);
    const up = estado.updates[0];
    expect(up.sql).toMatch(/paid_at = \(\$\d+::date \+ INTERVAL '3 hours'\)/);
    expect(up.params).toContain('2026-09-27');
    expect(up.sql).not.toMatch(/COALESCE\(paid_at, NOW\(\)\)/);
  });

  it('baixa sem data mantem o comportamento antigo (agora)', async () => {
    const estado = mockLinha({ amount: '10', idempotency_key: null, category: 'Outros', status: 'pending' });
    await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ status: 'confirmed' });
    expect(estado.updates[0].sql).toMatch(/paid_at = COALESCE\(paid_at, NOW\(\)\)/);
  });

  it('desfazer (volta para pendente) limpa paid_at', async () => {
    const estado = mockLinha({ amount: '10', idempotency_key: null, category: 'Outros', status: 'confirmed' });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ status: 'pending' });
    expect(res.status).toBe(200);
    expect(estado.updates[0].sql).toMatch(/paid_at = NULL/);
  });

  it('paid_at que nao e data e recusado antes de tocar no banco', async () => {
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send({ status: 'confirmed', paid_at: 'ontem' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each([
    ['A Receber do crediario', { category: 'Crediario - A Receber', idempotency_key: 'pdv-credit-receivable-558c850b-eca7-44d7-887a-de0a84e65b08', status: 'pending' }, 'confirmed'],
    ['recebimento do crediario', { category: 'Crediario - Recebido', idempotency_key: 'credit-payment-abc', status: 'confirmed' }, 'pending'],
  ])('crediario: mudar status (%s) e recusado com 409', async (_n, linha, novo) => {
    const estado = mockLinha(Object.assign({ amount: '100' }, linha));
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ status: novo });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_STATUS_DERIVED');
    expect(estado.updates).toHaveLength(0);
  });

  it('crediario: o modal que manda o mesmo status continua salvando', async () => {
    const estado = mockLinha({ amount: '100', category: 'Crediario - A Receber', idempotency_key: 'pdv-credit-receivable-558c850b-eca7-44d7-887a-de0a84e65b08', status: 'pending' });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send({ status: 'pending', notes: 'ligar sexta' });
    expect(res.status).toBe(200);
    expect(estado.updates).toHaveLength(1);
  });
});
