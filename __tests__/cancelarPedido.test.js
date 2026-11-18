// ============================================================
// AURA. — Cancelar o pedido do balcao (B6 / p-62e): regras sem banco
// services/cancelarPedido.js — destino do sinal e motivo.
// O dinheiro gravado de verdade esta em cancelarPedido.banco.test.js.
// ============================================================
'use strict';

const C = require('../src/services/cancelarPedido');

describe('lerDestino', () => {
  test('sem sinal: nada e exigido, e o que vier e ignorado', () => {
    expect(C.lerDestino({}, false)).toEqual({ dados: { kind: null, method: null } });
    expect(C.lerDestino({ refund_kind: 'credito' }, false)).toEqual({ dados: { kind: null, method: null } });
  });

  test('credito na ficha', () => {
    expect(C.lerDestino({ refund_kind: 'Credito' }, true)).toEqual({ dados: { kind: 'credito', method: null } });
  });

  test('devolucao: dinheiro, pix ou estorno', () => {
    for (const m of ['dinheiro', 'pix', 'estorno']) {
      expect(C.lerDestino({ refund_kind: 'devolucao', refund_method: m }, true)).toEqual({ dados: { kind: 'devolucao', method: m } });
    }
    expect(C.lerDestino({ refund_kind: 'devolucao', refund_method: 'cheque' }, true).erro.code).toBe('PEDIDO_DEVOLUCAO_FORMA');
    expect(C.lerDestino({ refund_kind: 'devolucao' }, true).erro.code).toBe('PEDIDO_DEVOLUCAO_FORMA');
  });

  test('com sinal e sem destino: 422', () => {
    expect(C.lerDestino({}, true).erro).toMatchObject({ status: 422, code: 'PEDIDO_DESTINO_DO_SINAL' });
    expect(C.lerDestino(null, true).erro.code).toBe('PEDIDO_DESTINO_DO_SINAL');
  });
});

describe('limparMotivo', () => {
  test('espacos e controle saem; vazio vira null; ate 200', () => {
    expect(C.limparMotivo('  a\n\tb  ')).toBe('a b');
    expect(C.limparMotivo('   ')).toBeNull();
    expect(C.limparMotivo(42)).toBeNull();
    expect(C.limparMotivo(undefined)).toBeNull();
    expect(C.limparMotivo('é'.repeat(250))).toHaveLength(200);
  });
});

describe('categoria e chaves', () => {
  test('"Devolução de sinal", nunca "devolucao"', () => {
    expect(C.CATEGORIA_DEVOLUCAO_SINAL).toBe('Devolução de sinal');
    const { CAT_TROCA_DEVOLUCAO, CAT_DEVOLUCAO_SINAL } = require('../src/services/resultadoDoPeriodo');
    expect(CAT_TROCA_DEVOLUCAO).not.toContain(C.CATEGORIA_DEVOLUCAO_SINAL.toLowerCase());
    expect(CAT_DEVOLUCAO_SINAL).toContain(C.CATEGORIA_DEVOLUCAO_SINAL.toLowerCase());
    expect(C.CHAVE_DEVOLUCAO('x')).toBe('pedido-devolucao-x');
    expect(C.CHAVE_CREDITO('x')).toBe('pedido-credito-x');
  });
});
