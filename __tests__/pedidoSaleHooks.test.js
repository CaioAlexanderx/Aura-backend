// ============================================================
// AURA. — Concluir o pedido pela venda (B5a): a conta, sem banco.
// services/pedidoSaleHooks.js — pedidoDoCorpo e valoresDaConclusao.
// O banco (trava, gancho, dois caminhos) esta em pdv.vendaRapida.banco e em
// pedidoConclusao.banco.
// ============================================================
'use strict';

const H = require('../src/services/pedidoSaleHooks');

const OID = '0b6c7a64-7d0e-4f37-9a52-6f1f1f6c2b11';
const staff = { id: 'u', is_staff: true };

describe('pedidoDoCorpo', () => {
  afterEach(() => { delete process.env.PEDIDO_LIBERADO; });

  test('sem order_id: null (venda comum)', () => {
    expect(H.pedidoDoCorpo({ body: {}, user: staff })).toBeNull();
    expect(H.pedidoDoCorpo({ body: { order_id: null }, user: staff })).toBeNull();
    expect(H.pedidoDoCorpo({ body: { order_id: '' }, user: staff })).toBeNull();
  });

  test('com comanda, orcamento ou venda com sinal: 422', () => {
    for (const extra of [{ comanda_id: OID }, { quote_id: OID }]) {
      expect(() => H.pedidoDoCorpo({ body: { order_id: OID, ...extra }, user: staff }))
        .toThrow(expect.objectContaining({ statusCode: 422, code: 'PEDIDO_COM_OUTRO_VINCULO' }));
    }
    expect(() => H.pedidoDoCorpo({ body: { order_id: OID }, user: staff }, { signalSale: true }))
      .toThrow(expect.objectContaining({ statusCode: 422 }));
  });

  test('trava desligada para o lojista e id fora do formato: 404', () => {
    expect(() => H.pedidoDoCorpo({ body: { order_id: OID }, user: { id: 'u', role: 'client' } }))
      .toThrow(expect.objectContaining({ statusCode: 404, code: 'PEDIDO_NAO_ENCONTRADO' }));
    expect(() => H.pedidoDoCorpo({ body: { order_id: 'abc' }, user: staff }))
      .toThrow(expect.objectContaining({ statusCode: 404 }));
    process.env.PEDIDO_LIBERADO = 'true';
    expect(H.pedidoDoCorpo({ body: { order_id: OID.toUpperCase() }, user: { id: 'u' } })).toBe(OID);
  });
});

describe('valoresDaConclusao (o sinal vem do servidor)', () => {
  const pedido = { sinal: 100 };
  const v = (extra) => H.valoresDaConclusao({ pedido, totalAmount: 389.7, customerId: 'c', ...extra });

  test('saldo em uma forma: so o de hoje entra', () => {
    expect(v({ payment_method: 'pix' })).toEqual({ sinal: 100, saldo: 289.7, creditAmount: 0, cashAmount: 289.7 });
  });

  test('saldo dividido: os pagamentos batem com o que falta', () => {
    expect(v({ payments: [{ method: 'dinheiro', value: 200 }, { method: 'pix', value: 89.7 }] }).cashAmount).toBe(289.7);
  });

  test('crediario sozinho = o saldo inteiro; parcial soma com o de hoje', () => {
    expect(v({ payment_method: 'crediario' })).toMatchObject({ creditAmount: 289.7, cashAmount: 0 });
    expect(v({ payments: [{ method: 'crediario', value: 189.7 }, { method: 'pix', value: 100 }] }))
      .toMatchObject({ creditAmount: 189.7, cashAmount: 100 });
  });

  test('pagamentos que cobram o sinal de novo: 422', () => {
    expect(() => v({ payments: [{ method: 'pix', value: 389.7 }] }))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'PEDIDO_PAGAMENTOS_NAO_BATEM' }));
  });

  test('crediario maior que o saldo: 422', () => {
    expect(() => v({ payments: [{ method: 'crediario', value: 300 }] }))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'PEDIDO_CREDIARIO_MAIOR' }));
  });

  test('sinal maior que a venda: 422 (a sobra e do B5b); sinal igual ao total: nada entra hoje', () => {
    expect(() => H.valoresDaConclusao({ pedido, totalAmount: 90, payment_method: 'pix', customerId: 'c' }))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'PEDIDO_SINAL_MAIOR_QUE_VENDA' }));
    expect(H.valoresDaConclusao({ pedido, totalAmount: 100, payment_method: 'pix' }))
      .toEqual({ sinal: 100, saldo: 0, creditAmount: 0, cashAmount: 0 });
  });

  test('pedido sem sinal: a conta da venda de sempre', () => {
    expect(H.valoresDaConclusao({ pedido: { sinal: 0 }, totalAmount: 50, payment_method: 'dinheiro' }))
      .toEqual({ sinal: 0, saldo: 50, creditAmount: 0, cashAmount: 50 });
  });
});
