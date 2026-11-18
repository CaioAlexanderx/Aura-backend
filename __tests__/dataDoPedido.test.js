// ============================================================
// AURA. — "Nova data" do pedido: leitura do corpo, sem banco (17/11/2026)
// ============================================================
'use strict';

const { lerNovaData, mudarDataDoPedido } = require('../src/services/dataDoPedido');

const HOJE = '2026-11-17';

describe('lerNovaData', () => {
  test('aceita hoje, dia depois e null; vazio vira null', () => {
    expect(lerNovaData({ promised_date: HOJE }, { hoje: HOJE })).toEqual({ data: HOJE });
    expect(lerNovaData({ promised_date: ' 2026-11-20 ' }, { hoje: HOJE })).toEqual({ data: '2026-11-20' });
    expect(lerNovaData({ promised_date: null }, { hoje: HOJE })).toEqual({ data: null });
    expect(lerNovaData({ promised_date: '' }, { hoje: HOJE })).toEqual({ data: null });
  });

  test.each([
    [{ promised_date: '2026-11-16' }, 'já passou'],
    [{ promised_date: '2026-02-30' }, 'inválida'],
    [{ promised_date: '20/11/2026' }, 'inválida'],
    [{ promised_date: 20261120 }, 'inválida'],
    [{ promised_date: { d: 1 } }, 'inválida'],
    [{}, 'Escolha a nova data'],
    [null, 'Escolha a nova data'],
  ])('%j: 422 PEDIDO_DATA', (body, trecho) => {
    let e;
    try { lerNovaData(body, { hoje: HOJE }); } catch (err) { e = err; }
    expect(e).toBeTruthy();
    expect(e.status).toBe(422);
    expect(e.code).toBe('PEDIDO_DATA');
    expect(e.message).toContain(trecho);
  });
});

describe('mudarDataDoPedido (consultas)', () => {
  test('so pedido do balcao, da loja, aberto e com data diferente; nenhuma outra tabela', async () => {
    const chamadas = [];
    const q = {
      query: jest.fn(async (sql, params) => {
        chamadas.push({ sql, params });
        if (/^\s*UPDATE digital_orders/.test(sql)) return { rows: [{ id: 'o1' }] };
        if (/FROM digital_orders WHERE id = \$1 AND company_id = \$2/.test(sql)) {
          return { rows: [{ id: 'o1', order_number: 'P-1', origem: 'balcao', status: 'confirmed', subtotal: 1, total: 1, promised_date: '2026-11-20' }] };
        }
        return { rows: [] };
      }),
    };
    const r = await mudarDataDoPedido(q, { companyId: 'c1', orderId: 'o1', body: { promised_date: '2026-11-20' }, hoje: HOJE });
    expect(r.ja_estava).toBe(false);
    const upd = chamadas[0];
    expect(upd.sql).toContain("origem = 'balcao'");
    expect(upd.sql).toContain('IS DISTINCT FROM');
    expect(upd.params).toEqual(['2026-11-20', 'o1', 'c1', ['confirmed', 'preparing', 'ready']]);
    // So digital_orders e os itens (leitura): nada de transactions, studio_payments, products.
    for (const c of chamadas) expect(c.sql).not.toMatch(/transactions|studio_payments|products|notifications/);
  });

  test('pedido fechado: 409 com a situacao; inexistente: 404', async () => {
    const fechado = { query: jest.fn(async (sql) => (/^\s*UPDATE/.test(sql) ? { rows: [] } : { rows: [{ status: 'delivered', promised_date: null }] })) };
    await expect(mudarDataDoPedido(fechado, { companyId: 'c1', orderId: 'o1', body: { promised_date: HOJE }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 409, code: 'PEDIDO_FECHADO', status_atual: 'delivered' });
    const nenhum = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(mudarDataDoPedido(nenhum, { companyId: 'c1', orderId: 'o1', body: { promised_date: HOJE }, hoje: HOJE }))
      .rejects.toMatchObject({ status: 404, code: 'PEDIDO_NAO_ENCONTRADO' });
  });
});
