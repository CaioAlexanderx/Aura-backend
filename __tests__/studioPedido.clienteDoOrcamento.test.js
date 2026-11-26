'use strict';
// Pedido do orcamento herda o customer_id do orcamento (reteste 26/11, P1-3).
const { inserirPedidoStudio } = require('../src/services/studioPedido');

function clientFalso() {
  const calls = [];
  return { calls, query: jest.fn(async (sql, p) => { calls.push([String(sql).replace(/\s+/g, ' '), p]); return { rows: [{ id: 'o1' }] }; }) };
}

describe('inserirPedidoStudio: customer_id', () => {
  test('com customerId: grava o vinculo, conferindo que o cliente e da mesma empresa', async () => {
    const c = clientFalso();
    await inserirPedidoStudio(c, { cid: 'c1', customerName: 'Ana', customerPhone: '11911112222', total: 49.9, customerId: 'cli-1' });
    const [sql, params] = c.calls[0];
    expect(sql).toMatch(/studio_bulk_event_id, customer_id\)/);
    expect(sql).toMatch(/SELECT c\.id FROM customers c WHERE c\.id = \$8 AND c\.company_id = \$1/);
    expect(params[7]).toBe('cli-1');
  });
  test('sem customerId: null (evento em lote segue como antes)', async () => {
    const c = clientFalso();
    await inserirPedidoStudio(c, { cid: 'c1', total: 10 });
    expect(c.calls[0][1][7]).toBeNull();
  });
});
