// ============================================================
// AURA. — Troca: servico novo nao e barrado por saldo (INC-2026-11-18-02)
//
// Servico (products.unit = 'srv') nasce com saldo 0 e nunca tem estoque. Na
// troca, o item novo baixava com `stock_qty >= qtd` e, sem linha atualizada,
// a troca inteira caia em INSUFFICIENT_STOCK. Regra: servico nao e barrado
// nem baixado por saldo, e nao gera stock_movements. Produto comum segue
// igual (sem saldo, INSUFFICIENT_STOCK).
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
'use strict';

const { _internal } = require('../src/services/trocaV2');

const CID = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const SERVICO = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUTO = 'aaaaaaaa-0000-0000-0000-000000000002';
const VAR = 'bbbbbbbb-0000-0000-0000-000000000001';
const TROCA = 'cccccccc-0000-0000-0000-000000000001';

function mockClient({ unidades = {}, saldo = {} } = {}) {
  const query = jest.fn().mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/FROM product_variants pv JOIN products p/i.test(s)) {
      return Promise.resolve({ rows: [{ stock_company_id: CID, sku_suffix: 'P', unit: unidades[params[1]] || 'un' }] });
    }
    if (/SELECT p\.company_id AS stock_company_id/i.test(s)) {
      return Promise.resolve({ rows: [{ stock_company_id: CID, unit: unidades[params[0]] || 'un' }] });
    }
    if (/UPDATE products SET stock_qty = stock_qty - \$1/i.test(s)) {
      const tem = (saldo[params[1]] || 0) >= params[0];
      return Promise.resolve({ rows: tem ? [{ stock_qty: saldo[params[1]] - params[0] }] : [] });
    }
    if (/UPDATE product_variants SET stock_qty = stock_qty - \$1/i.test(s)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  return { query };
}

const chamadas = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

describe('troca: item novo que e servico', () => {
  test('servico com saldo zero: nao barra, nao baixa, nao gera movimento', async () => {
    const client = mockClient({ unidades: { [SERVICO]: 'srv' }, saldo: { [SERVICO]: 0 } });
    await expect(_internal.adjustStock(client, [], [{ product_id: SERVICO, quantity: 1 }], CID, TROCA)).resolves.toBeUndefined();
    expect(chamadas(client, /UPDATE products SET stock_qty/i)).toHaveLength(0);
    expect(chamadas(client, /INSERT INTO stock_movements/i)).toHaveLength(0);
  });

  test('servico com variante tambem nao baixa', async () => {
    const client = mockClient({ unidades: { [SERVICO]: 'srv' } });
    await _internal.adjustStock(client, [], [{ product_id: SERVICO, variant_id: VAR, quantity: 1 }], CID, TROCA);
    expect(chamadas(client, /UPDATE product_variants SET stock_qty/i)).toHaveLength(0);
    expect(chamadas(client, /INSERT INTO stock_movements/i)).toHaveLength(0);
  });

  test('produto comum sem saldo segue INSUFFICIENT_STOCK', async () => {
    const client = mockClient({ saldo: { [PRODUTO]: 0 } });
    await expect(_internal.adjustStock(client, [], [{ product_id: PRODUTO, quantity: 1 }], CID, TROCA))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', product_id: PRODUTO });
  });

  test('servico e produto com saldo juntos: so o produto baixa e movimenta', async () => {
    const client = mockClient({ unidades: { [SERVICO]: 'srv' }, saldo: { [PRODUTO]: 5 } });
    await _internal.adjustStock(client, [], [
      { product_id: SERVICO, quantity: 1 },
      { product_id: PRODUTO, quantity: 2 },
    ], CID, TROCA);
    const baixa = chamadas(client, /UPDATE products SET stock_qty = stock_qty - \$1/i);
    expect(baixa).toHaveLength(1);
    expect(baixa[0][1]).toEqual([2, PRODUTO, CID]);
    const mov = chamadas(client, /INSERT INTO stock_movements/i);
    expect(mov).toHaveLength(1);
    expect(mov[0][1][0]).toBe(PRODUTO);
  });
});
