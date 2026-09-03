// ============================================================
// A escada de desconto do lote (S0 · 03/09/2026)
//
// Ela morava dentro de routes/studioBulkHub.js, onde so o painel a lia.
// O orcamento em lote da vitrine trouxe um SEGUNDO leitor, e escada de
// preco com duas implementacoes e a conta do cliente divergindo da conta
// da lojista: a pessoa fecha por um valor na loja e o evento nasce no
// painel com outro.
//
// O que este teste guarda nao e a tabela — e o fato de existir UMA.
// ============================================================
const fs = require('fs');
const path = require('path');
const { FAIXAS, descontoPorQuantidade, faixasParaTela, cotarLote } =
  require('../src/services/studioLote');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('descontoPorQuantidade', () => {
  test('os degraus, e o que ha logo abaixo de cada um', () => {
    expect(descontoPorQuantidade(9)).toBe(0);
    expect(descontoPorQuantidade(10)).toBe(5);
    expect(descontoPorQuantidade(19)).toBe(5);
    expect(descontoPorQuantidade(20)).toBe(10);
    expect(descontoPorQuantidade(49)).toBe(10);
    expect(descontoPorQuantidade(50)).toBe(15);
    expect(descontoPorQuantidade(99)).toBe(15);
    expect(descontoPorQuantidade(100)).toBe(20);
    expect(descontoPorQuantidade(5000)).toBe(20);
  });

  test('a ordem das faixas importa: a primeira que cabe e a mais generosa', () => {
    // Se alguem reordenar FAIXAS crescente, 150 pecas cairiam em 5%.
    const decrescente = FAIXAS.every((f, i) => i === 0 || FAIXAS[i - 1].de > f.de);
    expect(decrescente).toBe(true);
    expect(descontoPorQuantidade(150)).toBe(20);
  });

  test('lixo no lugar da quantidade nao vira desconto', () => {
    expect(descontoPorQuantidade(undefined)).toBe(0);
    expect(descontoPorQuantidade('abc')).toBe(0);
    expect(descontoPorQuantidade(-40)).toBe(0);
  });
});

describe('cotarLote', () => {
  test('o caso da tela: 12 canecas de R$ 44,90', () => {
    const c = cotarLote(12, 44.90);
    expect(c.discount_pct).toBe(5);
    expect(c.total_amount).toBe(511.86);
    expect(c.savings).toBe(26.94);
    expect(c.qty).toBe(12);
  });

  test('sem faixa, o total e a multiplicacao simples', () => {
    const c = cotarLote(3, 49.90);
    expect(c.discount_pct).toBe(0);
    expect(c.total_amount).toBe(149.70);
    expect(c.savings).toBe(0);
  });

  test('total mais economia devolvem o preco cheio', () => {
    const c = cotarLote(60, 39.90);
    expect(+(c.total_amount + c.savings).toFixed(2)).toBe(+(60 * 39.90).toFixed(2));
  });

  test('quantidade quebrada e arredondada para baixo; preco negativo vira zero', () => {
    expect(cotarLote(10.9, 10).qty).toBe(10);
    expect(cotarLote(10, -5).total_amount).toBe(0);
  });

  test('as faixas saem crescentes, que e a ordem em que a tela desenha', () => {
    const t = faixasParaTela();
    expect(t.map((f) => f.from)).toEqual([10, 20, 50, 100]);
    expect(t.map((f) => f.pct)).toEqual([5, 10, 15, 20]);
    expect(t[0].label).toBe('5% off acima de 10');
  });
});

describe('uma regra, dois leitores', () => {
  test('o painel importa do servico em vez de ter a propria tabela', () => {
    const hub = fonte('src/routes/studioBulkHub.js');
    expect(hub).toContain("require('../services/studioLote')");
    // A tabela literal saiu daqui. Se voltar, as duas contas divergem.
    expect(hub).not.toContain('if (qty >= 100) return 20;');
    expect(hub).not.toMatch(/tiers:\s*\[/);
  });

  test('a loja publica importa do mesmo servico', () => {
    const loja = fonte('src/routes/studioStorefront.js');
    expect(loja).toContain("require('../services/studioLote')");
    expect(loja).toContain('cotarLote(');
  });
});
