// ============================================================
// AURA. — Pedido de orcamento quitado e entregue (B1b): regras sem banco.
// O caminho com Postgres real esta em pedidoDeOrcamento.quitadoEntregue.banco.test.js.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));
jest.mock('../src/services/nfceEmissionService', () => ({ emitForDigitalOrder: jest.fn() }));
jest.mock('../src/services/financeiroDoOrcamento', () => ({ marcoLancaNoFinanceiro: jest.fn() }));

const fin = require('../src/services/financeiroDoOrcamento');
const lojaEvents = require('../src/services/lojaEvents');
const { quitarSeRecebeuTudo, entregarPedidoDeOrcamento, PAGO } = require('../src/services/entregaDoPedidoDeOrcamento');
const { baixarEstoqueDoPedido } = require('../src/services/digitalOrderConfirmation');

// Banco em memoria so do que a entrega toca.
function banco({ pedido, itens, estoques }) {
  const estado = { pedido: { ...pedido }, estoques: { ...estoques }, sqls: [] };
  const client = {
    query: jest.fn(async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      estado.sqls.push(s);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
      if (/FROM digital_orders WHERE id = \$1 AND company_id = \$2 FOR UPDATE/.test(s)) {
        return { rows: estado.pedido.id === params[0] ? [{ ...estado.pedido }] : [] };
      }
      if (/FROM digital_order_items/.test(s)) return { rows: itens };
      if (/SET delivered_at = NOW\(\)/.test(s)) { estado.pedido.delivered_at = new Date(); return { rows: [] }; }
      if (/SET stock_deducted = TRUE/.test(s)) { estado.pedido.stock_deducted = true; return { rows: [] }; }
      if (/UPDATE products SET stock_qty = GREATEST/.test(s)) {
        const [qtd, pid] = params;
        estado.estoques[pid] = Math.max(0, estado.estoques[pid] - Number(qtd));
        return { rows: [{ id: pid, name: 'Caneca', stock_qty: estado.estoques[pid], stock_min: 0 }] };
      }
      if (/UPDATE digital_orders SET payment_status/.test(s)) {
        if (estado.pedido.payment_status === 'pending') { estado.pedido.payment_status = params[2]; return { rowCount: 1, rows: [] }; }
        return { rowCount: 0, rows: [] };
      }
      throw new Error('SQL nao esperado: ' + s);
    }),
    release: jest.fn(),
  };
  return { estado, client, db: { connect: async () => client, query: client.query } };
}

const PEDIDO = { id: 'o1', company_id: 'c1', status: 'confirmed', stock_deducted: false, delivered_at: null, payment_status: 'pending' };
const ITENS = [{ order_id: 'o1', product_id: 'p1', variant_id: null, quantity: 2 }, { order_id: 'o1', product_id: null, variant_id: null, quantity: 1 }];

beforeEach(() => { jest.clearAllMocks(); fin.marcoLancaNoFinanceiro.mockResolvedValue(true); });

describe('quitarSeRecebeuTudo', () => {
  test('recebido igual ao total: pending vira paid (o valor que o banco aceita)', async () => {
    const { estado, client } = banco({ pedido: PEDIDO, itens: ITENS, estoques: {} });
    expect(PAGO).toBe('paid');
    expect(await quitarSeRecebeuTudo(client, { companyId: 'c1', orderId: 'o1', total: 100, recebido: 100 })).toBe(true);
    expect(estado.pedido.payment_status).toBe('paid');
  });
  test('recebido menor que o total (so o sinal): nao marca', async () => {
    const { estado, client } = banco({ pedido: PEDIDO, itens: ITENS, estoques: {} });
    expect(await quitarSeRecebeuTudo(client, { companyId: 'c1', orderId: 'o1', total: 100, recebido: 30 })).toBe(false);
    expect(estado.pedido.payment_status).toBe('pending');
  });
  test('diferenca de centavo de arredondamento ainda quita; total zero nunca', async () => {
    const { client } = banco({ pedido: PEDIDO, itens: ITENS, estoques: {} });
    expect(await quitarSeRecebeuTudo(client, { companyId: 'c1', orderId: 'o1', total: 100.004, recebido: 100 })).toBe(true);
    expect(await quitarSeRecebeuTudo(client, { companyId: 'c1', orderId: 'o1', total: 0, recebido: 0 })).toBe(false);
  });
});

describe('entregarPedidoDeOrcamento', () => {
  test('entrega: grava delivered_at e baixa o estoque (so item com produto)', async () => {
    const { estado, db } = banco({ pedido: PEDIDO, itens: ITENS, estoques: { p1: 10 } });
    const r = await entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' });
    expect(r).toEqual({ aplicou: true, baixou: true, jaEntregue: false });
    expect(estado.pedido.delivered_at).toBeTruthy();
    expect(estado.pedido.stock_deducted).toBe(true);
    expect(estado.estoques.p1).toBe(8);
    expect(estado.pedido.payment_status).toBe('pending'); // entregar nao marca pago
  });

  test('entregar duas vezes: baixa uma vez so e delivered_at fica', async () => {
    const { estado, db } = banco({ pedido: PEDIDO, itens: ITENS, estoques: { p1: 10 } });
    await entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' });
    const primeira = estado.pedido.delivered_at;
    const r2 = await entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' });
    expect(r2).toEqual({ aplicou: true, baixou: false, jaEntregue: true });
    expect(estado.estoques.p1).toBe(8);
    expect(estado.pedido.delivered_at).toBe(primeira);
  });

  test('pedido ja com stock_deducted TRUE (ex.: confirmado pela loja): nao baixa', async () => {
    const { estado, db } = banco({ pedido: { ...PEDIDO, stock_deducted: true }, itens: ITENS, estoques: { p1: 10 } });
    const r = await entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' });
    expect(r.baixou).toBe(false);
    expect(estado.estoques.p1).toBe(10);
  });

  test('fora do fluxo novo do orcamento: nada acontece', async () => {
    fin.marcoLancaNoFinanceiro.mockResolvedValue(false);
    const { estado, db, client } = banco({ pedido: PEDIDO, itens: ITENS, estoques: { p1: 10 } });
    expect(await entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' })).toEqual({ aplicou: false });
    expect(client.query).not.toHaveBeenCalled();
    expect(estado.estoques.p1).toBe(10);
  });

  test('pedido cancelado ou de outra loja: nada acontece e a transacao e desfeita', async () => {
    const a = banco({ pedido: { ...PEDIDO, status: 'cancelled' }, itens: ITENS, estoques: { p1: 10 } });
    expect(await entregarPedidoDeOrcamento(a.db, { companyId: 'c1', orderId: 'o1' })).toEqual({ aplicou: false });
    expect(a.estado.sqls).toContain('ROLLBACK');
    expect(a.estado.estoques.p1).toBe(10);
    const b = banco({ pedido: PEDIDO, itens: ITENS, estoques: { p1: 10 } });
    expect(await entregarPedidoDeOrcamento(b.db, { companyId: 'c1', orderId: 'outro' })).toEqual({ aplicou: false });
  });

  test('erro no meio da baixa: ROLLBACK, libera o client e propaga (a etapa nao muda)', async () => {
    const { client, db } = banco({ pedido: PEDIDO, itens: ITENS, estoques: { p1: 10 } });
    const orig = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, p) => {
      if (/UPDATE products/.test(sql)) throw new Error('falhou');
      return orig(sql, p);
    });
    await expect(entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' })).rejects.toThrow('falhou');
    expect(client.query.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  test('cruzar o estoque minimo avisa o sino depois do COMMIT', async () => {
    const { client, db } = banco({ pedido: PEDIDO, itens: ITENS, estoques: { p1: 3 } });
    const orig = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, p) => {
      const r = await orig(sql, p);
      if (/UPDATE products/.test(sql)) r.rows[0].stock_min = 2;
      return r;
    });
    await entregarPedidoDeOrcamento(db, { companyId: 'c1', orderId: 'o1' });
    expect(lojaEvents.emit).toHaveBeenCalledWith('loja_estoque_baixo', expect.objectContaining({ id: 'o1' }), expect.anything());
  });
});

describe('baixarEstoqueDoPedido (o mesmo da confirmacao da loja online)', () => {
  test('variante baixa product_variants; stock_deducted TRUE sai sem tocar em nada', async () => {
    const calls = [];
    const client = { query: jest.fn(async (sql, p) => { calls.push([String(sql).replace(/\s+/g, ' ').trim(), p]); return { rows: [] }; }) };
    const r = await baixarEstoqueDoPedido(client, { id: 'o1', stock_deducted: false },
      [{ variant_id: 'v1', quantity: 3 }]);
    expect(r.baixou).toBe(true);
    expect(calls[0][0]).toMatch(/^UPDATE product_variants SET stock_qty = GREATEST\(0, stock_qty - \$1\)/);
    expect(calls[0][1]).toEqual([3, 'v1']);
    client.query.mockClear();
    expect(await baixarEstoqueDoPedido(client, { id: 'o1', stock_deducted: true }, [{ variant_id: 'v1', quantity: 3 }]))
      .toEqual({ crossedMinimum: [], baixou: false });
    expect(client.query).not.toHaveBeenCalled();
  });
});
