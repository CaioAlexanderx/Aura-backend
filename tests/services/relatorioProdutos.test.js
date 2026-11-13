// ============================================================
// Relatório de Produtos (p-114) — as regras puras do serviço.
// Dados: tests/helpers/fakeRelatorioProdutosDb.js (lojas inventadas).
// ============================================================
'use strict';

const R = require('../../src/services/relatorioProdutos');
const fake = require('../helpers/fakeRelatorioProdutosDb');

const HOJE = fake.HOJE;
const params = (query = {}, opts = {}) => R.normalizarParametros(query, { hoje: HOJE, ...opts });
const relatorio = (query = {}, opts = {}, { grupo = false } = {}) => R.montarRelatorio(
  grupo ? [...fake.CATALOGO_A, fake.BOLSA] : fake.CATALOGO_A,
  grupo ? fake.VENDAS_GRUPO : fake.VENDAS_A,
  fake.DIAS,
  params(query, opts),
);
const porChave = (linhas) => Object.fromEntries(linhas.map((l) => [l.chave, l]));

describe('normalizarParametros', () => {
  test('sem nada: últimos 30 dias até hoje, item, nome asc, 50 por página, só ativos', () => {
    const p = params();
    expect(p.periodo).toEqual({ de: '2026-10-15', ate: '2026-11-13', dias: 30, hoje: HOJE });
    expect(p).toMatchObject({ modelo: null, agrupar: 'item', ordem: 'nome', direcao: 'asc', limit: 50, offset: 0, todas: false });
    expect(p.filtros.so_ativos).toBe(true);
  });

  test.each([
    ['estoque_acabando', 'item', 'dias_ate_acabar', 'asc', { com_estoque: true, acaba_em_dias: 30 }],
    ['mais_vendidos', 'produto', 'vendidos', 'desc', { vendeu: true }],
    ['parados_30', 'item', 'valor_parado', 'desc', { com_estoque: true, sem_vender_dias: 30 }],
    ['mais_lucrativos', 'produto', 'lucro', 'desc', { vendeu: true, sem_custo: false }],
    ['margem_baixa', 'produto', 'margem', 'asc', { vendeu: true, sem_custo: false, margem_max: 20 }],
    ['estoque_zerado', 'item', 'vendidos', 'desc', { com_estoque: false }],
    ['sem_custo', 'produto', 'faturamento', 'desc', { sem_custo: true }],
  ])('modelo %s preenche agrupar=%s, ordem=%s %s e os filtros', (modelo, agrupar, ordem, direcao, filtros) => {
    const p = params({ modelo });
    expect(p).toMatchObject({ modelo, agrupar, ordem, direcao });
    expect(p.filtros).toMatchObject(filtros);
  });

  test('o explícito na query vale mais que o modelo', () => {
    const p = params({ modelo: 'margem_baixa', margem_max: '35', agrupar: 'item', ordem: 'faturamento', direcao: 'desc' });
    expect(p).toMatchObject({ agrupar: 'item', ordem: 'faturamento', direcao: 'desc' });
    expect(p.filtros.margem_max).toBe(35);
    expect(params({ modelo: 'parados_30', sem_vender_dias: '60', com_estoque: '0' }).filtros)
      .toMatchObject({ sem_vender_dias: 60, com_estoque: false });
  });

  test('período explícito e só um dos lados', () => {
    expect(params({ de: '2026-11-01', ate: '2026-11-10' }).periodo).toMatchObject({ de: '2026-11-01', ate: '2026-11-10', dias: 10 });
    expect(params({ de: '2026-11-01' }).periodo).toMatchObject({ de: '2026-11-01', ate: HOJE, dias: 13 });
    expect(params({ ate: '2026-10-31' }).periodo).toMatchObject({ de: '2026-10-02', ate: '2026-10-31' });
  });

  test.each([
    [{ modelo: 'campeoes' }],
    [{ agrupar: 'loja' }],
    [{ ordem: 'preco_medio' }],
    [{ direcao: 'cima' }],
    [{ de: '01/11/2026' }],
    [{ de: '2026-11-10', ate: '2026-11-01' }],
    [{ ate: '2026-11-14' }],
    [{ de: '2025-01-01', ate: '2026-11-13' }],
    [{ limit: '0' }],
    [{ limit: '201' }],
    [{ offset: '-1' }],
    [{ estoque_min: 'muito' }],
    [{ vendeu: 'talvez' }],
    [{ sem_vender_dias: '0' }],
  ])('parâmetro inválido %j → 400 RELATORIO_PARAMETRO', (q) => {
    expect(() => params(q)).toThrow(expect.objectContaining({ statusCode: 400, code: 'RELATORIO_PARAMETRO' }));
  });

  test('quem não vê custo: modelos, ordem e filtros de custo dão 403 RELATORIO_SEM_CUSTO', () => {
    for (const modelo of ['mais_lucrativos', 'margem_baixa', 'sem_custo']) {
      expect(() => params({ modelo }, { podeVerCusto: false }))
        .toThrow(expect.objectContaining({ statusCode: 403, code: 'RELATORIO_SEM_CUSTO' }));
    }
    for (const q of [{ ordem: 'lucro' }, { ordem: 'custo' }, { ordem: 'margem' }, { ordem: 'valor_parado' }, { sem_custo: '1' }, { margem_max: '10' }]) {
      expect(() => params(q, { podeVerCusto: false })).toThrow(expect.objectContaining({ statusCode: 403 }));
    }
    // Os outros modelos seguem; parados_30 troca a ordem por valor parado.
    expect(params({ modelo: 'parados_30' }, { podeVerCusto: false })).toMatchObject({ ordem: 'dias_sem_vender', direcao: 'desc' });
    expect(params({ modelo: 'mais_vendidos' }, { podeVerCusto: false }).ordem).toBe('vendidos');
  });

  test('o 403 traz a lista de modelos de custo, para a tela esconder', () => {
    try {
      params({ modelo: 'sem_custo' }, { podeVerCusto: false });
      throw new Error('não deu 403');
    } catch (err) {
      expect(err.extra.modelos_sem_custo).toEqual(['mais_lucrativos', 'margem_baixa', 'sem_custo']);
    }
  });

  test('todas=1 ignora limit/offset e usa o teto da exportação', () => {
    expect(params({ todas: '1', limit: '10', offset: '20' })).toMatchObject({ todas: true, limit: R.TETO_EXPORTACAO, offset: 0 });
  });
});

describe('agrupar=item', () => {
  test('uma linha por variante (com o rótulo) e por produto sem grade', () => {
    const { linhas, total_linhas } = relatorio();
    expect(total_linhas).toBe(7);
    const l = porChave(linhas);
    expect(l[`v:${fake.V.m}`]).toMatchObject({
      product_id: fake.P.calca, variant_id: fake.V.m, nome: 'Calça Jeans Reta', variante: 'M',
      nome_exibicao: 'Calça Jeans Reta · M', sku: 'CJR-M', codigo_barras: '789000000002',
      estoque: 0, preco: 100, custo: 40, vendidos: 4, faturamento: 200, lucro: 40, margem: 20,
      valor_parado: 0, dias_ate_acabar: 0, ultima_venda: '2026-11-13', dias_sem_vender: 0,
    });
    expect(l[`v:${fake.V.p}`]).toMatchObject({ estoque: 10, vendidos: 10, lucro: 600, margem: 60, valor_parado: 400, valor_estoque_venda: 1000, media_diaria: 0.5, dias_ate_acabar: 19 });
    expect(l[`v:${fake.V.g}`]).toMatchObject({ media_diaria: 0.1, dias_ate_acabar: 299, dias_sem_vender: 12 });
    // A venda da variante desativada não tem item onde cair.
    expect(linhas.filter((x) => x.product_id === fake.P.calca).reduce((s, x) => s + x.vendidos, 0)).toBe(16);
  });

  test('produto sem custo cadastrado: lucro, margem e valor parado nulos, fora do lucro e na cobertura', () => {
    const { linhas, totais, cobertura_custo } = relatorio();
    const vestido = linhas.find((x) => x.product_id === fake.P.vestido);
    expect(vestido).toMatchObject({ custo: null, tem_custo: false, lucro: null, margem: null, valor_parado: null, faturamento: 450 });
    expect(cobertura_custo).toEqual({ com_custo: 6, sem_custo: 1, percentual: 85.7, faturamento_sem_custo: 450 });
    // Faturamento soma tudo; o lucro e a margem só o que tem custo.
    expect(totais.faturamento).toBe(2250);
    expect(totais.lucro).toBe(1060);
    expect(totais.margem).toBe(58.9); // 1.060 ÷ 1.800
  });

  test('produto com custo e sem venda: lucro 0 e margem nula', () => {
    const cinto = relatorio().linhas.find((x) => x.product_id === fake.P.cinto);
    expect(cinto).toMatchObject({ vendidos: 0, lucro: 0, margem: null, media_diaria: 0, dias_ate_acabar: null, ultima_venda: '2026-08-01', dias_sem_vender: 104 });
  });

  test('compartilhado na loja: dinheiro só da loja, ritmo do grupo inteiro', () => {
    const meia = relatorio().linhas.find((x) => x.product_id === fake.P.meia);
    expect(meia).toMatchObject({ compartilhado: true, loja: { company_id: fake.B, nome: 'Loja Filial' }, vendidos: 20, faturamento: 400, lucro: 300 });
    // 50 saídas no grupo em 30 dias abertos → 100 de estoque dura 60 dias de venda.
    expect(meia).toMatchObject({ media_diaria: 1.67, dias_ate_acabar: 59 });
  });

  test('totais somam todas as linhas do filtro, não só a página', () => {
    const r = relatorio({ limit: '2' });
    expect(r.linhas).toHaveLength(2);
    expect(r.total_linhas).toBe(7);
    expect(r.totais).toMatchObject({ itens: 7, estoque: 165, vendidos: 39, valor_estoque_custo: 2540, valor_estoque_venda: 8110 });
  });
});

describe('agrupar=produto', () => {
  test('soma as variantes, refaz a margem pela soma e diz qual acaba primeiro', () => {
    const { linhas } = relatorio({ agrupar: 'produto' });
    const calca = linhas.find((x) => x.product_id === fake.P.calca);
    expect(calca).toMatchObject({
      chave: `p:${fake.P.calca}`, variant_id: null, variante: null, nome_exibicao: 'Calça Jeans Reta', variantes: 3,
      estoque: 40, sku: 'CJR', preco: 100, custo: 40,
      // 10 + 4 + 2 + 1 da variante desativada
      vendidos: 17, faturamento: 1490, lucro: 810,
      valor_parado: 1600, valor_estoque_venda: 4000,
      ultima_venda: '2026-11-13', dias_sem_vender: 0,
      dias_ate_acabar: 0,
      primeiro_a_acabar: { variant_id: fake.V.m, rotulo: 'M', dias: 0 },
      media_diaria: 0.85,
    });
    // 810 ÷ 1.490 = 54,4% — a média das margens (60, 20, 60, 55,6) daria 48,9.
    expect(calca.margem).toBe(54.4);
    expect(linhas).toHaveLength(5);
  });

  test('sem a variante zerada, o primeiro a acabar é o de menos dias', () => {
    const semM = fake.CATALOGO_A.filter((l) => l.variant_id !== fake.V.m);
    const { linhas } = R.montarRelatorio(semM, fake.VENDAS_A, fake.DIAS, params({ agrupar: 'produto' }));
    const calca = linhas.find((x) => x.product_id === fake.P.calca);
    expect(calca.primeiro_a_acabar).toEqual({ variant_id: fake.V.p, rotulo: 'P', dias: 19 });
    expect(calca.dias_ate_acabar).toBe(19);
  });

  test('produto sem grade: primeiro_a_acabar nulo e dias do próprio item', () => {
    const vestido = relatorio({ agrupar: 'produto' }).linhas.find((x) => x.product_id === fake.P.vestido);
    expect(vestido).toMatchObject({ variantes: 0, primeiro_a_acabar: null, dias_ate_acabar: 33 });
  });
});

describe('modelos sobre os dados', () => {
  const nomes = (r) => r.linhas.map((l) => l.nome_exibicao);

  test('estoque_acabando: com estoque, acaba em até 30 dias, quem acaba antes primeiro', () => {
    expect(nomes(relatorio({ modelo: 'estoque_acabando' }))).toEqual(['Calça Jeans Reta · P']);
    expect(nomes(relatorio({ modelo: 'estoque_acabando', acaba_em_dias: '60' })))
      .toEqual(['Calça Jeans Reta · P', 'Vestido Linho', 'Meia Soquete']);
  });

  test('estoque_zerado: a variante M zerada aparece no item', () => {
    expect(nomes(relatorio({ modelo: 'estoque_zerado' }))).toEqual(['Calça Jeans Reta · M']);
  });

  test('parados_30: sem venda há 30 dias, nunca vendido entra, recém-cadastrado não', () => {
    const r = relatorio({ modelo: 'parados_30' });
    expect(nomes(r)).toEqual(['Cinto Trançado']);
    // Com 3 dias de corte: a G (12 dias sem vender) e a Caneca (cadastrada há 3) entram.
    expect(nomes(relatorio({ modelo: 'parados_30', sem_vender_dias: '3' }))).toEqual(['Calça Jeans Reta · G', 'Cinto Trançado', 'Caneca Nova']);
  });

  test('mais_vendidos e mais_lucrativos por produto', () => {
    expect(nomes(relatorio({ modelo: 'mais_vendidos' }))).toEqual(['Meia Soquete', 'Calça Jeans Reta', 'Vestido Linho']);
    // O Vestido vendeu, mas sem custo não entra no "mais lucrativos".
    expect(nomes(relatorio({ modelo: 'mais_lucrativos' }))).toEqual(['Calça Jeans Reta', 'Meia Soquete']);
  });

  test('margem_baixa: margem refeita pela soma até o limite, menor primeiro', () => {
    expect(nomes(relatorio({ modelo: 'margem_baixa' }))).toEqual([]);
    expect(nomes(relatorio({ modelo: 'margem_baixa', margem_max: '60' }))).toEqual(['Calça Jeans Reta']);
    // No item, a variante M (20%) entra com o padrão de 20%.
    expect(nomes(relatorio({ modelo: 'margem_baixa', agrupar: 'item' }))).toEqual(['Calça Jeans Reta · M']);
  });

  test('sem_custo: os produtos sem custo cadastrado', () => {
    expect(nomes(relatorio({ modelo: 'sem_custo' }))).toEqual(['Vestido Linho']);
  });
});

describe('ordem, filtros e página', () => {
  test('nulos sempre no fim, nos dois sentidos', () => {
    const asc = relatorio({ ordem: 'margem', direcao: 'asc' }).linhas.map((l) => l.margem);
    const desc = relatorio({ ordem: 'margem', direcao: 'desc' }).linhas.map((l) => l.margem);
    expect(asc).toEqual([20, 60, 60, 75, null, null, null]);
    expect(desc).toEqual([75, 60, 60, 20, null, null, null]);
  });

  test('dias_sem_vender: nunca vendido conta como o mais parado', () => {
    const r = relatorio({ ordem: 'dias_sem_vender', direcao: 'desc', limit: '2' });
    expect(r.linhas.map((l) => l.nome)).toEqual(['Caneca Nova', 'Cinto Trançado']);
  });

  test('faixa de estoque e vendeu=0', () => {
    expect(relatorio({ estoque_min: '10', estoque_max: '30' }).linhas.map((l) => l.nome_exibicao))
      .toEqual(['Calça Jeans Reta · G', 'Calça Jeans Reta · P', 'Cinto Trançado']);
    expect(relatorio({ vendeu: '0' }).linhas.map((l) => l.nome)).toEqual(['Caneca Nova', 'Cinto Trançado']);
  });

  test('offset e limit fatiam a lista ordenada', () => {
    const todas = relatorio({ ordem: 'faturamento' }).linhas.map((l) => l.chave);
    const pagina = relatorio({ ordem: 'faturamento', limit: '3', offset: '2' }).linhas.map((l) => l.chave);
    expect(pagina).toEqual(todas.slice(2, 5));
  });

  test('todas=1 devolve todas as linhas; acima do teto, truncado', () => {
    const r = relatorio({ todas: '1' });
    expect(r.linhas).toHaveLength(7);
    expect(r.truncado).toBe(false);

    const muitos = Array.from({ length: R.TETO_EXPORTACAO + 3 }, (_, i) => ({
      ...fake.CATALOGO_A[3], product_id: `p-${String(i).padStart(5, '0')}`, nome: `Produto ${i}`,
    }));
    const grande = R.montarRelatorio(muitos, [], fake.DIAS, params({ todas: '1' }));
    expect(grande.linhas).toHaveLength(R.TETO_EXPORTACAO);
    expect(grande.total_linhas).toBe(R.TETO_EXPORTACAO + 3);
    expect(grande.truncado).toBe(true);
  });
});

describe('custo cortado para quem não vê custo', () => {
  test('linhas e totais com custo, lucro, margem e valor parado em null; o resto fica', () => {
    const r = relatorio({ agrupar: 'produto' }, { podeVerCusto: false });
    for (const l of r.linhas) {
      expect(l).toMatchObject({ custo: null, tem_custo: null, lucro: null, margem: null, valor_parado: null });
      expect(typeof l.faturamento).toBe('number');
      expect(typeof l.preco).toBe('number');
    }
    expect(r.totais).toMatchObject({ valor_estoque_custo: null, lucro: null, margem: null, faturamento: 2340 });
    expect(r.cobertura_custo).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/"_/);
  });
});

describe('consolidado do grupo', () => {
  test('cada produto uma vez, com a loja dona; a venda das duas lojas soma no compartilhado', () => {
    const r = relatorio({ agrupar: 'produto' }, {}, { grupo: true });
    const meia = r.linhas.filter((l) => l.product_id === fake.P.meia);
    expect(meia).toHaveLength(1);
    expect(meia[0]).toMatchObject({ vendidos: 50, faturamento: 1000, lucro: 750, loja: { company_id: fake.B } });
    expect(r.linhas.find((l) => l.product_id === fake.P.bolsa)).toMatchObject({ loja: { company_id: fake.B, nome: 'Loja Filial' }, lucro: 180 });
    expect(r.totais.faturamento).toBe(3240);
  });
});
