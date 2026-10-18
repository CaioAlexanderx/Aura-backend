// ============================================================
// /admin/painel/custos — lançamento mensal de custos (card f5-06) e o
// convívio com o job diário do painel na mesma linha de aura_revenue_snapshot.
//
// O banco aqui é uma tabela em memória que EXECUTA os dois upserts de verdade
// (o do lançamento e o de services/receita.gravarSnapshot): lê a lista de
// colunas do INSERT e as atribuições do ON CONFLICT DO UPDATE SET. Atribuição
// que ela não entende LANÇA — mudou o SQL, o teste avisa. Nenhum dado é de
// cliente real; nada vai ao banco de produção.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/adminPainelCustos');
const custos = require('../../src/services/custosMensais');
const { gravarSnapshot, normalizarMrr } = require('../../src/services/receita');

const SEGREDO = 'aura-test-secret-2026';
const STAFF = 'bbbbbbbb-0000-4000-8000-000000000001';
const staff = jwt.sign({ id: STAFF, role: 'admin' }, SEGREDO);
// Dono/administrador DA LOJA: companyRole admin, mas não é equipe Aura.
const adminDaLoja = jwt.sign({ id: 'bbbbbbbb-0000-4000-8000-000000000002', role: 'client', companyRole: 'admin', company: 'aaaaaaaa-0000-4000-8000-000000000001' }, SEGREDO);
const semPapel = jwt.sign({ id: 'bbbbbbbb-0000-4000-8000-000000000003' }, SEGREDO);

// 18/10/2026 12:00 em Brasília.
const AGORA = new Date('2026-10-18T15:00:00.000Z');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/painel/custos', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const api = (metodo, url, token = staff) => request(makeApp())[metodo]('/admin/painel/custos' + url).set('Authorization', 'Bearer ' + token);

// ── tabela em memória ───────────────────────────────────────────
const COLUNAS_TABELA = ['reference_month', 'clients_essencial', 'clients_negocio', 'clients_expansao', 'clients_total',
  'mrr_essencial', 'mrr_negocio', 'mrr_expansao', 'mrr_addons', 'mrr_total', 'total_costs', 'gross_margin',
  'taxas_asaas', 'das', 'custos_detalhe', 'notes', 'updated_at'];
const PADRAO = {
  clients_essencial: 0, clients_negocio: 0, clients_expansao: 0, clients_total: 0,
  mrr_essencial: 0, mrr_negocio: 0, mrr_expansao: 0, mrr_addons: 0, mrr_total: 0,
  total_costs: 0, gross_margin: 0, taxas_asaas: null, das: null, custos_detalhe: null, notes: null,
};

function dividirTopo(texto) {
  // separa por vírgula fora de parênteses
  const out = [];
  let nivel = 0; let atual = '';
  for (const ch of texto) {
    if (ch === '(') nivel += 1;
    if (ch === ')') nivel -= 1;
    if (ch === ',' && nivel === 0) { out.push(atual.trim()); atual = ''; continue; }
    atual += ch;
  }
  if (atual.trim()) out.push(atual.trim());
  return out;
}

function valorDe(expr, params) {
  let m;
  if ((m = /^date_trunc\('month', \$(\d+)::date\)::date$/.exec(expr))) return String(params[m[1] - 1]).slice(0, 7) + '-01';
  if ((m = /^-\$(\d+)::numeric$/.exec(expr))) return -Number(params[m[1] - 1]);
  if ((m = /^\$(\d+)::jsonb$/.exec(expr))) return JSON.parse(params[m[1] - 1]);
  if ((m = /^\$(\d+)(::date)?$/.exec(expr))) {
    const v = params[m[1] - 1];
    return m[2] ? String(v).slice(0, 10) : v;
  }
  throw new Error('expressão do VALUES que o banco de teste não conhece: ' + expr);
}

function criarBanco(linhasIniciais = []) {
  const tabela = new Map(linhasIniciais.map((l) => [l.reference_month, { ...PADRAO, ...l }]));
  const auditoria = [];
  const sqls = [];
  let painelDoDia = false;

  const ler = (l) => ({
    mes: l.reference_month.slice(0, 7),
    mrr_total: l.mrr_total, total_costs: l.total_costs, gross_margin: l.gross_margin,
    taxas_asaas: l.taxas_asaas, das: l.das, custos_detalhe: l.custos_detalhe ? JSON.parse(JSON.stringify(l.custos_detalhe)) : null,
    updated_at: l.updated_at || null,
  });

  function upsert(s, params) {
    const m = /^INSERT INTO aura_revenue_snapshot \(([^)]*)\) VALUES \((.*)\) ON CONFLICT \(reference_month\) DO UPDATE SET (.*?)( RETURNING .*)?$/.exec(s);
    if (!m) throw new Error('INSERT em aura_revenue_snapshot fora do formato: ' + s);
    const cols = m[1].split(',').map((c) => c.trim());
    const vals = dividirTopo(m[2]).map((e) => valorDe(e, params));
    const novo = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
    for (const c of cols) if (!COLUNAS_TABELA.includes(c)) throw new Error('coluna desconhecida: ' + c);
    const chave = novo.reference_month;
    const existente = tabela.get(chave);
    if (!existente) {
      tabela.set(chave, { ...PADRAO, ...novo, updated_at: 'agora' });
    } else {
      const antes = { ...existente };
      for (const a of dividirTopo(m[3])) {
        let x;
        if ((x = /^(\w+) = EXCLUDED\.(\w+)$/.exec(a)) && x[1] === x[2]) existente[x[1]] = novo[x[2]];
        else if (/^updated_at = NOW\(\)$/.test(a)) existente.updated_at = 'agora';
        else if (/^gross_margin = COALESCE\(aura_revenue_snapshot\.mrr_total, 0\) - EXCLUDED\.total_costs$/.test(a)) {
          existente.gross_margin = Math.round((Number(antes.mrr_total || 0) - Number(novo.total_costs)) * 100) / 100;
        } else throw new Error('atribuição do ON CONFLICT que o banco de teste não conhece: ' + a);
      }
    }
    return m[4] ? [ler(tabela.get(chave))] : [];
  }

  function responder(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    sqls.push(s);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s)) return [];
    if (s.includes('-- custos:mes') || s.includes('-- custos:travar')) {
      const l = tabela.get(String(params[0]).slice(0, 10));
      return l ? [ler(l)] : [];
    }
    if (s.includes('-- custos:snapshot')) {
      return [...tabela.values()].filter((l) => l.reference_month <= String(params[0]).slice(0, 7) + '-01')
        .sort((a, b) => b.reference_month.localeCompare(a.reference_month)).slice(0, params[1]).map(ler);
    }
    if (s.startsWith('-- custos:gravar ')) return upsert(s.replace('-- custos:gravar ', ''), params);
    if (s.startsWith('INSERT INTO aura_revenue_snapshot')) return upsert(s, params);
    if (s.startsWith('INSERT INTO admin_audit_log')) {
      auditoria.push({ sql: s, params, payload: JSON.parse(params[1]) });
      return [];
    }
    if (s.startsWith('SELECT 1 FROM painel_blocos_diarios')) return painelDoDia ? [{ '?column?': 1 }] : [];
    throw new Error('SQL inesperado no banco de teste dos custos: ' + s.slice(0, 160));
  }

  const query = jest.fn(async (sql, params) => ({ rows: responder(sql, params) }));
  const cliente = { query, release: jest.fn() };
  return {
    tabela, auditoria, sqls, query, cliente,
    ligar() {
      db.query.mockImplementation(query);
      db.connect.mockImplementation(async () => cliente);
    },
    comPainelDoDia() { painelDoDia = true; },
  };
}

// O job das 06h gravando o MRR do mês (o mesmo SQL de produção).
async function rodarJob(banco, hoje, valores) {
  const mrr = normalizarMrr(valores.map((v, i) => ({
    company_id: 'c' + i, nome: 'Loja ' + i, plan: v.plan || 'negocio', ciclo: 'monthly',
    valor_contrato: v.valor, meses_contrato: 1, addons_mensal: 0, tem_cobranca: true,
  })));
  await gravarSnapshot({ db: { query: banco.query }, hoje, mrr });
  return mrr;
}

const lancar = (corpo, token) => api('post', '', token).send(corpo);

beforeAll(() => {
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
afterEach(() => { db.query.mockReset(); db.connect.mockReset(); });

// ── acesso ──────────────────────────────────────────────────────
describe('acesso: só equipe Aura (user.role admin)', () => {
  test('sem token → 401', async () => {
    criarBanco().ligar();
    expect((await request(makeApp()).get('/admin/painel/custos')).status).toBe(401);
    expect((await request(makeApp()).post('/admin/painel/custos').send({})).status).toBe(401);
  });

  test('administrador da loja (companyRole admin) e conta sem papel → 403, nada gravado', async () => {
    const banco = criarBanco();
    banco.ligar();
    for (const token of [adminDaLoja, semPapel]) {
      expect((await api('get', '', token)).status).toBe(403);
      const res = await lancar({ mes: '2026-10', categorias: { meta: { valor: 10, origem: 'empresa' } } }, token);
      expect(res.status).toBe(403);
    }
    expect(banco.query).not.toHaveBeenCalled();
    expect(banco.tabela.size).toBe(0);
  });
});

// ── validação ───────────────────────────────────────────────────
describe('validação do lançamento', () => {
  const casos = [
    ['mes fora do formato', { mes: '2026-10-01', categorias: { meta: { valor: 1, origem: 'empresa' } } }, /YYYY-MM/],
    ['mes no futuro', { mes: '2026-11', categorias: { meta: { valor: 1, origem: 'empresa' } } }, /futuro/],
    ['mes antigo demais', { mes: '2024-12', categorias: { meta: { valor: 1, origem: 'empresa' } } }, /2025-01/],
    ['sem categorias', { mes: '2026-10', categorias: {} }, /ao menos uma/],
    ['categoria desconhecida', { mes: '2026-10', categorias: { marketing: { valor: 1, origem: 'empresa' } } }, /categoria desconhecida: marketing/],
    ['valor negativo', { mes: '2026-10', categorias: { meta: { valor: -0.01, origem: 'empresa' } } }, /negativo/],
    ['valor texto com vírgula', { mes: '2026-10', categorias: { meta: { valor: '1,50', origem: 'empresa' } } }, /número/],
    ['valor ausente', { mes: '2026-10', categorias: { meta: { origem: 'empresa' } } }, /número/],
    ['valor com 3 casas', { mes: '2026-10', categorias: { meta: { valor: 1.005, origem: 'empresa' } } }, /2 casas/],
    ['valor infinito', { mes: '2026-10', categorias: { meta: { valor: 1e309, origem: 'empresa' } } }, /número/],
    ['valor acima do teto', { mes: '2026-10', categorias: { meta: { valor: 1000000.01, origem: 'empresa' } } }, /passa de/],
    ['origem desconhecida', { mes: '2026-10', categorias: { meta: { valor: 1, origem: 'cartao' } } }, /origem deve ser/],
    ['observação longa', { mes: '2026-10', categorias: { meta: { valor: 1, origem: 'empresa', observacao: 'x'.repeat(201) } } }, /200/],
  ];
  test.each(casos)('%s → 400, nada gravado', async (_nome, corpo, erro) => {
    const banco = criarBanco();
    banco.ligar();
    const res = await lancar(corpo);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CUSTO_INVALIDO');
    expect(res.body.error).toMatch(erro);
    expect(banco.query).not.toHaveBeenCalled();
  });

  test('valor zero e texto numérico com ponto são aceitos', async () => {
    const hoje = '2026-10-18';
    expect(custos.normalizarLancamento({ mes: '2026-10', categorias: { meta: { valor: 0, origem: 'empresa' }, outros: { valor: '12.5', origem: 'estimativa' } } }, { hoje }).valor.categorias)
      .toEqual({ meta: { valor: 0, origem: 'empresa', observacao: null }, outros: { valor: 12.5, origem: 'estimativa', observacao: null } });
  });

  test('GET com mes inválido → 400', async () => {
    criarBanco().ligar();
    expect((await api('get', '?mes=2026-13')).status).toBe(400);
  });
});

// ── lançamento ──────────────────────────────────────────────────
describe('POST /admin/painel/custos', () => {
  test('mês com linha do job: grava custos, soma o total, refaz a margem e não toca no MRR', async () => {
    const banco = criarBanco([{ reference_month: '2026-10-01', clients_negocio: 9, clients_total: 9, mrr_negocio: 1843.93, mrr_total: 1843.93 }]);
    banco.ligar();
    const res = await lancar({
      mes: '2026-10',
      categorias: {
        infraestrutura: { valor: 180.4, origem: 'empresa', observacao: 'Railway + Supabase' },
        anthropic: { valor: 550, origem: 'socio' },
      },
      motivo: 'fechamento parcial de outubro',
    });
    expect(res.status).toBe(200);
    expect(res.body.criou_linha).toBe(false);
    expect(res.body.total_costs).toBe(730.4);
    expect(res.body.painel_atualizado).toBe(false);
    expect(res.body.categorias.map((c) => [c.id, c.valor, c.origem])).toEqual([
      ['infraestrutura', 180.4, 'empresa'], ['anthropic', 550, 'socio'], ['meta', null, null], ['outros', null, null],
    ]);

    const l = banco.tabela.get('2026-10-01');
    expect(l.mrr_total).toBe(1843.93);
    expect(l.clients_total).toBe(9);
    expect(l.total_costs).toBe(730.4);
    expect(l.gross_margin).toBe(1113.53);
    expect(l.custos_detalhe.infraestrutura).toEqual({
      valor: 180.4, origem: 'empresa', observacao: 'Railway + Supabase', lancado_em: AGORA.toISOString(), lancado_por: STAFF,
    });
    // transação: trava a linha antes de gravar, e devolve a conexão
    expect(banco.sqls[0]).toBe('BEGIN');
    expect(banco.sqls[1]).toMatch(/FOR UPDATE$/);
    expect(banco.sqls[banco.sqls.length - 2]).toBe('COMMIT');
    expect(banco.cliente.release).toHaveBeenCalledTimes(1);
  });

  test('registra em admin_audit_log: quem, mês, antes, depois e motivo', async () => {
    const banco = criarBanco([{
      reference_month: '2026-09-01', mrr_total: 1136.07, total_costs: 871.17,
      custos_detalhe: { anthropic: { valor: 550, origem: 'socio' }, demais: { valor: 321.17 } },
    }]);
    banco.ligar();
    const res = await lancar({ mes: '2026-09', categorias: { demais: { valor: 0, origem: 'estimativa' }, infraestrutura: { valor: 321.17, origem: 'empresa' } }, motivo: 'abertura da sobra' });
    expect(res.status).toBe(200);
    expect(banco.auditoria).toHaveLength(1);
    const a = banco.auditoria[0];
    expect(a.sql).toContain("'set_monthly_cost'");
    expect(a.params[0]).toBe(STAFF);
    expect(a.params[2]).toBe('abertura da sobra');
    expect(a.payload.mes).toBe('2026-09');
    expect(a.payload.criou_linha).toBe(false);
    expect(a.payload.categorias).toEqual(['demais', 'infraestrutura']);
    expect(a.payload.antes.total_costs).toBe(871.17);
    expect(a.payload.depois.total_costs).toBe(871.17);
    expect(a.payload.depois.custos_detalhe.anthropic).toEqual({ valor: 550, origem: 'socio' });
    expect(banco.tabela.get('2026-09-01').gross_margin).toBe(264.9);
  });

  test('corrigir uma categoria mantém as outras', async () => {
    const banco = criarBanco([{ reference_month: '2026-10-01', mrr_total: 1000 }]);
    banco.ligar();
    await lancar({ mes: '2026-10', categorias: { anthropic: { valor: 550, origem: 'socio' }, meta: { valor: 40, origem: 'empresa' } } });
    await lancar({ mes: '2026-10', categorias: { meta: { valor: 62.5, origem: 'empresa', observacao: 'corrigido pelo extrato' } } });
    const l = banco.tabela.get('2026-10-01');
    expect(l.custos_detalhe.anthropic.valor).toBe(550);
    expect(l.custos_detalhe.meta).toMatchObject({ valor: 62.5, observacao: 'corrigido pelo extrato' });
    expect(l.total_costs).toBe(612.5);
    expect(banco.auditoria).toHaveLength(2);
  });

  test('total digitado sem detalhe (abril) não some: vira "demais" na soma', async () => {
    const banco = criarBanco([{ reference_month: '2026-04-01', mrr_total: 676, total_costs: 250, notes: 'Estimativa digitada' }]);
    banco.ligar();
    const res = await lancar({ mes: '2026-04', categorias: { infraestrutura: { valor: 33.33, origem: 'empresa' } } });
    expect(res.status).toBe(200);
    const l = banco.tabela.get('2026-04-01');
    expect(l.custos_detalhe.demais.valor).toBe(250);
    expect(l.total_costs).toBe(283.33);
    expect(l.notes).toBe('Estimativa digitada');
    expect(res.body.categorias.map((c) => c.id)).toContain('demais');
  });

  test('mês sem linha: cria a linha só com custos (201) — MRR fica para o job', async () => {
    const banco = criarBanco();
    banco.ligar();
    const res = await lancar({ mes: '2026-10', categorias: { anthropic: { valor: 550, origem: 'socio' } } });
    expect(res.status).toBe(201);
    expect(res.body.criou_linha).toBe(true);
    const l = banco.tabela.get('2026-10-01');
    expect(l.total_costs).toBe(550);
    expect(l.mrr_total).toBe(0);
    expect(l.gross_margin).toBe(-550);
    expect(banco.auditoria[0].payload).toMatchObject({ criou_linha: true, antes: null });
  });

  test('erro no meio da transação: ROLLBACK, conexão devolvida, 500', async () => {
    const banco = criarBanco([{ reference_month: '2026-10-01', mrr_total: 1000 }]);
    banco.ligar();
    const original = banco.cliente.query.getMockImplementation();
    banco.cliente.query.mockImplementation(async (sql, params) => {
      if (/INSERT INTO admin_audit_log/.test(sql)) throw new Error('auditoria fora do ar');
      return original(sql, params);
    });
    const res = await lancar({ mes: '2026-10', categorias: { meta: { valor: 10, origem: 'empresa' } } });
    expect(res.status).toBe(500);
    expect(banco.sqls).toContain('ROLLBACK');
    expect(banco.sqls).not.toContain('COMMIT');
    expect(banco.cliente.release).toHaveBeenCalledTimes(1);
  });

  test('banco sem a migration 382 → 503 MIGRATION_PENDING', async () => {
    const banco = criarBanco();
    banco.ligar();
    banco.cliente.query.mockImplementation(async (sql) => {
      if (/custos:travar/.test(sql)) { const e = new Error('column "custos_detalhe" does not exist'); e.code = '42703'; throw e; }
      return { rows: [] };
    });
    const res = await lancar({ mes: '2026-10', categorias: { meta: { valor: 10, origem: 'empresa' } } });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
  });

  test('dia já calculado: regrava só o bloco Custos de hoje com o valor novo', async () => {
    const banco = criarBanco([{ reference_month: '2026-10-01', mrr_total: 1000 }]);
    banco.comPainelDoDia();
    const escritas = [];
    banco.ligar();
    const base = banco.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('AS eh_dojo')) return { rows: [] };
      if (s.includes('FROM painel_blocos_diarios WHERE dia IN')) return { rows: [] };
      if (s.startsWith('INSERT INTO painel_blocos_diarios')) { escritas.push(params); return { rows: [] }; }
      return base(sql, params);
    });
    const res = await lancar({ mes: '2026-10', categorias: { meta: { valor: 99.9, origem: 'empresa' } } });
    expect(res.body.painel_atualizado).toBe(true);
    expect(escritas).toHaveLength(1);
    expect(escritas[0][0]).toBe('2026-10-18');
    const gravado = JSON.parse(escritas[0][1]);
    expect(gravado.map((g) => g.bloco)).toEqual(['custos']);
    expect(gravado[0].dados.valor).toBe(99.9);
  });
});

describe('GET /admin/painel/custos', () => {
  test('sem mes: o mês corrente; sem linha, categorias vazias e existe_linha false', async () => {
    criarBanco().ligar();
    const res = await api('get', '');
    expect(res.status).toBe(200);
    expect(res.body.mes).toBe('2026-10');
    expect(res.body.existe_linha).toBe(false);
    expect(res.body.categorias.map((c) => c.id)).toEqual(['infraestrutura', 'anthropic', 'meta', 'outros']);
    expect(res.body.origens.map((o) => o.id)).toEqual(['empresa', 'socio', 'estimativa']);
  });

  test('mês com detalhe: valor e origem de cada categoria, taxas e DAS à parte', async () => {
    criarBanco([{
      reference_month: '2026-09-01', mrr_total: 1136.07, total_costs: 871.17, taxas_asaas: 26.95, das: 45.34,
      custos_detalhe: { anthropic: { valor: 550, origem: 'socio', observacao: 'paga em conta pessoal do socio' }, demais: { valor: 321.17 } },
    }]).ligar();
    const res = await api('get', '?mes=2026-09');
    expect(res.body).toMatchObject({ mes: '2026-09', existe_linha: true, total_costs: 871.17, taxas_asaas: 26.95, das: 45.34, mrr_total: 1136.07 });
    expect(res.body.categorias.find((c) => c.id === 'anthropic')).toMatchObject({ valor: 550, origem: 'socio' });
    expect(res.body.categorias.find((c) => c.id === 'demais')).toMatchObject({ valor: 321.17, origem: null });
  });
});

// ── convívio com o job diário (o maior risco) ───────────────────
describe('convívio com o job do painel na mesma linha', () => {
  test('lançamento ANTES do job: o job grava o MRR e não apaga os custos', async () => {
    const banco = criarBanco();
    banco.ligar();
    await lancar({ mes: '2026-10', categorias: { anthropic: { valor: 550, origem: 'socio' }, meta: { valor: 49.9, origem: 'empresa' } } });
    const detalhe = JSON.parse(JSON.stringify(banco.tabela.get('2026-10-01').custos_detalhe));

    await rodarJob(banco, '2026-10-19', [{ valor: 169 }, { valor: 169 }, { valor: 89, plan: 'essencial' }]);
    await rodarJob(banco, '2026-10-20', [{ valor: 169 }, { valor: 169 }, { valor: 89, plan: 'essencial' }, { valor: 169 }]);

    const l = banco.tabela.get('2026-10-01');
    expect(l.mrr_total).toBe(596);
    expect(l.clients_total).toBe(4);
    expect(l.custos_detalhe).toEqual(detalhe);
    expect(l.total_costs).toBe(599.9);
  });

  test('lançamento DEPOIS do job: o MRR do job fica, a margem usa o MRR dele', async () => {
    const banco = criarBanco();
    banco.ligar();
    await rodarJob(banco, '2026-10-18', [{ valor: 169 }, { valor: 169 }]);
    await lancar({ mes: '2026-10', categorias: { infraestrutura: { valor: 100, origem: 'empresa' } } });
    const l = banco.tabela.get('2026-10-01');
    expect(l.mrr_total).toBe(338);
    expect(l.clients_negocio).toBe(2);
    expect(l.total_costs).toBe(100);
    expect(l.gross_margin).toBe(238);
  });

  test('o SQL do job não cita nenhuma coluna de custo; o do lançamento não cita clientes nem MRR', async () => {
    const banco = criarBanco();
    banco.ligar();
    await rodarJob(banco, '2026-10-18', [{ valor: 169 }]);
    await lancar({ mes: '2026-10', categorias: { meta: { valor: 1, origem: 'empresa' } } });
    const job = banco.sqls.find((s) => s.startsWith('INSERT INTO aura_revenue_snapshot'));
    const lancamento = banco.sqls.find((s) => s.startsWith('-- custos:gravar'));
    expect(job).not.toMatch(/custos_detalhe|total_costs|gross_margin|taxas_asaas|\bdas\b|notes/);
    const setDoLancamento = lancamento.split('DO UPDATE SET')[1].split('RETURNING')[0];
    expect(setDoLancamento).not.toMatch(/clients_|mrr_\w+ =|notes|taxas_asaas|\bdas\b/);
  });
});

// ── bloco Custos (o caso do mês sem lançamento está em blocos.custos.json) ──
describe('bloco Custos', () => {
  const bloco = require('../../src/services/painelBlocos/custos');

  test('mês corrente lançado: valor = custo do mês, margem pelo MRR do job, origem por categoria', async () => {
    const banco = criarBanco([
      { reference_month: '2026-10-01', mrr_total: 1843.93, total_costs: 730.4, gross_margin: 0, custos_detalhe: { anthropic: { valor: 550, origem: 'socio' }, infraestrutura: { valor: 180.4, origem: 'empresa' } } },
      { reference_month: '2026-09-01', mrr_total: 1136.07, total_costs: 871.17, taxas_asaas: 26.95, das: 45.34, custos_detalhe: { anthropic: { valor: 550, origem: 'socio' }, demais: { valor: 321.17 } } },
    ]);
    const d = await bloco.calcular({ hoje: '2026-10-18', db: { query: banco.query } });
    expect(d.valor).toBe(730.4);
    expect(d.resumo).toBe('Margem de outubro: R$ 1.113,53 · receita do snapshot R$ 1.843,93');
    expect(d.detalhe.indicadores.map((i) => [i.rotulo, i.valor])).toEqual([
      ['Custos · Out', 730.4], ['Margem bruta · Out', 1113.53], ['Custos · Set', 871.17], ['Resultado · Set', 192.61],
    ]);
    expect(d.detalhe.listas[0].titulo).toBe('Por categoria · Out/2026');
    expect(d.detalhe.listas[0].linhas.map((l) => [l.categoria, l.valor, l.origem])).toEqual([
      ['Infraestrutura', 180.4, 'Conta da empresa'], ['Anthropic', 550, 'Conta pessoal do sócio'],
    ]);
    expect(d.detalhe.insight).toMatch(/R\$ 321,17 sem abertura por categoria \(Set\)/);
  });

  test('rótulos da Financeiro (18/10): DAS pago (do snapshot), receita do snapshot e aporte do sócio', async () => {
    const banco = criarBanco([
      { reference_month: '2026-10-01', mrr_total: 1843.93, total_costs: 550, custos_detalhe: { anthropic: { valor: 550, origem: 'socio' } } },
      { reference_month: '2026-09-01', mrr_total: 1136.07, total_costs: 871.17, taxas_asaas: 26.95, das: 45.34, custos_detalhe: { anthropic: { valor: 550, origem: 'socio' }, infraestrutura: { valor: 321.17, origem: 'empresa' } } },
    ]);
    const d = await bloco.calcular({ hoje: '2026-10-18', db: { query: banco.query } });
    const porMes = d.detalhe.listas.find((l) => l.titulo === 'Por mês');
    expect(porMes.colunas.map((c) => c.rotulo)).toEqual(['Mês', 'Receita do snapshot', 'Custos', 'Margem', 'Taxas Asaas', 'DAS pago (do snapshot)', 'Resultado', 'Situação']);
    expect(d.detalhe.indicadores.find((i) => i.rotulo === 'Margem bruta · Out').nota).toBe('receita do snapshot − custos');
    expect(d.detalhe.indicadores.find((i) => i.rotulo === 'Resultado · Set').nota).toBe('depois de taxas da Asaas e DAS pago (do snapshot) · provisório até o fechamento do mês');
    const cat = d.detalhe.listas[0];
    expect(cat.colunas.map((c) => c.chave)).toContain('status');
    expect(cat.linhas.map((l) => l.status)).toEqual(['Aporte do sócio']);
    expect(d.detalhe.insight).toContain('Resultado depois de taxas e DAS é provisório até o fechamento do mês');
    expect(d.detalhe.insight).toContain('O DAS pago (do snapshot) está deslocado em um mês em relação à receita: o DAS gravado num mês é o da receita do mês anterior');
    expect(d.detalhe.insight).toContain('De set a receita do snapshot é a cobrança com vencimento no mês, não o MRR contratual: a comparação mês a mês não é da mesma medida');
    expect(d.detalhe.insight).toContain('R$ 550,00 de Out é aporte do sócio: custo de competência que não saiu do caixa da empresa');
    // nada disso muda o cálculo
    expect(d.valor).toBe(550);
    expect(d.detalhe.indicadores.find((i) => i.rotulo === 'Resultado · Set').valor).toBe(192.61);
  });

  test('soma das categorias diferente do total gravado aparece no insight', async () => {
    const banco = criarBanco([{ reference_month: '2026-10-01', mrr_total: 100, total_costs: 50, custos_detalhe: { meta: { valor: 40, origem: 'empresa' } } }]);
    const d = await bloco.calcular({ hoje: '2026-10-18', db: { query: banco.query } });
    expect(d.detalhe.insight).toMatch(/Soma das categorias diferente do total gravado em Out/);
  });

  test('sem a migration 382 (coluna ausente): bloco vazio, sem quebrar o passo diário', async () => {
    const query = jest.fn(async () => { const e = new Error('column "custos_detalhe" does not exist'); e.code = '42703'; throw e; });
    const d = await bloco.calcular({ hoje: '2026-10-18', db: { query } });
    expect(d.valor).toBeNull();
    expect(d.resumo).toBe('Nenhum mês com custo lançado');
  });
});
