// ============================================================
// AURA. — devolverEstoqueDoPedido com um client de mentira (19/10/2026)
//
// O comportamento no banco de verdade esta em
// canal.cancelarDevolveEstoque.banco.test.js. Aqui, a ordem das consultas
// e a transacao: trava a linha, decide pelo marcador, espelha a baixa
// (variante na variante), grava a entrada e zera o marcador — tudo entre
// BEGIN e COMMIT; erro faz ROLLBACK e solta a conexao.
// ============================================================
'use strict';

const { devolverEstoqueDoPedido } = require('../src/services/devolucaoDoEstoqueDoPedido');

function clientFalso({ pedido, itens = [], falhaEm } = {}) {
  const chamadas = [];
  const c = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      chamadas.push([s, params]);
      if (falhaEm && falhaEm.test(s)) throw new Error('falhou');
      if (/^SELECT id, order_number, status, stock_deducted/.test(s)) return { rows: pedido ? [pedido] : [] };
      if (/^SELECT product_id, variant_id, quantity/.test(s)) return { rows: itens };
      if (/^UPDATE product_variants/.test(s)) return { rows: [{ product_id: 'p-da-variante' }], rowCount: 1 };
      if (/^UPDATE products/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { c, chamadas, sqls: () => chamadas.map(([s]) => s) };
}
const banco = (c) => ({ connect: async () => c });

test('pedido cancelado com baixa: devolve produto e variante, grava as entradas e zera o marcador', async () => {
  const { c, chamadas, sqls } = clientFalso({
    pedido: { id: 'o1', order_number: '00011', status: 'cancelled', stock_deducted: true },
    itens: [
      { product_id: 'p1', variant_id: null, quantity: 2 },
      { product_id: 'p2', variant_id: 'v1', quantity: 1 },
    ],
  });
  const r = await devolverEstoqueDoPedido('o1', { db: banco(c) });
  expect(r).toEqual({ devolvido: true, itens: 2 });

  const s = sqls();
  expect(s[0]).toBe('BEGIN');
  expect(s[1]).toMatch(/FOR UPDATE$/);
  expect(s[s.length - 1]).toBe('COMMIT');
  expect(s.filter((x) => /^UPDATE products SET stock_qty = stock_qty \+ \$1/.test(x))).toHaveLength(1);
  expect(s.filter((x) => /^UPDATE product_variants SET stock_qty = stock_qty \+ \$1/.test(x))).toHaveLength(1);

  const entradas = chamadas.filter(([x]) => /^INSERT INTO stock_movements/.test(x));
  expect(entradas).toHaveLength(2);
  expect(entradas[0][0]).toMatch(/'in', \$2, \$3, 'digital_order_cancel'/);
  expect(entradas[0][1].slice(0, 3)).toEqual(['p1', 2, 'o1']);
  expect(entradas[1][1].slice(0, 3)).toEqual(['p2', 1, 'o1']);
  expect(s).toContain('UPDATE digital_orders SET stock_deducted = FALSE WHERE id = $1');
  expect(c.release).toHaveBeenCalled();
});

test.each([
  ['sem baixa', { id: 'o1', status: 'cancelled', stock_deducted: false }, 'sem_baixa'],
  ['ainda nao cancelado', { id: 'o1', status: 'confirmed', stock_deducted: true }, 'nao_cancelado'],
  ['inexistente', null, 'pedido_nao_encontrado'],
])('%s: nao mexe em estoque', async (_r, pedido, motivo) => {
  const { c, sqls } = clientFalso({ pedido, itens: [{ product_id: 'p1', quantity: 1 }] });
  expect(await devolverEstoqueDoPedido('o1', { db: banco(c) })).toEqual({ devolvido: false, motivo });
  expect(sqls().some((x) => /^UPDATE (products|product_variants)|^INSERT INTO stock_movements/.test(x))).toBe(false);
  expect(sqls()[sqls().length - 1]).toBe('COMMIT');
});

test('erro no meio: ROLLBACK e solta a conexao', async () => {
  const { c, sqls } = clientFalso({
    pedido: { id: 'o1', status: 'cancelled', stock_deducted: true },
    itens: [{ product_id: 'p1', quantity: 1 }],
    falhaEm: /^INSERT INTO stock_movements/,
  });
  await expect(devolverEstoqueDoPedido('o1', { db: banco(c) })).rejects.toThrow('falhou');
  expect(sqls()).toContain('ROLLBACK');
  expect(sqls()).not.toContain('COMMIT');
  expect(c.release).toHaveBeenCalled();
});

test('com client do chamador: nao abre nem fecha transacao', async () => {
  const { c, sqls } = clientFalso({
    pedido: { id: 'o1', status: 'cancelled', stock_deducted: true },
    itens: [{ product_id: 'p1', quantity: 1 }],
  });
  await devolverEstoqueDoPedido('o1', { client: c });
  expect(sqls()).not.toContain('BEGIN');
  expect(sqls()).not.toContain('COMMIT');
  expect(c.release).not.toHaveBeenCalled();
});

test('produto apagado: pula o item sem gravar entrada', async () => {
  const { c, chamadas } = clientFalso({
    pedido: { id: 'o1', status: 'cancelled', stock_deducted: true },
    itens: [{ product_id: 'sumiu', quantity: 1 }],
  });
  const original = c.query.getMockImplementation();
  c.query.mockImplementation(async (sql, params) => {
    if (/^\s*UPDATE products/.test(String(sql))) return { rows: [], rowCount: 0 };
    return original(sql, params);
  });
  const r = await devolverEstoqueDoPedido('o1', { db: banco(c) });
  expect(r).toEqual({ devolvido: true, itens: 0 });
  expect(chamadas.some(([x]) => /^INSERT INTO stock_movements/.test(x))).toBe(false);
});
