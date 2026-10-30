// ============================================================
// AURA. — Caixa: sangria e suprimento (migration 422) — Postgres real
//
//   1. caixa fechado: registrar é 404; listar devolve vazio
//   2. abre o caixa com troco 100; suprimento 50 e sangria 30 entram e o
//      dinheiro_em_caixa acompanha (120); sangria acima do caixa é 422
//   3. desfazer a sangria devolve o dinheiro; movimentação de outra loja
//      é 404
//   4. fechar grava total_sangrias/total_suprimentos e o dinheiro_esperado
//      já descontado; o detalhe da sessão lista as movimentações; a sessão
//      fechada não aceita mais nada
//
// Mesmo padrão de caixa.comandas.banco.test.js: tudo dentro de UMA
// transação revertida no afterAll; o client das rotas delega ao da
// transação do teste e troca BEGIN/COMMIT/ROLLBACK por SAVEPOINT.
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

const userId    = uuid();
const companyId = uuid();
const outraLoja = uuid();
const base = `/companies/${companyId}/caixa`;

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
  require('../src/services/caixaService')._resetCache();

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Caixa')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, pdv_settings)
     VALUES ($1, $3, 'Fixture Loja', '{"caixa_enabled": true}'::jsonb),
            ($2, $3, 'Fixture Outra Loja', '{"caixa_enabled": true}'::jsonb)`,
    [companyId, outraLoja, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/caixa', require('../src/routes/caixa'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('caixa — sangria e suprimento', () => {
  let sangriaId;

  test('1. caixa fechado: registrar é 404, listar devolve vazio', async () => {
    const post = await request(app).post(`${base}/movimentos`).send({ tipo: 'sangria', valor: 10 });
    expect(post.status).toBe(404);
    const get = await request(app).get(`${base}/movimentos`);
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ sessao_id: null, movimentos: [], dinheiro_em_caixa: 0 });
  });

  test('2. suprimento e sangria mexem no dinheiro em caixa; sangria acima é 422', async () => {
    const abrir = await request(app).post(`${base}/abrir`).send({ troco_inicial: 100 });
    expect(abrir.status).toBe(201);

    const sup = await request(app).post(`${base}/movimentos`).send({ tipo: 'suprimento', valor: 50, motivo: 'troco a mais' });
    expect(sup.status).toBe(201);
    expect(sup.body).toMatchObject({ suprimentos: 50, sangrias: 0, dinheiro_em_caixa: 150 });
    expect(sup.body.movimento).toMatchObject({ tipo: 'suprimento', valor: 50, motivo: 'troco a mais' });

    const demais = await request(app).post(`${base}/movimentos`).send({ tipo: 'sangria', valor: 150.01 });
    expect(demais.status).toBe(422);
    expect(demais.body.error).toMatch(/R\$ 150,00/);

    const san = await request(app).post(`${base}/movimentos`).send({ tipo: 'sangria', valor: 30, motivo: 'motoboy' });
    expect(san.status).toBe(201);
    expect(san.body).toMatchObject({ suprimentos: 50, sangrias: 30, dinheiro_em_caixa: 120 });
    sangriaId = san.body.movimento.id;

    const status = await request(app).get(`${base}/status`);
    expect(status.body.sessao_ativa).toMatchObject({ sangrias: 30, suprimentos: 50, dinheiro_em_caixa: 120 });
    expect(status.body.sessao_ativa.totais_ao_vivo.geral).toBe(0);

    const lista = await request(app).get(`${base}/movimentos`);
    expect(lista.body.movimentos).toHaveLength(2);
    // Tudo roda numa transação só: os dois created_at são o mesmo NOW() e a
    // ordem entre eles empata — acha pelo tipo, não pela posição.
    const aSangria = lista.body.movimentos.find((m) => m.tipo === 'sangria');
    expect(aSangria).toMatchObject({ tipo: 'sangria', valor: 30, motivo: 'motoboy', created_by_name: 'Fixture Caixa' });
  });

  test('3. desfazer devolve o dinheiro; movimentação de outra loja é 404', async () => {
    const alheia = await request(app).delete(`/companies/${outraLoja}/caixa/movimentos/${sangriaId}`);
    expect(alheia.status).toBe(404);

    const del = await request(app).delete(`${base}/movimentos/${sangriaId}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ sangrias: 0, suprimentos: 50, dinheiro_em_caixa: 150 });

    // lança de novo para o fechamento ter o que descontar
    const san = await request(app).post(`${base}/movimentos`).send({ tipo: 'sangria', valor: 30 });
    expect(san.status).toBe(201);
  });

  test('4. fechar grava os totais e desconta do esperado; sessão fechada não aceita mais', async () => {
    const fechar = await request(app).post(`${base}/fechar`).send({ dinheiro_contado: 120, observacao: null });
    expect(fechar.status).toBe(200);
    expect(fechar.body.fechamento).toMatchObject({ total_sangrias: 30, total_suprimentos: 50 });
    expect(parseFloat(fechar.body.fechamento.dinheiro_esperado)).toBe(120);
    expect(parseFloat(fechar.body.fechamento.diferenca)).toBe(0);

    const sessaoId = fechar.body.fechamento.sessao_id;
    const det = await request(app).get(`${base}/sessao/${sessaoId}`);
    expect(det.status).toBe(200);
    expect(parseFloat(det.body.sessao.total_sangrias)).toBe(30);
    expect(parseFloat(det.body.sessao.total_suprimentos)).toBe(50);
    expect(det.body.sessao.movimentos).toHaveLength(2);

    const hist = await request(app).get(`${base}/historico`);
    expect(hist.status).toBe(200);
    expect(parseFloat(hist.body.sessoes[0].total_sangrias)).toBe(30);

    const depois = await request(app).post(`${base}/movimentos`).send({ tipo: 'sangria', valor: 10 });
    expect(depois.status).toBe(404);
  });
});
