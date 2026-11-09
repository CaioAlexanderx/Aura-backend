// ============================================================
// AURA. — Categorias do Financeiro (migration 434) — regras puras e rotas
//
// Sem banco: normalizacao, lista padrao, resolverTexto (a regra da migracao
// e da contagem), o plano da migracao com a lista padrao simulada, o SQL que
// /transactions monta com category_id e o fallback sem a 434.
// O comportamento no Postgres de verdade (unicidade, 2 niveis, renomear,
// juntar, arquivar, aplicar a migracao) esta em
// financeiro.categorias.banco.test.js.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const svc = require('../src/services/financeCategories');
const catSql = require('../src/utils/categoriaDoLancamento');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CAT = '22222222-2222-4222-8222-222222222222';

function indiceSimulado() {
  // A mesma lista que a loja ganha na primeira leitura.
  let n = 0;
  const rows = [];
  svc.linhasDosPadroes(svc.PADROES).forEach((l) => {
    n += 1;
    const pai = l.parent ? rows.find((r) => !r.parent_id && r.kind === l.kind && r.name === l.parent) : null;
    rows.push({ id: 'c' + n, kind: l.kind, parent_id: pai ? pai.id : null, name: l.name, name_norm: svc.normalizarNome(l.name), is_system: l.is_system, archived_at: null });
  });
  return svc.montarIndice(rows);
}

function nomeDe(indice, cat) {
  if (!cat) return null;
  const mae = cat.parent_id ? indice.porId.get(cat.parent_id) : null;
  return mae ? mae.name + ' › ' + cat.name : cat.name;
}

describe('normalizarNome', () => {
  test('tira acento, caixa e espaco sobrando', () => {
    expect(svc.normalizarNome('  Serviços  ')).toBe('servicos');
    expect(svc.normalizarNome('CREDIÁRIO')).toBe('crediario');
    expect(svc.normalizarNome('Internet   e  telefone')).toBe('internet e telefone');
    expect(svc.normalizarNome(null)).toBe('');
  });
});

describe('lista padrao', () => {
  test('as usadas pela Aura tem o nome EXATO que o resto do codigo procura', () => {
    const sistema = svc.SISTEMA.map((p) => p.kind + ':' + p.name).sort();
    expect(sistema).toEqual([
      'expense:Fornecedores', 'expense:Outros', 'expense:Taxas de cartão', 'expense:Trocas e devoluções',
      'income:Crediário', 'income:Outros', 'income:Trocas e devoluções', 'income:Vendas',
    ].sort());
  });

  test('a lista fixa de antes do app continua existindo (com as subcategorias do mockup)', () => {
    const nomes = (kind) => svc.PADROES.filter((p) => p.kind === kind).map((p) => p.name);
    ['Fornecedores', 'Fixas', 'Operacional', 'Folha', 'Impostos', 'Marketing', 'Outros'].forEach((n) => expect(nomes('expense')).toContain(n));
    ['Vendas', 'Serviços', 'Crediário', 'Outros', 'Investimentos'].forEach((n) => expect(nomes('income')).toContain(n));
    expect(svc.PADROES.find((p) => p.name === 'Fixas').subs).toEqual(['Aluguel', 'Energia', 'Internet e telefone', 'Contador']);
    expect(svc.PADROES.find((p) => p.name === 'Vendas').subs).toEqual(['Balcão', 'Loja online']);
  });

  test('toda linha do DRE da lista e valida e nenhuma subcategoria passa de 60 letras', () => {
    svc.PADROES.forEach((p) => {
      expect(svc.DRE_LINES[p.kind].map((l) => l.key)).toContain(p.dre);
      p.subs.forEach((s) => expect(s.length).toBeLessThanOrEqual(60));
    });
  });

  test('troca e taxa de cartao ficam fora da escolha manual; o resto aparece', () => {
    const idx = indiceSimulado();
    const fora = Array.from(idx.porId.values()).filter((c) => !c.parent_id && !svc.naEscolhaManual(c)).map((c) => c.kind + ':' + c.name).sort();
    expect(fora).toEqual(['expense:Taxas de cartão', 'expense:Trocas e devoluções', 'income:Trocas e devoluções']);
  });
});

describe('resolverTexto (regra da migracao e da contagem)', () => {
  const idx = indiceSimulado();
  const r = (kind, t) => nomeDe(idx, svc.resolverTexto(kind, t, idx));

  test('casa pelo nome sem diferenciar maiuscula e acento', () => {
    expect(r('income', 'Servicos')).toBe('Serviços');
    expect(r('income', 'crediário')).toBe('Crediário');
    expect(r('expense', 'FIXAS')).toBe('Fixas');
    expect(r('expense', 'Taxas de cartao')).toBe('Taxas de cartão');
    expect(r('income', 'Vendas')).toBe('Vendas');
  });

  test('os textos automaticos do crediario, da troca e da loja online (mockup, secao E)', () => {
    expect(r('income', 'Crediario - A Receber')).toBe('Crediário');
    expect(r('income', 'Crediario - Recebido (parcial)')).toBe('Crediário');
    expect(r('income', 'Crediário - A Receber')).toBe('Crediário');
    expect(r('income', 'Troca - Venda')).toBe('Trocas e devoluções');
    expect(r('expense', 'Troca - Devolucao')).toBe('Trocas e devoluções');
    expect(r('expense', 'Troca - Devolução')).toBe('Trocas e devoluções');
    expect(r('expense', 'devolucao')).toBe('Trocas e devoluções');
    expect(r('income', 'Canal Digital')).toBe('Vendas › Loja online');
  });

  test('chaves do Categorizar com IA e o purchase da NF-e', () => {
    expect(r('expense', 'aluguel')).toBe('Fixas › Aluguel');
    expect(r('expense', 'das')).toBe('Impostos › DAS do Simples');
    expect(r('expense', 'prolabore')).toBe('Folha › Pró-labore');
    expect(r('expense', 'purchase')).toBe('Fornecedores');
    expect(r('income', 'servico_pj')).toBe('Serviços');
  });

  test('o tipo importa: despesa "Vendas" e despesa de crediario nao casam', () => {
    expect(r('expense', 'Vendas')).toBeNull();
    expect(r('expense', 'Crediario - A Receber')).toBeNull();
  });

  test('texto que nao casa com nada volta null (vira categoria da loja)', () => {
    expect(r('expense', 'Veículo')).toBeNull();
    expect(r('expense', '')).toBeNull();
  });

  test('categoria arquivada nao resolve texto', () => {
    const rows = [{ id: 'a', kind: 'expense', parent_id: null, name: 'Fixas', name_norm: 'fixas', archived_at: new Date() }];
    expect(svc.resolverTexto('expense', 'Fixas', svc.montarIndice(rows))).toBeNull();
  });

  test('anuidade da federacao fica fora', () => {
    expect(svc.foraDaMigracao('annuity_dojo')).toBe(true);
    expect(svc.foraDaMigracao('annuity_cpf')).toBe(true);
    expect(svc.foraDaMigracao('anuidade')).toBe(true);
    expect(svc.foraDaMigracao('Vendas')).toBe(false);
  });
});

describe('planejarMigracao (dry-run) — so leitura', () => {
  beforeEach(() => { db.query.mockReset(); });

  test('loja sem categorias: simula a lista padrao, liga o que casa e cria o resto, sem escrever', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // lerCategorias
      .mockResolvedValueOnce({ rows: [ // lerTextosSemLigacao
        { kind: 'income', category: 'Vendas', n: 120 },
        { kind: 'income', category: 'Crediario - A Receber', n: 9 },
        { kind: 'income', category: 'Servicos', n: 3 },
        { kind: 'income', category: 'Canal Digital', n: 2 },
        { kind: 'expense', category: 'Veículo', n: 4 },
        { kind: 'expense', category: 'veiculo', n: 1 },
        { kind: 'income', category: 'annuity_dojo', n: 57 },
      ] });
    const plano = await svc.planejarMigracao(COMPANY);
    expect(plano.semeia_padroes).toBe(true);
    const ligar = Object.fromEntries(plano.ligar.map((l) => [l.texto, l.categoria]));
    expect(ligar).toEqual({
      Vendas: 'Vendas', 'Crediario - A Receber': 'Crediário', Servicos: 'Serviços', 'Canal Digital': 'Vendas › Loja online',
    });
    // "Veículo" e "veiculo" viram UMA categoria nova.
    expect(plano.criar).toEqual([{ kind: 'expense', name: 'Veículo', n: 5, textos: ['Veículo', 'veiculo'] }]);
    // Fora da migracao: a anuidade nao aparece em lugar nenhum.
    expect(JSON.stringify(plano)).not.toMatch(/annuity/);
    db.query.mock.calls.forEach(([sql]) => expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i));
  });

  test('categoria nova: a grafia mais usada; no empate, a mais bem escrita, qualquer que seja a ordem do banco', async () => {
    db.query.mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ kind: 'expense', category: 'veiculo', n: 1 }, { kind: 'expense', category: 'Veículo', n: 1 }] });
    expect((await svc.planejarMigracao(COMPANY)).criar[0].name).toBe('Veículo');
    db.query.mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ kind: 'expense', category: 'veiculo', n: 5 }, { kind: 'expense', category: 'Veículo', n: 1 }] });
    expect((await svc.planejarMigracao(COMPANY)).criar[0].name).toBe('veiculo');
  });
});

describe('categoriaDoLancamento (SQL de /transactions)', () => {
  test('o texto sai do nome da categoria-MAE e o id so vale se for da loja e do tipo', () => {
    const txt = catSql.sqlDoTexto('$1', '$16', '$17', '$5');
    expect(txt).toMatch(/COALESCE\(p\.name, fc\.name\)/);
    expect(txt).toMatch(/fc\.company_id = \$1/);
    expect(txt).toMatch(/fc\.kind = \$17::text/);
    expect(txt).toMatch(/, \$5\)$/);
    const id = catSql.sqlDoId('$1', '$16', '$5', '$17');
    expect(id).toMatch(/finance_category_norm\(\$5\)/);
    expect(id).toMatch(/parent_id IS NULL AND fc\.archived_at IS NULL/);
  });

  test('idValido', () => {
    expect(catSql.idValido(undefined)).toBe(true);
    expect(catSql.idValido(null)).toBe(true);
    expect(catSql.idValido(CAT)).toBe(true);
    expect(catSql.idValido('nao-e-uuid')).toBe(false);
  });
});

describe('POST/PATCH /transactions com category_id', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/companies/:id/transactions', require('../src/routes/transactions'));
    return app;
  }
  beforeEach(() => { db.query.mockReset(); catSql._reset(); });

  test('POST manda category_id e o tipo como texto; o texto do insert vem da categoria', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'tx1', type: 'expense', amount: '10', description: 'Aluguel', category: 'Fixas', category_id: CAT, status: 'confirmed' }] });
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions')
      .send({ type: 'expense', amount: 10, description: 'Aluguel', category: 'Fixas', category_id: CAT });
    expect(res.status).toBe(201);
    expect(res.body.category_id).toBe(CAT);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/category_id\)/);
    expect(params[15]).toBe(CAT);
    expect(params[16]).toBe('expense');
  });

  test('POST com category_id que nao e uuid: 400', async () => {
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/transactions')
      .send({ type: 'expense', amount: 10, description: 'x', category_id: 'abc' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sem a migration 434 (42703): grava como antes e lembra', async () => {
    const e = new Error('column "category_id" does not exist'); e.code = '42703';
    db.query
      .mockRejectedValueOnce(e)
      .mockResolvedValue({ rows: [{ id: 'tx1', type: 'expense', amount: '10', description: 'x', category: 'Fixas', status: 'confirmed' }] });
    const app = buildApp();
    const res = await request(app).post('/companies/' + COMPANY + '/transactions')
      .send({ type: 'expense', amount: 10, description: 'x', category: 'Fixas', category_id: CAT });
    expect(res.status).toBe(201);
    expect(db.query.mock.calls[1][0]).not.toMatch(/category_id/);
    expect(db.query.mock.calls[1][1]).toHaveLength(15);
    await request(app).post('/companies/' + COMPANY + '/transactions').send({ type: 'expense', amount: 10, description: 'x', category: 'Fixas' });
    expect(db.query.mock.calls[2][0]).not.toMatch(/category_id/);
  });

  test('PATCH so com texto igual ao de antes mantem a ligacao', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'tx1', idempotency_key: null }] });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/tx1').send({ category: 'Fixas' });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[db.query.mock.calls.length - 1];
    expect(sql).toMatch(/THEN transactions\.category_id ELSE/);
    expect(params).toEqual(['Fixas', null, null, COMPANY, 'tx1', COMPANY]);
  });

  test('PATCH com category_id troca a ligacao e o texto vem da mae', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'tx1', idempotency_key: null }] });
    const res = await request(buildApp()).patch('/companies/' + COMPANY + '/transactions/tx1').send({ category: 'Fixas', category_id: CAT, type: 'expense' });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[db.query.mock.calls.length - 1];
    expect(sql).not.toMatch(/THEN transactions\.category_id ELSE/);
    expect(sql).toMatch(/category = COALESCE\(\(SELECT COALESCE\(p\.name, fc\.name\)/);
    expect(params.slice(-6)).toEqual(['Fixas', CAT, 'expense', COMPANY, 'tx1', COMPANY]);
  });
});

describe('rotas /finance-categories', () => {
  function buildApp(role) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.companyRole = role || 'owner'; next(); });
    app.use('/companies/:id/finance-categories', require('../src/routes/financeCategories'));
    return app;
  }

  test('sem a 434 a lista responde 503 com codigo (o app cai na lista fixa)', async () => {
    svc._resetCache();
    const e = new Error('relation "finance_categories" does not exist'); e.code = '42P01';
    db.query.mockReset().mockRejectedValue(e);
    const res = await request(buildApp()).get('/companies/' + COMPANY + '/finance-categories');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('FINANCE_CATEGORIES_UNAVAILABLE');
  });

  test('merge sem destino valido: 400', async () => {
    const res = await request(buildApp()).post('/companies/' + COMPANY + '/finance-categories/' + CAT + '/merge').send({});
    expect(res.status).toBe(400);
  });
});
