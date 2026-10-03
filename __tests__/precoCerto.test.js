// ============================================================
// Preco certo — a conta (03/10/2026)
//
// O custo fixo do estudio (aluguel, energia) entra no preco como
// PERCENTUAL: taxa = fixos ÷ faturamento. O preco sugerido divide o custo
// da peca pelo que sobra depois da taxa e da margem.
//
// Duas travas que estes testes seguram:
//   - com taxa 0 (ou ausente), tudo devolve EXATAMENTE o que o alerta de
//     margem ja devolvia — quem nao configurou nao ve diferenca;
//   - nada "conserta" entrada ruim em silencio.
// ============================================================
'use strict';

const pc = require('../src/services/precoCerto');
const margem = require('../src/services/margemEmRisco');

describe('a taxa', () => {
  test('so vale de 0 a 90', () => {
    expect(pc.taxaValida(0)).toBe(0);
    expect(pc.taxaValida(18.5)).toBe(18.5);
    expect(pc.taxaValida(90)).toBe(90);
    expect(pc.taxaValida('12')).toBe(12);
    expect(pc.taxaValida(90.01)).toBeNull();
    expect(pc.taxaValida(-1)).toBeNull();
    expect(pc.taxaValida(null)).toBeNull();
    expect(pc.taxaValida(undefined)).toBeNull();
    expect(pc.taxaValida('abc')).toBeNull();
    expect(pc.taxaValida(true)).toBeNull();
    expect(pc.taxaValida(Infinity)).toBeNull();
  });

  test('em uso: ausente ou invalida e zero', () => {
    expect(pc.taxaEmUso({})).toBe(0);
    expect(pc.taxaEmUso(null)).toBe(0);
    expect(pc.taxaEmUso({ taxa_custo_fixo_pct: null })).toBe(0);
    expect(pc.taxaEmUso({ taxa_custo_fixo_pct: 150 })).toBe(0);
    expect(pc.taxaEmUso({ taxa_custo_fixo_pct: 22 })).toBe(22);
  });

  test('zero aceito e configurado; ausente nao', () => {
    expect(pc.taxaConfigurada({ taxa_custo_fixo_pct: 0 })).toBe(true);
    expect(pc.taxaConfigurada({})).toBe(false);
    expect(pc.taxaConfigurada({ taxa_custo_fixo_pct: null })).toBe(false);
  });

  test('real = fixos ÷ faturamento', () => {
    expect(pc.taxaReal(2500, 12500)).toBe(20);
    expect(pc.taxaReal(1000, 3000)).toBe(33.33);
    expect(pc.taxaReal(0, 3000)).toBe(0);
  });

  test('sem faturamento nao ha taxa real', () => {
    expect(pc.taxaReal(2500, 0)).toBeNull();
    expect(pc.taxaReal(2500, -10)).toBeNull();
    expect(pc.taxaReal(2500, null)).toBeNull();
  });

  test('a real pode passar de 90 — e informacao, nao taxa aceitavel', () => {
    expect(pc.taxaReal(5000, 2500)).toBe(200);
    expect(pc.taxaValida(pc.taxaReal(5000, 2500))).toBeNull();
  });
});

describe('o preco sugerido', () => {
  test('custo ÷ (1 − taxa − margem)', () => {
    // 12 ÷ (1 − 0,20 − 0,30) = 24
    expect(pc.precoSugerido(12, 20, 30)).toBe(24);
  });

  test('21 ÷ 0,7 fecha em 30,00, nao 30,01', () => {
    // 21/0.7 da 30.000000000000004 no ponto flutuante.
    expect(pc.precoSugerido(21, 0, 30)).toBe(30);
  });

  test('arredonda para CIMA em centavos', () => {
    const p = pc.precoSugerido(12.34, 10, 30);
    expect(p).toBe(20.57); // 20,5666…
    expect(pc.margemQueSobra(12.34, p, 10)).toBeGreaterThanOrEqual(30);
  });

  test('com taxa 0 e identico ao precoParaOPiso do alerta', () => {
    for (const custo of [0.01, 7.77, 12.34, 21, 99.9, 1234.56]) {
      for (const piso of [0, 10, 30, 45, 60, 94]) {
        expect(pc.precoSugerido(custo, 0, piso)).toBe(margem.precoParaOPiso(custo, piso));
        expect(pc.precoSugerido(custo, null, piso)).toBe(margem.precoParaOPiso(custo, piso));
      }
    }
  });

  test('sem custo nao ha o que sugerir', () => {
    expect(pc.precoSugerido(0, 20, 30)).toBeNull();
    expect(pc.precoSugerido(-5, 20, 30)).toBeNull();
    expect(pc.precoSugerido(null, 20, 30)).toBeNull();
  });

  test('taxa + margem de 95 para cima nao tem preco', () => {
    expect(pc.precoSugerido(12, 65, 30)).toBeNull();
    expect(pc.precoSugerido(12, 70, 30)).toBeNull();
    expect(pc.precoSugerido(12, 64.99, 30)).not.toBeNull();
  });
});

describe('a margem que sobra', () => {
  test('(1 − taxa − custo/preco) × 100', () => {
    expect(pc.margemQueSobra(12, 24, 20)).toBe(30);
    expect(pc.margemQueSobra(12, 20, 10)).toBe(30);
  });

  test('com taxa 0 e a margem bruta', () => {
    expect(pc.margemQueSobra(12, 20, 0)).toBe(40);
    expect(pc.margemQueSobra(12, 20, null)).toBe(40);
  });

  test('pode ficar negativa: a taxa come o que parecia lucro', () => {
    // 40% de margem bruta, 45% de custo fixo → perde 5% em cada venda.
    expect(pc.margemQueSobra(12, 20, 45)).toBe(-5);
  });

  test('sem preco nao ha margem', () => {
    expect(pc.margemQueSobra(12, null, 20)).toBeNull();
    expect(pc.margemQueSobra(12, 0, 20)).toBeNull();
  });
});

describe('a situacao usa os rotulos do alerta de margem', () => {
  test('prejuizo, abaixo, ok', () => {
    expect(pc.situacao(12, 20, 45, 30)).toBe('prejuizo');
    expect(pc.situacao(12, 20, 20, 30)).toBe('abaixo'); // sobra 20
    expect(pc.situacao(12, 24, 20, 30)).toBe('ok');     // sobra 30, no piso
  });

  test('sem preco ou sem custo, nao se inventa veredito', () => {
    expect(pc.situacao(12, null, 20, 30)).toBe('sem_dado');
    expect(pc.situacao(0, 20, 20, 30)).toBe('sem_dado');
  });

  test('com taxa 0 julga igual ao alerta', () => {
    for (const [custo, preco] of [[12, 20], [25, 20], [16, 20], [14, 20]]) {
      const bruta = ((preco - custo) / preco) * 100;
      expect(pc.situacao(custo, preco, 0, 30)).toBe(margem.situacao(bruta, 30));
    }
  });
});

describe('o ponto de equilibrio', () => {
  test('fixos ÷ (1 − fracao variavel)', () => {
    // De cada R$ 100, R$ 40 sao custo da peca: precisa faturar 5.000 para pagar 3.000.
    expect(pc.pontoDeEquilibrio(3000, 0.4)).toBe(5000);
  });

  test('peca que custa o que vende nao paga aluguel nunca', () => {
    expect(pc.pontoDeEquilibrio(3000, 1)).toBeNull();
    expect(pc.pontoDeEquilibrio(3000, 1.2)).toBeNull();
    expect(pc.pontoDeEquilibrio(3000, null)).toBeNull();
  });

  test('a fracao variavel media ignora peca sem custo ou sem preco', () => {
    expect(pc.fracaoVariavelMedia([
      { custo: 10, preco: 20 }, { custo: 6, preco: 20 }, { custo: 0, preco: 20 }, { custo: 5, preco: null },
    ])).toBeCloseTo(0.4, 10);
    expect(pc.fracaoVariavelMedia([])).toBeNull();
  });
});

describe('a lista de custos fixos', () => {
  const aluguel = { id: 'a', nome: 'Aluguel', valor: 1800, origem: 'manual', ativo: true };

  test('o total soma so o que ela marcou', () => {
    expect(pc.totalDosCustos([
      aluguel,
      { id: 'b', nome: 'Energia', valor: 320.55, origem: 'manual', ativo: true },
      { id: 'c', nome: 'Academia', valor: 99, origem: 'manual', ativo: false },
    ])).toBe(2120.55);
    expect(pc.totalDosCustos([])).toBe(0);
    expect(pc.totalDosCustos(null)).toBe(0);
  });

  test('normaliza: apara o nome, assume manual e ativo, cria id', () => {
    const r = pc.normalizarCustos([{ nome: '  Internet ', valor: 119.9 }]);
    expect(r.ok).toBe(true);
    expect(r.value[0]).toMatchObject({ nome: 'Internet', valor: 119.9, origem: 'manual', ativo: true });
    expect(typeof r.value[0].id).toBe('string');
    expect(r.value[0]).not.toHaveProperty('chave_financeiro');
  });

  test('item do financeiro guarda a chave para casar depois', () => {
    const r = pc.normalizarCustos([{ id: 'x', nome: 'Aluguel', valor: 1800, origem: 'financeiro', chave_financeiro: 'rec:aluguel', ativo: false }]);
    expect(r.value[0]).toEqual({ id: 'x', nome: 'Aluguel', valor: 1800, origem: 'financeiro', chave_financeiro: 'rec:aluguel', ativo: false });
  });

  test.each([
    ['nao e lista', { a: 1 }],
    ['nome vazio', [{ ...aluguel, nome: '   ' }]],
    ['nome com mais de 60', [{ ...aluguel, nome: 'x'.repeat(61) }]],
    ['valor negativo', [{ ...aluguel, valor: -1 }]],
    ['valor em texto', [{ ...aluguel, valor: '1800' }]],
    ['valor infinito', [{ ...aluguel, valor: Infinity }]],
    ['valor NaN', [{ ...aluguel, valor: NaN }]],
    ['origem desconhecida', [{ ...aluguel, origem: 'planilha' }]],
    ['financeiro sem chave', [{ ...aluguel, origem: 'financeiro' }]],
    ['ativo que nao e booleano', [{ ...aluguel, ativo: 'sim' }]],
    ['id repetido', [aluguel, { ...aluguel, nome: 'Outro' }]],
    ['item que nao e objeto', ['aluguel']],
  ])('recusa: %s', (_nome, entrada) => {
    const r = pc.normalizarCustos(entrada);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  test('no maximo 30 itens', () => {
    const muitos = Array.from({ length: 31 }, (_, i) => ({ id: 'i' + i, nome: 'Custo ' + i, valor: 1 }));
    expect(pc.normalizarCustos(muitos).ok).toBe(false);
    expect(pc.normalizarCustos(muitos.slice(0, 30)).ok).toBe(true);
  });

  test('nome com exatamente 60 e valor zero passam', () => {
    expect(pc.normalizarCustos([{ nome: 'x'.repeat(60), valor: 0 }]).ok).toBe(true);
  });

  test('lixo gravado no JSON vira lista vazia, nao erro', () => {
    expect(pc.custosSalvos({ custos_fixos: 'oi' })).toEqual([]);
    expect(pc.custosSalvos({ custos_fixos: [{ nome: '', valor: 1 }] })).toEqual([]);
    expect(pc.custosSalvos(null)).toEqual([]);
  });
});

describe('o faturamento medio', () => {
  const MES = '2026-10';

  test('media dos meses fechados, mes corrente de fora', () => {
    const r = pc.faturamentoMedio([
      { mes: '2026-04', receita: 9000 }, { mes: '2026-05', receita: 11000 }, { mes: '2026-06', receita: 10000 },
      { mes: '2026-07', receita: 12000 }, { mes: '2026-08', receita: 8000 }, { mes: '2026-09', receita: 10000 },
      { mes: '2026-10', receita: 99999 },
    ], MES, null);
    expect(r).toEqual({ medio: 10000, meses_com_dado: 6, origem: 'historico' });
  });

  test('estudio novo divide pelos meses que tem, nao por 6', () => {
    const r = pc.faturamentoMedio([
      { mes: '2026-07', receita: 6000 }, { mes: '2026-08', receita: 9000 }, { mes: '2026-09', receita: 9000 },
    ], MES, null);
    expect(r).toEqual({ medio: 8000, meses_com_dado: 3, origem: 'historico' });
  });

  test('mes parado no meio conta como zero', () => {
    const r = pc.faturamentoMedio([
      { mes: '2026-06', receita: 8000 }, { mes: '2026-07', receita: 8000 }, { mes: '2026-09', receita: 8000 },
    ], MES, null);
    expect(r).toEqual({ medio: 6000, meses_com_dado: 3, origem: 'historico' });
  });

  test('menos de 3 meses com receita: vale o esperado', () => {
    const r = pc.faturamentoMedio([{ mes: '2026-09', receita: 4000 }], MES, 15000);
    expect(r).toEqual({ medio: 15000, meses_com_dado: 1, origem: 'esperado' });
  });

  test('pouco historico e sem esperado: usa o que ha, declarando', () => {
    const r = pc.faturamentoMedio([{ mes: '2026-08', receita: 4000 }, { mes: '2026-09', receita: 6000 }], MES, null);
    expect(r).toEqual({ medio: 5000, meses_com_dado: 2, origem: 'historico' });
  });

  test('sem nada', () => {
    expect(pc.faturamentoMedio([], MES, null)).toEqual({ medio: null, meses_com_dado: 0, origem: 'nenhum' });
    expect(pc.faturamentoMedio(null, MES, 0)).toEqual({ medio: null, meses_com_dado: 0, origem: 'nenhum' });
  });
});

describe('as sugestoes do financeiro', () => {
  const eFixa = (c) => c === 'aluguel';

  test('mensal entra cheio, semanal e anual viram mensal', () => {
    const r = pc.sugestoesDoFinanceiro([
      { grupo: 'g1', tipo: 'monthly', descricao: 'Aluguel do ateliê', categoria: 'aluguel', valor: 1800 },
      { grupo: 'g2', tipo: 'yearly', descricao: 'Seguro', categoria: 'seguro', valor: 1200 },
      { grupo: 'g3', tipo: 'weekly', descricao: 'Faxina', categoria: 'Outros', valor: 120 },
    ], [], eFixa);
    expect(r.map((s) => [s.nome, s.valor])).toEqual([
      ['Aluguel do ateliê', 1800], ['Faxina', 520], ['Seguro', 100],
    ]);
    expect(r[0]).toEqual({
      chave_financeiro: 'rec:aluguel-do-atelie', nome: 'Aluguel do ateliê', valor: 1800,
      categoria: 'aluguel', recorrencia: 'monthly', despesa_fixa: true, ja_incluida: false,
    });
  });

  test('a chave e a descricao: serie nova do mesmo aluguel casa com o item salvo', () => {
    const salvos = [{ id: 'a', nome: 'Aluguel', valor: 1800, origem: 'financeiro', chave_financeiro: 'rec:aluguel', ativo: true }];
    const r = pc.sugestoesDoFinanceiro(
      [{ grupo: 'serie-de-2027', tipo: 'monthly', descricao: 'Aluguel', categoria: 'aluguel', valor: 1950 }],
      salvos, eFixa,
    );
    expect(r[0].chave_financeiro).toBe('rec:aluguel');
    expect(r[0].ja_incluida).toBe(true);
  });

  test('duas series vivas com o mesmo nome somam', () => {
    const r = pc.sugestoesDoFinanceiro([
      { grupo: 'g1', tipo: 'monthly', descricao: 'Salário', categoria: 'salario', valor: 1500 },
      { grupo: 'g2', tipo: 'monthly', descricao: 'salario', categoria: 'salario', valor: 1700 },
    ], [], eFixa);
    expect(r).toHaveLength(1);
    expect(r[0].valor).toBe(3200);
  });

  test('sem recorrentes, lista vazia', () => {
    expect(pc.sugestoesDoFinanceiro([], [], eFixa)).toEqual([]);
    expect(pc.sugestoesDoFinanceiro(null, null)).toEqual([]);
  });
});

describe('o diagnostico peca a peca', () => {
  const linhas = [
    { product_id: 'ok', product_name: 'Kit', product_price: '100.00', total_cost: '30.00' },
    { product_id: 'perde', product_name: 'Chopp', product_price: '20.00', total_cost: '15.00' },
    { product_id: 'aperta', product_name: 'Caneca', product_price: '20.00', total_cost: '9.00' },
    { product_id: 'sempreco', product_name: 'Nova', product_price: null, total_cost: '9.00' },
  ];
  const maoDeObraDe = (pid) => (pid === 'perde' ? 3 : 1);

  test('custo da peca = insumos + mao de obra; ordenado do pior para o melhor', () => {
    const d = pc.diagnostico(linhas, { taxaPct: 20, piso: 30, maoDeObraDe });
    expect(d.pecas.map((p) => [p.product_id, p.situacao, p.margem_que_sobra_pct])).toEqual([
      ['perde', 'prejuizo', -10],     // 1 − 0,20 − 18/20
      ['aperta', 'ok', 30],           // 1 − 0,20 − 10/20: no piso exato ja esta ok
      ['ok', 'ok', 49],               // 1 − 0,20 − 31/100
      ['sempreco', 'sem_dado', null], // quem nao da para julgar fica no fim
    ]);
    expect(d.resumo).toEqual({ prejuizo: 1, abaixo: 0, ok: 2, sem_dado: 1 });
  });

  test('cada peca traz o custo aberto e o preco sugerido', () => {
    const d = pc.diagnostico(linhas, { taxaPct: 20, piso: 30, maoDeObraDe });
    const perde = d.pecas.find((p) => p.product_id === 'perde');
    expect(perde).toEqual({
      product_id: 'perde', nome: 'Chopp', image_url: null,
      custo_insumos: 15, mao_de_obra: 3, custo_da_peca: 18,
      preco_atual: 20, margem_que_sobra_pct: -10, situacao: 'prejuizo',
      preco_sugerido: 36, // 18 ÷ (1 − 0,20 − 0,30)
    });
    // Sem preco ainda assim ha sugestao: e justamente quem precisa de uma.
    expect(d.pecas.find((p) => p.product_id === 'sempreco').preco_sugerido).toBe(20);
  });

  test('abaixo do piso mas com lucro', () => {
    const d = pc.diagnostico(
      [{ product_id: 'a', product_name: 'Caneca', product_price: '20.00', total_cost: '11.00' }],
      { taxaPct: 20, piso: 30, maoDeObraDe: () => 0 },
    );
    expect(d.pecas[0]).toMatchObject({ situacao: 'abaixo', margem_que_sobra_pct: 25, preco_sugerido: 22 });
  });

  test('ficha vazia e sem mao de obra nao vira "ok" com 100% de margem', () => {
    const d = pc.diagnostico(
      [{ product_id: 'v', product_name: 'Vazia', product_price: '20.00', total_cost: '0.00' }],
      { taxaPct: 0, piso: 30, maoDeObraDe: () => 0 },
    );
    expect(d.pecas[0]).toMatchObject({ situacao: 'sem_dado', margem_que_sobra_pct: null, preco_sugerido: null });
  });

  test('entrada invalida nao quebra', () => {
    expect(pc.diagnostico(null, { taxaPct: 0, piso: 30 })).toEqual({
      pecas: [], resumo: { prejuizo: 0, abaixo: 0, ok: 0, sem_dado: 0 },
    });
  });
});

describe('o alerta de margem com a taxa em uso', () => {
  const linhas = [
    { product_id: 'a', product_name: 'Kit', product_price: 100, total_cost: 30, margin_pct: '70.00' },
    { product_id: 'b', product_name: 'Caneca', product_price: 20, total_cost: 12, margin_pct: '40.00' },
    { product_id: 'c', product_name: 'Chopp', product_price: 20, total_cost: 17, margin_pct: '15.00' },
  ];

  test('sem taxa, a lista e a de antes — mesmos campos, mesmos valores', () => {
    const antes = [
      { product_id: 'c', nome: 'Chopp', preco: 20, custo: 17, margem_pct: 15, situacao: 'abaixo' },
    ];
    expect(margem.pecasEmRisco(linhas, 30)).toEqual(antes);
    expect(margem.pecasEmRisco(linhas, 30, 0)).toEqual(antes);
    expect(margem.pecasEmRisco(linhas, 30, null)).toEqual(antes);
    expect(margem.pecasEmRisco(linhas, 30, undefined)).toEqual(antes);
  });

  test('com taxa, julga a margem que sobra e mostra a bruta ao lado', () => {
    const r = margem.pecasEmRisco(linhas, 30, 20);
    expect(r).toEqual([
      { product_id: 'c', nome: 'Chopp', preco: 20, custo: 17, margem_pct: -5, margem_bruta_pct: 15, situacao: 'prejuizo' },
      { product_id: 'b', nome: 'Caneca', preco: 20, custo: 12, margem_pct: 20, margem_bruta_pct: 40, situacao: 'abaixo' },
    ]);
  });

  test('peca sem margem continua fora, com ou sem taxa', () => {
    const semDado = [{ product_id: 'x', product_name: 'X', product_price: null, total_cost: 5, margin_pct: null }];
    expect(margem.pecasEmRisco(semDado, 30, 20)).toEqual([]);
  });
});
