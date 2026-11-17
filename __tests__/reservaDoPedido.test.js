// ============================================================
// AURA. — Reserva calculada (B2): regras sem banco
// services/reservaDoPedido.js. A soma de verdade, no Postgres, esta em
// reservaDoPedido.banco.test.js.
// ============================================================
'use strict';

const R = require('../src/services/reservaDoPedido');

const P = '11111111-2222-3333-4444-555555555555';
const V = '66666666-7777-8888-9999-000000000000';

test('o SQL conta so pedido do balcao aberto, sem baixa, do grupo e fora da encomenda', () => {
  const sql = R.SQL_RESERVAS.replace(/\s+/g, ' ');
  expect(sql).toContain("o.origem = 'balcao'");
  expect(sql).toContain("ARRAY['confirmed','preparing','ready']");
  expect(sql).toContain('o.stock_deducted IS NOT TRUE');
  expect(sql).toContain('NOT (p.is_personalizable IS TRUE AND p.customization_config IS NOT NULL)');
  expect(sql).toContain('o.company_id IN (');
  const maior = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  expect(maior).toBe(3);
});

test('sem id uuid: nenhuma ida ao banco', async () => {
  const q = { query: jest.fn() };
  const m = await R.lerReservas(q, 'c1', ['p1', 'abc', null]);
  expect(m.size).toBe(0);
  expect(q.query).not.toHaveBeenCalled();
});

test('soma por produto, por variante e sem variante', async () => {
  const q = { query: jest.fn(async () => ({ rows: [
    { product_id: P, variant_id: V, qtd: '2' },
    { product_id: P, variant_id: null, qtd: '1.5' },
  ] })) };
  const m = await R.lerReservas(q, 'c1', [P, P], { ignorarPedido: null });
  expect(q.query.mock.calls[0][1]).toEqual(['c1', [P], null]);
  expect(R.reservadoDoProduto(m, P)).toBe(3.5);
  expect(R.reservadoDaVariante(m, P, V)).toBe(2);
  expect(R.reservadoDaVariante(m, P, null)).toBe(1.5);
  expect(R.reservadoDoProduto(m, 'outro')).toBe(0);
});

test('lerReservasSemFalhar: erro vira reserva 0', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const q = { query: jest.fn(async () => { throw Object.assign(new Error('x'), { code: '42703' }); }) };
  const m = await R.lerReservasSemFalhar(q, 'c1', [P]);
  expect(R.reservadoDoProduto(m, P)).toBe(0);
  console.error.mockRestore();
});
