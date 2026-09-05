// ============================================================
// A cotacao do lote le a escada da LOJISTA (04/09/2026)
//
// Ate hoje o lote tinha uma tabela fixa nossa (10/20/50/100 → 5/10/15/20%)
// e o produto avulso usava a escada que a lojista configura. Na mesma
// caneca, a pagina dizia "10 ja da 10%" e o lote "faltam 8 para 10%".
// Sem faixa cadastrada, o lote inventava 5% que ela nunca deu.
//
// Decisao do Caio: uma escada, personalizavel por ela. O que este teste
// guarda e que existe UMA — e que, sem faixa, nao ha desconto.
// ============================================================
const fs = require('fs');
const path = require('path');
const { cotarLote, faixasParaTela } = require('../src/services/studioLote');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// A escada da Sheid na loja de teste: 10-49 a -10%, 50+ a -20%.
const ESCADA = [
  { min_qty: 1, max_qty: 9 },
  { min_qty: 10, max_qty: 49, unit_multiplier: 0.9, lead_days: 5 },
  { min_qty: 50, max_qty: null, unit_multiplier: 0.8, lead_days: 10 },
];

describe('sem faixa cadastrada, nao ha desconto', () => {
  test('a multiplicacao simples, e nada de 5% inventado', () => {
    const c = cotarLote(12, 44.90, null);
    expect(c.discount_pct).toBe(0);
    expect(c.total_amount).toBe(538.80);
    expect(c.savings).toBe(0);
    expect(c.tiers).toEqual([]);
  });

  test('lista vazia e o mesmo que nenhuma', () => {
    expect(cotarLote(60, 39.90, []).discount_pct).toBe(0);
  });
});

describe('com a escada da lojista', () => {
  test('12 canecas caem na faixa de 10%', () => {
    const c = cotarLote(12, 44.90, ESCADA);
    expect(c.discount_pct).toBe(10);
    expect(c.unit_price).toBe(44.90);          // preco de TABELA, para o degrau
    expect(c.total_amount).toBe(+(12 * 44.90 * 0.9).toFixed(2));
    expect(c.savings).toBe(+(12 * 44.90 * 0.1).toFixed(2));
  });

  test('abaixo da primeira faixa com desconto paga cheio', () => {
    const c = cotarLote(9, 44.90, ESCADA);
    expect(c.discount_pct).toBe(0);
    expect(c.total_amount).toBe(+(9 * 44.90).toFixed(2));
  });

  test('total mais economia devolvem o preco cheio', () => {
    const c = cotarLote(60, 39.90, ESCADA);
    expect(+(c.total_amount + c.savings).toFixed(2)).toBe(+(60 * 39.90).toFixed(2));
  });

  test('o mesmo numero que a pagina do produto mostra', () => {
    // E o ponto da unificacao: as duas telas leem a mesma funcao.
    const { unitPriceForQty } = require('../src/services/studioQtyTiers');
    const c = cotarLote(50, 39.90, ESCADA);
    expect(+(c.total_amount / 50).toFixed(2)).toBe(+unitPriceForQty(39.90, ESCADA, 50).toFixed(2));
  });

  test('quantidade quebrada e arredondada para baixo; preco negativo vira zero', () => {
    expect(cotarLote(10.9, 10, ESCADA).qty).toBe(10);
    expect(cotarLote(10, -5, ESCADA).total_amount).toBe(0);
  });
});

describe('os degraus que a tela desenha', () => {
  test('saem crescentes, so os que dao desconto', () => {
    const t = faixasParaTela(44.90, ESCADA);
    expect(t.map((f) => f.from)).toEqual([10, 50]);
    expect(t.map((f) => f.pct)).toEqual([10, 20]);
    expect(t[0].label).toBe('10% off acima de 10');
  });

  test('a faixa de 1 a 9, sem desconto, nao vira degrau', () => {
    // Nao existe "proximo degrau" para uma faixa que nao muda o preco.
    expect(faixasParaTela(44.90, ESCADA).some((f) => f.from === 1)).toBe(false);
  });
});

describe('o prazo e da lojista, ou "a loja informa"', () => {
  test('a faixa com prazo entrega o prazo', () => {
    expect(cotarLote(12, 44.90, ESCADA).prazo_dias).toBe(5);
    expect(cotarLote(80, 44.90, ESCADA).prazo_dias).toBe(10);
  });

  test('faixa sem prazo devolve null — nunca um numero inventado', () => {
    expect(cotarLote(5, 44.90, ESCADA).prazo_dias).toBeNull();
    expect(cotarLote(12, 44.90, null).prazo_dias).toBeNull();
  });

  test('os degraus carregam o prazo para a tela', () => {
    expect(faixasParaTela(44.90, ESCADA).map((f) => f.lead_days)).toEqual([5, 10]);
  });
});

describe('uma regra, dois leitores', () => {
  test('o painel importa do servico em vez de ter a propria tabela', () => {
    const hub = fonte('src/routes/studioBulkHub.js');
    expect(hub).toContain("require('../services/studioLote')");
    expect(hub).not.toContain('if (qty >= 100) return 20;');
    expect(hub).not.toMatch(/tiers:\s*\[/);
    // A tabela fixa saiu de todo lugar. Se voltar, as duas contas divergem.
    expect(hub).not.toContain('descontoPorQuantidade');
  });

  test('a loja publica importa do mesmo servico, com as faixas da lojista', () => {
    const loja = fonte('src/routes/studioStorefront.js');
    expect(loja).toContain("require('../services/studioLote')");
    expect(loja).toMatch(/cotarLote\([^)]*faixas\)/);
  });

  test('o servico nao tem mais tabela propria', () => {
    const svc = fonte('src/services/studioLote.js');
    expect(svc).not.toMatch(/const FAIXAS\s*=/);
    expect(svc).toContain("require('./studioQtyTiers')");
  });
});
