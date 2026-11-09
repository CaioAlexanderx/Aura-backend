// ============================================================
// AURA. — Categorias do Financeiro (migration 434) — Postgres real
//
// O que este arquivo cobre:
//   1. primeira leitura semeia a lista padrao (com subcategorias) uma vez so
//   2. CRUD: criar categoria com subcategorias, subcategoria avulsa, cor
//   3. unicidade entre irmaos (sem acento/caixa) e o mesmo nome em maes
//      diferentes; arquivar libera o nome
//   4. 2 niveis: subcategoria de subcategoria e recusada (rota e gatilho)
//   5. usada pela Aura nao renomeia nem arquiva, mas ganha subcategoria
//   6. renomear categoria DA LOJA reescreve o texto dos lancamentos dela
//   7. juntar move os lancamentos (e as subcategorias) e arquiva a origem
//   8. arquivar: some da lista, os lancamentos ficam onde estao
//   9. "em todas as minhas lojas"
//  10. /transactions com category_id: texto = nome da mae
//  11. migracao: casa sem acento, texto que nao casa vira categoria, nenhum
//      texto reescrito, e o que casa por nome (Crediario A Receber, Vendas,
//      Taxas de cartao) continua casando; rodar de novo nao muda nada
//
// Mesmo padrao de caixa.comandas.banco.test.js: tudo dentro de UMA transacao
// revertida no afterAll; o client das rotas delega ao da transacao do teste e
// troca BEGIN/COMMIT/ROLLBACK por SAVEPOINT.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let app;
let svc;

const userId = uuid();
const lojaA = uuid();
const lojaB = uuid();
const lojaC = uuid(); // para a migracao: nunca abriu as categorias
let papel = 'owner';

const base = (loja) => `/companies/${loja || lojaA}/finance-categories`;

async function lancar(loja, type, category, extra) {
  const id = uuid();
  await client.query(
    `INSERT INTO transactions (id, company_id, type, status, amount, description, category, due_date, category_id)
     VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, CURRENT_DATE, $7)`,
    [id, loja, type, (extra && extra.amount) || 10, 'fixture ' + (category || ''), category, (extra && extra.category_id) || null]
  );
  return id;
}
async function tx(id) {
  const { rows } = await client.query('SELECT category, category_id FROM transactions WHERE id = $1', [id]);
  return rows[0];
}
async function lista(loja, q) {
  const r = await request(app).get(base(loja) + (q || ''));
  expect(r.status).toBe(200);
  return r.body;
}
function acha(body, kind, nome) {
  return body.categories.find((c) => c.kind === kind && c.name === nome);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));

  svc = require('../src/services/financeCategories');
  svc._resetCache();
  require('../src/utils/categoriaDoLancamento')._reset();

  // O schema do CI (so migrations/) nao tem estas colunas que producao ganhou
  // fora delas e que POST /transactions grava. Dentro da transacao revertida.
  await client.query(
    `ALTER TABLE transactions
       ADD COLUMN IF NOT EXISTS payment_method varchar(20),
       ADD COLUMN IF NOT EXISTS employee_id uuid,
       ADD COLUMN IF NOT EXISTS employee_name text,
       ADD COLUMN IF NOT EXISTS recurrence_type varchar(20),
       ADD COLUMN IF NOT EXISTS recurrence_group_id uuid,
       ADD COLUMN IF NOT EXISTS recurrence_index integer`
  );

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Categorias')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, is_active)
     VALUES ($1, $4, 'Fixture Loja A', true), ($2, $4, 'Fixture Loja B', true), ($3, $4, 'Fixture Loja C', true)`,
    [lojaA, lojaB, lojaC, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; req.companyRole = papel; next(); });
  app.use('/companies/:id/finance-categories', require('../src/routes/financeCategories'));
  app.use('/companies/:id/transactions', require('../src/routes/transactions'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('categorias do financeiro — banco', () => {
  test('1. primeira leitura semeia a lista padrao uma vez so', async () => {
    const a = await lista(lojaA);
    const fixas = acha(a, 'expense', 'Fixas');
    expect(fixas.subcategories.map((s) => s.name)).toEqual(['Aluguel', 'Energia', 'Internet e telefone', 'Contador']);
    expect(acha(a, 'income', 'Vendas')).toMatchObject({ is_system: true, manual: true });
    expect(acha(a, 'expense', 'Trocas e devoluções')).toMatchObject({ is_system: true, manual: false });
    expect(acha(a, 'expense', 'Fornecedores').dre_label).toBe('Compras de mercadoria');
    expect(a.lojas).toBe(3);
    expect(a.pode_todas_as_lojas).toBe(true);
    svc._resetCache();
    await lista(lojaA);
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM finance_categories WHERE company_id = $1', [lojaA]);
    const esperado = svc.linhasDosPadroes(svc.PADROES).length;
    expect(rows[0].n).toBe(esperado);
  });

  test('2. criar categoria com subcategorias e uma subcategoria avulsa', async () => {
    const r = await request(app).post(base()).send({ kind: 'expense', name: '  Veículo ', subcategories: ['Combustível', 'Seguro', 'seguro'], color: '#DC2626' });
    expect(r.status).toBe(201);
    expect(r.body.category).toMatchObject({ name: 'Veículo', color: '#dc2626', dre_line: 'despesas_variaveis', is_system: false });
    expect(r.body.category.subcategories.map((s) => s.name)).toEqual(['Combustível', 'Seguro']);
    const sub = await request(app).post(base()).send({ parent_id: r.body.category.id, name: 'Pedágio' });
    expect(sub.status).toBe(201);
    expect(sub.body.category).toMatchObject({ name: 'Pedágio', kind: 'expense', parent_id: r.body.category.id });
  });

  test('3. unicidade entre irmaos sem acento e caixa; o mesmo nome em outra mae passa; arquivar libera', async () => {
    const dup = await request(app).post(base()).send({ kind: 'expense', name: 'VEICULO' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CATEGORY_EXISTS');
    // Mesmo nome, outro tipo: passa.
    expect((await request(app).post(base()).send({ kind: 'income', name: 'Veículo' })).status).toBe(201);
    const a = await lista(lojaA);
    const veiculo = acha(a, 'expense', 'Veículo');
    const fixas = acha(a, 'expense', 'Fixas');
    expect((await request(app).post(base()).send({ parent_id: veiculo.id, name: 'Seguro' })).status).toBe(409);
    expect((await request(app).post(base()).send({ parent_id: fixas.id, name: 'Seguro' })).status).toBe(201);
    // Arquivada nao segura o nome.
    const temp = await request(app).post(base()).send({ kind: 'expense', name: 'Temporária' });
    expect((await request(app).patch(base() + '/' + temp.body.category.id).send({ archived: true })).status).toBe(200);
    expect((await request(app).post(base()).send({ kind: 'expense', name: 'Temporaria' })).status).toBe(201);
  });

  test('4. dois niveis no maximo (rota e gatilho)', async () => {
    const a = await lista(lojaA);
    const aluguel = acha(a, 'expense', 'Fixas').subcategories.find((s) => s.name === 'Aluguel');
    const r = await request(app).post(base()).send({ parent_id: aluguel.id, name: 'Sala 2' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CATEGORY_DEPTH');
    await client.query('SAVEPOINT gatilho');
    await expect(client.query(
      `INSERT INTO finance_categories (company_id, kind, parent_id, name, name_norm) VALUES ($1, 'expense', $2, 'Sala 2', 'x')`,
      [lojaA, aluguel.id]
    )).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT gatilho');
    // E a mae tem que ser do mesmo tipo.
    await client.query('SAVEPOINT gatilho2');
    await expect(client.query(
      `INSERT INTO finance_categories (company_id, kind, parent_id, name, name_norm) VALUES ($1, 'income', $2, 'Errada', 'x')`,
      [lojaA, acha(a, 'expense', 'Fixas').id]
    )).rejects.toMatchObject({ code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT gatilho2');
  });

  test('5. usada pela Aura nao renomeia nem arquiva, mas ganha subcategoria', async () => {
    const a = await lista(lojaA);
    const vendas = acha(a, 'income', 'Vendas');
    const ren = await request(app).patch(base() + '/' + vendas.id).send({ name: 'Faturamento' });
    expect(ren.status).toBe(409);
    expect(ren.body.code).toBe('CATEGORY_SYSTEM');
    expect((await request(app).patch(base() + '/' + vendas.id).send({ archived: true })).status).toBe(409);
    const merge = await request(app).post(base() + '/' + vendas.id + '/merge').send({ target_id: acha(a, 'income', 'Outros').id });
    expect(merge.status).toBe(409);
    // Cor muda; subcategoria nova entra.
    expect((await request(app).patch(base() + '/' + vendas.id).send({ color: '#0891b2' })).status).toBe(200);
    const sub = await request(app).post(base()).send({ parent_id: vendas.id, name: 'WhatsApp' });
    expect(sub.status).toBe(201);
    const t = await tx(await lancar(lojaA, 'income', 'Vendas'));
    expect(t.category).toBe('Vendas');
  });

  test('6. renomear categoria DA LOJA reescreve o texto dos lancamentos dela', async () => {
    const a = await lista(lojaA);
    const mkt = acha(a, 'expense', 'Marketing');
    const anuncios = mkt.subcategories.find((s) => s.name === 'Anúncios');
    const ligado = await lancar(lojaA, 'expense', 'Marketing', { category_id: mkt.id });
    const naSub = await lancar(lojaA, 'expense', 'Marketing', { category_id: anuncios.id });
    const antigo = await lancar(lojaA, 'expense', 'marketing'); // so texto, sem ligacao
    const outraLoja = await lancar(lojaB, 'expense', 'Marketing');
    const r = await request(app).patch(base() + '/' + mkt.id).send({ name: 'Divulgação' });
    expect(r.status).toBe(200);
    expect(r.body.lancamentos_renomeados).toBe(3);
    expect(await tx(ligado)).toEqual({ category: 'Divulgação', category_id: mkt.id });
    expect(await tx(naSub)).toEqual({ category: 'Divulgação', category_id: anuncios.id });
    expect(await tx(antigo)).toEqual({ category: 'Divulgação', category_id: mkt.id });
    expect((await tx(outraLoja)).category).toBe('Marketing');
    // Renomear subcategoria nao mexe em texto de lancamento.
    expect((await request(app).patch(base() + '/' + anuncios.id).send({ name: 'Anúncios pagos' })).body.lancamentos_renomeados).toBe(0);
    expect((await tx(naSub)).category).toBe('Divulgação');
  });

  test('7. juntar move os lancamentos e as subcategorias e arquiva a origem', async () => {
    const a = await lista(lojaA);
    const veiculo = acha(a, 'expense', 'Veículo');
    const operacional = acha(a, 'expense', 'Operacional');
    const seguroVeic = veiculo.subcategories.find((s) => s.name === 'Seguro');
    const t1 = await lancar(lojaA, 'expense', 'Veículo', { category_id: veiculo.id });
    const t2 = await lancar(lojaA, 'expense', 'Veículo', { category_id: seguroVeic.id });
    const t3 = await lancar(lojaA, 'expense', 'veiculo');
    const r = await request(app).post(base() + '/' + veiculo.id + '/merge').send({ target_id: operacional.id });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(3);
    expect(await tx(t1)).toEqual({ category: 'Operacional', category_id: operacional.id });
    expect(await tx(t2)).toEqual({ category: 'Operacional', category_id: seguroVeic.id });
    expect(await tx(t3)).toEqual({ category: 'Operacional', category_id: operacional.id });
    const depois = await lista(lojaA);
    expect(acha(depois, 'expense', 'Veículo')).toBeUndefined();
    expect(acha(depois, 'expense', 'Operacional').subcategories.map((s) => s.name)).toEqual(
      expect.arrayContaining(['Frete e entregas', 'Manutenção', 'Combustível', 'Seguro', 'Pedágio'])
    );
    // sub -> sub (outra mae) e principal -> sub
    const frete = acha(depois, 'expense', 'Operacional').subcategories.find((s) => s.name === 'Frete e entregas');
    const aluguel = acha(depois, 'expense', 'Fixas').subcategories.find((s) => s.name === 'Aluguel');
    const t4 = await lancar(lojaA, 'expense', 'Operacional', { category_id: frete.id });
    expect((await request(app).post(base() + '/' + frete.id + '/merge').send({ target_id: aluguel.id })).status).toBe(200);
    expect(await tx(t4)).toEqual({ category: 'Fixas', category_id: aluguel.id });
    expect((await request(app).post(base() + '/' + acha(depois, 'expense', 'Folha').id + '/merge').send({ target_id: aluguel.id })).status).toBe(400);
    // Nao junta dentro de Trocas e devolucoes.
    const trocas = acha(depois, 'expense', 'Trocas e devoluções');
    expect((await request(app).post(base() + '/' + acha(depois, 'expense', 'Folha').id + '/merge').send({ target_id: trocas.id })).status).toBe(409);
  });

  test('8. arquivar some da lista e deixa os lancamentos onde estao', async () => {
    const a = await lista(lojaA);
    const invest = acha(a, 'income', 'Investimentos');
    const t = await lancar(lojaA, 'income', 'Investimentos', { category_id: invest.subcategories[0].id });
    expect((await request(app).patch(base() + '/' + invest.id).send({ archived: true })).status).toBe(200);
    expect(acha(await lista(lojaA), 'income', 'Investimentos')).toBeUndefined();
    const arq = acha(await lista(lojaA, '?include_archived=1'), 'income', 'Investimentos');
    expect(arq.archived_at).toBeTruthy();
    expect(arq.subcategories.every((s) => s.archived_at)).toBe(true);
    expect(await tx(t)).toEqual({ category: 'Investimentos', category_id: invest.subcategories[0].id });
    // Desarquivar a sub antes da mae: recusado. A mae: volta.
    expect((await request(app).patch(base() + '/' + invest.subcategories[0].id).send({ archived: false })).status).toBe(409);
    expect((await request(app).patch(base() + '/' + invest.id).send({ archived: false })).status).toBe(200);
  });

  test('9. "em todas as minhas lojas" cria nas lojas do dono e pula onde ja existe', async () => {
    await request(app).post(base(lojaB)).send({ kind: 'expense', name: 'Viagens' });
    const r = await request(app).post(base()).send({ kind: 'expense', name: 'Viagens', subcategories: ['Hotel'], todas_as_lojas: true });
    expect(r.status).toBe(201);
    expect(r.body.criadas_em.sort()).toEqual([lojaA, lojaC].sort());
    expect(r.body.ja_existia_em).toEqual([lojaB]);
    // A loja C ainda nao tinha aberto as categorias: ganhou a lista padrao junto.
    const c = await lista(lojaC);
    expect(acha(c, 'expense', 'Viagens').subcategories.map((s) => s.name)).toEqual(['Hotel']);
    expect(acha(c, 'expense', 'Fixas')).toBeDefined();
    papel = 'Vendedor';
    const neg = await request(app).post(base()).send({ kind: 'expense', name: 'Brindes', todas_as_lojas: true });
    expect(neg.status).toBe(403);
    papel = 'owner';
  });

  test('10. /transactions com category_id: o texto e o nome da mae; a lista devolve a subcategoria', async () => {
    const a = await lista(lojaA);
    const fixas = acha(a, 'expense', 'Fixas');
    const energia = fixas.subcategories.find((s) => s.name === 'Energia');
    const r = await request(app).post(`/companies/${lojaA}/transactions`)
      .send({ type: 'expense', amount: 540, description: 'Luz de novembro', category: 'Energia', category_id: energia.id });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ category: 'Fixas', category_id: energia.id });
    // id de outra loja e ignorado: fica o texto, ligado pelo nome se casar.
    const fixasB = acha(await lista(lojaB), 'expense', 'Fixas');
    const r2 = await request(app).post(`/companies/${lojaA}/transactions`)
      .send({ type: 'expense', amount: 1, description: 'x', category: 'fixas', category_id: fixasB.id });
    expect(r2.body).toMatchObject({ category: 'fixas', category_id: fixas.id });
    // So texto (app antigo): liga pelo nome.
    const r3 = await request(app).post(`/companies/${lojaA}/transactions`).send({ type: 'income', amount: 1, description: 'x', category: 'Servicos' });
    expect(r3.body.category).toBe('Servicos');
    expect(r3.body.category_id).toBe(acha(a, 'income', 'Serviços').id);
    const l = await request(app).get(`/companies/${lojaA}/transactions?limit=500`);
    const linha = l.body.transactions.find((t) => t.id === r.body.id);
    expect(linha).toMatchObject({ category: 'Fixas', subcategory: 'Energia', category_name: 'Fixas', category_id: energia.id });
    // PATCH so com o mesmo texto nao perde a ligacao.
    await request(app).patch(`/companies/${lojaA}/transactions/${r.body.id}`).send({ category: 'Fixas' });
    expect(await tx(r.body.id)).toEqual({ category: 'Fixas', category_id: energia.id });
  });

  test('11. migracao: casa sem acento, cria o que nao casa, nao reescreve texto, e idempotente', async () => {
    const loja = uuid();
    await client.query(`INSERT INTO companies (id, owner_id, legal_name, is_active) VALUES ($1, $2, 'Fixture Migracao', true)`, [loja, userId]);
    const ids = {
      vendas: await lancar(loja, 'income', 'Vendas'),
      aReceber: await lancar(loja, 'income', 'Crediario - A Receber'),
      recebido: await lancar(loja, 'income', 'Crediario - Recebido (parcial)'),
      servicos: await lancar(loja, 'income', 'Servicos'),
      canal: await lancar(loja, 'income', 'Canal Digital'),
      taxa: await lancar(loja, 'expense', 'Taxas de cartão'),
      troca: await lancar(loja, 'expense', 'Troca - Devolucao'),
      veiculo: await lancar(loja, 'expense', 'Veículo'),
      veiculo2: await lancar(loja, 'expense', 'veiculo'),
      anuidade: await lancar(loja, 'income', 'annuity_dojo'),
    };
    const textosAntes = {};
    for (const k of Object.keys(ids)) textosAntes[k] = (await tx(ids[k])).category;

    const plano = await svc.planejarMigracao(loja);
    expect(plano.semeia_padroes).toBe(true);
    // Dry-run nao escreveu nada.
    expect((await client.query('SELECT COUNT(*)::int AS n FROM finance_categories WHERE company_id = $1', [loja])).rows[0].n).toBe(0);

    const out = await svc.aplicarMigracao(loja);
    expect(out.ligados).toHaveLength(9);
    expect(out.criadas).toHaveLength(1);
    const cats = (await client.query('SELECT id, name, parent_id FROM finance_categories WHERE company_id = $1', [loja])).rows;
    const nome = (id) => { const c = cats.find((x) => x.id === id); const m = c && c.parent_id ? cats.find((x) => x.id === c.parent_id) : null; return c ? (m ? m.name + ' › ' + c.name : c.name) : null; };
    const depois = {};
    for (const k of Object.keys(ids)) depois[k] = await tx(ids[k]);
    expect(nome(depois.vendas.category_id)).toBe('Vendas');
    expect(nome(depois.aReceber.category_id)).toBe('Crediário');
    expect(nome(depois.recebido.category_id)).toBe('Crediário');
    expect(nome(depois.servicos.category_id)).toBe('Serviços');
    expect(nome(depois.canal.category_id)).toBe('Vendas › Loja online');
    expect(nome(depois.taxa.category_id)).toBe('Taxas de cartão');
    expect(nome(depois.troca.category_id)).toBe('Trocas e devoluções');
    expect(nome(depois.veiculo.category_id)).toBe('Veículo');
    expect(depois.veiculo2.category_id).toBe(depois.veiculo.category_id);
    expect(depois.anuidade.category_id).toBeNull();
    // Nenhum texto reescrito.
    for (const k of Object.keys(ids)) expect(depois[k].category).toBe(textosAntes[k]);
    // O que casa por nome continua casando.
    const casa = await client.query(
      `SELECT COUNT(*) FILTER (WHERE category ILIKE 'Crediario%A Receber%')::int AS a_receber,
              COUNT(*) FILTER (WHERE category = 'Vendas')::int AS vendas,
              COUNT(*) FILTER (WHERE category = 'Taxas de cartão')::int AS taxa
         FROM transactions WHERE company_id = $1`, [loja]);
    expect(casa.rows[0]).toEqual({ a_receber: 1, vendas: 1, taxa: 1 });
    // Rodar de novo nao muda nada.
    const again = await svc.aplicarMigracao(loja);
    expect(again.ligados).toHaveLength(0);
    expect(again.criadas).toHaveLength(0);
  });
});
