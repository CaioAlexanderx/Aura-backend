// ============================================================
// AURA CRÉDITO — o saldo de pagamento parcial ficava órfão (24/08/2026)
//
// O BUG
//   applyPayment, ao receber menos que o recebível aberto, quita o original e
//   cria o saldo remanescente com a chave:
//       'pdv-credit-receivable-<saleId>-rest-<timestamp>'
//   Só que TODAS as consultas de crediário casavam o recebível com a venda por
//   igualdade exata:
//       JOIN sales s ON ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
//   A chave com sufixo NUNCA casa. O saldo virava invisível para o FIFO (nunca
//   quitava), para a renegociação e para o card "Crediário — A Receber" (caía
//   sem nome de cliente), enquanto seguia somando no "a receber" do Financeiro.
//
// A MEDIÇÃO que motivou o conserto (produção, 21/08/2026): dos 246 recebíveis
// de crediário pendentes, os 145 com '-rest-' tinham 0% de quitação contra 63%
// dos 276 normais. Nenhum era alcançado pelo join.
//
// Este arquivo cobre a SEMÂNTICA DO JOIN em Postgres real. O guarda-corpo
// estático (que impede a igualdade exata de voltar ao código) vive em
// credito.recebivelJoinGuard.test.js — separado de propósito, porque não
// precisa de banco e tem que rodar mesmo onde não há Postgres.
//
// Mesmo padrão de karate.currentBeltRankFix.test.js: conecta direto no
// Postgres, tudo dentro de UMA transação revertida no afterAll — zero resíduo.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

// Como as consultas casam recebível com venda.
const JOIN_ANTIGO = "('pdv-credit-receivable-' || s.id::text) = t.idempotency_key";
const JOIN_NOVO   = "t.idempotency_key LIKE 'pdv-credit-receivable-' || s.id::text || '%'";

let pool;
let client;

const userId     = uuid();
const companyId  = uuid();
const customerId = uuid();
const saleId     = uuid();

// As duas formas da chave: a da venda e a do saldo de pagamento parcial.
const keyOriginal = 'pdv-credit-receivable-' + saleId;
const keyResto    = keyOriginal + '-rest-' + Date.now();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Crediário')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name)
     VALUES ($1, $2, 'Fixture Loja Crediário')`,
    [companyId, userId]
  );
  await client.query(
    `INSERT INTO customers (id, company_id, name)
     VALUES ($1, $2, 'Maria Fixture')`,
    [customerId, companyId]
  );
  await client.query(
    `INSERT INTO sales (id, company_id, customer_id, total_amount)
     VALUES ($1, $2, $3, 100.00)`,
    [saleId, companyId, customerId]
  );

  // Recebível da venda (quitado) + saldo remanescente (o que ficava órfão).
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, idempotency_key)
     VALUES
       ($1,'income','confirmed', 60.00,'venda','Crediario - Recebido',  CURRENT_DATE, $2),
       ($1,'income','pending',   40.00,'saldo','Crediario - A Receber', CURRENT_DATE, $3)`,
    [companyId, keyOriginal, keyResto]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function achadosCom(joinExpr) {
  const { rows } = await client.query(
    `SELECT t.idempotency_key
       FROM transactions t
       JOIN sales s ON ${joinExpr}
      WHERE t.company_id = $1
        AND t.category ILIKE 'Crediario%A Receber%'
        AND t.status = 'pending'`,
    [companyId]
  );
  return rows.map((r) => r.idempotency_key);
}

describe('semântica do join recebível → venda', () => {
  test('o join ANTIGO perdia o saldo de pagamento parcial', async () => {
    // É a reprodução do bug: o saldo existe, está pendente, é da venda —
    // e mesmo assim não é encontrado.
    expect(await achadosCom(JOIN_ANTIGO)).toEqual([]);
  });

  test('o join NOVO encontra o saldo remanescente', async () => {
    expect(await achadosCom(JOIN_NOVO)).toEqual([keyResto]);
  });

  test('o join novo continua achando a chave original da venda', async () => {
    const { rows } = await client.query(
      `SELECT t.idempotency_key
         FROM transactions t
         JOIN sales s ON ${JOIN_NOVO}
        WHERE t.company_id = $1 AND t.idempotency_key = $2`,
      [companyId, keyOriginal]
    );
    expect(rows).toHaveLength(1);
  });

  test('o prefixo não vaza recebível de OUTRA venda', async () => {
    // UUID tem tamanho fixo, então um id nunca é prefixo de outro — mas o
    // teste trava a garantia, porque é dela que depende usar LIKE aqui.
    const outraSale = uuid();
    await client.query(
      `INSERT INTO sales (id, company_id, customer_id, total_amount)
       VALUES ($1, $2, $3, 50.00)`,
      [outraSale, companyId, customerId]
    );
    const { rows } = await client.query(
      `SELECT t.idempotency_key
         FROM transactions t
         JOIN sales s ON ${JOIN_NOVO}
        WHERE t.company_id = $1 AND s.id = $2`,
      [companyId, outraSale]
    );
    expect(rows).toEqual([]);
  });

  test('o cliente volta a ser nomeável a partir do saldo', async () => {
    // Era isto que fazia o card "Crediário — A Receber" mostrar uma linha sem
    // nome e ainda contar +1 em customers_open.
    const { rows } = await client.query(
      `SELECT c.name
         FROM transactions t
         JOIN sales s ON ${JOIN_NOVO}
         JOIN customers c ON c.id = s.customer_id
        WHERE t.idempotency_key = $1`,
      [keyResto]
    );
    expect(rows[0] && rows[0].name).toBe('Maria Fixture');
  });
});
