// ============================================================
// AURA — todo SQL que o código manda pro banco tem que ser SQL válido
//
// POR QUE ESTE ARQUIVO EXISTE
//   Em 26/08/2026 um cliente ficou 5h20 sem conseguir registrar recebimento.
//   A causa: blocos de comentário JS inseridos por número de linha caíram
//   DENTRO de template literals de SQL, e o Postgres respondeu
//   `syntax error at or near "//"`. Como a query roda dentro da transação do
//   pagamento, derrubava a operação inteira.
//
//   Nada pegou isso antes do deploy. Os testes existentes verificavam o TEXTO
//   das queries (e o texto continuava lá, só que dentro de um SQL inválido),
//   e os testes de banco montavam o SQL a partir de constantes próprias —
//   nenhum executava um template literal do código de produção.
//
// O QUE ELE FAZ
//   Extrai, com parser JS de verdade, todo template literal que parece SQL em
//   src/, e manda cada um pro Postgres com PREPARE. O banco é quem diz se
//   parseia — não uma heurística de regex. Pega `//` dentro de SQL, parêntese
//   solto, palavra-chave errada, em qualquer arquivo, para sempre.
//
//   Regex literal e comentário JS confundem scanner ingênuo (uma varredura por
//   regex dava 193 falsos positivos neste repo), por isso o parser.
//
// LIMITE HONESTO
//   Valida SINTAXE, não semântica: não pega coluna inexistente em query com
//   interpolação, nem numeração de $n errada. Para o ciclo de negócio existe
//   __tests__/credito.recebivelSaldoParcial.test.js.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let parser;
try {
  parser = require('@babel/parser');
} catch (_) {
  parser = null; // o CI instala; local sem dep, o teste se pula sozinho
}

function arquivosJs(dir, acc = []) {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    const st = fs.statSync(p);
    if (st.isDirectory()) arquivosJs(p, acc);
    else if (nome.endsWith('.js')) acc.push(p);
  }
  return acc;
}

// Só o que é claramente SQL — evita pegar template de mensagem, URL, etc.
const COMECO_SQL = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

// Templates com interpolação viram SQL incompleto se a expressão for um
// fragmento (ex.: `${arDueExpr}`). Substituímos por um literal neutro para
// que o PREPARE ainda consiga julgar a ESTRUTURA em volta.
function normalizar(raw) {
  return raw
    .replace(/\$\{[^}]*\}/g, 'NULL')   // interpolação -> literal
    .replace(/\$(\d+)/g, '$$$1');      // mantém os placeholders do pg
}

function extrairSql(arquivo) {
  const código = fs.readFileSync(arquivo, 'utf8');
  let ast;
  try {
    ast = parser.parse(código, {
      sourceType: 'unambiguous',
      plugins: ['optionalChaining', 'nullishCoalescingOperator', 'classProperties'],
    });
  } catch (_) {
    return []; // arquivo que o parser não lê não é problema deste teste
  }

  const achados = [];
  (function andar(nó) {
    if (!nó || typeof nó !== 'object') return;
    if (nó.type === 'TemplateLiteral') {
      const bruto = nó.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' NULL ');
      if (COMECO_SQL.test(bruto)) {
        achados.push({
          sql: normalizar(bruto),
          linha: nó.loc && nó.loc.start.line,
        });
      }
    }
    for (const k of Object.keys(nó)) {
      const v = nó[k];
      if (Array.isArray(v)) v.forEach(andar);
      else if (v && typeof v === 'object' && v.type) andar(v);
    }
  })(ast);
  return achados;
}

// A conexao vive DENTRO do teste que precisa dela, de proposito: num beforeAll
// global, a falta de Postgres derruba tambem as checagens que nao usam banco --
// e sao elas que pegam a regressao do '//' em qualquer ambiente.
describe('SQL dos template literals de src/', () => {
  test('o parser está disponível (o CI instala @babel/parser)', () => {
    expect(parser).not.toBeNull();
  });

  test('nenhum template SQL tem comentário JS dentro', () => {
    // Camada barata, sem banco: é a assinatura exata da regressão de 26/08.
    const culpados = [];
    for (const arq of arquivosJs(SRC)) {
      for (const { sql, linha } of extrairSql(arq)) {
        if (/^\s*\/\//m.test(sql)) {
          culpados.push(`${path.relative(ROOT, arq)}:${linha}`);
        }
      }
    }
    expect(culpados).toEqual([]);
  });

  test('todo template SQL é aceito pelo Postgres', async () => {
    const pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      await pool.end().catch(() => {});
      // Sem Postgres (dev local), esta camada nao roda -- a de cima ja cobriu
      // a assinatura da regressao. No CI o banco sobe e esta camada vale.
      console.warn('[sqlDosTemplates] sem Postgres, pulando o PREPARE:', err.message);
      return;
    }

    const falhas = [];
    let testados = 0;

    for (const arq of arquivosJs(SRC)) {
      for (const { sql, linha } of extrairSql(arq)) {
        testados++;
        const nome = 'chk_' + testados;
        // SAVEPOINT por query: um PREPARE que falha envenenaria a transação
        // e derrubaria todos os seguintes com "current transaction is aborted".
        await client.query('BEGIN');
        try {
          await client.query(`PREPARE ${nome} AS ${sql}`);
          await client.query(`DEALLOCATE ${nome}`);
        } catch (err) {
          // 42601 = syntax_error. Só ele interessa aqui: coluna/tabela ausente
          // (42703/42P01) pode ser efeito da normalização da interpolação.
          if (err.code === '42601') {
            falhas.push(`${path.relative(ROOT, arq)}:${linha} — ${err.message}`);
          }
        } finally {
          await client.query('ROLLBACK');
        }
      }
    }

    client.release();
    await pool.end();

    expect(testados).toBeGreaterThan(100); // se cair, a extração quebrou
    expect(falhas).toEqual([]);
  }, 120000);
});
