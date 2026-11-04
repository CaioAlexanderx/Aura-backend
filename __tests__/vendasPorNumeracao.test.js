// ============================================================
// AURA. — Vendas por produto e numeração (03/11/2026)
//
// services/vendasPorNumeracao.js + GET /reports/vendas-por-numeracao +
// bloco "Mais vendidos" do e-mail. Números do mockup aprovado (aura-app
// docs/mockups/relatorio-vendas-por-numeracao.html): Tênis Runner Branco,
// 48 pares, 11 em estoque, giro 81%, dura ~7 dias, repor 37.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);
jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const V = require('../src/services/vendasPorNumeracao');
const RB = require('../src/services/relatorioBlocos');
const T = require('../src/templates/relatorioSemanalBlocos');

const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const BASE = `/companies/${COMPANY}`;

// ── Dados do mockup ───────────────────────────────────────────────
const TAM = ['34', '35', '36', '37', '38', '39', '40'];
const VEND = [3, 5, 9, 12, 10, 6, 3];
const EST = [2, 1, 2, 3, 1, 0, 2];
const RUNNER = { id: 'p-runner', name: 'Tênis Runner Branco', sku: 'TR-100', category: 'Tênis', unit: 'un', size: null, stock_qty: 0, is_active: true, supplier: { id: 's1', nome: 'Distribuidora Alfa', telefone: '11999990000' } };
const SANDALIA = { id: 'p-sand', name: 'Sandália Flat Nude', sku: 'SF-22', category: 'Sandália', unit: 'un', size: '36', stock_qty: 40, is_active: true, supplier: null };
const MANUTENCAO = { id: 'p-srv', name: 'Manutenção', sku: null, category: 'Serviços', unit: 'srv', size: null, stock_qty: 0, is_active: true, supplier: null };
const variantes = TAM.map((t, i) => ({ id: 'v' + t, product_id: 'p-runner', stock_qty: EST[i], is_active: t !== '39' || true, color_name: null, valores: [{ a: 'Tamanho', v: t }, { a: 'Cor', v: '#FFFFFF' }] }));
const vendas = [
  ...TAM.map((t, i) => ({ product_id: 'p-runner', variant_id: 'v' + t, qtd: VEND[i], receita: VEND[i] * 199.9, snapshot: 'Tênis Runner Branco' })),
  { product_id: 'p-sand', variant_id: null, qtd: 35, receita: 3465, snapshot: 'Sandália Flat Nude' },
  { product_id: 'p-srv', variant_id: null, qtd: 4, receita: 400, snapshot: 'Manutenção' },
  { product_id: 'p-apagado', variant_id: null, qtd: 2, receita: 100, snapshot: 'Bota antiga' },
];
const montar = (opts = {}) => V.montarRelatorio({
  produtos: [RUNNER, SANDALIA, MANUTENCAO], variantes, vendas, opts: { dias: 31, vendidosAnterior: 76, ...opts },
});

describe('período', () => {
  const hoje = '2026-11-03';
  test('este mês compara com os mesmos dias do mês anterior', () => {
    expect(V.resolverPeriodo('month', null, null, hoje)).toEqual({
      inicio: '2026-11-01', fim: '2026-11-03', dias: 3, rotulo: 'Novembro de 2026',
      anterior: { inicio: '2026-10-01', fim: '2026-10-03' },
    });
  });
  test('mês passado, 7 e 90 dias', () => {
    expect(V.resolverPeriodo('last_month', null, null, hoje)).toMatchObject({ inicio: '2026-10-01', fim: '2026-10-31', dias: 31, rotulo: 'Outubro de 2026', anterior: { inicio: '2026-09-01', fim: '2026-09-30' } });
    expect(V.resolverPeriodo('week', null, null, hoje)).toMatchObject({ inicio: '2026-10-28', fim: '2026-11-03', dias: 7 });
    expect(V.resolverPeriodo('d90', null, null, hoje)).toMatchObject({ dias: 90 });
    expect(V.resolverPeriodo('last_month', null, null, '2026-01-15')).toMatchObject({ inicio: '2025-12-01', fim: '2025-12-31' });
  });
  test('datas escolhidas: válidas, em ordem e até 1 ano', () => {
    expect(V.resolverPeriodo('custom', '2026-10-01', '2026-10-15', hoje)).toMatchObject({ dias: 15, rotulo: '01/10/2026 a 15/10/2026' });
    expect(() => V.resolverPeriodo('custom', '2026-10-15', '2026-10-01', hoje)).toThrow(/depois/);
    expect(() => V.resolverPeriodo('custom', '2025-01-01', '2026-10-01', hoje)).toThrow(/1 ano/);
    expect(() => V.resolverPeriodo('custom', null, '2026-10-01', hoje)).toThrow(/datas/);
    expect(() => V.resolverPeriodo('ano', null, null, hoje)).toThrow(/period/);
  });
});

describe('numeração', () => {
  test('ordem de vitrine: números, letras de roupa, o resto, Sem numeração', () => {
    const lista = ['G', '38', 'P', V.SEM_NUMERACAO, '34/35', '37,5', 'M', 'Infantil', 'GG'];
    expect([...lista].sort(V.compararNumeracao)).toEqual(['34/35', '37,5', '38', 'P', 'M', 'G', 'GG', 'Infantil', V.SEM_NUMERACAO]);
  });
  test('atributo com ou sem acento; letra minúscula vira maiúscula', () => {
    expect(V.numeracaoDaVariante([{ a: 'Numeração', v: ' 37 ' }])).toBe('37');
    expect(V.numeracaoDaVariante([{ a: 'tamanho', v: 'p' }])).toBe('P');
    expect(V.numeracaoDaVariante([{ a: 'Cor', v: 'Azul' }])).toBeNull();
  });
  test('cor: hex vira o nome guardado na variante', () => {
    expect(V.corDaVariante([{ a: 'Cor', v: '#000000' }], 'Preto')).toBe('Preto');
    expect(V.corDaVariante([{ a: 'Cor', v: 'Nude' }], null)).toBe('Nude');
  });
});

describe('relatório (tela 1 do mockup)', () => {
  const r = montar();
  const runner = r.modelos.find((m) => m.product_id === 'p-runner');

  test('Tênis Runner: 48 pares, 11 em estoque, giro 81%, dura 7 dias, repor 37', () => {
    expect(runner).toMatchObject({ vendidos: 48, estoque: 11, giro_pct: 81, dura_dias: 7, repor: 37, tipo: 'Tênis', fornecedor: { nome: 'Distribuidora Alfa' } });
    expect(runner.numeracoes).toEqual(TAM.map((t, i) => ({ numeracao: t, vendidos: VEND[i], estoque: EST[i] })));
  });

  test('sem variante: numeração do campo tamanho do produto', () => {
    const s = r.modelos.find((m) => m.product_id === 'p-sand');
    expect(s.numeracoes).toEqual([{ numeracao: '36', vendidos: 35, estoque: 40 }]);
    expect(s).toMatchObject({ giro_pct: 47, dura_dias: 35, repor: 0 });
  });

  test('serviço fica fora; produto apagado aparece pelo nome da venda', () => {
    expect(r.modelos.some((m) => m.nome === 'Manutenção')).toBe(false);
    expect(r.modelos.find((m) => m.product_id === 'p-apagado')).toMatchObject({ nome: 'Bota antiga', tipo: 'Sem categoria', numeracoes: [{ numeracao: V.SEM_NUMERACAO, vendidos: 2, estoque: 0 }] });
  });

  test('KPIs, campeã, variação e unidade', () => {
    expect(r.kpis).toMatchObject({ vendidos: 85, modelos_venderam: 3, modelos_total: 2, vendidos_anterior: 76, variacao_pct: 12 });
    expect(r.kpis.campea).toEqual({ numeracao: '36', vendidos: 44, pct: 52 });
    // Tênis e Sandália são calçado; a bota apagada não tem categoria → itens.
    expect(r.unidade).toBe('itens');
    expect(montar({ q: 'runner' }).unidade).toBe('pares');
  });

  test('por numeração: estoque de todos os produtos, Sem numeração por último', () => {
    expect(r.numeracoes[0]).toMatchObject({ numeracao: '36', vendidos: 44, estoque: 42 });
    expect(r.numeracoes[r.numeracoes.length - 1].numeracao).toBe(V.SEM_NUMERACAO);
    expect(r.numeracoes.find((n) => n.numeracao === '39')).toMatchObject({ vendidos: 6, estoque: 0, repor: 6 });
  });

  test('colunas da grade em ordem; totais', () => {
    expect(r.colunas).toEqual([...TAM, V.SEM_NUMERACAO]);
    expect(r.totais).toMatchObject({ vendidos: 85, estoque: 51, repor: 39 });
  });

  test('filtro de tipo e busca', () => {
    expect(montar({ category: 'Sandália' }).modelos.map((m) => m.product_id)).toEqual(['p-sand']);
    expect(montar({ q: 'tr-100' }).modelos.map((m) => m.product_id)).toEqual(['p-runner']);
  });

  test('separar por cor: o modelo vira uma linha por cor', () => {
    const vs = [
      { id: 'a', product_id: 'p-runner', stock_qty: 1, is_active: true, color_name: 'Branco', valores: [{ a: 'Tamanho', v: '37' }, { a: 'Cor', v: '#FFFFFF' }] },
      { id: 'b', product_id: 'p-runner', stock_qty: 4, is_active: true, color_name: 'Preto', valores: [{ a: 'Tamanho', v: '37' }, { a: 'Cor', v: '#000000' }] },
    ];
    const rc = V.montarRelatorio({
      produtos: [RUNNER], variantes: vs,
      vendas: [{ product_id: 'p-runner', variant_id: 'a', qtd: 3, receita: 600 }, { product_id: 'p-runner', variant_id: 'b', qtd: 1, receita: 200 }],
      opts: { dias: 7, porCor: true },
    });
    expect(rc.modelos.map((m) => [m.cor, m.vendidos, m.estoque])).toEqual([['Branco', 3, 1], ['Preto', 1, 4]]);
  });

  test('variante desativada depois da venda ainda dá a numeração; sem estoque', () => {
    const vs = [{ id: 'velha', product_id: 'p-runner', stock_qty: 9, is_active: false, color_name: null, valores: [{ a: 'Tamanho', v: '41' }] }];
    const rv = V.montarRelatorio({ produtos: [RUNNER], variantes: vs, vendas: [{ product_id: 'p-runner', variant_id: 'velha', qtd: 2, receita: 1 }], opts: { dias: 7 } });
    expect(rv.modelos[0].numeracoes).toEqual([{ numeracao: '41', vendidos: 2, estoque: 0 }]);
  });
});

describe('GET /reports/vendas-por-numeracao', () => {
  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/companies/:id', require('../src/routes/private'));
  }, 60000);
  const token = () => jwt.sign({ id: 'u1', role: 'client', plan: 'essencial', company: COMPANY }, 'aura-test-secret-2026', { expiresIn: '1h' });
  function banco({ papel = 'owner', permissions = null } = {}) {
    db.query.mockReset();
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      const r = (rows) => Promise.resolve({ rows, rowCount: rows.length });
      if (/'owner' AS role/.test(s)) return r([{ role: papel }]);
      if (/cm\.role_label, cm\.permissions/.test(s)) return r([{ is_owner: papel === 'owner', role_label: papel, permissions }]);
      if (/GROUP BY si\.product_id, si\.variant_id/.test(s)) return r(vendas.slice(0, 7));
      if (/COALESCE\(SUM\(si\.quantity\), 0\)::float AS qtd/.test(s)) return r([{ qtd: 40 }]);
      if (/FROM products p\s+LEFT JOIN suppliers/.test(s)) return r([{ ...RUNNER, supplier_id: 's1', supplier_name: 'Distribuidora Alfa', supplier_phone: null }]);
      if (/FROM product_variants v/.test(s)) return r(variantes);
      return r([]);
    });
  }
  const get = (q = '') => request(app).get(`${BASE}/reports/vendas-por-numeracao${q}`).set('Authorization', `Bearer ${token()}`);

  test('dono: o relatório do mês', async () => {
    banco();
    const res = await get('?period=last_month');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unidade: 'pares', consolidado: false, kpis: { vendidos: 48, vendidos_anterior: 40, variacao_pct: 20 } });
    expect(res.body.modelos[0]).toMatchObject({ nome: 'Tênis Runner Branco', vendidos: 48, repor: 37 });
    expect(JSON.stringify(res.body)).not.toMatch(/cost/);
  });

  test('período inválido: 400', async () => {
    banco();
    expect((await get('?period=ano')).status).toBe(400);
    expect((await get('?period=custom&start_date=2026-10-10')).status).toBe(400);
  });

  test('funcionário só de Caixa e Estoque: 403', async () => {
    banco({ papel: 'Colaborador', permissions: { pdv: true, estoque: true, painel: false } });
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SEM_PERMISSAO_RELATORIO');
  });

  test('funcionário com Financeiro vê', async () => {
    banco({ papel: 'Gerente', permissions: { pdv: true, painel: false, financeiro: true } });
    expect((await get()).status).toBe(200);
  });
});

describe('e-mail semanal: Mais vendidos com numeração (tela 5)', () => {
  const rel = montar();
  const nm = RB._montar.montarNumeracaoDaSemana(rel, 6);

  test('top com as 3 numerações e o Acabando', () => {
    expect(nm.modelos[0]).toMatchObject({ nome: 'Tênis Runner Branco', qtd: 48, estoque: 11, numeros: [{ n: '37', q: 12 }, { n: '38', q: 10 }, { n: '36', q: 9 }] });
    expect(nm.acabando[0]).toMatchObject({ nome: 'Tênis Runner Branco', numeracao: '39', estoque: 0 });
    expect(nm.modelos.length).toBeLessThanOrEqual(10);
    expect(nm.acabando.length).toBeLessThanOrEqual(5);
  });

  test('loja sem numeração: nada (o bloco fica o de sempre)', () => {
    const semNum = V.montarRelatorio({ produtos: [{ ...SANDALIA, size: null }], variantes: [], vendas: [vendas[7]], opts: { dias: 6 } });
    expect(RB._montar.montarNumeracaoDaSemana(semNum, 6)).toBeNull();
  });

  test('HTML: tabela, Acabando e o link da tabela completa', () => {
    const m = { ...RB._montar.montarMaisVendidos([{ id: 'p-runner', nome: 'Tênis Runner Branco', qtd: 48, receita: 9595 }]), numeracao: nm };
    const html = T.blocoNumeracao(nm);
    expect(html).toMatch(/Numerações que mais saíram/);
    expect(html).toMatch(/37 \(12\) · 38 \(10\) · 36 \(9\)/);
    expect(html).toMatch(/Tênis Runner Branco 39 \(acabou\)/);
    expect(html).toMatch(/>Itens</); // tênis + produto sem categoria = itens
    const bloco = T.renderBlocos({ blocos: ['mais_vendidos'], mais_vendidos: m }, { modo: 'email', companyId: COMPANY, env: { APP_URL: 'https://app.getaura.com.br' } });
    expect(bloco).toMatch(/financeiro\/vendas-por-numeracao\?period=week&amp;empresa=|financeiro\/vendas-por-numeracao\?period=week&empresa=/);
  });

  test('grupo: o mesmo produto soma vendidos e estoque', () => {
    const a = RB._montar.fecharNumeracao([{ id: 'x', nome: 'Bota', qtd: 3, estoque: 1, _numeros: { 37: 3 }, _estoques: { 37: 1 } }], 'pares', 6);
    const juntos = RB._montar.fecharNumeracao([
      { ...a._modelos[0] },
      { id: 'y', nome: 'Chinelo', qtd: 1, estoque: 9, _numeros: { 38: 1 }, _estoques: { 38: 9 } },
    ], 'pares', 6);
    expect(juntos.modelos.map((x) => x.nome)).toEqual(['Bota', 'Chinelo']);
    expect(juntos.acabando.map((x) => x.numeracao)).toEqual(['37']);
  });
});
