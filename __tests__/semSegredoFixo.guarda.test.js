// ============================================================
// Guarda: nenhum segredo com valor fixo no código (INC-2026-10-21-03, tq-101)
//
// O repositório é público. Um `process.env.ALGUM_TOKEN || '<literal>'` faz
// o literal virar o segredo de produção sempre que a env falta — e qualquer
// um que leia o GitHub passa a conhecê-lo. Foi assim com o token da rota
// /reports/admin/test-weekly, a chave de cifra da NFS-e e o verify token do
// webhook do Instagram.
//
// Este teste varre src/**/*.js e falha quando uma env com cara de segredo
// (SECRET, TOKEN, KEY, PASSWORD, PASS, PRIVATE no nome) tem fallback para
// um literal não vazio, em qualquer destas formas:
//   process.env.X || 'lit'          process.env.X ?? 'lit'
//   process.env.X ||\n  'lit'       process.env.A || process.env.B || 'lit'
//   process.env.X || CONST          (CONST = 'lit' no mesmo arquivo)
//   getOptionalEnv('X', 'lit')      (helper de src/config/env.js)
//
// Fallback para '' / null / undefined NÃO é segredo: é só "ausente", e o
// código decide o que fazer sem ele. Esses passam.
//
// Sem segredo, o certo é recusar (401/403/500 controlado) e logar o motivo.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const NOME_DE_SEGREDO = /SECRET|TOKEN|KEY|PASSWORD|PASS|PRIVATE/;

// Exceções explícitas. Cada uma precisa dizer por que não é segredo.
// Manter curta: se a lista crescer, o problema é o código, não a guarda.
const EXCECOES = [
  {
    arquivo: 'src/config/env.js',
    env: 'JWT_SECRET',
    porque: 'Só no ramo NODE_ENV=test (fora dele é requireEnv). É o mesmo valor ' +
            'de teste que tests/jest.setup.js e o ci.yml já fixam; não vale em produção.',
  },
];

function listarJs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listarJs(p, out);
    else if (ent.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

// process.env.A [|| process.env.B ...] (||/??) 'literal'
// grupos: 1 = env, 2 = cadeia de outras envs, 3 = aspas, 4 = conteúdo
const RE_ENV_LITERAL =
  /process\.env\.([A-Z0-9_]+)((?:\s*(?:\|\||\?\?)\s*process\.env\.[A-Z0-9_]+)*)\s*(?:\|\||\?\?)\s*(['"`])((?:(?!\3)[^\\]|\\.)*)\3/g;
// process.env.A (||/??) IDENTIFICADOR (não seguido de . ( [ — isso é expressão, não constante)
const RE_ENV_IDENT = /process\.env\.([A-Z0-9_]+)\s*(?:\|\||\?\?)\s*([A-Za-z_$][\w$]*)\b(?!\s*[.(\[])/g;
// getOptionalEnv('A', 'literal') — grupos: 1 = env, 2 = aspas, 3 = conteúdo
const RE_OPTIONAL = /getOptionalEnv\(\s*['"]([A-Z0-9_]+)['"]\s*,\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2/g;

function linhaDe(texto, idx) {
  return texto.slice(0, idx).split('\n').length;
}

function constantesLiterais(texto) {
  const mapa = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:(?!\2)[^\\]|\\.)*)\2\s*;?/g;
  let m;
  while ((m = re.exec(texto))) mapa.set(m[1], m[3]);
  return mapa;
}

/** Devolve [{ arquivo, linha, env, inicio }] — nunca o literal inteiro. */
function varrer(texto, arquivo) {
  const achados = [];
  const add = (envs, literal, idx) => {
    if (!literal) return; // '' = ausente, não é segredo
    const env = envs.find((n) => NOME_DE_SEGREDO.test(n));
    if (!env) return;
    achados.push({ arquivo, linha: linhaDe(texto, idx), env, inicio: literal.slice(0, 4) });
  };

  let m;
  RE_ENV_LITERAL.lastIndex = 0;
  while ((m = RE_ENV_LITERAL.exec(texto))) {
    const envs = [m[1], ...((m[2] || '').match(/[A-Z0-9_]{2,}/g) || [])];
    add(envs, m[4], m.index);
  }

  const consts = constantesLiterais(texto);
  RE_ENV_IDENT.lastIndex = 0;
  while ((m = RE_ENV_IDENT.exec(texto))) {
    if (['null', 'undefined', 'process'].includes(m[2])) continue;
    if (consts.has(m[2])) add([m[1]], consts.get(m[2]), m.index);
  }

  RE_OPTIONAL.lastIndex = 0;
  while ((m = RE_OPTIONAL.exec(texto))) add([m[1]], m[3], m.index);

  return achados;
}

function ehExcecao(a) {
  return EXCECOES.some((e) => e.arquivo === a.arquivo && e.env === a.env);
}

describe('guarda: nenhum segredo fixo em src/ (tq-101)', () => {
  test('a própria guarda pega as formas que já vazaram', () => {
    // Literais de mentira, só para provar que as regex enxergam cada forma.
    const amostras = [
      "const T = process.env.ALGUM_TOKEN || 'xxxx-falso';",
      "const K = process.env.ALGUMA_KEY ||\n  'yyyy-falso'; // multilinha",
      'const S = process.env.APP_SECRET ?? "zzzz-falso";',
      "const P = process.env.OUTRA || process.env.DB_PASSWORD || `wwww`;",
      "const _FB = 'vvvv-falso';\nfunction f() { return process.env.ADMIN_TOKEN || _FB; }",
      "const x = getOptionalEnv('PRIVATE_THING', 'uuuu');",
    ];
    for (const a of amostras) {
      expect(varrer(a, 'amostra.js')).toHaveLength(1);
    }
    // E deixa passar o que não é segredo.
    const limpas = [
      "const T = process.env.ALGUM_TOKEN || '';",
      'const T = process.env.ALGUM_TOKEN || null;',
      "const U = process.env.APP_URL || 'https://app.exemplo';",
      'const K = process.env.A_KEY || process.env.B_KEY;',
      "const S = process.env.SEGREDO_NOVO || env.JWT_SECRET;",
      "const h = getOptionalEnv('HEALTH_SECRET', '');",
    ];
    for (const l of limpas) {
      expect(varrer(l, 'limpa.js')).toEqual([]);
    }
  });

  test('src/**/*.js não tem process.env.<SEGREDO> || <literal>', () => {
    const raiz = path.join(__dirname, '..');
    const achados = [];
    for (const abs of listarJs(SRC)) {
      const rel = path.relative(raiz, abs).split(path.sep).join('/');
      achados.push(...varrer(fs.readFileSync(abs, 'utf8'), rel));
    }
    const proibidos = achados.filter((a) => !ehExcecao(a));
    // Mensagem mostra arquivo:linha e só os 4 primeiros caracteres.
    const msg = proibidos.map((a) => `${a.arquivo}:${a.linha} ${a.env} -> '${a.inicio}...'`);
    expect(msg).toEqual([]);
  });

  test('toda exceção ainda existe no código (lista não apodrece)', () => {
    const raiz = path.join(__dirname, '..');
    for (const e of EXCECOES) {
      const texto = fs.readFileSync(path.join(raiz, e.arquivo), 'utf8');
      const achados = varrer(texto, e.arquivo).filter((a) => a.env === e.env);
      expect(`${e.arquivo} ${e.env}: ${achados.length}`).not.toBe(`${e.arquivo} ${e.env}: 0`);
    }
  });
});
