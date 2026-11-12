// ============================================================
// AURA. — Preencher custos em massa: regras puras e rota sem banco
// (migration 448). O Postgres real fica em custoEmMassa.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const svc = require('../src/services/custoEmMassa');
const schema = require('../src/utils/custoEmMassaSchema');

const CID = '11111111-1111-4111-8111-111111111111';
const PID = '00000000-0000-4000-8000-000000000001';
const PID2 = '00000000-0000-4000-8000-000000000002';

describe('sugerirCusto (mesma conta do app)', () => {
  test('markup: preco / (1 + pct), ao centavo e mais nada', () => {
    expect(svc.sugerirCusto(59.9, 'markup', 100)).toBe(29.95);
    expect(svc.sugerirCusto(49.9, 'markup', 80)).toBe(27.72);
    expect(svc.sugerirCusto(39.9, 'markup', 0)).toBe(39.9);
  });
  test('margem: preco x (1 - pct), menor que 100', () => {
    expect(svc.sugerirCusto(59.9, 'margem', 50)).toBe(29.95);
    expect(svc.sugerirCusto(59.9, 'margem', 100)).toBeNull();
  });
  test('sem preco nao sugere', () => {
    expect(svc.sugerirCusto(0, 'markup', 100)).toBeNull();
    expect(svc.sugerirCusto(null, 'markup', 100)).toBeNull();
    expect(svc.sugerirCusto(10, 'markup', -1)).toBeNull();
  });
});

describe('estaSemCusto (mesma regra da conferencia)', () => {
  test.each([
    [{ cost_price: null, weighted_avg_cost: null }, true],
    [{ cost_price: '0.00', weighted_avg_cost: '0.0000' }, true],
    [{ cost_price: '0.00', weighted_avg_cost: null }, true],
    [{ cost_price: '12.00', weighted_avg_cost: null }, false],
    [{ cost_price: null, weighted_avg_cost: '8.5' }, false],
  ])('%j -> %s', (p, esperado) => {
    expect(svc.estaSemCusto(p)).toBe(esperado);
  });
});

describe('lerPedido', () => {
  const ler = (b) => () => svc.lerPedido(b);
  test('aceita custo com virgula e origem padrao digitado; previa por padrao', () => {
    const p = svc.lerPedido({ itens: [{ product_id: PID.toUpperCase(), custo: '1.234,56' }] });
    expect(p).toEqual({ dryRun: true, itens: [{ productId: PID, custoCentavos: 123456, origem: 'digitado' }], atalho: null, countId: null });
  });
  test('recusa o que nao da para gravar', () => {
    expect(ler({ itens: [] })).toThrow(expect.objectContaining({ code: 'SEM_ITENS' }));
    expect(ler({ itens: [{ product_id: 'x', custo: 1 }] })).toThrow(expect.objectContaining({ code: 'PEDIDO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: '0,00' }] })).toThrow(expect.objectContaining({ code: 'CUSTO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 0.004 }] })).toThrow(expect.objectContaining({ code: 'CUSTO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1e9 }] })).toThrow(expect.objectContaining({ code: 'CUSTO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1 }, { product_id: PID, custo: 2 }] })).toThrow(expect.objectContaining({ code: 'PRODUTO_REPETIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1, origem: 'chute' }] })).toThrow(expect.objectContaining({ code: 'PEDIDO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1, origem: 'sugerido' }] })).toThrow(expect.objectContaining({ code: 'ATALHO_OBRIGATORIO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1 }], atalho: { modo: 'margem', percentual: 100 } })).toThrow(expect.objectContaining({ code: 'PEDIDO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1 }], dry_run: 'nao' })).toThrow(expect.objectContaining({ code: 'PEDIDO_INVALIDO' }));
    expect(ler({ itens: [{ product_id: PID, custo: 1 }], count_id: 'abc' })).toThrow(expect.objectContaining({ code: 'PEDIDO_INVALIDO' }));
  });
  test('atalho com percentual e count_id', () => {
    const p = svc.lerPedido({
      itens: [{ product_id: PID, custo: 29.95, origem: 'sugerido' }],
      atalho: { modo: 'markup', percentual: '100' }, count_id: PID2, dry_run: false,
    });
    expect(p).toMatchObject({ dryRun: false, atalho: { modo: 'markup', percentual: 100 }, countId: PID2 });
  });
});

describe('montarPrevia', () => {
  const pedido = (itens) => ({ itens: itens.map(([productId, c, origem = 'digitado']) => ({ productId, custoCentavos: c, origem })) });
  test('grava, mudou no meio, servico, nao encontrado, acima do preco e compartilhado', () => {
    const produtos = [
      { id: PID, name: 'Chaveiro', price: '24.90', cost_price: null, weighted_avg_cost: null, is_group_shared: true, unit: 'un', is_active: true },
      { id: PID2, name: 'Bolsa', price: '89.90', cost_price: '40.00', weighted_avg_cost: null, is_group_shared: false, unit: 'un', is_active: true },
      { id: '00000000-0000-4000-8000-000000000003', name: 'Ajuste', price: '10.00', cost_price: null, weighted_avg_cost: null, unit: 'SRV', is_active: true },
    ];
    const { resumo, itens } = svc.montarPrevia({
      produtos,
      lojasDoGrupo: 3,
      pedido: pedido([[PID, 2490, 'mesmo'], [PID2, 4495, 'sugerido'], ['00000000-0000-4000-8000-000000000003', 100], ['00000000-0000-4000-8000-000000000004', 100]]),
    });
    expect(resumo).toEqual({
      gravar: 1, digitados: 0, sugeridos: 0, mesmo: 1, compartilhados: 1, lojas_do_grupo: 3,
      acima_do_preco: 1, mudou_no_meio: 1, servicos: 1, nao_encontrados: 1,
    });
    expect(svc.itemPublico(itens[0])).toEqual({
      product_id: PID, nome: 'Chaveiro', preco: 24.9, origem: 'mesmo', compartilhado: true, lojas: 3,
      status: 'grava', custo_antes: null, custo_depois: 24.9, acima_do_preco: true,
    });
    expect(itens[1]).toMatchObject({ status: 'mudou_no_meio', custo_atual: 40 });
    expect(itens.map((i) => i.status)).toEqual(['grava', 'mudou_no_meio', 'servico', 'nao_encontrado']);
  });
});

describe('mudouDepois (desfazer)', () => {
  const item = { cost_after: '27.72', weighted_avg_before: null };
  test('custo e custo medio iguais aos do preenchimento: volta', () => {
    expect(svc.mudouDepois(item, { cost_price: '27.72', weighted_avg_cost: null })).toBeNull();
  });
  test('entrada de mercadoria mexeu no custo ou no medio: fica', () => {
    expect(svc.mudouDepois(item, { cost_price: '30.00', weighted_avg_cost: '30' })).toBe('changed');
    expect(svc.mudouDepois(item, { cost_price: '27.72', weighted_avg_cost: '27.7200' })).toBe('changed');
    expect(svc.mudouDepois(item, undefined)).toBe('not_found');
  });
});

// ─── rota ──────────────────────────────────────────────────
function app(user = { id: 'u1', role: 'client' }, companyRole = 'owner') {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = user; req.companyRole = companyRole; next(); });
  a.use('/companies/:id/products', require('../src/routes/productCostFills'));
  return a;
}
const url = (s = '') => `/companies/${CID}/products/cost-fills${s}`;

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  schema._resetCache();
});

describe('antes da migration 448', () => {
  beforeEach(() => {
    db.query.mockImplementation(async (sql) => {
      if (/information_schema\.columns/.test(sql)) return { rows: [{ n: '0' }] };
      throw new Error(`query inesperada: ${sql}`);
    });
  });
  test.each([
    ['get', '/pendentes'],
    ['get', '/contagem'],
    ['get', ''],
    ['post', ''],
    ['post', `/${PID}/undo`],
  ])('%s %s = 503 MIGRATION_PENDING sem tocar em produto', async (metodo, caminho) => {
    const r = await request(app())[metodo](url(caminho)).send({ itens: [{ product_id: PID, custo: 1 }], dry_run: false });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('MIGRATION_PENDING');
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('depois da migration', () => {
  function banco(extra = () => null) {
    db.query.mockImplementation(async (sql, params) => {
      if (/information_schema\.columns/.test(sql)) return { rows: [{ n: '2' }] };
      const r = extra(sql, params);
      if (r) return r;
      return { rows: [] };
    });
  }

  test('membro sem ver custo leva 403 antes de qualquer leitura de produto', async () => {
    banco((sql) => (/FROM companies c\s+LEFT JOIN company_members/.test(sql)
      ? { rows: [{ is_owner: false, role_label: 'estoquista', permissions: { estoque: true, painel: false } }] }
      : null));
    const r = await request(app({ id: 'u2', role: 'client' }, 'member')).get(url('/pendentes'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SEM_PERMISSAO_DE_CUSTO');
    expect(db.query.mock.calls.some(([s]) => /FROM products/.test(s))).toBe(false);
  });

  test('pedido invalido = 400 sem abrir transacao', async () => {
    banco();
    const r = await request(app()).post(url()).send({ itens: [{ product_id: PID, custo: 'abc' }], dry_run: false });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUSTO_INVALIDO');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('filtro desta conferencia sem count_id = 400', async () => {
    banco();
    const r = await request(app()).get(url('/pendentes?filtro=conferencia'));
    expect(r.status).toBe(400);
  });

  test('id de lote invalido = 404', async () => {
    banco();
    expect((await request(app()).get(url('/nao-e-uuid'))).status).toBe(404);
    expect((await request(app()).post(url('/nao-e-uuid/undo'))).status).toBe(404);
  });

  test('gravar: falha no meio faz ROLLBACK e nada e confirmado', async () => {
    banco();
    const chamadas = [];
    db.connect.mockResolvedValue({
      query: jest.fn(async (sql) => {
        const s = String(sql).trim();
        chamadas.push(s.split(/\s+/)[0]);
        if (/COUNT\(\*\)::int AS n FROM companies/.test(s)) return { rows: [{ n: 1 }] };
        if (/FROM stock_counts sc/.test(s)) return { rows: [] };
        if (/FROM products p/.test(s)) {
          return { rows: [{ id: PID, name: 'P', price: '10.00', cost_price: null, weighted_avg_cost: null, is_group_shared: false, unit: 'un', is_active: true }] };
        }
        if (/INSERT INTO product_cost_fills/.test(s)) return { rows: [{ id: PID2, created_at: 'x', undo_deadline: 'y' }] };
        if (/^UPDATE products/.test(s)) { const e = new Error('lock timeout'); e.code = '55P03'; throw e; }
        return { rows: [] };
      }),
      release: jest.fn(),
    });
    const r = await request(app()).post(url()).send({ itens: [{ product_id: PID, custo: 5 }], dry_run: false });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TENTE_DE_NOVO');
    expect(chamadas).toContain('ROLLBACK');
    expect(chamadas).not.toContain('COMMIT');
  });
});
