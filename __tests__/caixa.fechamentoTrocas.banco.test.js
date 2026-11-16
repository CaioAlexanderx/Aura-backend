// ============================================================
// AURA. — Caixa: trocas e devoluções no fechamento — Postgres real
//
// O fechar() devolve `trocas` e `trocas_resumo` para o relatório e a tela
// explicarem por que "Vendas do período" e "Entradas no caixa" diferem.
// Aqui as consultas rodam contra o schema de verdade (as migrations do CI):
//   1. troca com diferença paga no débito (row negativa da trocaV2 fica de
//      fora do "recebido"), com o rótulo da variante como no cupom
//   2. devolução sem peça levada, com payout em dinheiro e crédito na
//      carteira separados
//   3. troca cancelada e troca de outra sessão não entram
//
// Mesmo padrão de caixa.movimentos.banco.test.js: tudo dentro de UMA
// transação revertida no afterAll.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let caixaService;

const userId = uuid();
const companyId = uuid();
const productId = uuid();
const variantId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));
  caixaService = require('../src/services/caixaService');
  caixaService._resetCache();

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Caixa')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, pdv_settings)
     VALUES ($1, $2, 'Fixture Loja', '{"caixa_enabled": true}'::jsonb)`,
    [companyId, userId]
  );
  await client.query(`INSERT INTO products (id, company_id, name, price) VALUES ($1, $2, 'Blusa casual', 119.90)`, [productId, companyId]);
  await client.query(`INSERT INTO product_variants (id, product_id, sku_suffix) VALUES ($1, $2, 'BRANCA-P')`, [variantId, productId]);
  await client.query(
    `INSERT INTO product_variant_values (variant_id, attribute_name, value)
     VALUES ($1, 'Cor', 'Branca'), ($1, 'Tamanho', 'P')`,
    [variantId]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function venda(sql, params) {
  const { rows } = await client.query(sql, params);
  return rows[0].id;
}

test('fechar devolve as trocas da sessão com a conta de cada uma', async () => {
  const sessao = await caixaService.abrir(companyId, userId, 0);
  const outraSessao = uuid();
  await client.query(
    `INSERT INTO caixa_sessoes (id, company_id, opened_by, troco_inicial, status, opened_at, closed_at)
     VALUES ($1, $2, $3, 0, 'fechada', NOW() - interval '2 days', NOW() - interval '1 day')`,
    [outraSessao, companyId, userId]
  );

  const original = await venda(
    `INSERT INTO sales (company_id, total_amount, payment_method) VALUES ($1, 389.70, 'pix') RETURNING id`,
    [companyId]
  );

  // 1. troca com diferença paga: devolveu 139,90; levou 79,90 + 119,90.
  const troca = await venda(
    `INSERT INTO sales (company_id, total_amount, payment_method, status, type, exchange_of_sale_id)
     VALUES ($1, 199.80, 'debito', 'completed', 'troca', $2) RETURNING id`,
    [companyId, original]
  );
  await client.query(
    `INSERT INTO sale_items (sale_id, product_id, variant_id, quantity, unit_price, total_price, product_name_snapshot)
     VALUES ($1, NULL, NULL, 1, 79.90, 79.90, 'Blusa com strass'),
            ($1, $2, $3, 1, 119.90, 119.90, 'Blusa casual')`,
    [troca, productId, variantId]
  );
  await client.query(
    `INSERT INTO troca_returned_items (troca_sale_id, original_sale_id, quantity, unit_price, product_name_snapshot)
     VALUES ($1, $2, 1, 139.90, 'Conjunto de linho (Azul · M)')`,
    [troca, original]
  );
  await client.query(
    `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
     VALUES ($1, $2, 'debito', -139.90, $3), ($1, $2, 'debito', 59.90, $3)`,
    [troca, companyId, sessao.id]
  );

  // 2. devolução sem levar peça: 50 em dinheiro + 19,90 na carteira.
  const devolucao = await venda(
    `INSERT INTO sales (company_id, total_amount, payment_method, status, type, exchange_of_sale_id)
     VALUES ($1, 0, 'dinheiro', 'completed', 'troca', $2) RETURNING id`,
    [companyId, original]
  );
  await client.query(
    `INSERT INTO troca_returned_items (troca_sale_id, original_sale_id, quantity, unit_price, product_name_snapshot)
     VALUES ($1, $2, 1, 69.90, 'Short jeans (42)')`,
    [devolucao, original]
  );
  await client.query(
    `INSERT INTO troca_payouts (troca_sale_id, company_id, method, amount, sessao_id)
     VALUES ($1, $2, 'dinheiro', 50, $3), ($1, $2, 'crediario_credito', 19.90, $3)`,
    [devolucao, companyId, sessao.id]
  );

  // 3. troca cancelada desta sessão e troca de outra sessão: ficam de fora.
  const cancelada = await venda(
    `INSERT INTO sales (company_id, total_amount, payment_method, status, type, exchange_of_sale_id)
     VALUES ($1, 10, 'pix', 'cancelled', 'troca', $2) RETURNING id`,
    [companyId, original]
  );
  const deOntem = await venda(
    `INSERT INTO sales (company_id, total_amount, payment_method, status, type, exchange_of_sale_id)
     VALUES ($1, 10, 'pix', 'completed', 'troca', $2) RETURNING id`,
    [companyId, original]
  );
  await client.query(
    `INSERT INTO sale_payments (sale_id, company_id, method, amount, sessao_id)
     VALUES ($1, $2, 'pix', 10, $3), ($4, $2, 'pix', 10, $5)`,
    [cancelada, companyId, sessao.id, deOntem, outraSessao]
  );

  const f = await caixaService.fechar(companyId, userId, 0, null);

  expect(f.trocas.map((t) => t.id).sort()).toEqual([troca, devolucao].sort());
  const t1 = f.trocas.find((t) => t.id === troca);
  expect(t1).toMatchObject({
    tipo: 'troca',
    devolvidos: [{ product_name_snapshot: 'Conjunto de linho (Azul · M)', quantity: 1, unit_price: 139.9 }],
    recebido: { total: 59.9, metodos: [{ method: 'debito', amount: 59.9 }] },
    devolvido_cliente: { total: 0, metodos: [] },
    credito_carteira: 0,
  });
  expect(t1.levados.map((l) => l.product_name).sort()).toEqual(['Blusa casual (Branca · P)', 'Blusa com strass']);

  const t2 = f.trocas.find((t) => t.id === devolucao);
  expect(t2).toMatchObject({
    tipo: 'devolucao',
    levados: [],
    recebido: { total: 0, metodos: [] },
    devolvido_cliente: { total: 50, metodos: [{ method: 'dinheiro', amount: 50 }] },
    credito_carteira: 19.9,
  });

  expect(f.trocas_resumo).toEqual({
    quantidade: 2,
    pecas_devolvidas: 209.8,
    pecas_levadas: 199.8,
    diferenca_recebida: 59.9,
    devolvido_cliente: 50,
  });
});
