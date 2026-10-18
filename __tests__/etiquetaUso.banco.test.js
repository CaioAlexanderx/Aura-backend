// ============================================================
// AURA. Etiquetas, registro de uso da impressão (migration 397) — Postgres real
//
// Prova o que o teste de rota (tests/routes/etiquetaUso.test.js, banco de
// mentira) não prova:
//   1. a migration 397 cria label_print_days e o upsert soma na MESMA linha
//      (empresa, dia de Brasília): 3 aberturas = prints 3, labels somadas
//   2. empresas diferentes ficam em linhas diferentes
//   3. o bloco "Uso por funcionalidade" lê essa tabela de verdade: a soma de
//      `prints` vira os eventos de Etiquetas, e a loja que não imprimiu não
//      aparece
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
const userId = uuid();
const lojaA = uuid();
const lojaB = uuid();
const lojaC = uuid();

const esperar = async (cond, ms = 3000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Etiqueta')`,
    [userId, `fixture-${userId}@example.test`]
  );
  for (const id of [lojaA, lojaB, lojaC]) {
    await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Etiqueta')`, [id, userId]);
  }
});

afterAll(async () => {
  if (!pool) return;
  for (const [sql, params] of [
    [`DELETE FROM label_print_days WHERE company_id = ANY($1)`, [[lojaA, lojaB, lojaC]]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [[lojaA, lojaB, lojaC]]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ]) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI e descartavel */ }
  }
  await pool.end();
});

test('upsert: aberturas no mesmo dia somam na mesma linha, por empresa', async () => {
  const { registrarImpressao } = require('../src/services/etiquetaUso');
  registrarImpressao(pool, { companyId: lojaA, qty: 4 });
  registrarImpressao(pool, { companyId: lojaA, qty: 10 });
  registrarImpressao(pool, { companyId: lojaA, qty: 1 });
  registrarImpressao(pool, { companyId: lojaB, qty: 2 });

  const ok = await esperar(async () => {
    const { rows } = await pool.query(`SELECT COALESCE(SUM(prints), 0)::int AS n FROM label_print_days WHERE company_id = ANY($1)`, [[lojaA, lojaB]]);
    return rows[0].n === 4;
  });
  expect(ok).toBe(true);

  const { rows } = await pool.query(
    `SELECT company_id, prints, labels, dia = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje_brt
       FROM label_print_days WHERE company_id = ANY($1) ORDER BY prints DESC`,
    [[lojaA, lojaB]]
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ company_id: lojaA, prints: 3, labels: 15, hoje_brt: true });
  expect(rows[1]).toMatchObject({ company_id: lojaB, prints: 1, labels: 2, hoje_brt: true });
});

test('o painel soma prints: Etiquetas aparece só para quem imprimiu', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {}); // fontes de outros módulos ausentes no schema de teste
  const { usoPorModulo } = require('../src/services/painelBlocos/_uso');
  const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
  const uso = await usoPorModulo({ db: pool, hoje, periodo: 30 });
  const etiquetas = uso.find((m) => m.id === 'etiquetas');
  expect(etiquetas.sem_dado).toBe(false);
  expect(etiquetas.lojas.get(lojaA)).toMatchObject({ e7: 3, ep: 3, total: 3 });
  expect(etiquetas.lojas.get(lojaB)).toMatchObject({ ep: 1 });
  expect(etiquetas.lojas.has(lojaC)).toBe(false);
});

test('a linha some junto com a empresa (ON DELETE CASCADE)', async () => {
  const { registrarImpressao } = require('../src/services/etiquetaUso');
  registrarImpressao(pool, { companyId: lojaC, qty: 1 });
  expect(await esperar(async () => (await pool.query(`SELECT 1 FROM label_print_days WHERE company_id = $1`, [lojaC])).rowCount === 1)).toBe(true);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [lojaC]);
  const { rowCount } = await pool.query(`SELECT 1 FROM label_print_days WHERE company_id = $1`, [lojaC]);
  expect(rowCount).toBe(0);
});
