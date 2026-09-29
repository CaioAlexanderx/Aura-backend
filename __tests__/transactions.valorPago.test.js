// ============================================================
// Valor pago e data do pagamento (28/09/2026 — feedback de lojista)
//
// "Tenho boletos atrasados: a data do pagamento nao e a do vencimento. E quero
// colocar o valor que paguei, sem calcular juros nem porcentagem."
//
// - Baixa com paid_amount diferente: amount = valor pago (o que os relatorios
//   somam) e original_amount = valor do boleto. Igual ao boleto: sem original.
// - Desfazer devolve amount = original_amount e limpa a coluna.
// - Cadastro "ja paguei": due_date = vencimento, paid_at = data do pagamento.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');

const COMPANY = 'company-uuid-boletos';
const TX_ID = 'tx-uuid-boleto';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
  return app;
}

// Postgres conta os parametros pelo maior $n e recusa um enviado e nao citado.
function conferirParametros(sql, params) {
  const citados = new Set((String(sql).match(/\$(\d+)/g) || []).map((s) => Number(s.slice(1))));
  const maior = Math.max(0, ...citados);
  expect(maior).toBe(params.length);
  for (let n = 1; n <= params.length; n++) expect(citados.has(n)).toBe(true);
}

function mockLinha(linha) {
  const estado = { updates: [], inserts: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/^\s*SELECT amount, idempotency_key/.test(s)) return Promise.resolve({ rows: [linha] });
    if (/^\s*UPDATE transactions SET/.test(s)) {
      estado.updates.push({ sql: s, params });
      return Promise.resolve({ rows: [{ id: TX_ID, idempotency_key: linha && linha.idempotency_key }] });
    }
    if (/^\s*INSERT INTO transactions/.test(s)) {
      estado.inserts.push({ sql: s, params });
      return Promise.resolve({ rows: [{ id: 'novo-' + estado.inserts.length, type: params[1], amount: params[2], status: params[7] }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return estado;
}

beforeEach(() => { db.query.mockReset(); });

describe('PATCH — baixa com valor pago', () => {
  it('boleto de 180 pago com 186,40: amount vira o pago e o boleto fica em original_amount', async () => {
    const estado = mockLinha({ amount: '180.00', idempotency_key: null, category: 'Fornecedores', status: 'pending' });
    const res = await request(buildApp())
      .patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send({ status: 'confirmed', paid_at: '2026-09-20', paid_amount: 186.4, payment_method: 'boleto' });

    expect(res.status).toBe(200);
    const up = estado.updates[0];
    expect(up.sql).toMatch(/original_amount = CASE WHEN ABS\(\$(\d+)::numeric - COALESCE\(original_amount, amount\)\) < 0\.005 THEN NULL ELSE COALESCE\(original_amount, amount\) END/);
    expect(up.sql).toMatch(/amount = \$\d+::numeric/);
    expect(up.params).toContain(186.4);
    expect(up.params).toContain('2026-09-20');
    conferirParametros(up.sql, up.params);
  });

  it('amount enviado junto do paid_amount e ignorado (o pago manda)', async () => {
    const estado = mockLinha({ amount: '180.00', idempotency_key: null, category: 'Fornecedores', status: 'pending' });
    await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send({ status: 'confirmed', paid_amount: 190, amount: 999 });
    expect(estado.updates[0].params).not.toContain(999);
    expect(estado.updates[0].sql.match(/(SET |, )amount = /g)).toHaveLength(1);
  });

  it('paid_amount sem status confirmed e recusado', async () => {
    mockLinha({ amount: '180.00', idempotency_key: null, category: 'Outros', status: 'pending' });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ paid_amount: 190 });
    expect(res.status).toBe(400);
  });

  it.each([0, -5, 'abc'])('paid_amount invalido (%p) e recusado', async (v) => {
    mockLinha({ amount: '180.00', idempotency_key: null, category: 'Outros', status: 'pending' });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ status: 'confirmed', paid_amount: v });
    expect(res.status).toBe(400);
  });

  it('crediario nao aceita valor pago por aqui, nem sem mudar o status', async () => {
    const estado = mockLinha({ amount: '100', category: 'Crediario - Recebido', idempotency_key: 'credit-payment-x', status: 'confirmed' });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID)
      .send({ status: 'confirmed', paid_amount: 120 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CREDIT_STATUS_DERIVED');
    expect(estado.updates).toHaveLength(0);
  });
});

describe('PATCH — desfazer a baixa', () => {
  it('devolve o valor do boleto e limpa original_amount', async () => {
    const estado = mockLinha({ amount: '186.40', idempotency_key: null, category: 'Fornecedores', status: 'confirmed' });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ status: 'pending' });
    expect(res.status).toBe(200);
    const sql = estado.updates[0].sql;
    expect(sql).toMatch(/paid_at = NULL/);
    expect(sql).toMatch(/amount = COALESCE\(original_amount, amount\)/);
    expect(sql).toMatch(/original_amount = NULL/);
  });

  it('se o corpo ja traz amount, nao atribui amount duas vezes', async () => {
    const estado = mockLinha({ amount: '186.40', idempotency_key: null, category: 'Fornecedores', status: 'confirmed' });
    await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/' + TX_ID).send({ status: 'pending', amount: 180 });
    const sql = estado.updates[0].sql;
    expect(sql).not.toMatch(/amount = COALESCE\(original_amount, amount\)/);
    expect(sql.match(/(SET |, )amount = /g)).toHaveLength(1);
  });
});

describe('POST — cadastro "ja paguei"', () => {
  const base = { type: 'expense', amount: 180, description: 'Boleto Malharia Aurora', category: 'Fornecedores', due_date: '2026-09-10' };

  it('vencimento, data e valor pagos', async () => {
    const estado = mockLinha(null);
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions')
      .send({ ...base, status: 'confirmed', paid_at: '2026-09-20', paid_amount: 186.4 });
    expect(res.status).toBe(201);
    const ins = estado.inserts[0];
    expect(ins.params[2]).toBe(186.4);            // amount = pago
    expect(ins.params[6]).toBe('2026-09-10');     // due_date = vencimento
    expect(ins.params[12]).toBe('2026-09-20');    // paid_at
    expect(ins.params[13]).toBe(180);             // original_amount = boleto
    conferirParametros(ins.sql, ins.params);
  });

  it('pago pelo valor do boleto: sem original_amount', async () => {
    const estado = mockLinha(null);
    await request(buildApp()).post('/companies/' + COMPANY + '/transactions').send({ ...base, status: 'confirmed', paid_amount: 180 });
    expect(estado.inserts[0].params[2]).toBe(180);
    expect(estado.inserts[0].params[13]).toBeNull();
  });

  it('"vou pagar" (pendente) ignora data e valor pagos', async () => {
    const estado = mockLinha(null);
    await request(buildApp()).post('/companies/' + COMPANY + '/transactions')
      .send({ ...base, status: 'pending', paid_at: '2026-09-20', paid_amount: 186.4 });
    const ins = estado.inserts[0];
    expect(ins.params[2]).toBe(180);
    expect(ins.params[12]).toBeNull();
    expect(ins.params[13]).toBeNull();
    conferirParametros(ins.sql, ins.params);
  });

  it('recorrente: so a 1a ocorrencia leva a baixa, e todo parametro e citado', async () => {
    const estado = mockLinha(null);
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions')
      .send({ ...base, status: 'confirmed', paid_at: '2026-09-20', paid_amount: 186.4, recurrence_type: 'monthly', recurrence_count: 2 });
    expect(res.status).toBe(201);
    const [primeira, segunda] = estado.inserts;
    expect(primeira.params[2]).toBe(186.4);
    expect(primeira.params[16]).toBe(180);
    expect(segunda.params[2]).toBe(180);
    expect(segunda.params[7]).toBe('pending');
    expect(segunda.params[15]).toBeNull();
    expect(segunda.params[16]).toBeNull();
    conferirParametros(primeira.sql, primeira.params);
    conferirParametros(segunda.sql, segunda.params);
  });

  // 29/09/2026 (hotfix): em producao status e o enum transaction_status. Um
  // cast $8::text vira texto -> enum na coluna e o Postgres recusa (42804): o
  // cadastro inteiro dava 500. O status vai sem cast; "esta pago?" e booleano.
  it.each([
    ['avulso', {}],
    ['recorrente', { recurrence_type: 'monthly', recurrence_count: 2 }],
  ])('status vai sem cast e a baixa decide por booleano (%s)', async (_n, extra) => {
    const estado = mockLinha(null);
    await request(buildApp()).post('/companies/' + COMPANY + '/transactions')
      .send({ ...base, status: 'confirmed', paid_at: '2026-09-20', ...extra });
    for (const ins of estado.inserts) {
      expect(ins.sql).not.toMatch(/\$8::/);
      expect(ins.sql).toMatch(/CASE WHEN \$\d+::boolean THEN/);
      expect(ins.params[ins.params.length - 1]).toBe(ins.params[7] === 'confirmed');
      conferirParametros(ins.sql, ins.params);
    }
  });

  it('paid_at que nao e data e recusado', async () => {
    mockLinha(null);
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions').send({ ...base, paid_at: '20/09/2026' });
    expect(res.status).toBe(400);
  });
});
