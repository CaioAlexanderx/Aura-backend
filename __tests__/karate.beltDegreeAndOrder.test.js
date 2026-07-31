// ============================================================
// AURA KARATÊ — F8.0 (migration 264) contra Postgres de verdade
//
// Cobre o que um mock de db.query não consegue cobrir:
//   1. A ORDEM CORRIGIDA da view karate_current_belt — o caso
//      Roxa (5º kyu) × Azul Claro (6º kyu), que a migration 229 tinha
//      invertido. Medido em produção em 31/07/2026: 32 praticantes têm as
//      duas faixas; os 3 casos limpos (ambas em fpkt_shotokan, com data
//      real, sem a sentinela '1900-01-01') têm Roxa DEPOIS de Azul Claro.
//   2. A escala completa: quem tem TODAS as cores no histórico aparece
//      com a mais alta, mesmo quando a data empurraria para a mais baixa.
//   3. O GRAU extraído dos formatos reais ("Preta 1°", "Marrom 3°kyu",
//      "Marrom" sem grau), pelas funções SQL da 264 — as mesmas que o
//      backfill usa.
//   4. A view NÃO PERDE NINGUÉM com grau NULL.
//   5. A fronteira do sensei gravada no schema: o resultado de exame do
//      dojô recusa faixa preta.
//   6. Aluno NÃO FEDERADO (sem practitioner_id) é graduado assim mesmo.
//
// Mesmo padrão de karate.currentBeltRankFix.test.js: conecta DIRETO no
// Postgres (bypassa o mock global de src/config/database), tudo dentro de
// UMA transação revertida no afterAll — zero resíduo. No CI o job sobe
// postgres:16 e aplica migrations/*.sql do zero antes de `npm test`.
//
// ATENÇÃO: toda asserção de FALHA esperada (violação de CHECK) roda dentro
// de SAVEPOINT + ROLLBACK TO. Sem isso o primeiro erro envenenaria a
// transação e derrubaria todos os testes seguintes com
// "current transaction is aborted".
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

const userId = uuid();
const federationId = uuid();
const dojoId = uuid();
const stRoxa = uuid(); // Roxa × Azul Claro
const stEscada = uuid(); // escada completa
const stMarrom = uuid(); // marrom sem grau
const stMarromGrau = uuid(); // marrom 1º kyu × 3º kyu
const dojoStudentFederado = uuid();
const dojoStudentSemFederacao = uuid();

// Roda um bloco que DEVE falhar, isolado num SAVEPOINT.
async function expectFailure(sql, params) {
  await client.query('SAVEPOINT sp_expect_failure');
  let erro = null;
  try {
    await client.query(sql, params);
  } catch (e) {
    erro = e;
  }
  await client.query('ROLLBACK TO SAVEPOINT sp_expect_failure');
  return erro;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name)
     VALUES ($1, $2, 'x', 'Fixture F8.0')`,
    [userId, `fixture-f80-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Federação F8.0')`,
    [federationId, userId]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Dojô F8.0')`,
    [dojoId, userId]
  );

  for (const [id, nome] of [
    [stRoxa, 'Fixture Roxa x Azul Claro'],
    [stEscada, 'Fixture Escada Completa'],
    [stMarrom, 'Fixture Marrom sem grau'],
    [stMarromGrau, 'Fixture Marrom com grau'],
  ]) {
    await client.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, $3)`, [
      id,
      federationId,
      nome,
    ]);
  }

  await client.query(
    `INSERT INTO karate_dojo_students (id, dojo_id, full_name, practitioner_id)
     VALUES ($1, $2, 'Aluno Federado', $3)`,
    [dojoStudentFederado, dojoId, stRoxa]
  );
  await client.query(
    `INSERT INTO karate_dojo_students (id, dojo_id, full_name, practitioner_id)
     VALUES ($1, $2, 'Aluno NAO Federado', NULL)`,
    [dojoStudentSemFederacao, dojoId]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('264 — funções de dedução de grau sobre os formatos reais do banco', () => {
  test('"Preta 1°" … "Preta 7°" viram dan (895 linhas em produção)', async () => {
    const { rows } = await client.query(
      `SELECT karate_belt_dan_from_name('preta', 'Preta 1°') AS d1,
              karate_belt_dan_from_name('preta', 'Preta 3°') AS d3,
              karate_belt_dan_from_name('preta', 'Preta 7°') AS d7`
    );
    expect(Number(rows[0].d1)).toBe(1);
    expect(Number(rows[0].d3)).toBe(3);
    expect(Number(rows[0].d7)).toBe(7);
  });

  test('"Marrom 3°kyu" / "2°kyu" / "1°kyu" viram kyu (17 linhas em produção)', async () => {
    const { rows } = await client.query(
      `SELECT karate_belt_kyu_from_name('marrom', 'Marrom 3°kyu', 'fpkt_shotokan') AS k3,
              karate_belt_kyu_from_name('marrom', 'Marrom 2°kyu', 'fpkt_shotokan') AS k2,
              karate_belt_kyu_from_name('marrom', 'Marrom 1°kyu', 'fpkt_shotokan') AS k1,
              karate_belt_kyu_from_name('marrom', 'Marrom 3°kyu', 'legacy')        AS k3_legacy`
    );
    expect(Number(rows[0].k3)).toBe(3);
    expect(Number(rows[0].k2)).toBe(2);
    expect(Number(rows[0].k1)).toBe(1);
    // grau ESCRITO no nome é fato, vale nas duas escalas
    expect(Number(rows[0].k3_legacy)).toBe(3);
  });

  test('"Marrom" sem grau fica NULL — as 762 linhas que NÃO podem ser adivinhadas', async () => {
    const { rows } = await client.query(
      `SELECT karate_belt_kyu_from_name('marrom', 'Marrom', 'fpkt_shotokan') AS k,
              karate_belt_dan_from_name('marrom', 'Marrom') AS d`
    );
    expect(rows[0].k).toBeNull();
    expect(rows[0].d).toBeNull();
  });

  test('cor de kyu único deduz o kyu da escala oficial — e só em fpkt_shotokan', async () => {
    const { rows } = await client.query(
      `SELECT karate_belt_kyu_from_name('branca',      'Branca',      'fpkt_shotokan') AS branca,
              karate_belt_kyu_from_name('amarela',     'Amarela',     'fpkt_shotokan') AS amarela,
              karate_belt_kyu_from_name('laranja',     'Laranja',     'fpkt_shotokan') AS laranja,
              karate_belt_kyu_from_name('verde',       'Verde',       'fpkt_shotokan') AS verde,
              karate_belt_kyu_from_name('azul_claro',  'Azul Claro',  'fpkt_shotokan') AS azul_claro,
              karate_belt_kyu_from_name('roxo',        'Roxa',        'fpkt_shotokan') AS roxo,
              karate_belt_kyu_from_name('azul_escuro', 'Azul Escuro', 'fpkt_shotokan') AS azul_escuro,
              karate_belt_kyu_from_name('roxo',        'Roxa',        'legacy')        AS roxo_legacy,
              karate_belt_kyu_from_name('vermelha',    'Vermelha',    'legacy')        AS vermelha_legacy,
              karate_belt_kyu_from_name('preta',       'Preta 1°',    'fpkt_shotokan') AS preta`
    );
    const r = rows[0];
    expect(Number(r.branca)).toBe(10);
    expect(Number(r.amarela)).toBe(9);
    expect(Number(r.laranja)).toBe(8);
    expect(Number(r.verde)).toBe(7);
    expect(Number(r.azul_claro)).toBe(6);
    expect(Number(r.roxo)).toBe(5);
    expect(Number(r.azul_escuro)).toBe(4);
    expect(r.roxo_legacy).toBeNull(); // escala legada não deduz kyu por cor
    expect(r.vermelha_legacy).toBeNull();
    expect(r.preta).toBeNull(); // preta nunca tem kyu
  });

  test('SQL e JS respondem a MESMA coisa sobre a mesma linha', async () => {
    const casos = [
      ['preta', 'Preta 1°', 'fpkt_shotokan'],
      ['preta', 'Preta 7°', 'fpkt_shotokan'],
      ['marrom', 'Marrom 3°kyu', 'fpkt_shotokan'],
      ['marrom', 'Marrom', 'fpkt_shotokan'],
      ['azul_claro', 'Azul Claro', 'fpkt_shotokan'],
      ['roxo', 'Roxa', 'fpkt_shotokan'],
      ['roxo', 'Roxa', 'legacy'],
      ['vermelha', 'Vermelha', 'legacy'],
    ];
    for (const [level, name, schema] of casos) {
      const { rows } = await client.query(
        `SELECT karate_belt_kyu_from_name($1, $2, $3) AS kyu,
                karate_belt_dan_from_name($1, $2)     AS dan`,
        [level, name, schema]
      );
      const sql = {
        kyu: rows[0].kyu == null ? null : Number(rows[0].kyu),
        dan: rows[0].dan == null ? null : Number(rows[0].dan),
      };
      const js = beltScale.resolveDegree(level, name, schema);
      expect(sql).toEqual({ kyu: js.kyu, dan: js.dan });
    }
  });
});

describe('264 — a ordem corrigida em karate_current_belt', () => {
  test('Roxa (5º kyu) vence Azul Claro (6º kyu) mesmo com Azul Claro mais recente', async () => {
    await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_kyu)
       VALUES
         ($1, $2, 'roxo',       'Roxa',       'fpkt_shotokan', '2019-03-01', 5),
         ($1, $2, 'azul_claro', 'Azul Claro', 'fpkt_shotokan', '2021-08-01', 6)`,
      [stRoxa, federationId]
    );

    const { rows } = await client.query(
      `SELECT belt_level, belt_name, belt_kyu FROM karate_current_belt
        WHERE student_id = $1 AND federation_id = $2`,
      [stRoxa, federationId]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].belt_level).toBe('roxo');
    expect(rows[0].belt_level).not.toBe('azul_claro'); // era isto que a 229 devolvia
    expect(Number(rows[0].belt_kyu)).toBe(5);
  });

  test('a escada inteira: com todas as cores no histórico, a view devolve a mais alta', async () => {
    // Datas DECRESCENTES conforme a faixa SOBE: se a view olhasse a data
    // antes da hierarquia, ela devolveria a Branca.
    const escada = [
      ['branca', 'Branca', 10, '2024-01-01'],
      ['amarela', 'Amarela', 9, '2023-01-01'],
      ['laranja', 'Laranja', 8, '2022-01-01'],
      ['verde', 'Verde', 7, '2021-01-01'],
      ['azul_claro', 'Azul Claro', 6, '2020-01-01'],
      ['roxo', 'Roxa', 5, '2019-01-01'],
      ['azul_escuro', 'Azul Escuro', 4, '2018-01-01'],
      ['marrom', 'Marrom 3°kyu', 3, '2017-01-01'],
      ['marrom', 'Marrom 2°kyu', 2, '2016-01-01'],
      ['marrom', 'Marrom 1°kyu', 1, '2015-01-01'],
    ];
    for (const [level, name, kyu, data] of escada) {
      await client.query(
        `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_kyu)
         VALUES ($1, $2, $3, $4, 'fpkt_shotokan', $5::date, $6)`,
        [stEscada, federationId, level, name, data, kyu]
      );
    }

    const antes = await client.query(
      `SELECT belt_level, belt_name, belt_kyu FROM karate_current_belt
        WHERE student_id = $1 AND federation_id = $2`,
      [stEscada, federationId]
    );
    expect(antes.rows[0].belt_level).toBe('marrom');
    expect(Number(antes.rows[0].belt_kyu)).toBe(1); // 1º kyu, não 3º
    expect(antes.rows[0].belt_name).toBe('Marrom 1°kyu');

    // e a preta, com a data mais antiga de todas, ainda ganha de tudo
    await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_dan)
       VALUES ($1, $2, 'preta', 'Preta 2°', 'fpkt_shotokan', '1900-01-01', 2)`,
      [stEscada, federationId]
    );
    const depois = await client.query(
      `SELECT belt_level, belt_name, belt_dan FROM karate_current_belt
        WHERE student_id = $1 AND federation_id = $2`,
      [stEscada, federationId]
    );
    expect(depois.rows[0].belt_level).toBe('preta');
    expect(Number(depois.rows[0].belt_dan)).toBe(2);
  });

  test('a ordem da view é exatamente a ordem canônica do módulo JS', async () => {
    const { rows } = await client.query(
      `SELECT belt_level, belt_kyu FROM karate_current_belt
        WHERE federation_id = $1 AND student_id = ANY($2::uuid[])`,
      [federationId, [stRoxa, stEscada]]
    );
    for (const r of rows) {
      expect(beltScale.levelRankOf(r.belt_level)).not.toBeNull();
    }
    // Azul Claro tem que estar ABAIXO de Roxa nos dois lados
    expect(beltScale.levelRankOf('azul_claro')).toBeLessThan(beltScale.levelRankOf('roxo'));
  });
});

describe('264 — grau NULL não faz ninguém sumir', () => {
  test('praticante só com "Marrom" sem grau continua na view, com belt_kyu NULL', async () => {
    await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at)
       VALUES ($1, $2, 'marrom', 'Marrom', 'fpkt_shotokan', '2020-05-05')`,
      [stMarrom, federationId]
    );

    const { rows } = await client.query(
      `SELECT belt_level, belt_kyu, belt_dan FROM karate_current_belt
        WHERE student_id = $1 AND federation_id = $2`,
      [stMarrom, federationId]
    );

    expect(rows).toHaveLength(1); // NÃO sumiu
    expect(rows[0].belt_level).toBe('marrom');
    expect(rows[0].belt_kyu).toBeNull(); // grau DESCONHECIDO, não inventado
    expect(rows[0].belt_dan).toBeNull();
  });

  test('"Marrom 1°kyu" vence "Marrom" sem grau — desconhecido nunca promove', async () => {
    await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_kyu)
       VALUES
         ($1, $2, 'marrom', 'Marrom',      'fpkt_shotokan', '2024-01-01', NULL),
         ($1, $2, 'marrom', 'Marrom 1°kyu','fpkt_shotokan', '2010-01-01', 1)`,
      [stMarromGrau, federationId]
    );

    const { rows } = await client.query(
      `SELECT belt_name, belt_kyu FROM karate_current_belt
        WHERE student_id = $1 AND federation_id = $2`,
      [stMarromGrau, federationId]
    );
    expect(rows[0].belt_name).toBe('Marrom 1°kyu');
    expect(Number(rows[0].belt_kyu)).toBe(1);
  });

  test('todo praticante com histórico aparece exatamente uma vez na view', async () => {
    const { rows: hist } = await client.query(
      `SELECT DISTINCT student_id FROM karate_belt_history WHERE federation_id = $1`,
      [federationId]
    );
    const { rows: atual } = await client.query(
      `SELECT student_id FROM karate_current_belt WHERE federation_id = $1`,
      [federationId]
    );
    expect(atual.length).toBe(hist.length);
    expect(new Set(atual.map((r) => r.student_id)).size).toBe(hist.length);
  });
});

describe('264 — CHECKs de grau em karate_belt_history', () => {
  test('dan só existe em faixa preta', async () => {
    const erro = await expectFailure(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_dan)
       VALUES ($1, $2, 'marrom', 'Marrom', 'fpkt_shotokan', '2020-01-01', 2)`,
      [stMarrom, federationId]
    );
    expect(erro).not.toBeNull();
    expect(erro.code).toBe('23514');
  });

  test('kyu e dan são mutuamente exclusivos', async () => {
    const erro = await expectFailure(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_kyu, belt_dan)
       VALUES ($1, $2, 'preta', 'Preta 1°', 'fpkt_shotokan', '2020-01-01', 1, 1)`,
      [stMarrom, federationId]
    );
    expect(erro).not.toBeNull();
    expect(erro.code).toBe('23514');
  });

  test('kyu fora de 1..10 é recusado', async () => {
    const erro = await expectFailure(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_kyu)
       VALUES ($1, $2, 'marrom', 'Marrom', 'fpkt_shotokan', '2020-01-01', 11)`,
      [stMarrom, federationId]
    );
    expect(erro).not.toBeNull();
    expect(erro.code).toBe('23514');
  });
});

describe('264 — graduação do dojô: a fronteira do sensei mora no schema', () => {
  let examId;

  beforeAll(async () => {
    examId = uuid();
    await client.query(
      `INSERT INTO karate_dojo_belt_exams (id, dojo_id, federation_id, exam_date, title, examiner_name, status, created_by)
       VALUES ($1, $2, $3, '2026-08-15', 'Exame de faixa — agosto', 'Sensei Fixture', 'completed', $4)`,
      [examId, dojoId, federationId, userId]
    );
  });

  test('o dojô gradua até 1º kyu (Marrom 1º kyu)', async () => {
    const { rows } = await client.query(
      `INSERT INTO karate_dojo_belt_exam_results
         (exam_id, dojo_id, student_id, practitioner_id, from_belt_level, from_belt_kyu,
          to_belt_level, to_belt_name, to_belt_kyu, result)
       VALUES ($1, $2, $3, $4, 'marrom', 2, 'marrom', 'Marrom 1°kyu', 1, 'approved')
       RETURNING id, to_belt_kyu`,
      [examId, dojoId, dojoStudentFederado, stRoxa]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].to_belt_kyu)).toBe(1);
    expect(beltScale.canDojoGrant({ level: 'marrom', kyu: 1 })).toBe(true);
  });

  test('o dojô NÃO gradua faixa preta — o banco recusa', async () => {
    const erro = await expectFailure(
      `INSERT INTO karate_dojo_belt_exam_results
         (exam_id, dojo_id, student_id, from_belt_level, from_belt_kyu, to_belt_level, to_belt_name, result)
       VALUES ($1, $2, $3, 'marrom', 1, 'preta', 'Preta 1°', 'approved')`,
      [examId, dojoId, dojoStudentSemFederacao]
    );
    expect(erro).not.toBeNull();
    expect(erro.code).toBe('23514');
    expect(beltScale.canDojoGrant({ level: 'preta', dan: 1 })).toBe(false);
  });

  test('ALUNO NÃO FEDERADO também é graduado (practitioner_id NULL)', async () => {
    const { rows } = await client.query(
      `INSERT INTO karate_dojo_belt_exam_results
         (exam_id, dojo_id, student_id, practitioner_id, from_belt_level, from_belt_kyu,
          to_belt_level, to_belt_name, to_belt_kyu, result)
       VALUES ($1, $2, $3, NULL, 'branca', 10, 'amarela', 'Amarela', 9, 'approved')
       RETURNING id, practitioner_id, belt_history_id`,
      [examId, dojoId, dojoStudentSemFederacao]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].practitioner_id).toBeNull();
    // a linha em karate_belt_history é F8.1 — aqui ainda não existe
    expect(rows[0].belt_history_id).toBeNull();
  });

  test('reprovado não pode carregar graduação no histórico da federação', async () => {
    const outroExame = uuid();
    await client.query(
      `INSERT INTO karate_dojo_belt_exams (id, dojo_id, exam_date, status) VALUES ($1, $2, '2026-09-01', 'draft')`,
      [outroExame, dojoId]
    );
    const { rows: hist } = await client.query(
      `INSERT INTO karate_belt_history (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, belt_kyu, source)
       VALUES ($1, $2, 'verde', 'Verde', 'fpkt_shotokan', '2026-09-01', 7, 'exam_dojo')
       RETURNING id`,
      [stRoxa, federationId]
    );

    const erro = await expectFailure(
      `INSERT INTO karate_dojo_belt_exam_results
         (exam_id, dojo_id, student_id, to_belt_level, to_belt_name, to_belt_kyu, result, belt_history_id)
       VALUES ($1, $2, $3, 'verde', 'Verde', 7, 'failed', $4)`,
      [outroExame, dojoId, dojoStudentFederado, hist[0].id]
    );
    expect(erro).not.toBeNull();
    expect(erro.code).toBe('23514');
  });

  test('um aluno tem no máximo um resultado por exame', async () => {
    const erro = await expectFailure(
      `INSERT INTO karate_dojo_belt_exam_results
         (exam_id, dojo_id, student_id, to_belt_level, to_belt_name, to_belt_kyu, result)
       VALUES ($1, $2, $3, 'verde', 'Verde', 7, 'approved')`,
      [examId, dojoId, dojoStudentFederado]
    );
    expect(erro).not.toBeNull();
    expect(erro.code).toBe('23505');
  });
});
