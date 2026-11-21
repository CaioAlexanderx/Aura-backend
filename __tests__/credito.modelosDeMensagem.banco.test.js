// ============================================================
// AURA. — Modelos de mensagem do crediário (migration 462) — Postgres real
//
// O que este arquivo cobre:
//   1. loja sem modelo: GET devolve os 4 prontos da Aura e não grava nada
//   2. primeiro modelo salvo: os prontos viram da loja (4 + 1); "Salvar uma
//      cópia" (replaces_aura) toma o lugar do pronto e a situação dele
//   3. padrão único por situação: dar a situação a outro modelo libera o
//      anterior (fica livre); /default com null deixa livre
//   4. limite de 10 por loja e 1.000 letras
//   5. outra loja: não vê, não edita, não exclui (404); outro dono: 403 no
//      requireCompanyAccess
//   6. régua com texto próprio: vira modelo na primeira leitura, uma vez só
//      (apagar tudo não traz de volta); régua de fábrica não vira nada
//   7. excluir todos: os prontos voltam
//
// Mesmo padrão de financeiro.categorias.banco.test.js: tudo dentro de UMA
// transacao revertida no afterAll; o client das rotas delega ao da transacao
// do teste e troca BEGIN/COMMIT/ROLLBACK por SAVEPOINT.
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

const dono = uuid();
const outroDono = uuid();
const lojaA = uuid();
const lojaB = uuid();
const lojaRegua = uuid();
const lojaReguaFabrica = uuid();
let quem = dono;

const base = (loja) => `/companies/${loja}/credit/message-templates`;

async function contar(loja) {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM credit_message_templates WHERE company_id = $1', [loja]);
  return rows[0].n;
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

  svc = require('../src/services/credit/messageTemplates');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES
       ($1, $2, 'x', 'Fixture Modelos'), ($3, $4, 'x', 'Fixture Outro Dono')`,
    [dono, `fixture-${dono}@example.test`, outroDono, `fixture-${outroDono}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, is_active) VALUES
       ($1, $5, 'Fixture Loja A', true), ($2, $6, 'Fixture Loja B', true),
       ($3, $5, 'Fixture Loja Regua', true), ($4, $5, 'Fixture Loja Regua Fabrica', true)`,
    [lojaA, lojaB, lojaRegua, lojaReguaFabrica, dono, outroDono]
  );

  const { requireCompanyAccess } = require('../src/middleware/auth');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: quem }; next(); });
  app.use('/companies/:id/credit', requireCompanyAccess(), require('../src/routes/creditMessageTemplates'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(() => { quem = dono; });

describe('loja sem modelo', () => {
  it('GET devolve os prontos da Aura e não grava linha', async () => {
    const r = await request(app).get(base(lojaA));
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('aura');
    expect(r.body.limit).toBe(10);
    expect(r.body.templates.map((t) => t.id)).toEqual(['aura:lembrete', 'aura:vence_hoje', 'aura:passou_do_dia', 'aura:vamos_combinar']);
    expect(await contar(lojaA)).toBe(0);
  });

  it('pronto da Aura não se edita', async () => {
    const r = await request(app).patch(base(lojaA) + '/aura:lembrete').send({ name: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('MODELO_DA_AURA');
  });
});

describe('primeiro modelo, padrão por situação e limite', () => {
  let novoId;

  it('"Salvar uma cópia" do Passou do dia: 3 prontos + a cópia, que fica padrão de em atraso', async () => {
    const r = await request(app).post(base(lojaA)).send({
      name: 'Passou do dia + novidade',
      body: 'Oi, {nome}! A parcela {parcela} venceu dia {vencimento}. Chegou coleção nova!',
      replaces_aura: 'passou_do_dia',
    });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe('loja');
    expect(r.body.templates.map((t) => t.name)).toEqual(['Lembrete', 'Vence hoje', 'Vamos combinar', 'Passou do dia + novidade']);
    expect(r.body.template.situation).toBe('em_atraso');
    expect(r.body.template.is_default).toBe(true);
    novoId = r.body.template.id;
  });

  it('dar "a vencer" ao novo tira o padrão do Lembrete (que fica livre)', async () => {
    const r = await request(app).post(base(lojaA) + `/${novoId}/default`).send({ situation: 'a_vencer' });
    expect(r.status).toBe(200);
    const porNome = Object.fromEntries(r.body.templates.map((t) => [t.name, t]));
    expect(porNome['Passou do dia + novidade']).toMatchObject({ situation: 'a_vencer', is_default: true });
    expect(porNome.Lembrete).toMatchObject({ situation: null, is_default: false });
    const { rows } = await client.query(
      `SELECT situation, count(*)::int AS n FROM credit_message_templates
        WHERE company_id = $1 AND is_default GROUP BY situation ORDER BY situation`, [lojaA]);
    expect(rows).toEqual([{ situation: 'a_vencer', n: 1 }, { situation: 'vence_hoje', n: 1 }]);
  });

  it('/default com null deixa livre; PATCH muda nome e texto', async () => {
    let r = await request(app).post(base(lojaA) + `/${novoId}/default`).send({ situation: null });
    expect(r.status).toBe(200);
    expect(r.body.template).toMatchObject({ situation: null, is_default: false });
    r = await request(app).patch(base(lojaA) + `/${novoId}`).send({ name: 'Novidade', body: 'Oi, {nome}!' });
    expect(r.status).toBe(200);
    expect(r.body.template).toMatchObject({ name: 'Novidade', body: 'Oi, {nome}!' });
  });

  it('o índice segura dois padrões na mesma situação mesmo fora da rota', async () => {
    await client.query('SAVEPOINT dup');
    await expect(client.query(
      `INSERT INTO credit_message_templates (company_id, name, body, situation, is_default)
       VALUES ($1, 'dup', 'x', 'vence_hoje', true)`, [lojaA])).rejects.toMatchObject({ code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT dup');
  });

  it('texto de 1.001 letras e variável desconhecida: 422', async () => {
    let r = await request(app).post(base(lojaA)).send({ name: 'Longo', body: 'a'.repeat(1001) });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('TEXTO_LONGO');
    r = await request(app).post(base(lojaA)).send({ name: 'Var', body: 'Oi {cliente}' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('VARIAVEL_DESCONHECIDA');
  });

  it('até 10 por loja', async () => {
    const ja = await contar(lojaA);
    for (let i = ja; i < 10; i++) {
      const r = await request(app).post(base(lojaA)).send({ name: `Extra ${i}`, body: 'Oi, {nome}!' });
      expect(r.status).toBe(201);
    }
    const r = await request(app).post(base(lojaA)).send({ name: 'Décimo primeiro', body: 'Oi, {nome}!' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('LIMITE_DE_MODELOS');
    expect(await contar(lojaA)).toBe(10);
  });
});

describe('outra loja e outro dono', () => {
  let idDaA;
  beforeAll(async () => {
    const { rows } = await client.query('SELECT id FROM credit_message_templates WHERE company_id = $1 LIMIT 1', [lojaA]);
    idDaA = rows[0].id;
  });

  it('dono da loja B não entra na loja A (403)', async () => {
    quem = outroDono;
    const r = await request(app).get(base(lojaA));
    expect(r.status).toBe(403);
  });

  it('pela loja B, o modelo da A não existe: não edita, não vira padrão, não exclui', async () => {
    quem = outroDono;
    let r = await request(app).get(base(lojaB));
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('aura');
    r = await request(app).patch(base(lojaB) + `/${idDaA}`).send({ name: 'invadido' });
    expect(r.status).toBe(404);
    r = await request(app).post(base(lojaB) + `/${idDaA}/default`).send({ situation: 'a_vencer' });
    expect(r.status).toBe(404);
    r = await request(app).delete(base(lojaB) + `/${idDaA}`);
    expect(r.status).toBe(404);
    const { rows } = await client.query('SELECT name FROM credit_message_templates WHERE id = $1', [idDaA]);
    expect(rows[0].name).not.toBe('invadido');
  });
});

describe('textos da régua', () => {
  it('régua de fábrica não grava nada', async () => {
    await client.query(
      `INSERT INTO credit_collection_rules (company_id, rules) VALUES ($1, $2)`,
      [lojaReguaFabrica, JSON.stringify([
        { id: 'lembrete', name: 'Lembrete', days_relative: -3, enabled: true, template: svc.REGUA_PADRAO.lembrete },
      ])]
    );
    const r = await request(app).get(base(lojaReguaFabrica));
    expect(r.body.source).toBe('aura');
    expect(await contar(lojaReguaFabrica)).toBe(0);
  });

  it('texto próprio vira modelo da loja na primeira leitura, como padrão da situação', async () => {
    await client.query(
      `INSERT INTO credit_collection_rules (company_id, rules) VALUES ($1, $2)`,
      [lojaRegua, JSON.stringify([
        { id: 'lembrete', name: 'Lembrete', days_relative: -3, enabled: true, template: svc.REGUA_PADRAO.lembrete },
        { id: 'atraso_1', name: 'Atraso leve', days_relative: 1, enabled: true, template: 'Oi {nome}, venceu em {vencimento}. Bjs da loja!' },
      ])]
    );
    const r = await request(app).get(base(lojaRegua));
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('loja');
    expect(r.body.imported_from_regua).toBe(1);
    const porNome = Object.fromEntries(r.body.templates.map((t) => [t.name, t]));
    expect(Object.keys(porNome)).toEqual(['Lembrete', 'Vence hoje', 'Passou do dia', 'Vamos combinar', 'Atraso leve']);
    expect(porNome['Atraso leve']).toMatchObject({ situation: 'em_atraso', is_default: true, body: 'Oi {nome}, venceu em {vencimento}. Bjs da loja!' });
    expect(porNome['Passou do dia']).toMatchObject({ situation: null, is_default: false });
    expect(porNome.Lembrete).toMatchObject({ situation: 'a_vencer', is_default: true });
    // Segunda leitura não duplica.
    const r2 = await request(app).get(base(lojaRegua));
    expect(r2.body.templates).toHaveLength(5);
  });

  it('excluir todos: os prontos voltam e a régua não é trazida de novo', async () => {
    const { rows } = await client.query('SELECT id FROM credit_message_templates WHERE company_id = $1', [lojaRegua]);
    for (const { id } of rows) {
      const r = await request(app).delete(base(lojaRegua) + `/${id}`);
      expect(r.status).toBe(200);
    }
    const r = await request(app).get(base(lojaRegua));
    expect(r.body.source).toBe('aura');
    expect(r.body.templates).toHaveLength(4);
    expect(await contar(lojaRegua)).toBe(0);
  });
});
