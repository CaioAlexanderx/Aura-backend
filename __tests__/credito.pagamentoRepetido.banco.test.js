// ============================================================
// AURA CRÉDITO — trava contra pagamento repetido: o SQL contra Postgres real
// (23/11/2026, caso Looks Da Jenny)
//
// O que este arquivo trava (a rota está em credito.pagamentoRepetido.test.js):
//   1. mesmo valor + mesmo dia de pagamento (retroativo) acha o igual
//   2. o dia é o de Brasília: 22h30 de 20/11 em SP (01h30 UTC de 21/11) é 20/11
//   3. outro dia, outro valor, outra cliente, outra loja: não acha
//   4. crédito de troca ('crediario_credito'), débito e devolução não contam
//   5. pagamento removido (undoPayment apaga a linha) não conta
//   6. Idempotency-Key já gravada = replay: nunca acusa repetido
//   7. sem paid_at, compara com hoje em Brasília
//
// Mesmo padrão dos *.banco.test.js: tudo dentro de UMA transação revertida
// no afterAll — zero resíduo.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let repetido;

const userId    = uuid();
const companyId = uuid();
const outraLoja = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  repetido = require('../src/services/credit/pagamentoRepetido');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Crediário')`,
    [userId, `fixture-${userId}@example.test`]
  );
  for (const [id, nome] of [[companyId, 'Fixture Loja Repetido'], [outraLoja, 'Fixture Outra Loja']]) {
    await client.query(
      `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, $3)`,
      [id, userId, nome]
    );
  }
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function cliente(nome, loja = companyId) {
  const id = uuid();
  await client.query(
    `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`,
    [id, loja, nome]
  );
  return id;
}

// Linha do razão com o instante explícito (ISO com fuso). `dia` = como o
// applyPayment grava o retroativo: meio-dia de Brasília.
async function lancar(customerId, amount, {
  type = 'payment', method = 'pix', loja = companyId, dia = null, instante = null, key = null,
} = {}) {
  const { rows } = await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, type, amount, payment_method, created_by, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             COALESCE($8::timestamptz, ($9::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo', NOW()))
     RETURNING id`,
    [loja, customerId, type, amount, method, userId, key, instante, dia]
  );
  return rows[0].id;
}

const achar = (customerId, amount, paidAt, extra = {}) =>
  repetido.acharPagamentoRepetido(client, { companyId, customerId, amount, paidAt, ...extra });

describe('acharPagamentoRepetido — Postgres real', () => {
  it('mesmo valor e mesmo dia de pagamento retroativo: acha', async () => {
    const c = await cliente('Cliente Jenny');
    await lancar(c, 150, { dia: '2026-11-20' });
    expect(await achar(c, 150, '2026-11-20')).toEqual({ data_pagamento: '2026-11-20', valor: 150 });
    expect(await achar(c, '150.00', '2026-11-20')).not.toBeNull();
  });

  it('o dia é o de Brasília, não o UTC', async () => {
    const c = await cliente('Cliente Fuso');
    // 22h30 de 20/11 em Brasília = 01h30 de 21/11 em UTC
    await lancar(c, 80, { instante: '2026-11-21T01:30:00Z' });
    expect(await achar(c, 80, '2026-11-20')).not.toBeNull();
    expect(await achar(c, 80, '2026-11-21')).toBeNull();
  });

  it('outro dia, outro valor, outra cliente, outra loja: não acha', async () => {
    const c = await cliente('Cliente Base');
    const outra = await cliente('Outra Cliente');
    const daOutraLoja = await cliente('Cliente Outra Loja', outraLoja);
    await lancar(c, 99.9, { dia: '2026-11-18' });
    await lancar(daOutraLoja, 99.9, { dia: '2026-11-18', loja: outraLoja });

    expect(await achar(c, 99.9, '2026-11-17')).toBeNull();
    expect(await achar(c, 99.91, '2026-11-18')).toBeNull();
    expect(await achar(outra, 99.9, '2026-11-18')).toBeNull();
    // a linha da outra loja não conta para esta loja
    expect(await achar(daOutraLoja, 99.9, '2026-11-18')).toBeNull();
  });

  it('crédito de troca, débito e devolução não contam como pagamento', async () => {
    const c = await cliente('Cliente Troca');
    await lancar(c, 60, { dia: '2026-11-19', method: 'crediario_credito' });
    await lancar(c, 60, { dia: '2026-11-19', type: 'debit', method: null });
    await lancar(c, 60, { dia: '2026-11-19', type: 'refund', method: 'crediario_credito' });
    expect(await achar(c, 60, '2026-11-19')).toBeNull();
  });

  it('pagamento sem forma (payment_method nulo) conta', async () => {
    const c = await cliente('Cliente Sem Forma');
    await lancar(c, 33, { dia: '2026-11-19', method: null });
    expect(await achar(c, 33, '2026-11-19')).not.toBeNull();
  });

  it('pagamento removido não conta', async () => {
    const c = await cliente('Cliente Removido');
    const id = await lancar(c, 45, { dia: '2026-11-16' });
    expect(await achar(c, 45, '2026-11-16')).not.toBeNull();
    await client.query(`DELETE FROM customer_credit_transactions WHERE id = $1`, [id]);
    expect(await achar(c, 45, '2026-11-16')).toBeNull();
  });

  it('Idempotency-Key já gravada é replay: nunca acusa repetido', async () => {
    const c = await cliente('Cliente Replay');
    const key = `rfp-${companyId}-${c}-teste`;
    await lancar(c, 70, { dia: '2026-11-15', key });
    expect(await achar(c, 70, '2026-11-15', { idempotencyKey: key })).toBeNull();
    // chave nova (outro pedido) com o mesmo valor e dia: acusa
    expect(await achar(c, 70, '2026-11-15', { idempotencyKey: key + '-outra' })).not.toBeNull();
  });

  it('sem paid_at compara com hoje em Brasília', async () => {
    const c = await cliente('Cliente Hoje');
    await lancar(c, 25); // NOW()
    const hoje = repetido.hojeEmBrasilia();
    expect(await achar(c, 25, null)).toEqual({ data_pagamento: hoje, valor: 25 });
  });
});
