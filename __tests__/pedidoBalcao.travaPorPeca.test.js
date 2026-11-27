// ============================================================
// AURA — Trava por peca no pedido do balcao (reserva pelo WhatsApp)
//
// A trava (pg_advisory_xact_lock por produto) fica SO no caminho do pedido:
//  (1) guardarPedido trava ANTES de conferir o saldo, na mesma transacao;
//  (2) a venda do Caixa (pdv.js) nao usa a trava nem o helper: segue igual;
//  (3) conferirSaldo continua puro (mesma conta de livres de sempre).
// A corrida de verdade (dois pedidos, uma peca) esta em pedidoBalcao.banco.test.js.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database');
jest.mock('../src/services/sinalDoPedido', () => ({
  lerSinal: () => ({ dados: null }), criarContaAReceber: jest.fn(), registrarSinal: jest.fn(),
  comSinal: async (_q, p) => p,
}));
jest.mock('../src/utils/vendaSemEstoque', () => ({ vendaSemEstoqueLiberada: jest.fn().mockResolvedValue(false) }));

const db = require('../src/config/database');
const pedidoBalcao = require('../src/services/pedidoBalcao');

const LOJA = '11111111-1111-4111-8111-111111111111';
const PROD = '22222222-2222-4222-8222-222222222222';
const VAR = '33333333-3333-4333-8333-333333333333';

describe('trava por peca no pedido', () => {
  test('guardarPedido trava o produto antes de conferir o saldo, dentro da transacao', async () => {
    const sqls = [];
    const client = {
      release: jest.fn(),
      query: jest.fn(async (sql) => {
        const s = String(sql);
        sqls.push(s);
        if (s.includes('FROM products p')) return { rows: [{ id: PROD, name: 'Saia', stock_qty: 5, unit: 'un', sob_encomenda: false }] };
        if (s.includes('FROM product_variants WHERE id')) return { rows: [{ id: VAR, product_id: PROD, sku_suffix: 'M', stock_qty: 1 }] };
        if (s.includes('INSERT INTO digital_orders')) return { rows: [{ id: 'o1', order_number: 'PED-1', total: 10, promised_date: null }] };
        return { rows: [] };
      }),
    };
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });
    await pedidoBalcao.guardarPedido({
      companyId: LOJA, userId: 'u', chave: null, hoje: '2026-11-27',
      body: { items: [{ product_id: PROD, variant_id: VAR, quantity: 1, unit_price: 10 }] },
    }).catch(() => {});
    const iBegin = sqls.indexOf('BEGIN');
    const iTrava = sqls.findIndex((s) => s.includes('pg_advisory_xact_lock') && s.includes('condicional-peca'));
    const iLeitura = sqls.findIndex((s) => s.includes('FROM products p'));
    const iReservas = sqls.findIndex((s) => s.includes('FROM digital_order_items'));
    expect(iBegin).toBe(0);
    expect(iTrava).toBeGreaterThan(iBegin);
    expect(iTrava).toBeLessThan(iLeitura);
    expect(iTrava).toBeLessThan(iReservas);
  });

  test('a venda do Caixa nao usa a trava nem o helper', () => {
    const pdv = fs.readFileSync(path.join(__dirname, '../src/routes/pdv.js'), 'utf8');
    expect(pdv).not.toMatch(/travarPecas|condicional-peca/);
    const rota = fs.readFileSync(path.join(__dirname, '../src/routes/pedidosDoBalcao.js'), 'utf8');
    expect(rota).toMatch(/guardarPedido/);
  });

  test('conferirSaldo segue com a mesma conta de livres (sem trava propria)', async () => {
    const client = { query: jest.fn(async () => ({ rows: [] })) };
    const faltas = await pedidoBalcao.conferirSaldo(client, LOJA, [
      { product_id: PROD, variant_id: VAR, quantity: 2, estoque: 1, nome: 'Saia', sobEncomenda: false, servico: false },
    ]);
    expect(faltas).toHaveLength(1);
    expect(faltas[0]).toMatchObject({ estoque: 1, reservado: 0, livre: 1, quantidade: 2 });
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('pg_advisory'))).toBe(false);
  });
});
