// ============================================================
// services/temporada — datas da temporada e o texto do que sera cobrado.
// Funcoes puras: a regra de banco esta em tests/integration/seatPassLive.test.js.
// ============================================================
'use strict';

const {
  TEMPORADA,
  LIMITE_POR_LOJA,
  LIMITE_ADMIN,
  janelaDoPasse,
  mensalidadesAteOFim,
  descreverCobranca,
} = require('../../src/services/temporada');

describe('constante unica', () => {
  test('validade fixa de 01/11/2026 a 31/01/2027', () => {
    expect(TEMPORADA).toMatchObject({ id: '2026-2027', starts_at: '2026-11-01', ends_at: '2027-01-31' });
    expect(Object.isFrozen(TEMPORADA)).toBe(true);
  });

  test('limites: loja 10, admin 50', () => {
    expect(LIMITE_POR_LOJA).toBe(10);
    expect(LIMITE_ADMIN).toBe(50);
  });
});

describe('janelaDoPasse', () => {
  test('antes da temporada: agenda para 01/11 e nao aplica agora', () => {
    expect(janelaDoPasse('2026-10-13')).toMatchObject({
      aberta: true, starts_at: '2026-11-01', ends_at: '2027-01-31', aplica_agora: false,
    });
  });

  test('primeiro dia: aplica agora', () => {
    expect(janelaDoPasse('2026-11-01')).toMatchObject({ aberta: true, starts_at: '2026-11-01', aplica_agora: true });
  });

  test('no meio: comeca hoje, termina em 31/01', () => {
    expect(janelaDoPasse('2026-12-20')).toMatchObject({ aberta: true, starts_at: '2026-12-20', ends_at: '2027-01-31', aplica_agora: true });
  });

  test('ultimo dia ainda contrata; depois, encerrada', () => {
    expect(janelaDoPasse('2027-01-31')).toMatchObject({ aberta: true, starts_at: '2027-01-31', aplica_agora: true });
    expect(janelaDoPasse('2027-02-01')).toMatchObject({ aberta: false, motivo: 'temporada_encerrada' });
  });
});

describe('mensalidadesAteOFim', () => {
  test.each([
    ['2026-11-01', '2027-01-31', 3],
    ['2026-12-10', '2027-01-31', 2],
    ['2027-01-15', '2027-01-31', 1],
  ])('%s → %s = %i', (a, b, n) => expect(mensalidadesAteOFim(a, b)).toBe(n));
});

describe('descreverCobranca', () => {
  test('cobrado: valor por mensalidade, maximo e ate quando', () => {
    const c = descreverCobranca({ qty: 2, starts_at: '2026-11-01', ends_at: '2027-01-31' });
    expect(c).toMatchObject({
      forma: 'assinatura_asaas', valor_unitario: 19, valor_mensal: 38,
      mensalidades_ate_o_fim: 3, valor_maximo_total: 114, de: '2026-11-01', ate: '2027-01-31',
    });
    expect(c.texto).toContain('R$ 38,00 por mensalidade');
    expect(c.texto).toContain('2 assentos × R$ 19,00');
    expect(c.texto).toContain('31/01/2027');
    expect(c.texto).toContain('114,00');
    expect(c.texto).toContain('expira sozinho');
  });

  test('singular', () => {
    expect(descreverCobranca({ qty: 1, starts_at: '2026-11-01', ends_at: '2027-01-31' }).texto).toContain('1 assento ×');
  });

  test('cortesia: zero e diz que nao ha cobranca', () => {
    const c = descreverCobranca({ qty: 3, starts_at: '2026-11-01', ends_at: '2027-01-31', cortesia: true });
    expect(c).toMatchObject({ forma: 'cortesia', valor_unitario: 0, valor_mensal: 0, valor_maximo_total: 0 });
    expect(c.texto).toMatch(/sem cobrança/);
  });
});
