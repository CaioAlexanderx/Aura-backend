// ============================================================
// AURA DOJÔ — F10 (04/08/2026): testes de FILIAÇÃO (mãe e pai)
//
// karateDojoStudentService.js não tem arquivo de teste dedicado e sua SQL
// não é ancorada (`-- f81:...` como karateDojoBeltExamService.js) — mockar
// o banco aqui exigiria fila posicional, que já derrubou o CI deste repo
// quatro vezes (ver armadilha_mock_sql_ignora_parametro_escopo /
// feedback_pr_verificar_testes_existentes). Por isso esta cobertura fica
// nas FUNÇÕES PURAS que o PATCH/POST atravessam antes de qualquer query:
// validateStudentPayload (parsing/validação do corpo) e as constantes que
// decidem onde a filiação entra (ou não) na guarda de identidade.
//
// O que este arquivo protege:
//   • mother_name/father_name são aceitos, trim() aplicado, string vazia
//     vira null explícito (permite apagar num PATCH) — mesmo tratamento
//     de rg/street/etc (F7.0).
//   • campo AUSENTE é neutro: não entra em `data` (dado faltante ≠
//     pendência — princípio do produto, nunca pendência/422).
//   • PARENTAGE_COLS (migration 272) é uma lista SEPARADA de
//     IDENTITY_COLS (migration 262) — migrations diferentes, probes
//     diferentes, sem colisão.
//   • mother_name/father_name NÃO entram em SYNCED_IDENTITY_COLS: não há
//     coluna equivalente em `customers` hoje, então nada sobe para a
//     federação (decisão explícita do PR, não omissão).
// ============================================================
'use strict';

const svc = require('../src/services/karateDojoStudentService');

describe('F10 — validateStudentPayload: mother_name / father_name', () => {
  test('aceita e faz trim() de mother_name e father_name', () => {
    const { errors, data } = svc.validateStudentPayload({
      full_name: 'Aluno Teste',
      mother_name: '  Maria da Silva  ',
      father_name: '  José Santos  ',
    });

    expect(errors).toEqual([]);
    expect(data.mother_name).toBe('Maria da Silva');
    expect(data.father_name).toBe('José Santos');
  });

  test('campo AUSENTE é neutro — não entra em data (dado faltante ≠ pendência)', () => {
    const { errors, data } = svc.validateStudentPayload({ full_name: 'Aluno Teste' });

    expect(errors).toEqual([]);
    expect(data).not.toHaveProperty('mother_name');
    expect(data).not.toHaveProperty('father_name');
  });

  test('string vazia (ou só espaços) vira null explícito — permite apagar o campo num PATCH', () => {
    const { errors, data } = svc.validateStudentPayload(
      { mother_name: '', father_name: '   ' },
      { partial: true }
    );

    expect(errors).toEqual([]);
    expect(data.mother_name).toBeNull();
    expect(data.father_name).toBeNull();
  });

  test('null explícito no corpo também vira null (não é erro de validação)', () => {
    const { errors, data } = svc.validateStudentPayload(
      { mother_name: null, father_name: null },
      { partial: true }
    );

    expect(errors).toEqual([]);
    expect(data.mother_name).toBeNull();
    expect(data.father_name).toBeNull();
  });

  test('só mother_name informado — father_name continua ausente (independência entre os dois campos)', () => {
    const { data } = svc.validateStudentPayload({ mother_name: 'Ana' }, { partial: true });

    expect(data.mother_name).toBe('Ana');
    expect(data).not.toHaveProperty('father_name');
  });
});

describe('F10 — PARENTAGE_COLS: lista separada, sem colisão com identidade (262) ou sync', () => {
  test('PARENTAGE_COLS é exportado e contém exatamente mother_name/father_name', () => {
    expect(svc.PARENTAGE_COLS).toEqual(['mother_name', 'father_name']);
  });

  test('PARENTAGE_COLS (migration 272) não colide com IDENTITY_COLS (migration 262) — migrations independentes', () => {
    const clash = svc.PARENTAGE_COLS.filter((c) => svc.IDENTITY_COLS.includes(c));
    expect(clash).toEqual([]);
  });

  test('mother_name/father_name NÃO entram em SYNCED_IDENTITY_COLS — nada sobe para a federação (sem coluna equivalente em customers)', () => {
    expect(svc.SYNCED_IDENTITY_COLS).not.toContain('mother_name');
    expect(svc.SYNCED_IDENTITY_COLS).not.toContain('father_name');
  });

  test('touchedIdentityCols ignora mother_name/father_name (eles não fazem parte do gatilho de sync F7.2)', () => {
    const touched = svc.touchedIdentityCols({ mother_name: 'Maria', father_name: 'José', rg: '123' });
    expect(touched).not.toContain('mother_name');
    expect(touched).not.toContain('father_name');
    // rg é IDENTITY_COLS/SYNCED_IDENTITY_COLS de verdade — continua disparando.
    expect(touched).toContain('rg');
  });
});
