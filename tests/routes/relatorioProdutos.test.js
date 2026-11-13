// ============================================================
// Relatório de Produtos (p-114) — a rota, com o pg de mentira.
//
//   GET /companies/:id/relatorios/produtos   (loja ou consolidado)
//
// Montada pelo src/routes/private.js de verdade: confere o caminho, que
// nenhum requirePlan pega a rota e a ordem dos middlewares de custo.
// Dados: tests/helpers/fakeRelatorioProdutosDb.js (lojas inventadas).
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const fake = require('../helpers/fakeRelatorioProdutosDb');
const { SQL_CATALOGO, SQL_VENDAS, SQL_DIAS } = require('../../src/services/relatorioProdutos');

const SECRET = 'aura-test-secret-2026';
// Plano Essencial no token: a rota não tem gate de plano.
const dono = jwt.sign({ id: fake.USER, role: 'client', plan: 'essencial', company: fake.A }, SECRET);
const donoConsolidado = jwt.sign({ id: fake.USER, role: 'client', plan: 'negocio', company: null, consolidated_view: true }, SECRET);
const staff = jwt.sign({ id: fake.USER, role: 'admin' }, SECRET);

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../../src/routes/private'));
});

const get = (query = '', token = dono, cid = fake.A) => {
  const r = request(app).get(`/companies/${cid}/relatorios/produtos${query}`);
  return token ? r.set('Authorization', 'Bearer ' + token) : r;
};

const CATALOGO = /FROM products p\s+JOIN companies c/;
const VENDAS = /WITH v AS/;
const DIAS = /GROUP BY 1, 2, 3/;

// O perfil real do "custo oculto" (03/11/2026): Caixa e Estoque, sem retaguarda.
const BALCAO = { permissions: { pdv: true, painel: false, estoque: true, clientes: true } };
const CONSULTA = { permissions: { estoque: true, estoque_consulta: true, pdv: true } };

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ now: fake.AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
  fake.ligar(db.query);
});
afterEach(() => jest.useRealTimers());

describe('GET /companies/:id/relatorios/produtos — loja', () => {
  test('dono no Essencial: 200 com o contrato completo', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'agrupar', 'cobertura_custo', 'direcao', 'empresas', 'escopo', 'filtros', 'linhas', 'modelo',
      'ordem', 'paginacao', 'periodo', 'pode_ver_custo', 'totais', 'total_linhas', 'truncado',
    ]);
    expect(res.body).toMatchObject({
      periodo: { de: '2026-10-15', ate: '2026-11-13', dias: 30, hoje: '2026-11-13' },
      modelo: null, agrupar: 'item', escopo: 'loja', empresas: [fake.A], pode_ver_custo: true,
      total_linhas: 7,
      totais: { itens: 7, faturamento: 2250, lucro: 1060, margem: 58.9 },
      cobertura_custo: { com_custo: 6, sem_custo: 1, percentual: 85.7 },
    });
    expect(Object.keys(res.body.linhas[0]).sort()).toEqual([
      'ativo', 'categoria', 'categoria_id', 'chave', 'codigo_barras', 'compartilhado', 'custo',
      'dias_ate_acabar', 'dias_sem_vender', 'estoque', 'faturamento', 'loja', 'lucro', 'marca', 'margem',
      'media_diaria', 'nome', 'nome_exibicao', 'preco', 'product_id', 'sku', 'tem_custo', 'ultima_venda',
      'unidade', 'valor_estoque_venda', 'valor_parado', 'variant_id', 'variante', 'vendidos',
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('três consultas, com o período, a janela de 1 ano e os filtros no banco', async () => {
    await get(`?de=2026-11-01&ate=2026-11-10&categoria=${fake.CAT_ROUPAS}&marca=Marca%20Teste&busca=50%25_off&so_ativos=0`);
    expect(fake.chamadas(db.query, CATALOGO)[0][1]).toEqual([[fake.A], fake.CAT_ROUPAS, null, 'Marca Teste', '%50\\%\\_off%', false]);
    expect(fake.chamadas(db.query, VENDAS)[0][1]).toEqual([[fake.A], '2026-11-01', '2026-11-10', '2025-11-13', '2026-11-13']);
    expect(fake.chamadas(db.query, DIAS)[0][1]).toEqual([[fake.A], '2026-11-01', '2026-11-10']);
    // Categoria pelo nome antigo (products.category) vai no outro parâmetro.
    jest.clearAllMocks();
    await get('?categoria=Roupas');
    expect(fake.chamadas(db.query, CATALOGO)[0][1].slice(1, 3)).toEqual([null, 'Roupas']);
  });

  test('as consultas tiram venda cancelada e troca, e usam o dia de São Paulo', () => {
    for (const sql of [SQL_VENDAS, SQL_DIAS]) {
      expect(sql).toMatch(/COALESCE\(s\.status, 'completed'\) <> 'cancelled'/);
      expect(sql).toMatch(/COALESCE\(s\.type, 'sale'\) = 'sale'/);
      expect(sql).toMatch(/AT TIME ZONE 'America\/Sao_Paulo'/);
    }
    // Serviço fora; compartilhado do grupo dentro.
    expect(SQL_CATALOGO).toMatch(/duration_minutes IS NULL/);
    expect(SQL_CATALOGO).toMatch(/is_group_shared = true AND p\.company_id IN/);
  });

  test('modelo + paginação: mais_vendidos por produto, segunda página', async () => {
    const res = await get('?modelo=mais_vendidos&limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ modelo: 'mais_vendidos', agrupar: 'produto', ordem: 'vendidos', direcao: 'desc', total_linhas: 3 });
    expect(res.body.paginacao).toEqual({ limit: 2, offset: 1, todas: false });
    expect(res.body.linhas.map((l) => l.nome)).toEqual(['Calça Jeans Reta', 'Vestido Linho']);
    expect(res.body.linhas[0].primeiro_a_acabar).toEqual({ variant_id: fake.V.m, rotulo: 'M', dias: 0 });
  });

  test('todas=1 para a exportação', async () => {
    const res = await get('?todas=1&limit=1');
    expect(res.body.linhas).toHaveLength(7);
    expect(res.body).toMatchObject({ truncado: false, paginacao: { todas: true, offset: 0 } });
  });

  test('parâmetro inválido → 400 sem consultar o relatório', async () => {
    for (const q of ['?modelo=xyz', '?agrupar=loja', '?escopo=mundo', '?ate=2026-12-01']) {
      jest.clearAllMocks();
      const res = await get(q);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('RELATORIO_PARAMETRO');
      expect(fake.chamadas(db.query, CATALOGO)).toHaveLength(0);
    }
  });

  test('sem token → 401; sem acesso à loja → 403', async () => {
    expect((await get('', null)).status).toBe(401);
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    expect((await get()).status).toBe(403);
  });

  test('erro do banco → 500 com mensagem da tela', async () => {
    fake.ligar(db.query);
    const original = db.query.getMockImplementation();
    db.query.mockImplementation((sql, p) => (VENDAS.test(String(sql)) ? Promise.reject(new Error('boom')) : original(sql, p)));
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Não conseguimos montar o relatório/);
    erro.mockRestore();
  });
});

describe('quem não vê custo', () => {
  test('funcionário sem retaguarda: 200 com custo, lucro, margem e valor parado em null', async () => {
    fake.ligar(db.query, { membro: BALCAO });
    const res = await get('?agrupar=produto');
    expect(res.status).toBe(200);
    expect(res.body.pode_ver_custo).toBe(false);
    for (const l of res.body.linhas) {
      expect(l).toMatchObject({ custo: null, tem_custo: null, lucro: null, margem: null, valor_parado: null });
    }
    expect(res.body.totais).toMatchObject({ valor_estoque_custo: null, lucro: null, margem: null, faturamento: 2340 });
    expect(res.body.cobertura_custo).toBeNull();
    // Preço e estoque continuam.
    expect(res.body.linhas.find((l) => l.nome === 'Calça Jeans Reta')).toMatchObject({ preco: 100, estoque: 40, vendidos: 17 });
  });

  test.each(['mais_lucrativos', 'margem_baixa', 'sem_custo'])('modelo %s → 403 RELATORIO_SEM_CUSTO', async (modelo) => {
    fake.ligar(db.query, { membro: BALCAO });
    const res = await get(`?modelo=${modelo}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'RELATORIO_SEM_CUSTO', modelos_sem_custo: ['mais_lucrativos', 'margem_baixa', 'sem_custo'] });
    expect(fake.chamadas(db.query, CATALOGO)).toHaveLength(0);
  });

  test('ordem por lucro → 403; parados_30 sai ordenado por dias sem vender', async () => {
    fake.ligar(db.query, { membro: BALCAO });
    expect((await get('?ordem=lucro')).status).toBe(403);
    const res = await get('?modelo=parados_30');
    expect(res.status).toBe(200);
    expect(res.body.ordem).toBe('dias_sem_vender');
  });

  test('a chave custos=false do dono da equipe vale mesmo com Financeiro', async () => {
    fake.ligar(db.query, { membro: { permissions: { financeiro: true, custos: false } } });
    const res = await get();
    expect(res.body.pode_ver_custo).toBe(false);
    expect(res.body.linhas.every((l) => l.custo === null)).toBe(true);
  });

  test('membro com Financeiro vê custo', async () => {
    fake.ligar(db.query, { membro: { permissions: { financeiro: true, painel: false } } });
    const res = await get('?modelo=mais_lucrativos');
    expect(res.status).toBe(200);
    expect(res.body.pode_ver_custo).toBe(true);
  });

  test('"estoque só consulta" → 403 ESTOQUE_SO_CONSULTA', async () => {
    fake.ligar(db.query, { membro: CONSULTA });
    const res = await get();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ESTOQUE_SO_CONSULTA');
    expect(fake.chamadas(db.query, CATALOGO)).toHaveLength(0);
  });
});

describe('consolidado do grupo', () => {
  test('token em "Todas as empresas": as lojas que o usuário alcança, o compartilhado uma vez', async () => {
    const res = await get('?agrupar=produto', donoConsolidado);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ escopo: 'grupo', empresas: [fake.A, fake.B] });
    expect(fake.chamadas(db.query, /AS alcanca/)[0][1]).toEqual([fake.A, fake.USER, false]);
    expect(fake.chamadas(db.query, CATALOGO)[0][1][0]).toEqual([fake.A, fake.B]);
    expect(fake.chamadas(db.query, VENDAS)[0][1][0]).toEqual([fake.A, fake.B]);
    const meia = res.body.linhas.filter((l) => l.nome === 'Meia Soquete');
    expect(meia).toHaveLength(1);
    expect(meia[0]).toMatchObject({ vendidos: 50, loja: { company_id: fake.B, nome: 'Loja Filial' }, compartilhado: true });
    expect(res.body.linhas.find((l) => l.nome === 'Bolsa Palha').loja.company_id).toBe(fake.B);
  });

  test('?escopo=grupo com o token de uma loja; ?escopo=loja vale mais que o token', async () => {
    expect((await get('?escopo=grupo')).body.empresas).toEqual([fake.A, fake.B]);
    jest.clearAllMocks();
    const res = await get('?escopo=loja', donoConsolidado);
    expect(res.body).toMatchObject({ escopo: 'loja', empresas: [fake.A] });
    expect(fake.chamadas(db.query, /AS alcanca/)).toHaveLength(0);
  });

  test('loja do grupo que o usuário não alcança fica fora', async () => {
    fake.ligar(db.query, { membro: { permissions: null }, membroB: { permissions: null, alcanca: false } });
    const res = await get('', donoConsolidado);
    expect(res.body).toMatchObject({ escopo: 'loja', empresas: [fake.A] });
  });

  test('vale a loja mais restrita: sem custo na Filial, o custo some de tudo', async () => {
    fake.ligar(db.query, { membro: { permissions: { financeiro: true } }, membroB: BALCAO });
    const res = await get('', donoConsolidado);
    expect(res.body).toMatchObject({ escopo: 'grupo', pode_ver_custo: false });
    expect(res.body.totais.lucro).toBeNull();
    expect((await get('?modelo=sem_custo', donoConsolidado)).status).toBe(403);
  });

  test('loja onde a pessoa é "só consulta" sai do consolidado', async () => {
    fake.ligar(db.query, { membro: { permissions: { financeiro: true } }, membroB: CONSULTA });
    const res = await get('', donoConsolidado);
    expect(res.body).toMatchObject({ escopo: 'loja', empresas: [fake.A], pode_ver_custo: true });
  });

  test('staff alcança o grupo inteiro', async () => {
    await get('?escopo=grupo', staff);
    expect(fake.chamadas(db.query, /AS alcanca/)[0][1]).toEqual([fake.A, fake.USER, true]);
  });
});
