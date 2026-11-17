// ============================================================
// AURA. — Cadastro com a variavel FRENTE_STUDIO_NO_NEGOCIO desligada:
// byte a byte o de hoje (p-189, 17/11/2026)
//
// O retrato (tests/fixtures/segment/cadastro-frentes.sql.json) foi gravado
// com o services/segment.js da main ANTES do p-189 (origin/main cb400bad).
// Ele guarda, para cada frente e cada origem do cadastro (cnae, landing,
// user), o texto exato de cada SQL, os parametros e o estado final da
// empresa. Com a variavel ausente, vazia, 'false' ou qualquer coisa que nao
// seja 'true', applySegment tem de repetir tudo, caractere por caractere.
//
// Para regravar (so se a mudanca no cadastro for de proposito):
//   GRAVAR_RETRATO_CADASTRO=1 npx jest cadastroFrenteStudio.retrato
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { applySegment, SEGMENTS } = require('../src/services/segment');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');

const RETRATO = path.join(__dirname, '..', 'tests', 'fixtures', 'segment', 'cadastro-frentes.sql.json');
const AGORA = new Date('2026-11-17T12:00:00.000Z');
const C = 'c-novo-1';

// Os mesmos casos que o /auth/register produz: empresa recem-criada (sem
// vertical, pdv_settings vazio), origem do cliente, com e sem o extra 'os'
// e com e sem a meta do CNAE.
function casos() {
  const out = [];
  for (const plan of ['negocio', 'essencial']) {
    for (const segment of SEGMENTS) {
      for (const source of ['cnae', 'landing', 'user']) {
        for (const extras of [[], ['os']]) {
          const meta = source === 'cnae'
            ? { segment_suggested: segment, cnae_principal: '1813001', cnae_descricao: 'Impressao' }
            : { segment_suggested: null, cnae_principal: null, cnae_descricao: null };
          out.push({ nome: `${plan}|${segment}|${source}|${extras.join(',') || '-'}`, plan, segment, source, extras, meta });
        }
      }
    }
  }
  return out;
}

async function rodar(caso) {
  const db = fakeSegmentDb({ companies: { [C]: { plan: caso.plan } } });
  let resultado;
  let erro = null;
  try {
    resultado = await applySegment(db.client, C, {
      segment: caso.segment, extras: caso.extras, source: caso.source, meta: caso.meta,
    });
  } catch (err) {
    erro = { statusCode: err.statusCode || null, code: err.code || null, message: err.message };
  }
  return {
    sql: db.calls.map((c) => ({ text: c.text, params: c.params })),
    resultado: resultado || null,
    erro,
    empresa: db.state.companies[C],
  };
}

async function retratoAtual() {
  const out = {};
  for (const caso of casos()) out[caso.nome] = await rodar(caso);
  return JSON.parse(JSON.stringify(out));
}

const VARIAVEL = 'FRENTE_STUDIO_NO_NEGOCIO';
let antes;

beforeEach(() => {
  antes = process.env[VARIAVEL];
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(AGORA);
});
afterEach(() => {
  jest.useRealTimers();
  if (antes === undefined) delete process.env[VARIAVEL];
  else process.env[VARIAVEL] = antes;
});

describe('cadastro com a variavel desligada: igual ao retrato da main', () => {
  if (process.env.GRAVAR_RETRATO_CADASTRO === '1') {
    test('grava o retrato', async () => {
      delete process.env[VARIAVEL];
      const r = await retratoAtual();
      fs.mkdirSync(path.dirname(RETRATO), { recursive: true });
      fs.writeFileSync(RETRATO, JSON.stringify(r, null, 2) + '\n');
    });
    return;
  }

  const retrato = JSON.parse(fs.readFileSync(RETRATO, 'utf8'));

  test('o retrato cobre as 7 frentes, 3 origens, 2 planos e o extra', () => {
    expect(Object.keys(retrato)).toHaveLength(SEGMENTS.length * 3 * 2 * 2);
    // A frente studio no Negocio cria a vertical (o caminho de hoje).
    const studio = retrato['negocio|studio|user|-'];
    expect(studio.empresa.vertical_active).toBe('studio');
    expect(studio.empresa.pdv_settings.studio_enabled).toBe(true);
  });

  test.each([
    ['ausente', undefined],
    ['vazia', ''],
    ['false', 'false'],
    ['0', '0'],
    ['TRUE com espaco no meio', 'tr ue'],
  ])('variavel %s: mesmo SQL, mesmos parametros e mesmo estado', async (_n, valor) => {
    if (valor === undefined) delete process.env[VARIAVEL];
    else process.env[VARIAVEL] = valor;
    const atual = await retratoAtual();
    expect(Object.keys(atual)).toEqual(Object.keys(retrato));
    for (const nome of Object.keys(retrato)) {
      expect({ nome, ...atual[nome] }).toEqual({ nome, ...retrato[nome] });
    }
  });
});
