// ============================================================
// AURA. — B3 (edicao): leitura do pedido de "Aplicar tambem na Filial", sem
// banco. O caminho com banco esta em produtoNasLojas.edicao.banco.test.js.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const svc = require('../src/services/produtoNasLojas');

const FILIAL = '22222222-2222-4222-8222-222222222222';

test('campos de cadastro passam, repetido some; lojas normalizadas', () => {
  expect(svc.lerPedidoDeAplicar({ campos: ['price', 'name', 'price'], lojas: [FILIAL.toUpperCase(), FILIAL] }))
    .toEqual({ campos: ['price', 'name'], lojas: [FILIAL] });
});

test('estoque nunca: 400 com o motivo; campo fora da lista: 400', () => {
  for (const campo of ['stock_qty', 'stock_fraction', 'variantes']) {
    expect(() => svc.lerPedidoDeAplicar({ campos: [campo], lojas: [FILIAL] }))
      .toThrow(expect.objectContaining({ code: 'CAMPOS_INVALIDOS', status: 400, message: expect.stringMatching(/Transferir/) }));
  }
  for (const campo of ['company_id', 'is_group_shared', 'master_sku', 'id']) {
    expect(() => svc.lerPedidoDeAplicar({ campos: [campo], lojas: [FILIAL] })).toThrow(expect.objectContaining({ code: 'CAMPOS_INVALIDOS' }));
  }
  expect(svc.CAMPOS_EDITAVEIS.has('is_group_shared')).toBe(false);
  expect(svc.CAMPOS_EDITAVEIS.has('master_sku')).toBe(false);
});

test('sem campos ou sem lojas: 400', () => {
  expect(() => svc.lerPedidoDeAplicar({ campos: [], lojas: [FILIAL] })).toThrow(expect.objectContaining({ code: 'CAMPOS_INVALIDOS' }));
  expect(() => svc.lerPedidoDeAplicar({ campos: ['price'] })).toThrow(expect.objectContaining({ code: 'LOJAS_INVALIDAS' }));
  expect(() => svc.lerPedidoDeAplicar({ campos: ['price'], lojas: ['x'] })).toThrow(expect.objectContaining({ code: 'LOJAS_INVALIDAS' }));
});
