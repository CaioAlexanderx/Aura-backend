// ============================================================
// O que vai faltar — a conta (services/ruptura.js).
//
// Relógio fixo em 13/10/2026 (terça). Janela de 14 dias: 29/09 a 12/10.
// De 13/10 a 30/11 são 49 dias; 7 são domingos.
// ============================================================
'use strict';

const db = require('../../src/config/database');
const {
  calcularRuptura, calcularRupturaPorLoja, normalizarParametros, projetar, montarRuptura,
  SQL_ITENS_VISIVEIS, SQL_ITENS_PROPRIOS, SQL_DIAS,
} = require('../../src/services/ruptura');
const fake = require('../helpers/fakeRupturaDb');

const HOJE = fake.HOJE;
const ATE = '2026-11-30';
const base = { hoje: HOJE, ate: ATE };

beforeEach(() => jest.resetAllMocks());

describe('projetar — ritmo', () => {
  test('divide pelos dias com loja aberta, não pelos 14 da janela', () => {
    // Fechou uma semana: 12 unidades em 6 dias abertos são 2 por dia, não 0,86.
    const semana = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
    const r = projetar({ ...base, estoque: 100, unidades: 12, diasAbertos: semana });
    expect(r.ritmo_diario).toBe(2);
    // Seg–sáb daqui para a frente: 42 dias de venda até 30/11.
    expect(r.demanda_ate_a_data).toBe(84);
  });

  test('dia da semana em que a loja nunca abriu não conta na previsão', () => {
    // 2 por dia, 10 no estoque: acaba no 5º dia de venda. Sem domingo, 13→17/10.
    const r = projetar({ ...base, estoque: 10, unidades: 24, diasAbertos: fake.DIAS_A });
    expect(r.data_prevista).toBe('2026-10-17');
    expect(r.dias_ate_acabar).toBe(4);
    // 14 no estoque: o 7º dia de venda pula o domingo 18/10 e cai na terça 20/10.
    expect(projetar({ ...base, estoque: 14, unidades: 24, diasAbertos: fake.DIAS_A }).data_prevista).toBe('2026-10-20');
    // Aberta todo dia, o mesmo estoque acaba um dia antes.
    expect(projetar({ ...base, estoque: 14, unidades: 28, diasAbertos: fake.DIAS_B }).data_prevista).toBe('2026-10-19');
  });

  test('sem venda na janela (ou sem dia aberto) não há previsão', () => {
    expect(projetar({ ...base, estoque: 50, unidades: 0, diasAbertos: fake.DIAS_A })).toBeNull();
    expect(projetar({ ...base, estoque: 50, unidades: 5, diasAbertos: [] })).toBeNull();
  });
});

describe('projetar — antes e depois da data', () => {
  test('acaba antes: falta, com as unidades e o valor que deixariam de vender', () => {
    const r = projetar({ ...base, estoque: 60, unidades: 24, diasAbertos: fake.DIAS_A, preco: 79.9 });
    expect(r.data_prevista).toBe('2026-11-16');
    expect(r.faltara).toBe(true);
    expect(r.unidades_faltantes).toBe(24); // 84 de demanda − 60
    expect(r.valor_em_risco).toBe(1917.6);
  });

  test('acaba depois: não falta, sugestão zero e nada em risco', () => {
    const r = projetar({ ...base, estoque: 40, unidades: 6, diasAbertos: fake.DIAS_A, preco: 159.9 });
    expect(r.ritmo_diario).toBe(0.5);
    expect(r.data_prevista > ATE).toBe(true);
    expect(r.faltara).toBe(false);
    expect(r.unidades_faltantes).toBe(0);
    expect(r.valor_em_risco).toBe(0);
    expect(r.sugestao_compra).toBe(0); // 21 × 1,2 = 25,2 < 40
  });

  test('estoque que dá exatamente até a data não falta, mas a folga ainda sugere compra', () => {
    const r = projetar({ ...base, estoque: 84, unidades: 24, diasAbertos: fake.DIAS_A });
    expect(r.data_prevista).toBe(ATE);
    expect(r.faltara).toBe(false);
    expect(r.sugestao_compra).toBe(17); // ⌈100,8 − 84⌉
  });

  test('além de um ano fica sem data', () => {
    const r = projetar({ ...base, estoque: 5000, unidades: 1, diasAbertos: fake.DIAS_B });
    expect(r.data_prevista).toBeNull();
    expect(r.dias_ate_acabar).toBeNull();
    expect(r.faltara).toBe(false);
  });
});

describe('projetar — sugestão com folga de 20%', () => {
  test('⌈demanda × 1,2 − estoque⌉', () => {
    // demanda 84 → 100,8 − 10 = 90,8 → 91
    expect(projetar({ ...base, estoque: 10, unidades: 24, diasAbertos: fake.DIAS_A }).sugestao_compra).toBe(91);
  });

  test('conta fechada não ganha uma unidade por ruído de ponto flutuante', () => {
    // 1 por dia, todo dia: demanda 49 → 58,8 − 8,8 = 50 exatos.
    expect(projetar({ ...base, estoque: 8.8, unidades: 14, diasAbertos: fake.DIAS_B }).sugestao_compra).toBe(50);
    // 6 ÷ 2 = 3 dias de venda, não 4.
    expect(projetar({ ...base, estoque: 6, unidades: 28, diasAbertos: fake.DIAS_B }).data_prevista).toBe('2026-10-15');
  });

  test('item já zerado: data é hoje e a sugestão cobre a demanda inteira', () => {
    const r = projetar({ ...base, estoque: 0, unidades: 12, diasAbertos: fake.DIAS_A });
    expect(r.data_prevista).toBe(HOJE);
    expect(r.dias_ate_acabar).toBe(0);
    expect(r.sugestao_compra).toBe(51); // 42 × 1,2 = 50,4
  });
});

describe('montarRuptura', () => {
  const linhas = [fake.CALCA, fake.MEIA, fake.CINTO, fake.BLUSA, fake.VESTIDO];
  const r = montarRuptura(linhas, fake.DIAS_GRUPO, base);

  test('ordena pela data prevista e separa os zerados', () => {
    expect(r.itens.map((i) => i.nome)).toEqual([
      'Vestido Midi Canelado', 'Meia Cano Curto Kit 3 Pares', 'Cinto Couro Fivela Dourada', 'Calça Jeans Wide Leg',
    ]);
    expect(r.zerados.map((i) => i.nome)).toEqual(['Blusa Básica Algodão']);
  });

  test('item compartilhado usa os dias em que qualquer loja do grupo abriu', () => {
    const meia = r.itens.find((i) => i.compartilhado);
    expect(meia.dias_com_loja_aberta).toBe(14);
    expect(meia.ritmo_diario).toBe(1.14); // 16 ÷ 14
    expect(meia.data_prevista).toBe('2026-11-08');
    expect(meia.loja.company_id).toBe(fake.B);
    const vestido = r.itens[0];
    expect(vestido.dias_com_loja_aberta).toBe(12);
  });

  test('pronto para a tela: nome, variante, código, estoque, ritmo, dias, data, sugestão', () => {
    expect(r.itens[0]).toMatchObject({
      nome: 'Vestido Midi Canelado', variante: 'Preto / M', codigo: '7890000000011',
      estoque: 10, vendas_na_janela: 24, ritmo_diario: 2, dias_ate_acabar: 4,
      data_prevista: '2026-10-17', faltara: true, sugestao_compra: 91, preco: 129.9,
    });
    // Sem código de barras, o código é o SKU com o sufixo da variante.
    expect(r.zerados[0].codigo).toBe('BBA-BRANCO-P');
    expect(r.itens[2].codigo).toBe('CCF-01');
  });

  test('resumo: itens que faltam, valor em risco e o top por valor', () => {
    expect(r.resumo).toMatchObject({
      itens_com_venda: 5, itens_em_risco: 3, zerados: 1, primeira_ruptura: '2026-10-17',
    });
    // 74 × 129,90 + 24 × 79,90 + 26 × 24,90
    expect(r.resumo.valor_em_risco).toBe(12177.6);
    expect(r.resumo.top.map((i) => i.nome)).toEqual([
      'Vestido Midi Canelado', 'Cinto Couro Fivela Dourada', 'Meia Cano Curto Kit 3 Pares',
    ]);
  });

  test('top para em 10', () => {
    const muitas = Array.from({ length: 15 }, (_, i) => ({ ...fake.CINTO, product_id: `p${i}`, preco: String(10 + i) }));
    const m = montarRuptura(muitas, fake.DIAS_GRUPO, base);
    expect(m.resumo.itens_em_risco).toBe(15);
    expect(m.resumo.top).toHaveLength(10);
    expect(m.resumo.top[0].preco).toBe(24);
  });

  test('linha sem venda não entra', () => {
    const m = montarRuptura([{ ...fake.CINTO, unidades: '0.000' }], fake.DIAS_GRUPO, base);
    expect(m.itens).toEqual([]);
    expect(m.resumo.itens_com_venda).toBe(0);
  });
});

describe('normalizarParametros', () => {
  test('padrões: 30/11 e 14 dias', () => {
    expect(normalizarParametros({ hoje: HOJE })).toEqual({ hoje: HOJE, ate: ATE, janelaDias: 14 });
  });
  test('depois de 30/11 o padrão anda 30 dias', () => {
    expect(normalizarParametros({ hoje: '2026-12-05' }).ate).toBe('2027-01-04');
  });
  test.each([
    [{ ate: '30/11/2026' }], [{ ate: '2026-02-31' }], [{ ate: '2026-10-12' }], [{ ate: '2028-01-01' }],
    [{ janela: '3' }], [{ janela: '14.5' }], [{ janela: 'abc' }], [{ janela: '400' }],
  ])('recusa %j', (p) => {
    expect(() => normalizarParametros({ hoje: HOJE, ...p })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
  test('aceita a janela como texto da query', () => {
    expect(normalizarParametros({ hoje: HOJE, janela: '30', ate: '2026-12-24' })).toEqual({ hoje: HOJE, ate: '2026-12-24', janelaDias: 30 });
  });
});

describe('calcularRuptura — consultas', () => {
  test('loja: duas consultas, cada uma com os três parâmetros que cita', async () => {
    fake.ligar(db.query);
    const r = await calcularRuptura({ companyId: fake.A, hoje: HOJE });
    expect(db.query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of db.query.mock.calls) {
      expect(params).toEqual([HOJE, 14, [fake.A]]);
      for (const n of [1, 2, 3]) expect(sql).toContain(`$${n}`);
      expect(sql).not.toContain('$4');
    }
    expect(r.escopo).toBe('loja');
    expect(r.janela).toEqual({ de: '2026-09-29', ate: '2026-10-12' });
    // A Matriz vê o compartilhado da Filial, mas não o que é só da Filial.
    expect(r.itens.map((i) => i.nome)).toContain('Meia Cano Curto Kit 3 Pares');
    expect(r.itens.map((i) => i.nome)).not.toContain('Bolsa Tiracolo Caramelo');
  });

  test('consolidado do grupo: soma as lojas e o estoque compartilhado entra uma vez', async () => {
    fake.ligar(db.query);
    const r = await calcularRuptura({ companyId: fake.A, companyIds: [fake.A, fake.B], hoje: HOJE });
    expect(db.query.mock.calls[0][1][2]).toEqual([fake.A, fake.B]);
    expect(r.escopo).toBe('grupo');
    expect(r.itens.map((i) => i.nome)).toContain('Bolsa Tiracolo Caramelo');
    const meias = [...r.itens, ...r.zerados].filter((i) => i.product_id === fake.MEIA.product_id);
    expect(meias).toHaveLength(1);
    expect(meias[0].estoque).toBe(30);
    // O resumo do grupo é o da Matriz mais o que é só da Filial.
    fake.ligar(db.query);
    const soA = await calcularRuptura({ companyId: fake.A, hoje: HOJE });
    const bolsa = r.itens.find((i) => i.nome === 'Bolsa Tiracolo Caramelo');
    expect(r.resumo.itens_em_risco).toBe(soA.resumo.itens_em_risco + 1);
    expect(r.resumo.valor_em_risco).toBeCloseTo(soA.resumo.valor_em_risco + bolsa.valor_em_risco, 2);
  });

  test('a venda conta pelo produto em todo o grupo; o produto, pelo que a loja vê', () => {
    // Vendas: das empresas do grupo das de referência, nunca só "da loja".
    expect(SQL_ITENS_VISIVEIS).toMatch(/s\.company_id IN \(\s*SELECT g\.id FROM companies g/);
    expect(SQL_DIAS).toMatch(/s\.company_id IN \(\s*SELECT g\.id FROM companies g/);
    // Produto: próprio ou compartilhado do grupo (loja) × só o próprio (painel).
    expect(SQL_ITENS_VISIVEIS).toMatch(/p\.is_group_shared = true AND p\.company_id IN/);
    expect(SQL_ITENS_PROPRIOS).not.toMatch(/p\.is_group_shared = true AND/);
    // Cancelada fora; hoje fora da janela; produto com grade só pela variante.
    for (const sql of [SQL_ITENS_VISIVEIS, SQL_ITENS_PROPRIOS]) {
      expect(sql).toContain(`COALESCE(s.status, 'completed') <> 'cancelled'`);
      expect(sql).toMatch(/s\.created_at <\s+\(\(\$1::date\)::timestamp AT TIME ZONE 'America\/Sao_Paulo'\)/);
      expect(sql).toContain('pv.is_active = true');
      expect(sql).toContain('p.is_active = true');
    }
  });

  test('sem companyId é erro de quem chama', async () => {
    await expect(calcularRuptura({ hoje: HOJE })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('calcularRupturaPorLoja — painel', () => {
  const empresas = [
    { company_id: fake.A, nome: 'Boutique Aurora — Matriz', telefone: '11999990001' },
    { company_id: fake.B, nome: 'Boutique Aurora — Filial', telefone: null },
    { company_id: fake.C, nome: 'Empório do Bairro', telefone: '11999990003' },
  ];

  test('uma passada para todas as lojas; o compartilhado conta na loja dona', async () => {
    fake.ligar(db.query);
    const r = await calcularRupturaPorLoja({ empresas, hoje: HOJE });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1]).toEqual([HOJE, 14, [fake.A, fake.B, fake.C]]);
    expect(db.query.mock.calls[0][0]).toBe(SQL_ITENS_PROPRIOS);

    expect(r.lojas.map((l) => l.nome)).toEqual(['Boutique Aurora — Matriz', 'Boutique Aurora — Filial']);
    const [matriz, filial] = r.lojas;
    expect(matriz).toMatchObject({ itens_em_risco: 2, zerados: 1, primeira_ruptura: '2026-10-17', telefone: '11999990001' });
    expect(filial.itens_em_risco).toBe(2); // a bolsa e a meia compartilhada
    expect(filial.top.map((i) => i.nome)).toContain('Meia Cano Curto Kit 3 Pares');
    expect(matriz.top.map((i) => i.nome)).not.toContain('Meia Cano Curto Kit 3 Pares');
    // Loja sem nada em risco não entra na lista, mas conta no universo.
    expect(r.resumo).toMatchObject({ lojas: 3, lojas_com_risco: 2, itens_em_risco: 4 });
    expect(r.resumo.valor_em_risco).toBeCloseTo(matriz.valor_em_risco + filial.valor_em_risco, 2);
  });

  test('sem lojas no universo não consulta nada', async () => {
    const r = await calcularRupturaPorLoja({ empresas: [], hoje: HOJE });
    expect(db.query).not.toHaveBeenCalled();
    expect(r.lojas).toEqual([]);
  });
});
