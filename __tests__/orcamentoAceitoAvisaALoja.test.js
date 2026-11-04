// ============================================================
// AURA. — Aceite do orcamento pelo link avisa a loja (04/11/2026)
//
// A pagina publica dizia ao cliente "A loja ja foi notificada" e nada
// saia. Agora o aceite (Studio e Matcon) dispara 'loja_orcamento_aprovado'
// depois do COMMIT, com o que o texto precisa (nome, total, quem fez), e a
// recusa nao dispara nada. O disparo e fire-and-forget: a resposta ao
// cliente nao depende dele.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const quotePublic = require('../src/routes/studioQuotePublic');
const lojaEvents = require('../src/services/lojaEvents');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(lojaEvents, 'emit').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const app = express();
app.use(express.json());
app.use('/orcamento', quotePublic);

const TOKEN = 'tok-123';
const STUDIO = { id: 'q-studio', company_id: 'c1', status: 'sent', expires_at: null, customer_name: 'Maria', total: '1200', created_by: 'u-bianca' };
const MATCON = { id: 'q-matcon', company_id: 'c2', number: 12, customer_name: 'Joao', total: '1207.81', created_by: 'u-x', seller_id: 'u-vend', status: 'open', vencido: false };

function mockClient({ studio = null, matcon = null } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM studio_quotes WHERE token/i.test(s)) return Promise.resolve({ rows: studio ? [studio] : [] });
    if (/FROM matcon_quotes WHERE public_token/i.test(s)) return Promise.resolve({ rows: matcon ? [matcon] : [] });
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: jest.fn() };
  db.connect.mockResolvedValue(client);
  return client;
}

test('Studio: aceitar avisa a loja depois do COMMIT, com nome, total e quem fez', async () => {
  const client = mockClient({ studio: STUDIO });
  const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'accept' });
  expect(res.status).toBe(200);
  expect(res.body.message).toMatch(/A loja já foi notificada/);
  expect(lojaEvents.emit).toHaveBeenCalledTimes(1);
  expect(lojaEvents.emit).toHaveBeenCalledWith('loja_orcamento_aprovado', {
    id: 'q-studio', company_id: 'c1', vertical: 'studio', origem: 'link',
    customer_name: 'Maria', total: '1200', created_by: 'u-bianca',
  });
  const sqls = client.query.mock.calls.map(([s]) => String(s));
  expect(sqls.indexOf('COMMIT')).toBeGreaterThan(-1);
  // o SELECT do orcamento traz o que o texto consome
  expect(sqls.find((s) => /FROM studio_quotes WHERE token/.test(s))).toMatch(/customer_name, total, created_by/);
});

test('Studio: recusar nao avisa', async () => {
  mockClient({ studio: STUDIO });
  const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'reject' });
  expect(res.status).toBe(200);
  expect(lojaEvents.emit).not.toHaveBeenCalled();
});

test('Matcon: aceitar avisa com numero, vendedor e quem fez', async () => {
  const client = mockClient({ matcon: MATCON });
  const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'accept' });
  expect(res.status).toBe(200);
  expect(lojaEvents.emit).toHaveBeenCalledWith('loja_orcamento_aprovado', {
    id: 'q-matcon', company_id: 'c2', vertical: 'matcon', origem: 'link',
    number: 12, customer_name: 'Joao', total: '1207.81', created_by: 'u-x', seller_id: 'u-vend',
  });
  expect(client.query.mock.calls.find(([s]) => /FROM matcon_quotes WHERE public_token/.test(String(s)))[0])
    .toMatch(/company_id, number, customer_name, total, created_by, seller_id/);
});

test('Matcon: recusar e orcamento ja respondido nao avisam', async () => {
  mockClient({ matcon: MATCON });
  await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'reject' });
  mockClient({ matcon: { ...MATCON, status: 'approved' } });
  const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'accept' });
  expect(res.status).toBe(409);
  expect(lojaEvents.emit).not.toHaveBeenCalled();
});
