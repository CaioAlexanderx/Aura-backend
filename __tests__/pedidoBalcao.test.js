// ============================================================
// AURA. — Pedido guardado no Caixa (B1): regras sem banco
// services/pedidoBalcao.js — leitura do corpo, chave e trava.
// O que o pedido grava (e o que NAO grava) esta em pedidoBalcao.banco.test.js.
// ============================================================
'use strict';

const { lerCorpo, lerChave, pedidoLiberado, hojeSP } = require('../src/services/pedidoBalcao');

const P = '11111111-2222-3333-4444-555555555555';
const V = '66666666-7777-8888-9999-000000000000';
const HOJE = '2026-11-17';

describe('lerCorpo', () => {
  test('soma por item com desconto e o desconto do pedido', () => {
    const { dados } = lerCorpo({
      items: [
        { product_id: P, variant_id: V, quantity: 3, unit_price: 19.9, item_discount: 4.7 },
        { product_name: 'Ajuste', quantity: 1, unit_price: '15' },
      ],
      discount: '5',
    }, { hoje: HOJE });
    expect(dados.itens[0]).toMatchObject({ quantity: 3, unit_price: 19.9, item_discount: 4.7, subtotal: 55 });
    expect(dados.itens[1]).toMatchObject({ product_id: null, nome: 'Ajuste', subtotal: 15 });
    expect(dados).toMatchObject({ subtotal: 70, desconto: 5, total: 65 });
  });

  test('desconto do item nunca passa da linha', () => {
    const { dados } = lerCorpo({ items: [{ product_id: P, quantity: 1, unit_price: 10, item_discount: 50 }] }, { hoje: HOJE });
    expect(dados.itens[0]).toMatchObject({ item_discount: 10, subtotal: 0 });
  });

  test('data de hoje vale; ontem e data impossivel nao', () => {
    const base = { items: [{ product_id: P, quantity: 1, unit_price: 10 }] };
    expect(lerCorpo({ ...base, promised_date: HOJE }, { hoje: HOJE }).dados.promisedDate).toBe(HOJE);
    expect(lerCorpo({ ...base, promised_date: '2026-11-16' }, { hoje: HOJE }).erro.code).toBe('PEDIDO_DATA');
    expect(lerCorpo({ ...base, promised_date: '2026-02-30' }, { hoje: HOJE }).erro.code).toBe('PEDIDO_DATA');
    expect(lerCorpo({ ...base, promised_date: '' }, { hoje: HOJE }).dados.promisedDate).toBeNull();
  });

  test('variante sem produto e quantidade quebrada sao recusadas', () => {
    expect(lerCorpo({ items: [{ variant_id: V, product_name: 'x', quantity: 1, unit_price: 1 }] }, { hoje: HOJE }).erro.code).toBe('PEDIDO_ITEM_INVALIDO');
    expect(lerCorpo({ items: [{ product_id: P, quantity: 0.5, unit_price: 1 }] }, { hoje: HOJE }).erro.code).toBe('PEDIDO_QUANTIDADE');
    expect(lerCorpo({ items: new Array(101).fill({ product_id: P, quantity: 1, unit_price: 1 }) }, { hoje: HOJE }).erro.code).toBe('PEDIDO_ITENS_DEMAIS');
  });

  test('nome e telefone: espacos e controle saem, +55 sai', () => {
    const { dados } = lerCorpo({
      items: [{ product_id: P, quantity: 1, unit_price: 1 }],
      customer_name: ' Ana\u0000  Paula ', customer_phone: '+55 (11) 98888-7777', notes: '  ',
    }, { hoje: HOJE });
    expect(dados).toMatchObject({ customerName: 'Ana Paula', customerPhone: '11988887777', notes: null });
  });

  test('customer_id que nao e uuid: 404 de cliente', () => {
    expect(lerCorpo({ items: [{ product_id: P, quantity: 1, unit_price: 1 }], customer_id: 'abc' }, { hoje: HOJE }).erro)
      .toMatchObject({ status: 404, code: 'CUSTOMER_NOT_FOUND' });
  });
});

describe('lerChave', () => {
  test('cabecalho vale sobre o corpo; formato fora do padrao e ignorado', () => {
    expect(lerChave({ headers: { 'idempotency-key': 'abcdefgh-1' }, body: { idempotency_key: 'outra-chave-1' } })).toBe('abcdefgh-1');
    expect(lerChave({ headers: {}, body: { idempotency_key: 'outra-chave-1' } })).toBe('outra-chave-1');
    expect(lerChave({ headers: { 'idempotency-key': 'curta' }, body: {} })).toBeNull();
    expect(lerChave({ headers: {}, body: {} })).toBeNull();
  });
});

describe('trava PEDIDO_LIBERADO', () => {
  const antes = process.env.PEDIDO_LIBERADO;
  afterEach(() => { if (antes === undefined) delete process.env.PEDIDO_LIBERADO; else process.env.PEDIDO_LIBERADO = antes; });

  test('desligada: so equipe Aura (is_staff ou admin)', () => {
    delete process.env.PEDIDO_LIBERADO;
    expect(pedidoLiberado({ user: { role: 'client' } })).toBe(false);
    expect(pedidoLiberado({ user: { role: 'client', is_staff: true } })).toBe(true);
    expect(pedidoLiberado({ user: { role: 'admin' } })).toBe(true);
    expect(pedidoLiberado({})).toBe(false);
  });
  test('ligada no ambiente: todo lojista', () => {
    process.env.PEDIDO_LIBERADO = 'true';
    expect(pedidoLiberado({ user: { role: 'client' } })).toBe(true);
    process.env.PEDIDO_LIBERADO = 'false';
    expect(pedidoLiberado({ user: { role: 'client' } })).toBe(false);
  });
});

test('hojeSP usa o fuso de Sao Paulo', () => {
  expect(hojeSP(new Date('2026-11-18T02:30:00Z'))).toBe('2026-11-17');
  expect(hojeSP(new Date('2026-11-18T03:30:00Z'))).toBe('2026-11-18');
});
