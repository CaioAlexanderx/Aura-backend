// ============================================================
// AURA. — Troca do Caixa com origem em pedido da loja online (27/10/2026)
//
// Sem banco: client de mentira que responde por padrao de SQL. Cobre
//   - a busca (formato, elegibilidade, filtros, juntar com vendas);
//   - o trocaV2.handle com pedido online como origem: elegibilidade, guarda
//     contra devolver duas vezes, estoque reposto na variante do pedido,
//     fiscal 'none', item gravado com as colunas da migration 415;
//   - venda do Caixa continua indo pelo caminho de sempre;
//   - cancelar o pedido depois da troca nao devolve de novo o que ja voltou.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ connect: jest.fn(), query: jest.fn() }));
jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));
jest.mock('../src/services/trocaDevolucao55', () => ({ handle: jest.fn() }));

const db = require('../src/config/database');
const trocaV2 = require('../src/services/trocaV2');
const { buscarPedidosParaTroca, juntarComPedidos } = require('../src/services/trocaPedidoOnline');
const { devolverEstoqueDoPedido } = require('../src/services/devolucaoDoEstoqueDoPedido');

const EMPRESA = 'c0000000-0000-0000-0000-000000000001';
const PEDIDO = 'd0000000-0000-0000-0000-000000000012';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ── client de mentira do handle ─────────────────────────────
function clientDaTroca({ pedido, itens, jaDevolvido = [], venda } = {}) {
  const chamadas = [];
  const c = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = norm(sql);
      chamadas.push([s, params]);
      if (/FROM digital_orders o JOIN companies c/.test(s)) return { rows: pedido ? [pedido] : [] };
      if (/FROM digital_order_items WHERE order_id IN/.test(s)) return { rows: itens || [] };
      if (/original_digital_order_item_id AS item_id, SUM/.test(s)) return { rows: jaDevolvido };
      if (/^SELECT s\.id, s\.status, s\.company_id/.test(s)) return { rows: venda ? [venda] : [] };
      if (/^SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot FROM sale_items/.test(s)) {
        return { rows: venda ? venda.items : [] };
      }
      if (/information_schema\.columns/.test(s)) return { rows: [{ n: '2' }] };
      if (/^INSERT INTO troca_payouts/.test(s)) return { rows: [{ id: 'po-1' }] };
      if (/^INSERT INTO sales/.test(s)) return { rows: [{ id: 'troca-1', company_id: params[0], customer_id: params[1] }] };
      if (/^SELECT company_id FROM products WHERE id=\$1/.test(s)) return { rows: [{ company_id: EMPRESA }] };
      if (/^UPDATE product_variants SET stock_qty = stock_qty - \$1/.test(s)) return { rows: [{ stock_qty: 5 }] };
      if (/^UPDATE products SET stock_qty = stock_qty - \$1/.test(s)) return { rows: [{ stock_qty: 5 }] };
      if (/^SELECT p\.company_id AS stock_company_id/.test(s)) return { rows: [{ stock_company_id: EMPRESA }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { c, chamadas, sqls: () => chamadas.map(([s]) => s) };
}

function resFalso() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}

const pedidoOk = {
  id: PEDIDO, order_number: '00012', status: 'delivered', payment_status: 'confirmed',
  stock_deducted: true, company_id: EMPRESA, customer_id: 'cli-1', total: '40.00',
  created_at: '2026-10-16T22:36:21Z', nfce_id: null,
};
const itensOk = [{
  id: '61', order_id: PEDIDO, product_id: 'prod-1', variant_id: 'var-1',
  quantity: 1, unit_price: '40.00', product_name: 'Vestido', variant_label: 'M / Azul',
}];

function reqTroca(extra = {}) {
  return {
    params: { id: EMPRESA },
    user: { id: 'user-1' },
    body: {
      original_sale_ids: [],
      original_digital_order_ids: [PEDIDO],
      returned_items: [{
        original_digital_order_id: PEDIDO,
        original_digital_order_item_id: '61',
        // payload "errado" de proposito: o produto/variante vem do pedido
        product_id: 'outro-produto', variant_id: 'outra-variante',
        quantity: 1, unit_price: 40,
      }],
      new_items: [],
      refund_splits: [{ method: 'crediario_credito', amount: 40 }],
      nfce_strategy: 'none',
      ...extra,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

describe('trocaV2.handle — pedido da loja online como origem', () => {
  test('troca so com pedido online: grava o item com as colunas novas, repoe a variante do pedido e fiscal fica none', async () => {
    const { c, chamadas, sqls } = clientDaTroca({ pedido: pedidoOk, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);

    expect(res.statusCode).toBe(201);
    expect(res.body.original_sale_ids).toEqual([]);
    expect(res.body.original_digital_order_ids).toEqual([PEDIDO]);
    expect(res.body.returned_value).toBe(40);
    expect(res.body.fiscal.per_origin).toEqual([
      expect.objectContaining({ origin_sale_id: null, origin_digital_order_id: PEDIDO, origin_order_number: '00012', strategy: 'none', status: 'none' }),
    ]);

    const s = sqls();
    // trava a linha do pedido
    expect(s.find((x) => /FROM digital_orders o JOIN companies c/.test(x))).toMatch(/FOR UPDATE OF o$/);
    // venda do Caixa nao e consultada
    expect(s.some((x) => /^SELECT s\.id, s\.status, s\.company_id/.test(x))).toBe(false);

    const venda = chamadas.find(([x]) => /^INSERT INTO sales/.test(x));
    expect(venda[1]).toContain('Troca v2 — pedido da loja online #00012');
    expect(venda[1][venda[1].length - 1]).toBeNull(); // exchange_of_sale_id

    const tri = chamadas.filter(([x]) => /^INSERT INTO troca_returned_items/.test(x));
    expect(tri).toHaveLength(1);
    expect(tri[0][0]).toMatch(/original_digital_order_id, original_digital_order_item_id/);
    expect(tri[0][1].slice(0, 5)).toEqual(['troca-1', PEDIDO, '61', 'prod-1', 'var-1']);

    // repoe UMA vez, na variante do pedido (nao a do payload)
    const repoe = chamadas.filter(([x]) => /^UPDATE product_variants SET stock_qty=stock_qty\+\$1/.test(x));
    expect(repoe).toHaveLength(1);
    expect(repoe[0][1]).toEqual([1, 'var-1']);
    expect(s.some((x) => /^UPDATE products SET stock_qty=stock_qty\+/.test(x))).toBe(false);

    // credito na loja vai pro cliente vinculado ao pedido
    const credito = chamadas.find(([x]) => /^INSERT INTO customer_credit_transactions/.test(x));
    expect(credito[1][1]).toBe('cli-1');

    // financeiro com descricao do pedido
    const lanc = chamadas.find(([x]) => /^INSERT INTO transactions/.test(x));
    expect(lanc[1][1]).toBe(40);
    expect(lanc[1][2]).toBe('Troca PDV — pedido da loja online #00012');

    expect(s).toContain('COMMIT');
  });

  test.each([
    ['cancelado', { status: 'cancelled' }],
    ['sem baixa de estoque (nao confirmado)', { status: 'pending_payment', stock_deducted: false }],
  ])('pedido %s: 409 DIGITAL_ORDER_NOT_ELIGIBLE e nada gravado', async (_n, patch) => {
    const { c, sqls } = clientDaTroca({ pedido: { ...pedidoOk, ...patch }, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DIGITAL_ORDER_NOT_ELIGIBLE');
    expect(res.body.error).toMatch(/#00012/);
    expect(sqls().some((x) => /^INSERT INTO (sales|troca_returned_items)/.test(x))).toBe(false);
    expect(sqls()).toContain('ROLLBACK');
  });

  test('pedido de fora do grupo: 404', async () => {
    const { c } = clientDaTroca({ pedido: null, itens: [] });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('DIGITAL_ORDER_NOT_FOUND');
  });

  test('item ja devolvido em troca anterior: 409 DOUBLE_RETURN_BLOCKED, estoque nao volta de novo', async () => {
    const { c, sqls } = clientDaTroca({ pedido: pedidoOk, itens: itensOk, jaDevolvido: [{ item_id: '61', already_returned: '1' }] });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DOUBLE_RETURN_BLOCKED');
    expect(res.body.original_digital_order_item_id).toBe('61');
    expect(sqls().some((x) => /^UPDATE product_variants SET stock_qty=stock_qty\+/.test(x))).toBe(false);
    expect(sqls().some((x) => /^INSERT INTO sales/.test(x))).toBe(false);
  });

  test('item que nao e do pedido: 400', async () => {
    const { c } = clientDaTroca({ pedido: pedidoOk, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    const req = reqTroca();
    req.body.returned_items[0].original_digital_order_item_id = '999';
    await trocaV2.handle(req, res);
    expect(res.statusCode).toBe(400);
  });

  test('quantidade acima da do pedido: 400', async () => {
    const { c } = clientDaTroca({ pedido: pedidoOk, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    const req = reqTroca();
    req.body.returned_items[0].quantity = 2;
    await trocaV2.handle(req, res);
    expect(res.statusCode).toBe(400);
  });

  test('sem venda nem pedido: 400 de sempre', async () => {
    const { c } = clientDaTroca({});
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ original_digital_order_ids: [], original_sale_ids: [] }), res);
    expect(res.statusCode).toBe(400);
  });

  test('venda do Caixa: mesmo caminho de antes (nao consulta pedido online, grava original_sale_id)', async () => {
    const venda = {
      id: 'venda-1', status: 'completed', company_id: EMPRESA, seller_id: 'u', employee_id: null,
      created_at: '2026-10-20T10:00:00Z', total_amount: 50, customer_id: null,
      items: [{ id: 'si-1', sale_id: 'venda-1', product_id: 'prod-2', variant_id: null, quantity: 1, unit_price: 50, product_name_snapshot: 'Blusa' }],
    };
    const { c, chamadas, sqls } = clientDaTroca({ venda });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle({
      params: { id: EMPRESA }, user: { id: 'user-1' },
      body: {
        original_sale_ids: ['venda-1'],
        returned_items: [{ original_sale_id: 'venda-1', original_sale_item_id: 'si-1', product_id: 'prod-2', quantity: 1, unit_price: 50 }],
        new_items: [], nfce_strategy: 'none',
      },
    }, res);
    expect(res.statusCode).toBe(201);
    expect(sqls().some((x) => /digital_orders/.test(x))).toBe(false);
    const tri = chamadas.find(([x]) => /^INSERT INTO troca_returned_items/.test(x));
    expect(tri[0]).not.toMatch(/original_digital_order_id/);
    expect(tri[1].slice(0, 3)).toEqual(['troca-1', 'venda-1', 'si-1']);
    const venda1 = chamadas.find(([x]) => /^INSERT INTO sales/.test(x));
    expect(venda1[1]).toContain('Troca v2 — 1 venda(s) original(is)');
    expect(venda1[1][venda1[1].length - 1]).toBe('venda-1');
    const lanc = chamadas.find(([x]) => /^INSERT INTO transactions/.test(x));
    expect(lanc[1][2]).toBe('Troca PDV — venda venda-1');
  });
});

// ── busca ────────────────────────────────────────────────────
describe('buscarPedidosParaTroca', () => {
  function dbBusca(rows = []) {
    return { query: jest.fn(async () => ({ rows })) };
  }

  test('so pedidos elegiveis e do grupo; formato da venda com origin_kind', async () => {
    const banco = dbBusca([{
      id: PEDIDO, order_number: '00012', status: 'delivered', payment_status: 'pending',
      payment_method: 'on_delivery', total: '40.00', created_at: '2026-10-16T22:36:21Z',
      company_id: EMPRESA, company_name: 'Loja', customer_id: null, customer_name: 'Cliente',
      customer_phone: '11999990000', customer_cpf_cnpj: null, is_cross_filial: false,
      item_count: '1', items: [{ original_digital_order_item_id: '61', quantity: 1, unit_price: 40 }],
    }]);
    const rows = await buscarPedidosParaTroca(banco, EMPRESA, {});
    const [sql, vals] = banco.query.mock.calls[0];
    expect(norm(sql)).toMatch(/o\.status<>'cancelled' AND o\.stock_deducted=TRUE/);
    expect(norm(sql)).toMatch(/billing_owner_company_id/);
    expect(vals).toEqual([EMPRESA]);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: PEDIDO, origin_kind: 'digital_order', order_number: '00012',
      digital_status: 'delivered', payment_status: 'pending', total_amount: 40,
      has_nfce: false, item_count: 1, seller_name: null,
    }));
  });

  test('numero do pedido com # e telefone por digitos', async () => {
    const banco = dbBusca();
    await buscarPedidosParaTroca(banco, EMPRESA, { order_number: '#00012' });
    expect(banco.query.mock.calls[0][1]).toEqual([EMPRESA, '%00012%']);

    const b2 = dbBusca();
    await buscarPedidosParaTroca(b2, EMPRESA, { q: '(11) 99999-0000' });
    const [sql2, vals2] = b2.query.mock.calls[0];
    expect(norm(sql2)).toMatch(/regexp_replace\(COALESCE\(o\.customer_phone,''\),'\\D','','g'\) LIKE \$3/);
    expect(vals2).toEqual([EMPRESA, '%(11) 99999-0000%', '%11999990000%']);

    const b3 = dbBusca();
    await buscarPedidosParaTroca(b3, EMPRESA, { q: 'maria' });
    expect(b3.query.mock.calls[0][1]).toEqual([EMPRESA, '%maria%']);
  });

  test('codigo de barras casa produto/variante do item', async () => {
    const banco = dbBusca();
    await buscarPedidosParaTroca(banco, EMPRESA, { barcodes: ['7891234567890'] });
    const [sql, vals] = banco.query.mock.calls[0];
    expect(norm(sql)).toMatch(/v3\.barcode=ANY\(\$2::text\[\]\) OR p3\.barcode=ANY\(\$2::text\[\]\)/);
    expect(vals[1]).toEqual(['7891234567890']);
  });

  test('chave de NFC-e nao traz pedido (pedido online nao tem nota)', async () => {
    const banco = dbBusca();
    expect(await buscarPedidosParaTroca(banco, EMPRESA, { nfce_chave: '3'.repeat(44) })).toEqual([]);
    expect(banco.query).not.toHaveBeenCalled();
  });
});

describe('juntarComPedidos', () => {
  test('mistura por data, mais recente primeiro, no limite', async () => {
    const vendas = [{ id: 'v1', created_at: '2026-10-20T10:00:00Z' }, { id: 'v2', created_at: '2026-10-10T10:00:00Z' }];
    const pedidos = [{ id: 'p1', created_at: '2026-10-15T10:00:00Z' }];
    const out = await juntarComPedidos(vendas, async () => pedidos, 2);
    expect(out.map((r) => r.id)).toEqual(['v1', 'p1']);
  });

  test('busca de pedidos falhando nao derruba a das vendas', async () => {
    const vendas = [{ id: 'v1', created_at: '2026-10-20T10:00:00Z' }];
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await juntarComPedidos(vendas, async () => { throw new Error('column x does not exist'); }, 50);
    expect(out).toBe(vendas);
    warn.mockRestore();
  });
});

// ── cancelamento do pedido depois da troca ──────────────────
describe('devolverEstoqueDoPedido depois de troca no Caixa', () => {
  function clientCancel({ jaDevolvido, falhaTroca } = {}) {
    const chamadas = [];
    const c = {
      release: jest.fn(),
      query: jest.fn(async (sql, params) => {
        const s = norm(sql);
        chamadas.push([s, params]);
        if (/^SELECT id, order_number, status, stock_deducted/.test(s)) {
          return { rows: [{ id: PEDIDO, order_number: '00012', status: 'cancelled', stock_deducted: true }] };
        }
        if (/^SELECT product_id, variant_id, quantity/.test(s)) {
          return { rows: [
            { id: '61', product_id: 'prod-1', variant_id: 'var-1', quantity: 2 },
            { id: '62', product_id: 'prod-3', variant_id: null, quantity: 1 },
          ] };
        }
        if (/FROM troca_returned_items tri/.test(s)) {
          if (falhaTroca) throw Object.assign(new Error('column does not exist'), { code: '42703' });
          return { rows: jaDevolvido || [] };
        }
        if (/^UPDATE product_variants/.test(s)) return { rows: [{ product_id: 'prod-1' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    return { c, chamadas };
  }

  test('devolve so o que ainda nao voltou pela troca', async () => {
    const { c, chamadas } = clientCancel({ jaDevolvido: [{ item_id: '61', qtd: '1' }, { item_id: '62', qtd: '1' }] });
    const r = await devolverEstoqueDoPedido(PEDIDO, { client: c });
    expect(r).toEqual({ devolvido: true, itens: 1 });
    const variante = chamadas.filter(([x]) => /^UPDATE product_variants SET stock_qty = stock_qty \+ \$1/.test(x));
    expect(variante).toHaveLength(1);
    expect(variante[0][1]).toEqual([1, 'var-1']);
    expect(chamadas.some(([x]) => /^UPDATE products SET stock_qty = stock_qty \+/.test(x))).toBe(false);
  });

  test('sem a coluna da 415 (deploy parcial): devolve tudo, como antes', async () => {
    const { c, chamadas } = clientCancel({ falhaTroca: true });
    const r = await devolverEstoqueDoPedido(PEDIDO, { client: c });
    expect(r).toEqual({ devolvido: true, itens: 2 });
    expect(chamadas.map(([x]) => x)).toContain('ROLLBACK TO SAVEPOINT sp_troca_do_pedido');
  });
});
