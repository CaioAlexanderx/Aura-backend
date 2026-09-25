// ============================================================
// Vitrine Studio · Fase 2 — a conta da sacola num lugar so
//
// services/precoDoStudio.js e a conta que POST /studio/order cobra e que
// POST /studio/cotacao mostra. O que trava aqui:
//   - o servico de arte pago ("voces ajustam" / "criem a arte") entra UMA
//     VEZ POR LINHA, nao por unidade (decisao do PO, 25/09/2026);
//   - o resto da conta nao mudou: faixa sobre o preco de tabela, opcoes,
//     verso e meio por unidade, Pix sobre o subtotal;
//   - o cartao (Mercado Pago) recebe a arte como item proprio;
//   - o prazo da sacola e o maior das linhas.
// ============================================================
'use strict';

const {
  ehCampoDeServicoDeArte, computeChoicesDelta, computeArtServiceDelta,
  precoDaLinha, cotarItens, totaisDoPedido, prazoDaSacola, faixaAplicada,
  itensParaCobranca, carregarFaixas, r2,
} = require('../src/services/precoDoStudio');

// Mesmo formato que o app grava (buildArtServiceChoices em artService.ts).
const ARTE = {
  id: 'art_service', type: 'option', label: 'Arte',
  config: {
    is_art_service: true,
    choices: [
      { value: 'none',     label: 'Vou enviar minha arte pronta',     price_delta: 0 },
      { value: 'adjust',   label: 'Envio minha arte e vocês ajustam', price_delta: 10 },
      { value: 'designer', label: 'Criem a arte pra mim',             price_delta: 30 },
    ],
  },
};
const TAMANHO = {
  id: 'tam', type: 'option', label: 'Tamanho',
  config: { choices: [{ value: 'p', label: 'P', price_delta: 0 }, { value: 'g', label: 'G', price_delta: 5 }] },
};
const FOTO = { id: 'foto', type: 'image', label: 'Sua foto', required: true };

const CANECA = {
  id: 'p1', name: 'Caneca Alça Coração', price: '39.90', is_active: true, is_personalizable: true,
  customization_config: {
    fields: [ARTE, TAMANHO, FOTO],
    has_back: true, back_charge_enabled: true, back_price_delta: 8,
  },
};

describe('servico de arte: uma vez por linha', () => {
  test('o campo e reconhecido pela marca ou pelo id canonico, e so se for opcao', () => {
    expect(ehCampoDeServicoDeArte(ARTE)).toBe(true);
    expect(ehCampoDeServicoDeArte({ id: 'art_service', type: 'option', config: {} })).toBe(true);
    expect(ehCampoDeServicoDeArte({ id: 'x', type: 'option', config: { is_art_service: true } })).toBe(true);
    // O briefing tambem leva a marca, mas e texto.
    expect(ehCampoDeServicoDeArte({ id: 'art_service_brief', type: 'text', config: { is_art_service: true } })).toBe(false);
    expect(ehCampoDeServicoDeArte(TAMANHO)).toBe(false);
  });

  test('a arte sai das opcoes por unidade e entra so na conta da linha', () => {
    const cfg = CANECA.customization_config;
    const v = { art_service: 'adjust', tam: 'g' };
    expect(computeChoicesDelta(cfg, v)).toBe(5);
    expect(computeArtServiceDelta(cfg, v)).toBe(10);
  });

  // O exemplo do relatorio: caneca R$ 39,90, ajuste R$ 10,00, 2 unidades.
  test('antes (39,90 + 10) x 2 = 99,80; agora 39,90 x 2 + 10 = 89,80', () => {
    const p = precoDaLinha({ produto: CANECA, faixas: null, quantidade: 2, customization: { art_service: 'adjust', foto: 'u' } });
    expect(p.preco_unitario).toBeCloseTo(39.9, 10);
    expect(p.arte).toBe(10);
    expect(r2(p.total)).toBe(89.8);
  });

  test('criacao da arte tambem e por linha, qualquer que seja a quantidade', () => {
    for (const qty of [1, 3, 50]) {
      const p = precoDaLinha({ produto: CANECA, faixas: null, quantidade: qty, customization: { art_service: 'designer' } });
      expect(r2(p.total)).toBe(r2(39.9 * qty + 30));
    }
  });

  test('"vou enviar pronta" nao cobra nada', () => {
    const p = precoDaLinha({ produto: CANECA, faixas: null, quantidade: 3, customization: { art_service: 'none', foto: 'u' } });
    expect(p.arte).toBe(0);
    expect(r2(p.total)).toBe(r2(39.9 * 3));
  });
});

describe('o resto da conta nao mudou', () => {
  test('faixa sobre o preco de tabela; opcoes e verso por unidade; arte depois', () => {
    const faixas = [{ min_qty: 10, unit_multiplier: 0.9 }];
    const p = precoDaLinha({
      produto: CANECA, faixas, quantidade: 10,
      customization: { art_service: 'adjust', tam: 'g', has_back_selected: true, foto: 'u' },
    });
    expect(p.base).toBeCloseTo(35.91, 10);
    expect(p.preco_unitario).toBeCloseTo(35.91 + 5 + 8, 10);
    expect(r2(p.total)).toBe(r2((35.91 + 5 + 8) * 10 + 10));
    expect(p.faixa).toEqual({ min_qty: 10, pct: 10 });
  });

  test('sem arte, o preco unitario e exatamente a soma de antes', () => {
    // Mesma ordem de soma da rota antiga: base + opcoes + verso + meio.
    const p = precoDaLinha({ produto: CANECA, faixas: null, quantidade: 3, customization: { tam: 'g', has_back_selected: true } });
    expect(p.preco_unitario).toBe(39.9 + 5 + 8 + 0);
    expect(p.total).toBe((39.9 + 5 + 8 + 0) * 3);
  });

  test('faixa que nao baixa o preco nao aparece', () => {
    expect(faixaAplicada(39.9, [{ min_qty: 10, unit_multiplier: 0.9 }], 9)).toBeNull();
    expect(faixaAplicada(39.9, null, 50)).toBeNull();
  });

  test('Pix so sobre o subtotal, so no Pix; frete por fora', () => {
    const t = totaisDoPedido({ subtotal: 217.69, pixPct: 5, formaDePagamento: 'pix', frete: 12 });
    expect(t.desconto_pix).toBe(10.88);
    expect(t.discount_amount).toBe(10.88);
    expect(r2(t.total)).toBe(218.81);
    const c = totaisDoPedido({ subtotal: 217.69, pixPct: 5, formaDePagamento: 'card', frete: 0 });
    expect(c.discount_amount).toBe(0);
    expect(c.total).toBe(217.69);
    expect(r2(c.total_pix)).toBe(206.81);
  });
});

describe('cotarItens', () => {
  const produtos = { p1: CANECA };
  const validar = jest.fn(() => null);

  test('precifica cada linha e soma o subtotal', () => {
    const r = cotarItens({
      items: [
        { product_id: 'p1', quantity: 2, customization: { art_service: 'adjust' } },
        { product_id: 'p1', quantity: 1, customization: { art_service: 'none', foto: 'u' } },
      ],
      produtos, faixas: {}, validar,
    });
    expect(r.erro).toBeUndefined();
    expect(r.linhas.map((l) => r2(l.preco.total))).toEqual([89.8, 39.9]);
    expect(r2(r.subtotal)).toBe(129.7);
  });

  test('recusa com a mensagem de sempre e diz qual linha', () => {
    expect(cotarItens({ items: [{ product_id: 'p1', quantity: 1 }, { product_id: 'zz' }], produtos, faixas: {} }))
      .toEqual({ erro: 'Produto zz nao encontrado', indice: 1 });
    expect(cotarItens({ items: [{ product_id: 'p1', quantity: -2 }], produtos, faixas: {} }))
      .toEqual({ erro: 'Quantidade invalida para "Caneca Alça Coração"', indice: 0 });
    const r = cotarItens({ items: [{ product_id: 'p1', quantity: 1, customization: {} }], produtos, faixas: {}, validar: () => 'informe a arte' });
    expect(r).toEqual({ erro: 'Personalizacao de "Caneca Alça Coração": informe a arte', indice: 0 });
  });

  test('regra propria do produto vence a global', () => {
    const faixas = { p1: [{ min_qty: 2, unit_price: 30 }], __global: [{ min_qty: 2, unit_price: 20 }] };
    const r = cotarItens({ items: [{ product_id: 'p1', quantity: 2, customization: {} }], produtos, faixas });
    expect(r.linhas[0].preco.base).toBe(30);
  });
});

describe('prazo da sacola', () => {
  const faixas = [
    { min_qty: 1, max_qty: 9, unit_multiplier: 1, lead_days: 3 },
    { min_qty: 10, max_qty: 49, unit_multiplier: 0.95, lead_days: 5 },
    { min_qty: 50, unit_multiplier: 0.85, lead_days: 8 },
  ];
  test('o maior prazo entre as linhas', () => {
    expect(prazoDaSacola(3, [{ faixas, quantidade: 2 }, { faixas, quantidade: 12 }])).toBe(5);
    expect(prazoDaSacola(3, [{ faixas, quantidade: 60 }])).toBe(8);
  });
  test('linha sem faixa vale o prazo padrao da loja; loja sem prazo vale 3', () => {
    expect(prazoDaSacola(4, [{ faixas: null, quantidade: 2 }])).toBe(4);
    expect(prazoDaSacola(undefined, [{ faixas: null, quantidade: 2 }])).toBe(3);
    expect(prazoDaSacola(2, [])).toBe(2);
  });
});

test('cartao: a arte vira item proprio de quantidade 1', () => {
  const itens = itensParaCobranca([
    { product_id: 'p1', product_name: 'Caneca', unit_price: 39.9, quantity: 2, _art_delta: 10 },
    { product_id: 'p2', product_name: 'Copo', unit_price: 20, quantity: 1, _art_delta: 0 },
  ]);
  expect(itens.map((i) => [i.product_name, i.unit_price, i.quantity])).toEqual([
    ['Caneca', 39.9, 2],
    ['Servico de arte — Caneca', 10, 1],
    ['Copo', 20, 1],
  ]);
  const soma = itens.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  expect(r2(soma)).toBe(109.8);
});

describe('carregarFaixas', () => {
  test('regra global vira __global; base sem a tabela nao derruba', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [
      { product_id: 'p1', qty_tiers: [{ min_qty: 2, unit_price: 1 }] },
      { product_id: null, qty_tiers: [{ min_qty: 5, unit_price: 2 }] },
    ] }) };
    const f = await carregarFaixas(db, 'c1');
    expect(f.p1).toBeTruthy();
    expect(f.__global).toEqual([{ min_qty: 5, unit_price: 2 }]);
    const semTabela = { query: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' })) };
    expect(await carregarFaixas(semTabela, 'c1')).toEqual({});
  });
});
