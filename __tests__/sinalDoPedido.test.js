// ============================================================
// AURA. — Sinal do pedido do balcao (B4a / p-62a): regras sem banco
// services/sinalDoPedido.js (leitura do sinal), o mapa do DRE
// (routes/dre.js), a categoria viva (financeCategories.resolverTexto) e a
// guarda do Financeiro (quadroFinanceiro.eDoPedido).
// O dinheiro gravado de verdade esta em sinalDoPedido.banco.test.js.
// ============================================================
'use strict';

const S = require('../src/services/sinalDoPedido');
const { DEFAULT_LINE_MAP } = require('../src/routes/dre');
const cat = require('../src/services/financeCategories');
const quadro = require('../src/utils/quadroFinanceiro');

describe('lerSinal', () => {
  test('sem sinal: valor ausente, vazio ou zero', () => {
    expect(S.lerSinal(undefined, 100)).toEqual({ dados: null });
    expect(S.lerSinal({}, 100)).toEqual({ dados: null });
    expect(S.lerSinal({ amount: 0, method: 'pix' }, 100)).toEqual({ dados: null });
    expect(S.lerSinal({ amount: '' }, 100)).toEqual({ dados: null });
  });

  test('na rota do sinal o valor e obrigatorio', () => {
    expect(S.lerSinal({}, 100, { obrigatorio: true }).erro.code).toBe('PEDIDO_SINAL_VALOR');
  });

  test('ate o total vale; um centavo a mais e 422', () => {
    expect(S.lerSinal({ amount: 389.7, method: 'pix' }, 389.7)).toEqual({ dados: { valor: 389.7, forma: 'pix' } });
    expect(S.lerSinal({ amount: '100', method: 'pix' }, 389.7)).toEqual({ dados: { valor: 100, forma: 'pix' } });
    const e = S.lerSinal({ amount: 389.71, method: 'pix' }, 389.7).erro;
    expect(e).toMatchObject({ status: 422, code: 'PEDIDO_SINAL_MAIOR' });
    expect(e.message).toContain('R$ 389,71');
    expect(e.message).toContain('R$ 389,70');
  });

  test('valor invalido e forma desconhecida', () => {
    expect(S.lerSinal({ amount: -1, method: 'pix' }, 100).erro.code).toBe('PEDIDO_SINAL_VALOR');
    expect(S.lerSinal({ amount: 'abc', method: 'pix' }, 100).erro.code).toBe('PEDIDO_SINAL_VALOR');
    expect(S.lerSinal({ amount: 10 }, 100).erro.code).toBe('PEDIDO_SINAL_FORMA');
    expect(S.lerSinal({ amount: 10, method: 'crediario' }, 100).erro.code).toBe('PEDIDO_SINAL_FORMA');
  });

  test('formas do Caixa e apelidos', () => {
    expect(S.lerForma('Dinheiro')).toBe('dinheiro');
    expect(S.lerForma('credito')).toBe('cartao');
    expect(S.lerForma('cartao_debito')).toBe('debito');
    expect(S.lerForma('cash')).toBe('dinheiro');
    expect(S.lerForma('boleto')).toBeNull();
    expect(S.lerSinal({ valor: 10, forma: 'debito' }, 100)).toEqual({ dados: { valor: 10, forma: 'debito' } });
  });
});

describe('chaves e categorias', () => {
  test('chaves por pedido', () => {
    expect(S.CHAVE_A_RECEBER('x')).toBe('pedido-areceber-x');
    expect(S.CHAVE_SINAL('x')).toBe('pedido-sinal-x');
    expect(S.CHAVE_TAXA_SINAL('x')).toBe('pedido-sinal-taxa-x');
    expect(S.CATEGORIA_A_RECEBER).toBe('Pedido a receber');
    expect(S.CATEGORIA_SINAL).toBe('Sinal de pedido');
  });

  test('DRE (routes/dre.js): sinal e devolucao na linha de receita bruta, nunca em despesa', () => {
    for (const k of ['sinal de pedido', 'devolução de sinal', 'devolucao de sinal', 'pedido a receber']) {
      expect(DEFAULT_LINE_MAP[k]).toMatchObject({ line: 'receita_bruta', group: 'Receita Bruta' });
    }
  });

  test('categoria viva (finance_categories): "Sinal de pedido" e "Pedido a receber" sao Vendas', () => {
    let n = 0;
    const rows = [];
    cat.linhasDosPadroes(cat.PADROES).forEach((l) => {
      n += 1;
      const pai = l.parent ? rows.find((r) => !r.parent_id && r.kind === l.kind && r.name === l.parent) : null;
      rows.push({ id: 'c' + n, kind: l.kind, parent_id: pai ? pai.id : null, name: l.name, name_norm: cat.normalizarNome(l.name), is_system: l.is_system, archived_at: null });
    });
    const idx = cat.montarIndice(rows);
    const vendas = cat.resolverTexto('income', 'Vendas', idx);
    expect(cat.resolverTexto('income', 'Sinal de pedido', idx)).toBe(vendas);
    expect(cat.resolverTexto('income', 'Pedido a receber', idx)).toBe(vendas);
    expect(cat.PADROES.find((p) => p.kind === 'income' && p.name === 'Vendas').dre).toBe('receita_vendas');
  });

  test('o Financeiro reconhece o lancamento do pedido (e so ele)', () => {
    expect(quadro.eDoPedido({ idempotency_key: 'pedido-areceber-1' })).toBe(true);
    expect(quadro.eDoPedido({ idempotency_key: 'pedido-sinal-1' })).toBe(true);
    expect(quadro.eDoPedido({ idempotency_key: 'pedido-sinal-taxa-1' })).toBe(true);
    expect(quadro.eDoPedido({ idempotency_key: 'pedido-devolucao-1' })).toBe(true);
    expect(quadro.eDoPedido({ idempotency_key: 'pdv-sale-1' })).toBe(false);
    expect(quadro.eDoPedido({ idempotency_key: null })).toBe(false);
    expect(quadro.eDoPedido(null)).toBe(false);
  });

  test('resumo dos itens na descricao', () => {
    expect(S.resumoDosItens([{ nome: 'A' }, { product_name: 'B' }])).toBe('A, B');
    expect(S.resumoDosItens([{ nome: 'A' }, { nome: 'B' }, { nome: 'C' }, { nome: 'D' }, { nome: 'E' }])).toBe('A, B, C e mais 2');
  });
});
