// ============================================================
// AURA. — WhatsApp · Conversas: etiquetas e "É ela" — Postgres real
// Migration 474 + hubSocialEtiquetas.js + a lista/thread do hubSocial.js.
//
//  - etiqueta: criar, repetir (sem diferenciar maiúscula), nome vazio,
//    aplicar, filtrar a lista, apagar (sai de todas as conversas);
//  - uma loja nunca aplica, lê nem apaga etiqueta de outra;
//  - "É ela": sugestão pelo telefone do cadastro (formatado × só dígitos),
//    ligar grava customer_id, o nome do cadastro vale no lugar do nome do
//    perfil (sem sobrescrever o perfil), cadastro de outra loja é recusado.
//
// Fixtures com uuid próprio, apagadas no afterAll.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = {
  dono: uuid(), lojaA: uuid(), lojaB: uuid(),
  ana: uuid(), bruna: uuid(), carla: uuid(),
  conv1: uuid(), conv2: uuid(), convB: uuid(),
};
const FONE_ANA = '5511988887777';

let pool;
let app;
const q = (sql, params) => pool.query(sql, params);
const hub = (loja) => `/companies/${loja}/hub`;

async function limpar() {
  const passos = [
    [`DELETE FROM hub_conversation_labels WHERE conversation_id IN (SELECT id FROM hub_conversations WHERE company_id = ANY($1))`, [[ID.lojaA, ID.lojaB]]],
    [`DELETE FROM hub_labels WHERE company_id = ANY($1)`, [[ID.lojaA, ID.lojaB]]],
    [`DELETE FROM hub_conversations WHERE company_id = ANY($1)`, [[ID.lojaA, ID.lojaB]]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [[ID.lojaA, ID.lojaB]]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [[ID.lojaA, ID.lojaB]]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartável */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Etiquetas')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Etiq A'), ($3, $2, 'Fixture Etiq B')`,
    [ID.lojaA, ID.dono, ID.lojaB]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES
             ($1, $4, 'Ana Paula Ribeiro', '(11) 98888-7777'),
             ($2, $4, 'Bruna Sem Telefone', NULL),
             ($3, $5, 'Carla da Outra Loja', '11988887777')`,
    [ID.ana, ID.bruna, ID.carla, ID.lojaA, ID.lojaB]);
  await q(`INSERT INTO hub_conversations (id, company_id, channel, external_id, customer_name, last_inbound_at, last_message_at)
           VALUES ($1, $4, 'whatsapp', $5, 'AnaPerfil', NOW(), NOW()),
                  ($2, $4, 'whatsapp', '5521977770002', 'Outro Perfil', NOW(), NOW() - interval '1 hour'),
                  ($3, $6, 'whatsapp', $5, 'Perfil da B', NOW(), NOW())`,
    [ID.conv1, ID.conv2, ID.convB, ID.lojaA, FONE_ANA, ID.lojaB]);

  app = express();
  app.use(express.json());
  app.use('/companies/:id/hub', (req, _res, next) => { req.user = { id: ID.dono }; next(); }, require('../src/routes/hubSocial'));
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

let etiquetaId;

describe('etiquetas', () => {
  it('cria; o mesmo nome em outra caixa é recusado; nome vazio é recusado', async () => {
    const r = await request(app).post(`${hub(ID.lojaA)}/etiquetas`).send({ name: 'Orcamento', color: '#f59e0b' });
    expect(r.status).toBe(201);
    expect(r.body.label).toMatchObject({ name: 'Orcamento', color: '#f59e0b', n: 0 });
    etiquetaId = r.body.label.id;

    const dup = await request(app).post(`${hub(ID.lojaA)}/etiquetas`).send({ name: ' ORCAMENTO ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ETIQUETA_REPETIDA');

    expect((await request(app).post(`${hub(ID.lojaA)}/etiquetas`).send({ name: '   ' })).status).toBe(400);
    expect((await request(app).post(`${hub(ID.lojaA)}/etiquetas`).send({ name: 'X', color: 'vermelho' })).status).toBe(400);
  });

  it('a outra loja pode ter uma etiqueta de mesmo nome', async () => {
    const r = await request(app).post(`${hub(ID.lojaB)}/etiquetas`).send({ name: 'Orcamento' });
    expect(r.status).toBe(201);
  });

  it('aplica na conversa; a lista traz a etiqueta e o filtro só devolve quem a tem', async () => {
    const ap = await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv1}/etiquetas/${etiquetaId}`);
    expect(ap.status).toBe(200);
    // aplicar de novo não duplica nem quebra
    expect((await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv1}/etiquetas/${etiquetaId}`)).status).toBe(200);

    const todas = await request(app).get(`${hub(ID.lojaA)}/conversations`);
    expect(todas.status).toBe(200);
    expect(todas.body.conversations).toHaveLength(2);
    const c1 = todas.body.conversations.find((c) => c.id === ID.conv1);
    expect(c1.labels).toEqual([{ id: etiquetaId, name: 'Orcamento', color: '#f59e0b' }]);
    expect(todas.body.conversations.find((c) => c.id === ID.conv2).labels).toEqual([]);

    const filtrada = await request(app).get(`${hub(ID.lojaA)}/conversations?label=${etiquetaId}`);
    expect(filtrada.body.conversations.map((c) => c.id)).toEqual([ID.conv1]);

    const lista = await request(app).get(`${hub(ID.lojaA)}/etiquetas`);
    expect(lista.body.labels).toEqual([{ id: etiquetaId, name: 'Orcamento', color: '#f59e0b', n: 1 }]);
  });

  it('a thread também traz as etiquetas', async () => {
    const r = await request(app).get(`${hub(ID.lojaA)}/conversations/${ID.conv1}/messages`);
    expect(r.status).toBe(200);
    expect(r.body.conversation.labels).toHaveLength(1);
  });

  it('uma loja não usa, não filtra por e não apaga a etiqueta da outra', async () => {
    const { rows: [outra] } = await q(`SELECT id FROM hub_labels WHERE company_id = $1`, [ID.lojaB]);
    expect((await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv1}/etiquetas/${outra.id}`)).status).toBe(404);
    expect((await request(app).put(`${hub(ID.lojaB)}/conversations/${ID.conv1}/etiquetas/${etiquetaId}`)).status).toBe(404);
    expect((await request(app).delete(`${hub(ID.lojaA)}/etiquetas/${outra.id}`)).status).toBe(404);
    const filtro = await request(app).get(`${hub(ID.lojaA)}/conversations?label=${outra.id}`);
    expect(filtro.body.conversations).toHaveLength(0);
  });

  it('tirar da conversa e apagar a etiqueta limpam os vínculos', async () => {
    expect((await request(app).delete(`${hub(ID.lojaA)}/conversations/${ID.conv1}/etiquetas/${etiquetaId}`)).status).toBe(200);
    const sem = await request(app).get(`${hub(ID.lojaA)}/conversations?label=${etiquetaId}`);
    expect(sem.body.conversations).toHaveLength(0);

    await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv2}/etiquetas/${etiquetaId}`);
    expect((await request(app).delete(`${hub(ID.lojaA)}/etiquetas/${etiquetaId}`)).status).toBe(200);
    const { rows } = await q(`SELECT 1 FROM hub_conversation_labels WHERE label_id = $1`, [etiquetaId]);
    expect(rows).toHaveLength(0);
  });
});

describe('quem está no comando', () => {
  it('a lista e a thread trazem assigned_user_id e o primeiro nome de quem assumiu', async () => {
    await q(`UPDATE hub_conversations SET assigned_user_id = $1 WHERE id = $2`, [ID.dono, ID.conv1]);
    const lista = await request(app).get(`${hub(ID.lojaA)}/conversations`);
    const c = lista.body.conversations.find((x) => x.id === ID.conv1);
    expect(c.assigned_user_id).toBe(ID.dono);
    expect(c.assigned_user_name).toBe('Fixture');
    const thread = await request(app).get(`${hub(ID.lojaA)}/conversations/${ID.conv1}/messages`);
    expect(thread.body.conversation.assigned_user_id).toBe(ID.dono);
    expect(thread.body.conversation.assigned_user_name).toBe('Fixture');
    await q(`UPDATE hub_conversations SET assigned_user_id = NULL WHERE id = $1`, [ID.conv1]);
    const livre = await request(app).get(`${hub(ID.lojaA)}/conversations`);
    expect(livre.body.conversations.find((x) => x.id === ID.conv1).assigned_user_id).toBeNull();
  });
});

describe('"É ela"', () => {
  it('sugere o cadastro de mesmo telefone da MESMA loja, mesmo com máscara', async () => {
    const r = await request(app).get(`${hub(ID.lojaA)}/conversations/${ID.conv1}/cliente`);
    expect(r.status).toBe(200);
    expect(r.body.cliente).toBeNull();
    expect(r.body.sugestao).toMatchObject({ id: ID.ana, name: 'Ana Paula Ribeiro' });
  });

  it('conversa sem cadastro de mesmo telefone não sugere ninguém', async () => {
    const r = await request(app).get(`${hub(ID.lojaA)}/conversations/${ID.conv2}/cliente`);
    expect(r.body).toEqual({ cliente: null, sugestao: null });
  });

  it('busca por nome e por telefone; nunca devolve cadastro de outra loja', async () => {
    const porNome = await request(app).get(`${hub(ID.lojaA)}/clientes?q=paula`);
    expect(porNome.body.clientes.map((c) => c.id)).toEqual([ID.ana]);
    const porFone = await request(app).get(`${hub(ID.lojaA)}/clientes?q=98888-77`);
    expect(porFone.body.clientes.map((c) => c.id)).toEqual([ID.ana]);
    const outra = await request(app).get(`${hub(ID.lojaA)}/clientes?q=carla`);
    expect(outra.body.clientes).toHaveLength(0);
    expect((await request(app).get(`${hub(ID.lojaA)}/clientes?q=a`)).body.clientes).toEqual([]);
  });

  it('liga: grava o customer_id e o nome do cadastro vale no lugar do perfil, sem apagar o perfil', async () => {
    const r = await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv1}/cliente`).send({ customer_id: ID.ana });
    expect(r.status).toBe(200);
    const { rows: [c] } = await q(`SELECT customer_id, customer_name FROM hub_conversations WHERE id = $1`, [ID.conv1]);
    expect(c.customer_id).toBe(ID.ana);
    expect(c.customer_name).toBe('AnaPerfil');

    const lista = await request(app).get(`${hub(ID.lojaA)}/conversations`);
    expect(lista.body.conversations.find((x) => x.id === ID.conv1).customer_name).toBe('Ana Paula Ribeiro');
    const thread = await request(app).get(`${hub(ID.lojaA)}/conversations/${ID.conv1}/messages`);
    expect(thread.body.conversation.customer_name).toBe('Ana Paula Ribeiro');
    expect(thread.body.conversation.customer_id).toBe(ID.ana);

    const cartao = await request(app).get(`${hub(ID.lojaA)}/conversations/${ID.conv1}/cliente`);
    expect(cartao.body.cliente).toMatchObject({ id: ID.ana, name: 'Ana Paula Ribeiro' });
    expect(cartao.body.sugestao).toBeNull();
  });

  it('cadastro de outra loja ou inexistente é recusado e nada muda', async () => {
    const outra = await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv2}/cliente`).send({ customer_id: ID.carla });
    expect(outra.status).toBe(404);
    expect((await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv2}/cliente`).send({ customer_id: 'nao-e-uuid' })).status).toBe(400);
    expect((await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv2}/cliente`).send({})).status).toBe(400);
    const { rows: [c] } = await q(`SELECT customer_id FROM hub_conversations WHERE id = $1`, [ID.conv2]);
    expect(c.customer_id).toBeNull();
    // e a conversa de outra loja não é tocada por esta
    expect((await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.convB}/cliente`).send({ customer_id: ID.ana })).status).toBe(404);
  });

  it('desligar (null) devolve o nome do perfil', async () => {
    const r = await request(app).put(`${hub(ID.lojaA)}/conversations/${ID.conv1}/cliente`).send({ customer_id: null });
    expect(r.status).toBe(200);
    const lista = await request(app).get(`${hub(ID.lojaA)}/conversations`);
    expect(lista.body.conversations.find((x) => x.id === ID.conv1).customer_name).toBe('AnaPerfil');
  });
});
