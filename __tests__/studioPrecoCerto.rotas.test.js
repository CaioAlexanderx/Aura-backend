// ============================================================
// AURA Studio — Preco certo: as rotas (03/10/2026)
//
// O que estes testes seguram:
//   (1) GET /custos sem historico e sem recorrentes responde inteiro, sem
//       inventar taxa;
//   (2) PUT /custos recusa entrada ruim com frase clara e NAO grava; a
//       taxa em uso so muda quando o corpo traz o campo;
//   (3) o diagnostico separa prejuizo / abaixo / ok / sem ficha, com a mao
//       de obra da regra (produto > global) e sem setup;
//   (4) aplicar grava o preco que veio da tela, numa transacao, e produto
//       de outra empresa derruba o lote inteiro sem um UPDATE sequer;
//   (5) o quote-line e o alerta de margem passam a usar a taxa em uso.
//
// Mock por SQL, nunca por posicao.
// ============================================================
'use strict';

jest.mock('../src/services/cacheDaPaginaDaLoja', () => ({
  esquecerPagina: jest.fn(),
  paginaLembrada: jest.fn(),
  lembrarPagina: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { esquecerPagina } = require('../src/services/cacheDaPaginaDaLoja');

const CID = 'c-studio';
const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const DE_FORA = '99999999-9999-4999-8999-999999999999';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 'u1', plan: 'negocio' }; next(); });
  a.use('/companies/:id/studio', require('../src/routes/studio'));
  a.use('/companies/:id/studio', require('../src/routes/studioPricing'));
  a.use('/companies/:id/studio', require('../src/routes/studioPrecoCerto'));
  return a;
}

/**
 * O banco de mentira, por SQL. Devolve as chamadas para o teste conferir
 * o que foi (e o que NAO foi) gravado.
 */
function banco({
  settings = {}, empresaExiste = true, recorrentes = [], receita = [],
  pecas = [], regras = [], semFicha = 0,
} = {}) {
  const chamadas = [];
  let atual = settings;
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    chamadas.push({ s, params });
    if (/UPDATE companies/.test(s)) {
      if (!empresaExiste) return { rows: [] };
      atual = { ...atual, ...JSON.parse(params[0]) };
      return { rows: [{ s: atual }] };
    }
    if (/FROM companies/.test(s)) return { rows: empresaExiste ? [{ s: atual }] : [] };
    if (/recurrence_group_id/.test(s)) return { rows: recorrentes };
    if (/FROM transactions/.test(s)) return { rows: receita };
    if (/FROM studio_compositions_summary/.test(s)) return { rows: pecas };
    if (/FROM studio_pricing_rules/.test(s)) return { rows: regras };
    if (/COUNT\(\*\)/.test(s) && /FROM products/.test(s)) return { rows: [{ n: semFicha }] };
    return { rows: [] };
  });
  return chamadas;
}

/** O cliente da transacao do /aplicar. `meus` sao os produtos da empresa. */
function clienteQueGrava(meus) {
  const chamadas = [];
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      chamadas.push({ s, params });
      if (/SELECT id FROM products/.test(s)) {
        return { rows: params[1].filter((id) => meus.includes(id)).map((id) => ({ id })) };
      }
      if (/UPDATE products/.test(s)) {
        return { rows: [{ id: params[1], name: 'Peça ' + params[1].slice(0, 4), price: String(params[0]) }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  }));
  return chamadas;
}

const url = (resto) => `/companies/${CID}/studio${resto}`;

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  esquecerPagina.mockClear();
});

describe('GET /studio/preco-certo/custos', () => {
  test('(1) estudio sem historico, sem recorrentes e sem nada salvo', async () => {
    banco({});
    const r = await request(app()).get(url('/preco-certo/custos'));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      itens: [],
      sugestoes_do_financeiro: [],
      total_mensal: 0,
      faturamento: { medio: null, meses_com_dado: 0, origem: 'nenhum' },
      faturamento_esperado: null,
      taxa_real_pct: null,
      taxa_em_uso_pct: null,
      taxa_aceita_em: null,
      margem_minima_pct: 30,
      ponto_de_equilibrio: null,
      custo_variavel_medio_pct: null,
    });
  });

  test('sem historico, mas com faturamento esperado, ja ha taxa real', async () => {
    banco({
      settings: {
        faturamento_esperado: 10000,
        custos_fixos: [{ id: 'a', nome: 'Aluguel', valor: 1800, origem: 'manual', ativo: true }],
      },
    });
    const r = await request(app()).get(url('/preco-certo/custos'));
    expect(r.body.faturamento).toEqual({ medio: 10000, meses_com_dado: 0, origem: 'esperado' });
    expect(r.body.total_mensal).toBe(1800);
    expect(r.body.taxa_real_pct).toBe(18);
    expect(r.body.taxa_em_uso_pct).toBeNull(); // real nao vira em uso sozinha
  });

  test('sugere as recorrentes do financeiro e marca as ja incluidas', async () => {
    const chamadas = banco({
      settings: {
        taxa_custo_fixo_pct: 15,
        custos_fixos: [{ id: 'a', nome: 'Aluguel', valor: 1800, origem: 'financeiro', chave_financeiro: 'rec:aluguel', ativo: true }],
      },
      recorrentes: [
        { grupo: 'g1', tipo: 'monthly', descricao: 'Aluguel', categoria: 'aluguel', valor: 1800 },
        { grupo: 'g2', tipo: 'monthly', descricao: 'Internet', categoria: 'internet', valor: 120 },
      ],
      pecas: [{ product_id: P1, product_name: 'Caneca', product_price: '20.00', total_cost: '7.00', item_count: 2 }],
      regras: [{ product_id: null, labor_cost: '1.00' }],
    });
    const r = await request(app()).get(url('/preco-certo/custos'));
    expect(r.status).toBe(200);
    expect(r.body.sugestoes_do_financeiro).toEqual([
      { chave_financeiro: 'rec:aluguel', nome: 'Aluguel', valor: 1800, categoria: 'aluguel', recorrencia: 'monthly', despesa_fixa: true, ja_incluida: true },
      { chave_financeiro: 'rec:internet', nome: 'Internet', valor: 120, categoria: 'internet', recorrencia: 'monthly', despesa_fixa: true, ja_incluida: false },
    ]);
    expect(r.body.taxa_em_uso_pct).toBe(15);
    // (7 + 1) / 20 = 40% de custo variavel → 1800 / 0,6 = 3000
    expect(r.body.custo_variavel_medio_pct).toBe(40);
    expect(r.body.ponto_de_equilibrio).toBe(3000);

    // Tudo escopado na empresa da URL; receita pela fonte do DRE.
    const recorr = chamadas.find((c) => /recurrence_group_id/.test(c.s));
    expect(recorr.params).toEqual([CID]);
    expect(recorr.s).toMatch(/type = 'expense'/);
    const fat = chamadas.find((c) => /type = 'income'/.test(c.s));
    expect(fat.params).toEqual([CID]);
    expect(fat.s).toMatch(/status = 'confirmed'/);
    expect(fat.s).toMatch(/paid_at/);
  });

  test('financeiro fora do ar nao derruba a tela', async () => {
    banco({});
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM transactions/.test(String(sql))) throw new Error('relation "transactions" does not exist');
      return base(sql, params);
    });
    const r = await request(app()).get(url('/preco-certo/custos'));
    expect(r.status).toBe(200);
    expect(r.body.sugestoes_do_financeiro).toEqual([]);
    expect(r.body.faturamento.origem).toBe('nenhum');
  });

  test('empresa que nao existe: 404', async () => {
    banco({ empresaExiste: false });
    const r = await request(app()).get(url('/preco-certo/custos'));
    expect(r.status).toBe(404);
  });
});

describe('PUT /studio/preco-certo/custos', () => {
  const gravou = (chamadas) => chamadas.filter((c) => /UPDATE companies/.test(c.s));

  test.each([
    ['itens que nao e lista', { itens: 'aluguel' }],
    ['valor negativo', { itens: [{ nome: 'Aluguel', valor: -1 }] }],
    ['valor em texto', { itens: [{ nome: 'Aluguel', valor: '1800' }] }],
    ['nome vazio', { itens: [{ nome: '', valor: 10 }] }],
    ['nome longo demais', { itens: [{ nome: 'x'.repeat(61), valor: 10 }] }],
    ['origem desconhecida', { itens: [{ nome: 'Aluguel', valor: 10, origem: 'planilha' }] }],
    ['mais de 30 itens', { itens: Array.from({ length: 31 }, (_, i) => ({ nome: 'C' + i, valor: 1 })) }],
    ['taxa acima de 90', { taxa_em_uso_pct: 91 }],
    ['taxa negativa', { taxa_em_uso_pct: -1 }],
    ['taxa em texto', { taxa_em_uso_pct: '20' }],
    ['margem acima de 95', { margem_minima_pct: 96 }],
    ['faturamento negativo', { faturamento_esperado: -100 }],
    ['corpo vazio', {}],
  ])('(2) recusa %s com 400 e nao grava', async (_nome, corpo) => {
    const chamadas = banco({});
    const r = await request(app()).put(url('/preco-certo/custos')).send(corpo);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
    expect(r.body.error.length).toBeGreaterThan(5);
    expect(gravou(chamadas)).toHaveLength(0);
  });

  test('taxa + margem minima de 95 para cima e recusada', async () => {
    const chamadas = banco({ settings: { margem_minima_pct: 40 } });
    const r = await request(app()).put(url('/preco-certo/custos')).send({ taxa_em_uso_pct: 55 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/95/);
    expect(gravou(chamadas)).toHaveLength(0);
  });

  test('grava a lista SEM mexer na taxa em uso', async () => {
    const chamadas = banco({ settings: { taxa_custo_fixo_pct: 12, pix_key: 'chave' }, receita: [] });
    const r = await request(app()).put(url('/preco-certo/custos')).send({
      itens: [{ id: 'a', nome: ' Aluguel ', valor: 1800 }, { id: 'b', nome: 'Energia', valor: 300, ativo: false }],
      faturamento_esperado: 9000,
    });
    expect(r.status).toBe(200);
    const [upd] = gravou(chamadas);
    expect(upd.params[1]).toBe(CID);
    expect(upd.s).toMatch(/COALESCE\(studio_settings, '\{\}'::jsonb\) \|\| \$1::jsonb/);
    const patch = JSON.parse(upd.params[0]);
    expect(patch).toEqual({
      custos_fixos: [
        { id: 'a', nome: 'Aluguel', valor: 1800, origem: 'manual', ativo: true },
        { id: 'b', nome: 'Energia', valor: 300, origem: 'manual', ativo: false },
      ],
      faturamento_esperado: 9000,
    });
    // A taxa real mudou (1800 / 9000 = 20%); a em uso continua a que ela aceitou.
    expect(r.body.total_mensal).toBe(1800);
    expect(r.body.taxa_real_pct).toBe(20);
    expect(r.body.taxa_em_uso_pct).toBe(12);
  });

  test('aceitar a nova taxa e mandar taxa_em_uso_pct', async () => {
    const chamadas = banco({ settings: { taxa_custo_fixo_pct: 12 } });
    const r = await request(app()).put(url('/preco-certo/custos')).send({ taxa_em_uso_pct: 20, margem_minima_pct: 35 });
    expect(r.status).toBe(200);
    const patch = JSON.parse(gravou(chamadas)[0].params[0]);
    expect(patch.taxa_custo_fixo_pct).toBe(20);
    expect(patch.margem_minima_pct).toBe(35);
    expect(typeof patch.taxa_custo_fixo_aceita_em).toBe('string');
    expect(patch).not.toHaveProperty('custos_fixos');
    expect(r.body.taxa_em_uso_pct).toBe(20);
    expect(r.body.margem_minima_pct).toBe(35);
  });

  test('empresa que nao existe: 404, sem gravar', async () => {
    const chamadas = banco({ empresaExiste: false });
    const r = await request(app()).put(url('/preco-certo/custos')).send({ itens: [] });
    expect(r.status).toBe(404);
    expect(gravou(chamadas)).toHaveLength(0);
  });
});

describe('GET /studio/preco-certo/diagnostico', () => {
  const PECAS = [
    { product_id: 'ok', product_name: 'Kit', product_price: '100.00', total_cost: '30.00', item_count: 3, image_url: 'https://cdn/kit.jpg' },
    { product_id: 'perde', product_name: 'Chopp', product_price: '20.00', total_cost: '15.00', item_count: 2, image_url: null },
    { product_id: 'aperta', product_name: 'Caneca', product_price: '20.00', total_cost: '10.00', item_count: 2, image_url: null },
  ];
  const REGRAS = [
    { product_id: null, labor_cost: '1.00' },      // global
    { product_id: 'perde', labor_cost: '3.00' },   // a do produto vence
  ];

  test('(3) prejuizo, abaixo, ok e sem ficha — com a taxa em uso', async () => {
    const chamadas = banco({
      settings: { taxa_custo_fixo_pct: 20, margem_minima_pct: 30 },
      pecas: PECAS, regras: REGRAS, semFicha: 4,
    });
    const r = await request(app()).get(url('/preco-certo/diagnostico'));
    expect(r.status).toBe(200);
    expect(r.body.taxa_em_uso_pct).toBe(20);
    expect(r.body.taxa_configurada).toBe(true);
    expect(r.body.margem_minima_pct).toBe(30);
    expect(r.body.resumo).toEqual({ prejuizo: 1, abaixo: 1, ok: 1, sem_dado: 0, sem_ficha: 4 });
    expect(r.body.pecas).toEqual([
      {
        product_id: 'perde', nome: 'Chopp', image_url: null,
        custo_insumos: 15, mao_de_obra: 3, custo_da_peca: 18,
        preco_atual: 20, margem_que_sobra_pct: -10, situacao: 'prejuizo', preco_sugerido: 36,
      },
      {
        product_id: 'aperta', nome: 'Caneca', image_url: null,
        custo_insumos: 10, mao_de_obra: 1, custo_da_peca: 11,
        preco_atual: 20, margem_que_sobra_pct: 25, situacao: 'abaixo', preco_sugerido: 22,
      },
      {
        product_id: 'ok', nome: 'Kit', image_url: 'https://cdn/kit.jpg',
        custo_insumos: 30, mao_de_obra: 1, custo_da_peca: 31,
        preco_atual: 100, margem_que_sobra_pct: 49, situacao: 'ok', preco_sugerido: 62,
      },
    ]);

    // Escopo e produtos inativos de fora.
    const fichas = chamadas.find((c) => /FROM studio_compositions_summary/.test(c.s));
    expect(fichas.params).toEqual([CID]);
    expect(fichas.s).toMatch(/is_active IS NOT FALSE/);
    const regras = chamadas.find((c) => /FROM studio_pricing_rules/.test(c.s));
    expect(regras.s).not.toMatch(/setup_fee/); // setup depende da tiragem: nao entra
  });

  test('sem taxa configurada, a conta e a margem bruta de sempre (mais a mao de obra)', async () => {
    banco({ pecas: PECAS, regras: [], semFicha: 0 });
    const r = await request(app()).get(url('/preco-certo/diagnostico'));
    expect(r.body.taxa_em_uso_pct).toBe(0);
    expect(r.body.taxa_configurada).toBe(false);
    expect(r.body.pecas.map((p) => [p.product_id, p.margem_que_sobra_pct, p.situacao, p.preco_sugerido])).toEqual([
      ['perde', 25, 'abaixo', 21.43],
      ['aperta', 50, 'ok', 14.29],
      ['ok', 70, 'ok', 42.86],
    ]);
  });

  test('base sem a view de fichas: lista vazia, sem erro', async () => {
    banco({ semFicha: 7 });
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM studio_compositions_summary/.test(String(sql))) {
        const e = new Error('relation does not exist'); e.code = '42P01'; throw e;
      }
      return base(sql, params);
    });
    const r = await request(app()).get(url('/preco-certo/diagnostico'));
    expect(r.status).toBe(200);
    expect(r.body.pecas).toEqual([]);
    expect(r.body.resumo).toEqual({ prejuizo: 0, abaixo: 0, ok: 0, sem_dado: 0, sem_ficha: 7 });
  });
});

describe('POST /studio/preco-certo/aplicar', () => {
  const updates = (chamadas) => chamadas.filter((c) => /UPDATE products/.test(c.s));
  const sqls = (chamadas) => chamadas.map((c) => c.s.trim().split(/\s+/)[0]);

  test('(4) grava o preco que veio da tela, numa transacao, escopado na empresa', async () => {
    const chamadas = clienteQueGrava([P1, P2]);
    const r = await request(app()).post(url('/preco-certo/aplicar')).send({
      itens: [{ product_id: P1, price: 36 }, { product_id: P2, price: 22.005 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.atualizados).toEqual([
      { product_id: P1, nome: 'Peça 1111', price: 36 },
      { product_id: P2, nome: 'Peça 2222', price: 22.01 },
    ]);
    expect(sqls(chamadas)).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'COMMIT']);
    for (const u of updates(chamadas)) {
      expect(u.s).toMatch(/WHERE id = \$2 AND company_id = \$3/);
      expect(u.params[2]).toBe(CID);
    }
    expect(esquecerPagina).toHaveBeenCalledTimes(1);
  });

  test('produto de outra empresa: nada e gravado', async () => {
    const chamadas = clienteQueGrava([P1]);
    const r = await request(app()).post(url('/preco-certo/aplicar')).send({
      itens: [{ product_id: P1, price: 36 }, { product_id: DE_FORA, price: 10 }],
    });
    expect(r.status).toBe(404);
    expect(r.body.product_ids).toEqual([DE_FORA]);
    expect(updates(chamadas)).toHaveLength(0);
    expect(sqls(chamadas)).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    // A conferencia de dono e pela empresa da URL.
    expect(chamadas[1].s).toMatch(/company_id = \$1/);
    expect(chamadas[1].params[0]).toBe(CID);
    expect(esquecerPagina).not.toHaveBeenCalled();
  });

  test.each([
    ['sem itens', {}],
    ['lista vazia', { itens: [] }],
    ['preco zero', { itens: [{ product_id: P1, price: 0 }] }],
    ['preco negativo', { itens: [{ product_id: P1, price: -5 }] }],
    ['preco em texto', { itens: [{ product_id: P1, price: '36' }] }],
    ['preco infinito (null no JSON)', { itens: [{ product_id: P1, price: null }] }],
    ['product_id que nao e uuid', { itens: [{ product_id: 'abc', price: 10 }] }],
    ['produto repetido', { itens: [{ product_id: P1, price: 10 }, { product_id: P1, price: 12 }] }],
    ['mais de 200', { itens: Array.from({ length: 201 }, () => ({ product_id: P1, price: 10 })) }],
  ])('recusa %s com 400, sem abrir transacao', async (_nome, corpo) => {
    clienteQueGrava([P1]);
    const r = await request(app()).post(url('/preco-certo/aplicar')).send(corpo);
    expect(r.status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('erro no meio desfaz tudo', async () => {
    const chamadas = [];
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        chamadas.push({ s, params });
        if (/SELECT id FROM products/.test(s)) return { rows: [{ id: P1 }, { id: P2 }] };
        if (/UPDATE products/.test(s) && params[1] === P2) throw new Error('deadlock');
        if (/UPDATE products/.test(s)) return { rows: [{ id: P1, name: 'A', price: '36' }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    }));
    const r = await request(app()).post(url('/preco-certo/aplicar')).send({
      itens: [{ product_id: P1, price: 36 }, { product_id: P2, price: 22 }],
    });
    expect(r.status).toBe(500);
    expect(sqls(chamadas)).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'ROLLBACK']);
    expect(esquecerPagina).not.toHaveBeenCalled();
  });
});

describe('(5) o que ja existia passa a usar a taxa em uso', () => {
  const REGRA = {
    product_id: P1, setup_fee: '30.00', labor_cost: '4.50',
    default_margin_pct: '40.00', urgency_pct: '20.00', qty_tiers: null,
  };
  const cotar = (corpo) => request(app()).post(url('/pricing/quote-line')).send(corpo);
  const fichaDe = (custo) => [{ total_cost: String(custo), product_id: P1, product_name: 'Caneca', product_price: '20.00', margin_pct: '40.00' }];

  test('quote-line: o divisor desconta a taxa e o breakdown mostra o custo fixo', async () => {
    banco({ settings: { taxa_custo_fixo_pct: 20 }, pecas: fichaDe(12.34), regras: [REGRA] });
    const r = await cotar({ product_id: P1, quantity: 10 });
    // custo 12,34 + 4,50 + 3,00 = 19,84 ÷ (1 − 0,40 − 0,20) = 49,60
    expect(r.body).toEqual({
      unit_price: 49.6,
      breakdown: {
        base_cost: 12.34, labor: 4.5, setup: 3, tier_multiplier: 1, margin_pct: 40, urgency: 0,
        fixed_cost_pct: 20, fixed_cost: 9.92,
      },
    });
  });

  test('quote-line sem taxa: campos novos zerados, preco de antes', async () => {
    banco({ pecas: fichaDe(12.34), regras: [REGRA] });
    const r = await cotar({ product_id: P1, quantity: 10 });
    expect(r.body.unit_price).toBe(33.07);
    expect(r.body.breakdown.fixed_cost_pct).toBe(0);
    expect(r.body.breakdown.fixed_cost).toBe(0);
  });

  test('quote-line: preco fixo de faixa e override continuam mandando', async () => {
    banco({
      settings: { taxa_custo_fixo_pct: 20 }, pecas: fichaDe(20),
      regras: [{ ...REGRA, qty_tiers: [{ min_qty: 50, max_qty: null, unit_price: 29.9 }] }],
    });
    const faixa = await cotar({ product_id: P1, quantity: 60 });
    expect(faixa.body.unit_price).toBe(29.9);
    expect(faixa.body.breakdown.fixed_cost).toBe(5.98);

    const over = await cotar({ product_id: P1, quantity: 60, overrides: { unit_price: 55 } });
    expect(over.body.unit_price).toBe(55);
    expect(over.body.breakdown.fixed_cost).toBe(11);
  });

  test('quote-line: margem + taxa de 100 para cima cai no dobro do custo', async () => {
    banco({
      settings: { taxa_custo_fixo_pct: 50 }, pecas: fichaDe(10),
      regras: [{ ...REGRA, setup_fee: '0', labor_cost: '0', default_margin_pct: '50' }],
    });
    const r = await cotar({ product_id: P1, quantity: 1 });
    expect(r.body.unit_price).toBe(20);
  });

  test('quote-line: settings fora do ar nao derruba o orcamento', async () => {
    banco({ pecas: fichaDe(12.34), regras: [REGRA] });
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM companies/.test(String(sql))) throw new Error('timeout');
      return base(sql, params);
    });
    const r = await cotar({ product_id: P1, quantity: 10 });
    expect(r.status).toBe(200);
    expect(r.body.unit_price).toBe(33.07);
  });

  const RISCO = [
    { product_id: 'b', product_name: 'Caneca', product_price: '20.00', total_cost: '12.00', margin_pct: '40.00' },
    { product_id: 'c', product_name: 'Chopp', product_price: '20.00', total_cost: '17.00', margin_pct: '15.00' },
  ];

  test('alerta de margem sem taxa: resposta identica a de antes', async () => {
    banco({ pecas: RISCO });
    const r = await request(app()).get(url('/margem/risco'));
    expect(r.body).toEqual({
      piso: 30,
      pecas: [{
        product_id: 'c', nome: 'Chopp', preco: 20, custo: 17, margem_pct: 15,
        situacao: 'abaixo', preco_sugerido: 24.29,
      }],
      recado: '"Chopp" ficou abaixo de 30% de margem.',
    });
  });

  test('alerta de margem com taxa: julga a margem que sobra e sugere com a taxa', async () => {
    banco({ settings: { taxa_custo_fixo_pct: 20 }, pecas: RISCO });
    const r = await request(app()).get(url('/margem/risco'));
    expect(r.body.taxa_em_uso_pct).toBe(20);
    expect(r.body.pecas).toEqual([
      {
        product_id: 'c', nome: 'Chopp', preco: 20, custo: 17, margem_pct: -5, margem_bruta_pct: 15,
        situacao: 'prejuizo', preco_sugerido: 34,
      },
      {
        product_id: 'b', nome: 'Caneca', preco: 20, custo: 12, margem_pct: 20, margem_bruta_pct: 40,
        situacao: 'abaixo', preco_sugerido: 24,
      },
    ]);
    expect(r.body.recado).toMatch(/1 peca passou a custar mais do que vende/);
  });

  test('PATCH /settings agora grava a margem minima — e valida', async () => {
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql, params) => (/UPDATE companies/.test(String(sql))
        ? { rows: [{ settings: JSON.parse(params[0]) }] } : { rows: [] })),
      release: jest.fn(),
    }));
    const ok = await request(app()).patch(url('/settings')).send({ margem_minima_pct: 45 });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toEqual({ margem_minima_pct: 45 });

    const ruim = await request(app()).patch(url('/settings')).send({ margem_minima_pct: 120 });
    expect(ruim.status).toBe(400);
  });
});
