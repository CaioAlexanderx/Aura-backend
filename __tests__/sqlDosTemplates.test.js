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
//   src/, em duas camadas:
//
//   1. Procura comentário JS dentro do SQL. Roda em TODOS os ~3.100 templates,
//      não precisa de banco, e é a assinatura exata da regressão acima.
//   2. Manda pro Postgres com PREPARE os ~2.670 que são SQL literal e INTEIRO.
//      Quem julga é o banco, não uma heurística.
//
//   Regex literal e comentário JS confundem scanner ingênuo (uma varredura por
//   regex dava 193 falsos positivos neste repo), por isso o parser.
//
// POR QUE A CAMADA 2 NÃO OLHA TUDO
//   Template com `${...}` costuma receber um FRAGMENTO (`${arDueExpr}`, um
//   ORDER BY montado, uma lista de colunas). Não existe substituto neutro que
//   sirva em toda posição: trocar por NULL dá `ORDER BY NULL` e outros 300
//   erros que não são defeito nenhum — foi o que aconteceu na primeira versão
//   deste arquivo. Idem para o SQL montado por concatenação. Esses ficam de
//   fora do PREPARE, mas seguem cobertos pela camada 1.
//
// LIMITE HONESTO
//   Valida SINTAXE, não semântica: não pega coluna inexistente nem numeração
//   de $n errada. Para o ciclo de negócio existe
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

// Nomes de variáveis que aparecem em alguma concatenação com '+' no arquivo.
// Serve para reconhecer o SQL montado por pedaços (`let sql = \`INSERT ...\`;
// ... sql + \`) VALUES ...\``): cada pedaço é incompleto de propósito.
function nomesConcatenados(ast) {
  const nomes = new Set();
  (function andar(nó) {
    if (!nó || typeof nó !== 'object') return;
    if (nó.type === 'BinaryExpression' && nó.operator === '+') {
      for (const lado of [nó.left, nó.right]) {
        if (lado && lado.type === 'Identifier') nomes.add(lado.name);
      }
    }
    for (const k of Object.keys(nó)) {
      const v = nó[k];
      if (Array.isArray(v)) v.forEach(andar);
      else if (v && typeof v === 'object' && v.type) andar(v);
    }
  })(ast);
  return nomes;
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

  const concatenados = nomesConcatenados(ast);
  const achados = [];
  (function andar(nó, pai) {
    if (!nó || typeof nó !== 'object') return;
    if (nó.type === 'TemplateLiteral') {
      const bruto = nó.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
      if (COMECO_SQL.test(bruto)) {
        const fragmento =
          (pai && pai.type === 'BinaryExpression' && pai.operator === '+') ||
          (pai && pai.type === 'VariableDeclarator' && pai.id.type === 'Identifier' &&
            concatenados.has(pai.id.name)) ||
          (pai && pai.type === 'AssignmentExpression' && pai.left.type === 'Identifier' &&
            concatenados.has(pai.left.name));
        achados.push({
          sql: bruto,
          linha: nó.loc && nó.loc.start.line,
          // Só o SQL literal e inteiro pode ser julgado pelo PREPARE.
          completo: nó.expressions.length === 0 && !fragmento,
        });
      }
    }
    for (const k of Object.keys(nó)) {
      const v = nó[k];
      if (Array.isArray(v)) v.forEach((f) => andar(f, nó));
      else if (v && typeof v === 'object' && v.type) andar(v, nó);
    }
  })(ast, null);
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
      for (const { sql, linha, completo } of extrairSql(arq)) {
        if (!completo) continue;
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
          // (42703/42P01) é migration ainda não aplicada no banco do CI, não
          // SQL malformado — e é justamente o malformado que este teste caça.
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

    // Eram 2.672 em 26/08/2026. Um piso alto protege contra a extração
    // degradar em silêncio e o teste virar um "verde" que não olha nada.
    expect(testados).toBeGreaterThan(2000);
    expect(falhas).toEqual([]);
  }, 120000);
});
