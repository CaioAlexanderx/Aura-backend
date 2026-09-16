// ============================================================
// AURA — FASE 1 do CRM: regra pura de atribuição de venda à mensagem
//
// Sem banco, sem HTTP: só a função attributeSales({ envios, vendas }).
// Cobertura pedida pela spec:
//  - direta (cupom da mensagem)
//  - estimada dentro da janela de 5 dias
//  - estimada fora da janela (não atribui)
//  - sem leitura usa o envio como base da janela
//  - duas mensagens na janela → vai para a mais recente (last-touch)
//  - troca e cancelada são excluídas
//  - a mesma venda nunca conta duas vezes
// ============================================================
'use strict';

const { attributeSales, WINDOW_DAYS, isVendaElegivel } = require('../src/services/marketingAttribution');

function envio(over = {}) {
  return {
    id: 'envio-1',
    customer_id: 'cliente-1',
    coupon_id: null,
    coupon_code: null,
    coupon_expires_at: null,
    sent_at: '2026-09-01T12:00:00Z',
    read_at: null,
    status: 'delivered',
    ...over,
  };
}

function venda(over = {}) {
  return {
    id: 'venda-1',
    customer_id: 'cliente-1',
    coupon_id: null,
    coupon_code: null,
    total_amount: 100,
    status: 'completed',
    cancelled_at: null,
    type: 'sale',
    created_at: '2026-09-02T12:00:00Z',
    ...over,
  };
}

function addDays(iso, n) {
  return new Date(new Date(iso).getTime() + n * 24 * 3600 * 1000).toISOString();
}

describe('WINDOW_DAYS', () => {
  it('é 5 dias, o número do contrato', () => {
    expect(WINDOW_DAYS).toBe(5);
  });
});

describe('isVendaElegivel', () => {
  it('venda normal é elegível', () => {
    expect(isVendaElegivel(venda())).toBe(true);
  });
  it('troca não é elegível', () => {
    expect(isVendaElegivel(venda({ type: 'troca' }))).toBe(false);
  });
  it('cancelada por status não é elegível', () => {
    expect(isVendaElegivel(venda({ status: 'cancelled' }))).toBe(false);
  });
  it('cancelada por cancelled_at não é elegível mesmo com status antigo', () => {
    expect(isVendaElegivel(venda({ status: 'completed', cancelled_at: '2026-09-03T00:00:00Z' }))).toBe(false);
  });
});

describe('atribuição direta (cupom)', () => {
  it('venda com o cupom da mensagem, dentro da validade → direta', () => {
    const e = envio({ id: 'e1', coupon_id: 'cupom-1', sent_at: '2026-09-01T10:00:00Z', coupon_expires_at: '2026-09-20T23:59:59Z' });
    const v = venda({ id: 'v1', coupon_id: 'cupom-1', created_at: '2026-09-10T10:00:00Z' });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.diretas).toHaveLength(1);
    expect(r.diretas[0]).toMatchObject({ sale_id: 'v1', envio_id: 'e1', tipo: 'direta', valor: 100 });
    expect(r.estimadas).toHaveLength(0);
  });

  it('venda com o cupom, mas depois da expiração → não atribui', () => {
    const e = envio({ id: 'e1', coupon_id: 'cupom-1', sent_at: '2026-09-01T10:00:00Z', coupon_expires_at: '2026-09-05T23:59:59Z' });
    const v = venda({ id: 'v1', coupon_id: 'cupom-1', created_at: '2026-09-10T10:00:00Z' });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.diretas).toHaveLength(0);
    expect(r.estimadas).toHaveLength(0); // cupom não bate com a mensagem (é dela), não vira estimada
  });

  it('venda antes do envio (cupom não existia ainda) → não atribui', () => {
    const e = envio({ id: 'e1', coupon_id: 'cupom-1', sent_at: '2026-09-10T10:00:00Z' });
    const v = venda({ id: 'v1', coupon_id: 'cupom-1', created_at: '2026-09-05T10:00:00Z' });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.diretas).toHaveLength(0);
  });
});

describe('atribuição estimada (last-touch)', () => {
  it('compra 3 dias após a LEITURA, sem cupom → estimada', () => {
    const e = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T12:00:00Z' });
    const v = venda({ id: 'v1', created_at: addDays('2026-09-01T12:00:00Z', 3) });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.estimadas).toHaveLength(1);
    expect(r.estimadas[0]).toMatchObject({ sale_id: 'v1', envio_id: 'e1', tipo: 'estimada' });
    expect(r.diretas).toHaveLength(0);
  });

  it('compra 6 dias após a leitura (fora da janela de 5) → não atribui', () => {
    const e = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T12:00:00Z' });
    const v = venda({ id: 'v1', created_at: addDays('2026-09-01T12:00:00Z', 6) });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.estimadas).toHaveLength(0);
    expect(r.diretas).toHaveLength(0);
  });

  it('exatamente no limite da janela (5 dias) → ainda atribui', () => {
    const e = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T12:00:00Z' });
    const v = venda({ id: 'v1', created_at: addDays('2026-09-01T12:00:00Z', 5) });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.estimadas).toHaveLength(1);
  });

  it('sem leitura registrada, usa o ENVIO como base da janela', () => {
    const e = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: null, status: 'sent' });
    const dentro = venda({ id: 'v1', created_at: addDays('2026-09-01T10:00:00Z', 4) });
    const r1 = attributeSales({ envios: [e], vendas: [dentro] });
    expect(r1.estimadas).toHaveLength(1);
    expect(r1.estimadas[0].lida_em).toBeNull();
    expect(r1.estimadas[0].enviada_em).toBe('2026-09-01T10:00:00Z');

    const fora = venda({ id: 'v2', created_at: addDays('2026-09-01T10:00:00Z', 7) });
    const r2 = attributeSales({ envios: [e], vendas: [fora] });
    expect(r2.estimadas).toHaveLength(0);
  });

  it('duas mensagens na janela → a venda vai para a mais RECENTE antes dela', () => {
    const e1 = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T10:00:00Z' });
    const e2 = envio({ id: 'e2', sent_at: '2026-09-03T10:00:00Z', read_at: '2026-09-03T10:00:00Z' });
    // Compra em 04/09: dentro da janela das duas (e1: até 06/09; e2: até 08/09).
    const v = venda({ id: 'v1', created_at: '2026-09-04T10:00:00Z' });
    const r = attributeSales({ envios: [e1, e2], vendas: [v] });
    expect(r.estimadas).toHaveLength(1);
    expect(r.estimadas[0].envio_id).toBe('e2');
  });

  it('mensagem posterior à compra não é candidata (só toque ANTES da venda conta)', () => {
    const antes = envio({ id: 'antes', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T10:00:00Z' });
    const depois = envio({ id: 'depois', sent_at: '2026-09-05T10:00:00Z', read_at: '2026-09-05T10:00:00Z' });
    const v = venda({ id: 'v1', created_at: '2026-09-03T10:00:00Z' });
    const r = attributeSales({ envios: [antes, depois], vendas: [v] });
    expect(r.estimadas).toHaveLength(1);
    expect(r.estimadas[0].envio_id).toBe('antes');
  });
});

describe('troca e cancelada são excluídas da atribuição', () => {
  it('venda type=troca não vira direta nem estimada', () => {
    const e = envio({ id: 'e1', coupon_id: 'cupom-1' });
    const v = venda({ id: 'v1', coupon_id: 'cupom-1', type: 'troca' });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.diretas).toHaveLength(0);
    expect(r.estimadas).toHaveLength(0);
  });

  it('venda cancelada não vira direta nem estimada', () => {
    const e = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T10:00:00Z' });
    const v = venda({ id: 'v1', status: 'cancelled', created_at: '2026-09-02T10:00:00Z' });
    const r = attributeSales({ envios: [e], vendas: [v] });
    expect(r.diretas).toHaveLength(0);
    expect(r.estimadas).toHaveLength(0);
  });
});

describe('a mesma venda nunca conta duas vezes', () => {
  it('venda direta (bate o cupom) não some também nas estimadas do mesmo cliente', () => {
    const e1 = envio({ id: 'e1', coupon_id: 'cupom-1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T10:00:00Z', coupon_expires_at: '2026-09-30T23:59:59Z' });
    const v = venda({ id: 'v1', coupon_id: 'cupom-1', created_at: '2026-09-02T10:00:00Z' });
    const r = attributeSales({ envios: [e1], vendas: [v] });
    expect(r.diretas).toHaveLength(1);
    expect(r.estimadas).toHaveLength(0);
    const totalVendasContadas = r.diretas.length + r.estimadas.length;
    expect(totalVendasContadas).toBe(1);
  });

  it('duas vendas elegíveis do mesmo cliente → cada uma conta uma vez só (nenhuma some, nenhuma duplica)', () => {
    const e = envio({ id: 'e1', sent_at: '2026-09-01T10:00:00Z', read_at: '2026-09-01T10:00:00Z' });
    const v1 = venda({ id: 'v1', created_at: '2026-09-02T10:00:00Z' });
    const v2 = venda({ id: 'v2', created_at: '2026-09-03T10:00:00Z' });
    const r = attributeSales({ envios: [e], vendas: [v1, v2] });
    const ids = [...r.diretas, ...r.estimadas].map((a) => a.sale_id).sort();
    expect(ids).toEqual(['v1', 'v2']);
  });
});
