// ============================================================
// AURA. — Resultado do período (p-81) — Postgres real
//
// Loja A, novembro de 2026:
//   V1  03/11  total 180 (desconto de 20 na venda): Vestido 2 × 50 com custo 20
//       e Meia 1 × 100 com custo 0 → rateio 90 / 90
//   V2  05/11  cancelada (500, com custo) → fora
//   V3  31/10 23h30 em São Paulo (já é 01/11 em UTC) → fora de novembro
//   V4  30/11 23h30 em São Paulo (já é 01/12 em UTC) → dentro; custo vazio
//   T1  troca (type 'troca', 300 com custo) → fora da venda e do CMV
//   Lançamentos: Troca - Venda 150, Troca - Devolucao 100, devolucao 30,
//   Devolução 5 (as duas contam como Troca - Devolucao), Fornecedores 800,
//   Aluguel 300, Taxas de cartão 20, uma despesa pendente (fora) e
//   Fornecedores de dezembro (fora). O income 'Vendas' não entra: o
//   faturamento vem da venda.
// Loja B (mesmo dono): venda 50 com custo 10; despesa Outros 70.
//
// Tudo numa transação revertida no afterAll (padrão dos *.banco).
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const R = require('../src/services/resultadoDoPeriodo');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;

const dono = uuid();
const A = uuid();
const B = uuid();
const P1 = uuid();
const P2 = uuid();
const PB = uuid();

async function venda(empresa, { total, quando, status = 'completed', type = 'sale', itens }) {
  const id = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, total_amount, payment_method, status, type, created_at)
     VALUES ($1, $2, $3, 'pix', $4, $5, $6::timestamptz)`,
    [id, empresa, total, status, type, quando]
  );
  for (const it of itens) {
    await client.query(
      `INSERT INTO sale_items (id, sale_id, product_id, quantity, unit_price, unit_cost, total_price, product_name_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [uuid(), id, it.produto, it.qtd, it.preco, it.custo, it.qtd * it.preco, it.nome]
    );
  }
  return id;
}

async function lancamento(empresa, type, category, amount, due, status = 'confirmed') {
  await client.query(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date)`,
    [empresa, type, status, amount, category, category, due]
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dona Fixture')`,
    [dono, `resultado-${dono.slice(0, 8)}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary)
     VALUES ($1, $3, 'A LTDA', 'Loja A', true), ($2, $3, 'B LTDA', 'Loja B', false)`,
    [A, B, dono]
  );
  await client.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty, is_active) VALUES
       ($1, $4, 'Vestido', 50, 10, true), ($2, $4, 'Meia', 100, 10, true), ($3, $5, 'Bolsa', 50, 10, true)`,
    [P1, P2, PB, A, B]
  );

  await venda(A, { total: 180, quando: '2026-11-03T14:00:00-03:00', itens: [
    { produto: P1, qtd: 2, preco: 50, custo: 20, nome: 'Vestido' },
    { produto: P2, qtd: 1, preco: 100, custo: 0, nome: 'Meia' },
  ] });
  await venda(A, { total: 500, quando: '2026-11-05T10:00:00-03:00', status: 'cancelled', itens: [
    { produto: P1, qtd: 10, preco: 50, custo: 20, nome: 'Vestido' },
  ] });
  await venda(A, { total: 999, quando: '2026-10-31T23:30:00-03:00', itens: [
    { produto: P1, qtd: 1, preco: 999, custo: 20, nome: 'Vestido' },
  ] });
  await venda(A, { total: 60, quando: '2026-11-30T23:30:00-03:00', itens: [
    { produto: P1, qtd: 1, preco: 60, custo: null, nome: 'Vestido' },
  ] });
  await venda(A, { total: 300, quando: '2026-11-10T10:00:00-03:00', type: 'troca', itens: [
    { produto: P1, qtd: 1, preco: 300, custo: 20, nome: 'Vestido' },
  ] });

  await lancamento(A, 'income', 'Vendas', 180, '2026-11-03');
  await lancamento(A, 'income', 'Troca - Venda', 150, '2026-11-10');
  await lancamento(A, 'expense', 'Troca - Devolucao', 100, '2026-11-10');
  await lancamento(A, 'expense', 'devolucao', 30, '2026-11-11');
  await lancamento(A, 'expense', 'Devolução', 5, '2026-11-11');
  await lancamento(A, 'expense', 'Fornecedores', 800, '2026-11-12');
  await lancamento(A, 'expense', 'Aluguel', 300, '2026-11-05');
  await lancamento(A, 'expense', 'Taxas de cartão', 20, '2026-11-30');
  await lancamento(A, 'expense', 'Aluguel', 999, '2026-11-20', 'pending');
  await lancamento(A, 'expense', 'Fornecedores', 777, '2026-12-01');

  await venda(B, { total: 50, quando: '2026-11-15T12:00:00-03:00', itens: [
    { produto: PB, qtd: 1, preco: 50, custo: 10, nome: 'Bolsa' },
  ] });
  await lancamento(B, 'expense', 'Outros', 70, '2026-11-15');
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const NOV = { de: '2026-11-01', ate: '2026-11-30' };

describe('resultadoDoPeriodo — banco real', () => {
  test('loja A: troca líquida, item sem custo, fornecedores fora, limites do dia em São Paulo', async () => {
    const r = await R.resultadoDoPeriodo({ empresas: [A], ...NOV, client });
    expect(r.vendas).toBe(240);
    expect(r.vendas_qtd).toBe(2);
    expect(r.trocas).toEqual({ entrou: 150, devolvido: 135 });
    expect(r.faturamento).toBe(255);
    expect(r.receita_com_custo).toBe(90);
    expect(r.custos).toBe(40);
    expect(r.lucro_bruto).toBe(50);
    expect(r.margem_pct).toBe(55.6);
    expect(r.cobertura).toMatchObject({ pct: 38, receita_sem_custo: 150, itens: 3, itens_com_custo: 1, produtos_sem_custo: 2 });
    expect(r.despesas).toBe(320);
    expect(r.compras_pagas).toEqual({ total: 800, lancamentos: 1 });
    expect(r.produtos_sem_custo.map((p) => [p.nome, p.receita])).toEqual([['Meia', 90], ['Vestido', 60]]);
    expect(r.consolidado).toBe(false);
  });

  test('outubro pega a venda das 23h30 de 31/10', async () => {
    const r = await R.resultadoDoPeriodo({ empresas: [A], de: '2026-10-01', ate: '2026-10-31', client });
    expect(r.vendas).toBe(999);
    expect(r.custos).toBe(20);
  });

  test('consolidado A + B soma as lojas e traz cada uma', async () => {
    const r = await R.resultadoDoPeriodo({ empresas: [{ id: A, nome: 'Loja A' }, { id: B, nome: 'Loja B' }], ...NOV, client });
    expect(r.consolidado).toBe(true);
    expect(r.faturamento).toBe(305);
    expect(r.custos).toBe(50);
    expect(r.lucro_bruto).toBe(90);
    expect(r.despesas).toBe(390);
    expect(r.compras_pagas.total).toBe(800);
    expect(r.cobertura.pct).toBe(48);
    expect(r.cobertura.lojas_com_pouco_custo).toBe(1);
    expect(r.por_empresa.map((e) => [e.nome, e.faturamento, e.lucro_bruto])).toEqual([['Loja A', 255, 50], ['Loja B', 50, 40]]);
  });

  test('loja sem nada no período: zeros e lucro null', async () => {
    const r = await R.resultadoDoPeriodo({ empresas: [B], de: '2026-01-01', ate: '2026-01-31', client });
    expect(r.faturamento).toBe(0);
    expect(r.lucro_bruto).toBeNull();
    expect(r.cobertura.pct).toBeNull();
    expect(r.produtos_sem_custo).toEqual([]);
  });
});
