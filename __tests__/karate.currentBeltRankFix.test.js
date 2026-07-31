// ============================================================
// AURA KARATÊ — Regressão: karate_current_belt não pode perder faixa
// por causa de data (migration 229_karate_current_belt_rank_fix.sql).
//
// Contexto do bug (ver migration 229 pro relato completo): a view
// ordenava por graduated_at ANTES da hierarquia de faixa. O histórico
// importado tem milhares de eventos com data-sentinela ('1900-01-01',
// usada quando a data real da graduação não é conhecida) e também
// datas futuras inválidas (2028, 2201). Duas consequências:
//
//   1) Uma faixa maior com data-sentinela/desconhecida perdia para uma
//      faixa MENOR com data conhecida mais recente — faixa "regredia".
//   2) Dentro da faixa preta, o grau (dan) mora em belt_name ('Preta 1°'
//      ... 'Preta 7°'), não em belt_level (sempre 'preta' pra todo mundo).
//      Sem extrair o grau de belt_name, todas as pretas empatavam e o
//      desempate caía pra data — uma Preta 7° com data-sentinela perdia
//      pra uma Preta 3° de 2000 (caso real: Yasuyuki Sasaki, matrícula
//      1-Y-SHICHI).
//
// Este teste conecta DIRETO no Postgres real (bypassa o mock global de
// src/config/database — necessário pra exercitar a ORDER BY de verdade
// da view, algo que um mock de db.query não consegue cobrir). No CI, o
// job já sobe postgres:16 e aplica migrations/*.sql do zero antes de
// `npm test` (ver .github/workflows/ci.yml) — este teste roda contra
// esse schema real.
//
// F8.0 (31/07/2026): a ORDEM Roxa x Azul Claro que a 229 tinha invertida
// e corrigida pela migration 264, e o comportamento novo da view esta em
// __tests__/karate.beltDegreeAndOrder.test.js. Aqui a mudanca foi tirar o
// mapa de faixa DUPLICADO que este proprio arquivo mantinha (ver o teste
// de invariante abaixo).
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const beltScale = require('../src/utils/karateBeltScale');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;

// IDs fixos do fixture (gerados uma vez, usados em todo o arquivo)
const userId = uuid();
const federationId = uuid();
const studentAId = uuid(); // caso "Preta 7° x Preta 3°"
const studentBId = uuid(); // caso "azul_escuro não regride"

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();

  // Tudo dentro de UMA transação que é revertida no afterAll — o teste
  // não deixa nenhum resíduo no banco, mesmo se rodar mais de uma vez
  // contra o mesmo banco (ex.: uso local fora do CI efêmero).
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture Federação')`,
    [userId, `fixture-${userId}@example.test`]
  );

  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name)
     VALUES ($1, $2, 'Fixture Federação FPKT')`,
    [federationId, userId]
  );

  await client.query(
    `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Aluno Fixture A')`,
    [studentAId, federationId]
  );
  await client.query(
    `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Aluno Fixture B')`,
    [studentBId, federationId]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('karate_current_belt — faixa não regride por causa de data (migration 229)', () => {
  test('Preta 7° com data desconhecida (sentinela 1900) vence Preta 3° de 2000 — caso real Yasuyuki Sasaki', async () => {
    await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, graduated_at)
       VALUES
         ($1, $2, 'preta', 'Preta 3°', '2000-01-01'),
         ($1, $2, 'preta', 'Preta 7°', '1900-01-01')`,
      [studentAId, federationId]
    );

    const { rows } = await client.query(
      `SELECT belt_name FROM karate_current_belt WHERE student_id = $1 AND federation_id = $2`,
      [studentAId, federationId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].belt_name).toBe('Preta 7°');
    expect(rows[0].belt_name).not.toBe('Preta 3°');
  });

  test('azul_escuro (2015) não regride para verde (2020, data mais recente)', async () => {
    await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, graduated_at)
       VALUES
         ($1, $2, 'azul_escuro', 'Azul Escuro', '2015-06-01'),
         ($1, $2, 'verde', 'Verde', '2020-06-01')`,
      [studentBId, federationId]
    );

    const { rows } = await client.query(
      `SELECT belt_level, belt_name FROM karate_current_belt WHERE student_id = $1 AND federation_id = $2`,
      [studentBId, federationId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].belt_level).toBe('azul_escuro');
    expect(rows[0].belt_level).not.toBe('verde');
  });

  test('invariante: nenhum praticante do fixture exibe faixa menor que o máximo do próprio histórico', async () => {
    // F8.0 (31/07/2026): este teste mantinha o SEU PRÓPRIO mapa de faixa,
    // copiado da migration 229 — e com ele o mesmo bug (roxo=5,
    // azul_claro=6, invertidos). Um teste com a escala errada não protege
    // nada: ele CONGELA o erro. Agora usa a escala canônica, a mesma que a
    // migration 264 escreve no CASE da view.
    const rankOf = (level) => {
      const r = beltScale.levelRankOf(level);
      return r == null ? 0 : r;
    };

    const { rows } = await client.query(
      `SELECT student_id, belt_level FROM karate_belt_history WHERE federation_id = $1`,
      [federationId]
    );
    const maxRankByStudent = {};
    for (const r of rows) {
      const rank = rankOf(r.belt_level);
      maxRankByStudent[r.student_id] = Math.max(maxRankByStudent[r.student_id] || 0, rank);
    }

    const { rows: current } = await client.query(
      `SELECT student_id, belt_level FROM karate_current_belt WHERE federation_id = $1`,
      [federationId]
    );

    expect(current.length).toBeGreaterThan(0);
    for (const c of current) {
      const currentRank = rankOf(c.belt_level);
      expect(currentRank).toBeGreaterThanOrEqual(maxRankByStudent[c.student_id]);
    }
  });
});
